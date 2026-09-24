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
import type { ImageResolution } from './linkTarget'

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
  /** #10 链接跳转执行（vscode 层注入：URI 解析白名单 + openExternal/
   *  showTextDocument/用户反馈）；只读交互，暂停态同样放行 */
  openLink?(intent: { href: string; srcStart: number; srcEnd: number }): void
  /** #11 双链跳转执行（vscode 层注入：wikilinkTarget 按需解析 + 打开/
   *  定位/用户反馈）；只读交互，暂停态同样放行 */
  openWikilink?(intent: { target: string; srcStart: number; srcEnd: number }): void
  /** #10 图片资源解析（vscode 层注入：classifyImageTarget + asWebviewUri） */
  resolveImage?(src: string): Promise<ImageResolution>
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
  /** 最近一次性能探针回报（#5：测试钩子 perfProbe 轮询读取） */
  lastPerfReport?: Extract<WebviewToHost, { kind: 'perf.report' }>
  /** 最近一次阅读视图探针回报（#7：测试钩子 readingPerf 轮询读取） */
  lastReadingPerfReport?: Extract<WebviewToHost, { kind: 'reading.perf.report' }>
  /** 冲突通知只发一次（避免通知风暴） */
  conflictNotified: boolean
  /** webview 曾在会话内重载（ready 重复到达，B-2）：暂停面板复制未确认
   *  输入时跳过面板查询（重载后 view.state 是权威全文，不代表冲突前输入） */
  reloaded: boolean
}

const ACK_CACHE_LIMIT = 64
const VERSION_LOG_LIMIT = 256

/** 变更组相等（顺序无关）：段内区间互不重叠，排序后逐段比较。
 *  VSCode 对多段 WorkspaceEdit 的回流 contentChanges 按偏移降序到达，
 *  而 webview 出站（CM6 iterChanges）为升序——按序比较会把自家确认
 *  误判为外部变更（#13 表格结构操作的多段变更暴露）。 */
function changesEqual(a: readonly SerChange[], b: readonly SerChange[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const sortedA = [...a].sort((x, y) => x.offset - y.offset)
  const sortedB = [...b].sort((x, y) => x.offset - y.offset)
  return sortedA.every(
    (c, i) =>
      c.offset === sortedB[i]!.offset && c.length === sortedB[i]!.length && c.text === sortedB[i]!.text,
  )
}

export class DocumentSession {
  private readonly panels = new Map<string, PanelEntry>()
  /** versionLog 同时保存宿主与 LF 两种形态：重定位在 LF 空间进行（C-1），
   *  行尾分布变化在 LF 空间是 no-op，先转后移会把 no-op 当平移错位 */
  private readonly versionLog: {
    version: number
    changes: SerChange[]
    lfChanges: SerChange[]
  }[] = []
  /** 兜底确认记录（C-4）：applyEdit resolve 后回流迟到时，回流到达按
   *  (version, changes) 匹配识别为自家确认，不作为外部变更重复广播 */
  private readonly confirmedEchoes: { version: number; changes: SerChange[] }[] = []
  /** 换行协调：webview 侧统一 LF 坐标，宿主侧负责与权威文本的 CRLF 双向转换 */
  private readonly newline = new NewlineCoordinator()
  private queue: Promise<void> = Promise.resolve()
  private nextPanelId = 1
  private disposed = false
  /** #10 图片解析：同 src 在途去重与成功结果缓存（失败不缓存，重试重解析） */
  private readonly imageInFlight = new Map<string, Promise<ImageResolution>>()
  private readonly imageCache = new Map<string, ImageResolution>()

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
      reloaded: false,
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
    this.confirmedEchoes.length = 0
    this.imageInFlight.clear()
    this.imageCache.clear()
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
      case 'ready': {
        const wasReady = panel.ready
        this.sendInit(panel)
        if (wasReady) {
          // 重复 ready = webview 重载（B-2）：init 已重发权威全文，此后暂停
          // 面板的 view.state 不再代表冲突前的未确认输入
          panel.reloaded = true
        }
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
      }
      case 'edit.request': {
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        const task = this.queue.then(() => this.processEditRequest(panel, message))
        this.queue = task.catch(() => undefined)
        return task
      }
      case 'conflict.report': {
        if (message.docUri !== this.docUri) {
          return Promise.resolve() // C-6：与 edit.request 对称的 docUri 校验
        }
        // webview 冲突快照：与请求片段并存（fragments 是逐笔输入，全文是
        // 完整上下文），用户取回时优先最新 view.state，此处留存兜底
        panel.conflictWebviewText = message.text
        panel.conflictWebviewVersion = message.version
        return Promise.resolve()
      }
      case 'conflict.action': {
        if (message.docUri !== this.docUri) {
          return Promise.resolve() // C-6：非本文档的冲突动作不得影响本面板
        }
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
        if (!panel.ready || panel.suspended) {
          // 暂停面板忽略（B-4，与 edit.request 一致）：宿主 undo 命令作用于
          // 活动编辑器，暂停面板的请求会撤销到其他目标文档
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
      case 'link.activate': {
        // #10 链接跳转意图：校验归属与 ready 后交面板端口执行。只读交互，
        // 不受写回暂停影响（暂停面板照样可以点链接）
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        panel.port.openLink?.({
          href: message.href,
          srcStart: message.srcStart,
          srcEnd: message.srcEnd,
        })
        return Promise.resolve()
      }
      case 'wikilink.activate': {
        // #11 双链跳转意图：与 link.activate 同校验口径（归属 + ready），
        // 执行（按名/路径解析、打开与定位）归宿主 vscode 层
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        panel.port.openWikilink?.({
          target: message.target,
          srcStart: message.srcStart,
          srcEnd: message.srcEnd,
        })
        return Promise.resolve()
      }
      case 'image.request': {
        // #10 图片解析请求：同 src 在途去重 + 成功缓存（失败重试重解析）。
        // 返回完成 Promise（image.result 已回发才算处理完，调用方可等待）
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        return this.resolveImageRequest(panel, message.reqId, message.src)
      }
      case 'perf.report':
        panel.lastPerfReport = message
        return Promise.resolve()
      case 'reading.perf.report':
        panel.lastReadingPerfReport = message
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
    // 一切 LF 转换都基于变更前的行尾位置表（changes/pending 坐标均指变更前
    // 文档），全部发送完成后再以变更后的全文重建位置表
    const lfChanges = this.newline.hostChangesToLf(changes)
    this.versionLog.push({ version, changes, lfChanges })
    if (this.versionLog.length > VERSION_LOG_LIMIT) {
      this.versionLog.splice(0, this.versionLog.length - VERSION_LOG_LIMIT)
    }
    // 兜底确认的迟到回流（C-4）：日志仍需完整（重定位依赖变更史），
    // 但不作为外部变更重复广播
    if (this.confirmedEchoes.some((e) => e.version === version && changesEqual(e.changes, changes))) {
      this.newline.rebuild(this.doc.getText())
      return
    }
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

  /** 最近一次性能探针回报（#5 测试钩子与测量脚本用） */
  getLastPerfReport(
    sessionId: string,
  ): Extract<WebviewToHost, { kind: 'perf.report' }> | undefined {
    return this.panels.get(sessionId)?.lastPerfReport
  }

  /** 最近一次阅读视图探针回报（#7 测试钩子与测量脚本用） */
  getLastReadingPerfReport(
    sessionId: string,
  ): Extract<WebviewToHost, { kind: 'reading.perf.report' }> | undefined {
    return this.panels.get(sessionId)?.lastReadingPerfReport
  }

  /** #10 图片解析请求处理（去重/缓存/回发） */
  private async resolveImageRequest(
    panel: PanelEntry,
    reqId: number,
    src: string,
  ): Promise<void> {
    const send = (resolution: ImageResolution): void => {
      if (resolution.ok) {
        panel.port.send({ kind: 'image.result', reqId, ok: true, src: resolution.src })
      } else {
        panel.port.send({
          kind: 'image.result',
          reqId,
          ok: false,
          reason: resolution.reason,
          detail: resolution.detail,
        })
      }
    }
    const cached = this.imageCache.get(src)
    if (cached) {
      send(cached)
      return
    }
    let pending = this.imageInFlight.get(src)
    if (!pending) {
      const resolver = panel.port.resolveImage
      pending = resolver
        ? resolver(src).catch((): ImageResolution => ({ ok: false, reason: 'read-error' }))
        : Promise.resolve({ ok: false, reason: 'read-error', detail: '未注入解析器' } as ImageResolution)
      this.imageInFlight.set(src, pending)
      // 完成后清理在途表；成功结果进入小容量缓存（滚动回视口的重复请求
      // 直接命中，避免反复读盘；失败不缓存，保留重试语义）
      void pending.then((resolution) => {
        this.imageInFlight.delete(src)
        if (resolution.ok) {
          this.imageCache.set(src, resolution)
          while (this.imageCache.size > 16) {
            const oldest = this.imageCache.keys().next().value
            if (oldest === undefined) {
              break
            }
            this.imageCache.delete(oldest)
          }
        }
      })
    }
    send(await pending)
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
      // 暂停写回：请求不写入权威文档，输入片段留存到快照（不丢字）。
      // collectFragments 以宿主系为入参口径（B-6 统一 LF 入库）
      this.collectFragments(panel.conflictFragments, this.newline.lfChangesToHost(message.changes))
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
    if (message.baseVersion === this.doc.version) {
      // webview 消息为 LF 坐标，先转换为宿主坐标再校验/应用
      mapped = this.newline.lfChangesToHost(message.changes)
    } else if (message.baseVersion < this.doc.version) {
      // 重定位全程在 LF 空间进行（C-1）：versionLog 的 LF 形态变更组与
      // webview 的 LF 坐标同一参考系（行尾变化在 LF 空间是 no-op，不会被
      // 当作平移）；完成后再以当前行尾表一次性转宿主坐标
      const relocatedLf = this.relocateLfChanges(message.baseVersion, message.changes)
      mapped = relocatedLf === null ? null : this.newline.lfChangesToHost(relocatedLf)
    } else {
      // webview 版本超前（迟到异常），按不可安全应用处理
      mapped = null
    }
    if (!mapped) {
      // 不可安全应用：保留输入、暂停写回、提示——不再以全文覆盖 webview
      this.suspendPanel(panel)
      this.collectFragments(panel.conflictFragments, this.newline.lfChangesToHost(message.changes))
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
      this.collectFragments(panel.conflictFragments, mapped)
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
      // applyEdit 已 resolve 但回流事件尚未到达（或被合并），以当前版本兜底确认；
      // 记录 (version, changes) 供迟到回流匹配，防止重复广播（C-4）
      this.confirmPending(panel, entry, this.doc.version)
      this.confirmedEchoes.push({ version: this.doc.version, changes: mapped })
      while (this.confirmedEchoes.length > ACK_CACHE_LIMIT) {
        this.confirmedEchoes.shift()
      }
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

  /** 把 baseVersion 系的 LF 变更组穿过 versionLog 的 LF 形态变更组；
   *  日志不覆盖或区间不可安全映射时返回 null。 */
  private relocateLfChanges(baseVersion: number, lfChanges: SerChange[]): SerChange[] | null {
    if (!this.logCovers(baseVersion)) {
      return null
    }
    const groups = this.versionLog
      .filter((g) => g.version > baseVersion)
      .map((g) => g.lfChanges)
    const mapped: SerChange[] = []
    for (const change of lfChanges) {
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
    panel.reloaded = false
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
    /** webview 曾重载（B-2）：暂停面板的 view.state 是重载装载的权威全文，
     *  复制未确认输入时应跳过面板查询、直接用宿主快照 */
    reloaded: boolean
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
      reloaded: panel.reloaded,
    }
  }

  /** 留存输入片段：入参为宿主系变更组，统一转 LF 形态入库（B-6）——
   *  片段面向用户取回（剪贴板/通知），与 webview 输入的 LF 形态一致 */
  private collectFragments(into: string[], hostChanges: SerChange[]): void {
    for (const c of this.newline.hostChangesToLf(hostChanges)) {
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
