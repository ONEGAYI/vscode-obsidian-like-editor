// 文档会话：宿主侧每个 TextDocument 一份，管理该文档全部 webview 面板的
// 同步。权威文档通过 HostDocumentPort 注入（vscode 层用 WorkspaceEdit 实现），
// 本模块保持纯逻辑、可单元测试。
//
// 职责（依据探索笔记 02 §3/§5/§6）：
// - ready 握手：webview 脚本加载完成前宿主不发送任何消息，ready 后发 init
// - edit.request：结构校验（协议层）+ sessionId/docUri 校验 + seq 幂等去重
//   + baseVersion 过期重定位（可平移则应用）；不可安全应用（区间被覆盖、
//   版本超前、versionLog 截断缺口）或 applyEdit 失败时进入面板级暂停：
//   保留输入片段（conflictFragments / conflict.report 快照）、拒绝后续
//   写回、经 onNotice 提示，恢复走 resumePanel（doc.resync 重置，#4）
// - 自家编辑的 onDidChangeTextDocument 回流识别为确认（edit.ack），其余
//   一切文档变更广播给面板（doc.changed），避免回显死循环
// - 请求串行处理：同一时刻只有一个 applyEdit 在途，后续请求基于推进后的
//   版本重定位，消除并发窗口
// - 面板关闭/断连（onDidDispose → detachPanel）时存在未确认输入必须通知，
//   不得静默丢弃（SSH 断开不得误报已保存）
import {
  isWebviewToHost,
  type HostToWebview,
  type SerChange,
  type WebviewToHost,
} from '../shared/protocol'
import { mapChangeThroughChanges } from '../shared/changeMapping'
import { NewlineCoordinator } from '../shared/newline'

/** 权威文档适配器：vscode 层实现 */
export interface HostDocumentPort {
  readonly version: number
  getText(): string
  /** 应用一组全文偏移变更；返回是否成功 */
  applyChanges(changes: SerChange[]): Promise<boolean>
  /** 对权威文档执行宿主撤销（undoRedoService 文本栈）；返回是否执行 */
  undo(): Promise<boolean>
  /** 对权威文档执行宿主重做；返回是否执行 */
  redo(): Promise<boolean>
}

/** 面板发送通道 */
export interface PanelPort {
  send(message: HostToWebview): void
}

/** 会话通知（#4）：冲突暂停、复制请求、面板关闭时存在未确认输入等需要
 *  用户感知的事件；由 vscode 层注入回调呈现（警告通知 + 取回按钮） */
export type SessionNotice =
  | { type: 'conflict'; sessionId: string; docUri: string }
  | { type: 'copy-request'; sessionId: string; docUri: string }
  | { type: 'panel-closed-with-input'; sessionId: string; docUri: string; fragments: string[] }

export interface DocumentSessionOptions {
  docUri?: string
  onNotice?: (notice: SessionNotice) => void
}

interface PendingEdit {
  seq: number
  changes: SerChange[]
  confirmed: boolean
}

interface PanelEntry {
  sessionId: string
  port: PanelPort
  ready: boolean
  pending: PendingEdit[]
  /** seq → 已发送的 ack（幂等去重：重复消息重发同一 ack） */
  ackCache: Map<number, HostToWebview>
  lastViewState?: Extract<WebviewToHost, { kind: 'view.state' }>
  /** 暂停写回状态（#4）：不可安全应用外部更新或写回失败时置位 */
  suspended: boolean
  /** 被拒绝请求的输入文本片段（用户未确认输入的宿主侧留存） */
  conflictFragments: string[]
  /** webview 冲突上报的本地全文快照（conflict.report） */
  conflictWebviewText?: string
  conflictWebviewVersion?: number
  /** 冲突通知只发一次（避免通知风暴） */
  conflictNotified: boolean
}

const ACK_CACHE_LIMIT = 64
const VERSION_LOG_LIMIT = 256

function changesEqual(a: readonly SerChange[], b: readonly SerChange[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every(
    (c, i) =>
      c.offset === b[i].offset && c.length === b[i].length && c.text === b[i].text,
  )
}

export class DocumentSession {
  private readonly panels = new Map<string, PanelEntry>()
  private readonly versionLog: { version: number; changes: SerChange[] }[] = []
  /** 换行协调：webview 侧统一 LF 坐标，宿主侧负责与权威文本的 CRLF 双向转换 */
  private readonly newline = new NewlineCoordinator()
  private queue: Promise<void> = Promise.resolve()
  private nextPanelId = 1
  private disposed = false

  constructor(
    private readonly doc: HostDocumentPort,
    private readonly options: DocumentSessionOptions = {},
  ) {
    this.newline.rebuild(doc.getText())
  }

  private get docUri(): string {
    return this.options.docUri ?? ''
  }

  /** 注册一个面板（resolveCustomTextEditor 时调用），返回 sessionId */
  attachPanel(port: PanelPort): string {
    const sessionId = `panel-${this.nextPanelId++}`
    this.panels.set(sessionId, {
      sessionId,
      port,
      ready: false,
      pending: [],
      ackCache: new Map(),
      suspended: false,
      conflictFragments: [],
      conflictNotified: false,
    })
    return sessionId
  }

  /**
   * 注销面板。存在未确认输入（暂停快照或在途请求）时必须通知——
   * 面板关闭与 SSH 断连（dispose）都走这里，不得静默丢弃用户输入。
   */
  detachPanel(sessionId: string): void {
    const panel = this.panels.get(sessionId)
    if (panel) {
      const fragments = [...panel.conflictFragments]
      for (const p of panel.pending) {
        if (!p.confirmed) {
          this.collectFragments(fragments, p.changes)
        }
      }
      if (panel.suspended || fragments.length > 0) {
        this.notify({ type: 'panel-closed-with-input', sessionId, docUri: this.docUri, fragments })
      }
    }
    this.panels.delete(sessionId)
  }

  dispose(): void {
    this.disposed = true
    this.panels.clear()
    this.versionLog.length = 0
  }

  /** webview 消息入口（provider 接到 webview.onDidReceiveMessage 后调用） */
  handleWebviewMessage(message: unknown, sessionId: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    const panel = this.panels.get(sessionId)
    if (!panel || !isWebviewToHost(message)) {
      return Promise.resolve()
    }
    switch (message.kind) {
      case 'ready':
        this.sendInit(panel)
        if (panel.suspended) {
          // webview 重载（retainContextWhenHidden 关闭）后恢复暂停提示：
          // 快照保留在宿主侧，取回途径不受重载影响
          panel.port.send({
            kind: 'session.suspended',
            version: this.doc.version,
            reason: 'conflict',
          })
        }
        return Promise.resolve()
      case 'edit.request': {
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        const task = this.queue.then(() => this.processEditRequest(panel, message))
        this.queue = task.catch(() => undefined)
        return task
      }
      case 'conflict.report': {
        // webview 冲突快照：与请求片段并存（fragments 是逐笔输入，全文是
        // 完整上下文），用户取回时优先最新 view.state，此处留存兜底
        panel.conflictWebviewText = message.text
        panel.conflictWebviewVersion = message.version
        return Promise.resolve()
      }
      case 'conflict.action': {
        if (message.action === 'copy') {
          this.notify({ type: 'copy-request', sessionId, docUri: this.docUri })
        } else {
          this.resumePanel(sessionId)
        }
        return Promise.resolve()
      }
      case 'history.request': {
        // 撤销/重做经队列串行：排在在途 edit.request 之后，保证撤销的是
        // 已完整应用（含回流确认）的编辑；undo/redo 的文档变更经
        // handleDocChanged 回流广播（逆变更不匹配任何 pending 正向变更，
        // 天然走 external 分支，不会作为确认吞掉）
        if (!panel.ready) {
          return Promise.resolve()
        }
        const op = message.op
        const task = this.queue.then(() => (op === 'undo' ? this.doc.undo() : this.doc.redo()))
        this.queue = task.then(() => undefined, () => undefined)
        return task.then(() => undefined)
      }
      case 'sync.request': {
        if (!panel.ready) {
          return Promise.resolve()
        }
        panel.port.send({
          kind: 'doc.resync',
          version: this.doc.version,
          text: this.newline.toLfText(this.doc.getText()),
        })
        return Promise.resolve()
      }
      case 'view.state':
        panel.lastViewState = message
        return Promise.resolve()
    }
  }

  /**
   * 宿主文档变更事件入口（provider 接到 onDidChangeTextDocument 后调用）。
   * 自家 applyEdit 的回流在此被识别为确认并发 ack；其余视为外部变更广播。
   */
  handleDocChanged(changes: SerChange[], version: number): void {
    if (this.disposed) {
      return
    }
    this.versionLog.push({ version, changes })
    if (this.versionLog.length > VERSION_LOG_LIMIT) {
      this.versionLog.splice(0, this.versionLog.length - VERSION_LOG_LIMIT)
    }
    // 一切 LF 转换都基于变更前的行尾位置表（changes/pending 坐标均指变更前
    // 文档），全部发送完成后再以变更后的全文重建位置表
    const lfChanges = this.newline.hostChangesToLf(changes)
    try {
      for (const panel of this.panels.values()) {
        const head = panel.pending[0]
        if (head && !head.confirmed && changesEqual(head.changes, changes)) {
          this.confirmPending(panel, head, version)
          return
        }
      }
      for (const panel of this.panels.values()) {
        if (panel.ready) {
          panel.port.send({ kind: 'doc.changed', version, changes: lfChanges, origin: 'external' })
        }
      }
    } finally {
      this.newline.rebuild(this.doc.getText())
    }
  }

  /** 最近一次 view.state 诊断（测试钩子与性能观测用） */
  getViewState(sessionId: string): Extract<WebviewToHost, { kind: 'view.state' }> | undefined {
    return this.panels.get(sessionId)?.lastViewState
  }

  /** 会话观测信息（测试钩子与调试用） */
  getInfo(): { panels: Array<{ sessionId: string; ready: boolean }> } {
    return {
      panels: [...this.panels.values()].map((p) => ({
        sessionId: p.sessionId,
        ready: p.ready,
      })),
    }
  }

  /** 向指定面板发送宿主消息（诊断请求等） */
  postToPanel(sessionId: string, message: HostToWebview): void {
    this.panels.get(sessionId)?.port.send(message)
  }

  private sendInit(panel: PanelEntry): void {
    panel.ready = true
    panel.port.send({
      kind: 'init',
      sessionId: panel.sessionId,
      docUri: this.docUri,
      version: this.doc.version,
      text: this.newline.toLfText(this.doc.getText()),
    })
  }

  private async processEditRequest(
    panel: PanelEntry,
    message: Extract<WebviewToHost, { kind: 'edit.request' }>,
  ): Promise<void> {
    const cached = panel.ackCache.get(message.seq)
    if (cached) {
      panel.port.send(cached)
      return
    }
    if (panel.suspended) {
      // 暂停写回：请求不写入权威文档，输入片段留存到快照（不丢字）
      this.collectFragments(panel.conflictFragments, message.changes)
      this.sendAck(panel, {
        kind: 'edit.ack',
        seq: message.seq,
        ok: false,
        reason: 'conflict',
        version: this.doc.version,
        text: this.newline.toLfText(this.doc.getText()),
      })
      return
    }
    let mapped: SerChange[] | null
    // webview 消息为 LF 坐标，先转换为宿主坐标再校验/重定位/应用
    const hostChanges = this.newline.lfChangesToHost(message.changes)
    if (message.baseVersion === this.doc.version) {
      mapped = hostChanges
    } else if (message.baseVersion < this.doc.version) {
      mapped = this.relocateChanges(message.baseVersion, hostChanges)
    } else {
      // webview 版本超前（迟到异常），按不可安全应用处理
      mapped = null
    }
    if (!mapped) {
      // 不可安全应用：保留输入、暂停写回、提示——不再以全文覆盖 webview
      this.suspendPanel(panel)
      this.collectFragments(panel.conflictFragments, message.changes)
      this.sendAck(panel, {
        kind: 'edit.ack',
        seq: message.seq,
        ok: false,
        reason: 'conflict',
        version: this.doc.version,
        text: this.newline.toLfText(this.doc.getText()),
      })
      this.notifyConflict(panel)
      return
    }
    const pending: PendingEdit = { seq: message.seq, changes: mapped, confirmed: false }
    panel.pending.push(pending)
    const ok = await this.doc.applyChanges(mapped)
    const entry = panel.pending.find((p) => p === pending)
    if (!entry) {
      return // 已被其他路径处理
    }
    if (!ok) {
      // 写回通道失败：编辑未进入权威文档，同样保留输入并暂停（不虚报成功）
      panel.pending.splice(panel.pending.indexOf(entry), 1)
      this.suspendPanel(panel)
      this.collectFragments(panel.conflictFragments, message.changes)
      this.sendAck(panel, {
        kind: 'edit.ack',
        seq: message.seq,
        ok: false,
        reason: 'error',
        version: this.doc.version,
        text: this.newline.toLfText(this.doc.getText()),
      })
      this.notifyConflict(panel)
      return
    }
    if (!entry.confirmed) {
      // applyEdit 已 resolve 但回流事件尚未到达（或被合并），以当前版本兜底确认
      this.confirmPending(panel, entry, this.doc.version)
    }
  }

  /** 日志覆盖检查：baseVersion..current 之间的变更组必须连续可见。
   *  versionLog 超限截断后对更早版本存在缺口，穿越不完整组会静默错位，
   *  必须拒绝并走冲突保留路径（不能拿不完整信息冒充安全重定位）。 */
  private logCovers(baseVersion: number): boolean {
    if (this.versionLog.length === 0) {
      return false // 版本落后但无日志可依据
    }
    return this.versionLog[0].version <= baseVersion + 1
  }

  private relocateChanges(baseVersion: number, hostChanges: SerChange[]): SerChange[] | null {
    if (!this.logCovers(baseVersion)) {
      return null
    }
    const groups = this.versionLog
      .filter((g) => g.version > baseVersion)
      .map((g) => g.changes)
    const mapped: SerChange[] = []
    for (const change of hostChanges) {
      const result = mapChangeThroughChanges(change, groups)
      if (result === null) {
        return null
      }
      mapped.push(result)
    }
    return mapped
  }

  /** 暂停面板写回：在途未确认请求一并拒绝并留存输入 */
  private suspendPanel(panel: PanelEntry): void {
    if (panel.suspended) {
      return
    }
    panel.suspended = true
    for (const p of panel.pending) {
      if (!p.confirmed) {
        this.collectFragments(panel.conflictFragments, p.changes)
        this.sendAck(panel, {
          kind: 'edit.ack',
          seq: p.seq,
          ok: false,
          reason: 'conflict',
          version: this.doc.version,
          text: this.newline.toLfText(this.doc.getText()),
        })
      }
    }
    panel.pending.length = 0
  }

  /** 恢复面板写回：清空快照并以权威全文重置 webview（doc.resync 兼作恢复信号） */
  resumePanel(sessionId: string): boolean {
    const panel = this.panels.get(sessionId)
    if (!panel) {
      return false
    }
    panel.suspended = false
    panel.conflictFragments = []
    panel.conflictWebviewText = undefined
    panel.conflictWebviewVersion = undefined
    panel.conflictNotified = false
    panel.pending.length = 0
    if (panel.ready) {
      panel.port.send({
        kind: 'doc.resync',
        version: this.doc.version,
        text: this.newline.toLfText(this.doc.getText()),
      })
    }
    return true
  }

  /** 面板冲突/暂停状态（测试钩子与通知按钮取回用） */
  getConflictState(
    sessionId: string,
  ): {
    suspended: boolean
    fragments: string[]
    webviewText: string | undefined
    webviewVersion: number | undefined
  } | undefined {
    const panel = this.panels.get(sessionId)
    if (!panel) {
      return undefined
    }
    return {
      suspended: panel.suspended,
      fragments: [...panel.conflictFragments],
      webviewText: panel.conflictWebviewText,
      webviewVersion: panel.conflictWebviewVersion,
    }
  }

  private collectFragments(into: string[], changes: SerChange[]): void {
    for (const c of changes) {
      if (c.text.length > 0) {
        into.push(c.text)
      }
    }
  }

  private notifyConflict(panel: PanelEntry): void {
    if (panel.conflictNotified) {
      return
    }
    panel.conflictNotified = true
    this.notify({ type: 'conflict', sessionId: panel.sessionId, docUri: this.docUri })
  }

  private notify(notice: SessionNotice): void {
    this.options.onNotice?.(notice)
  }

  private confirmPending(panel: PanelEntry, pending: PendingEdit, version: number): void {
    pending.confirmed = true
    const index = panel.pending.indexOf(pending)
    if (index >= 0) {
      panel.pending.splice(index, 1)
    }
    this.sendAck(panel, { kind: 'edit.ack', seq: pending.seq, ok: true, version })
    // 其他面板需要看到这次变更（split 多实例广播），坐标转换为 LF 形态
    const lfChanges = this.newline.hostChangesToLf(pending.changes)
    for (const other of this.panels.values()) {
      if (other !== panel && other.ready) {
        other.port.send({
          kind: 'doc.changed',
          version,
          changes: lfChanges,
          origin: 'external',
        })
      }
    }
  }

  private sendAck(panel: PanelEntry, ack: HostToWebview): void {
    if (ack.kind === 'edit.ack') {
      panel.ackCache.set(ack.seq, ack)
      while (panel.ackCache.size > ACK_CACHE_LIMIT) {
        const oldest = panel.ackCache.keys().next().value
        if (oldest === undefined) {
          break
        }
        panel.ackCache.delete(oldest)
      }
    }
    panel.port.send(ack)
  }
}
