// 文档会话：宿主侧每个 TextDocument 一份，管理该文档全部 webview 面板的
// 同步。权威文档通过 HostDocumentPort 注入（vscode 层用 WorkspaceEdit 实现），
// 本模块保持纯逻辑、可单元测试。
//
// 职责（依据探索笔记 02 §3/§5/§6）：
// - ready 握手：webview 脚本加载完成前宿主不发送任何消息，ready 后发 init
// - edit.request：结构校验（协议层）+ sessionId/docUri 校验 + seq 幂等去重
//   + baseVersion 过期重定位（可平移则应用，区间被覆盖则拒绝附全文）
// - 自家编辑的 onDidChangeTextDocument 回流识别为确认（edit.ack），其余
//   一切文档变更广播给面板（doc.changed），避免回显死循环
// - 请求串行处理：同一时刻只有一个 applyEdit 在途，后续请求基于推进后的
//   版本重定位，消除并发窗口
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
}

/** 面板发送通道 */
export interface PanelPort {
  send(message: HostToWebview): void
}

export interface DocumentSessionOptions {
  docUri?: string
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
    this.panels.set(sessionId, { sessionId, port, ready: false, pending: [], ackCache: new Map() })
    return sessionId
  }

  detachPanel(sessionId: string): void {
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
        return Promise.resolve()
      case 'edit.request': {
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        const task = this.queue.then(() => this.processEditRequest(panel, message))
        this.queue = task.catch(() => undefined)
        return task
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
    let mapped: SerChange[] | null
    // webview 消息为 LF 坐标，先转换为宿主坐标再校验/重定位/应用
    const hostChanges = this.newline.lfChangesToHost(message.changes)
    if (message.baseVersion === this.doc.version) {
      mapped = hostChanges
    } else if (message.baseVersion < this.doc.version) {
      mapped = this.relocateChanges(message.baseVersion, hostChanges)
    } else {
      // webview 版本超前（异常状态），按过期处理
      mapped = null
    }
    if (!mapped) {
      this.sendAck(panel, {
        kind: 'edit.ack',
        seq: message.seq,
        ok: false,
        reason: 'stale',
        version: this.doc.version,
        text: this.newline.toLfText(this.doc.getText()),
      })
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
      panel.pending.splice(panel.pending.indexOf(entry), 1)
      this.sendAck(panel, {
        kind: 'edit.ack',
        seq: message.seq,
        ok: false,
        reason: 'error',
        version: this.doc.version,
      })
      return
    }
    if (!entry.confirmed) {
      // applyEdit 已 resolve 但回流事件尚未到达（或被合并），以当前版本兜底确认
      this.confirmPending(panel, entry, this.doc.version)
    }
  }

  private relocateChanges(baseVersion: number, hostChanges: SerChange[]): SerChange[] | null {
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
