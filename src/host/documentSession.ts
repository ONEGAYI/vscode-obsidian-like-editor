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
//   一切文档变更广播给面板（doc.changed），避免回显死循环；面板存在
//   「已应用未确认」pending 时外部广播先暂存、确认后有序补发（#48，
//   保证 webview 收到 ack(E) → doc.changed(X) 的参考系一致序列）
// - 请求串行处理：同一时刻只有一个 applyEdit 在途，后续请求基于推进后的
//   版本重定位，消除并发窗口
// - 面板关闭/断连（onDidDispose → detachPanel）时存在未确认输入必须通知，
//   不得静默丢弃（SSH 断开不得误报已保存）
import { Text } from '@codemirror/state'
import {
  isWebviewToHost,
  type DiagramExportFailReason,
  type DiagramExportPayload,
  type HostToWebview,
  type SerChange,
  type SettingsPayload,
  type WebviewToHost,
} from '../shared/protocol'
import { mapChangeThroughChanges } from '../shared/changeMapping'
import { NewlineCoordinator } from '../shared/newline'
import type { ImageResolution } from './linkTarget'

/** 权威文档适配器：vscode 层实现 */
export interface HostDocumentPort {
  readonly version: number
  /** 权威文档行尾（镜像 vscode.EndOfLine：1=LF、2=CRLF）。#81 复制产物
   *  按此归一（webview 出站恒为 LF）；缺省按 LF 处理 */
  readonly eol?: 1 | 2
  getText(): string
  /** 应用一组全文偏移变更；返回是否成功 */
  applyChanges(changes: SerChange[]): Promise<boolean>
  /** 对权威文档执行宿主撤销（undoRedoService 文本栈）；返回是否执行 */
  undo(): Promise<boolean>
  /** 对权威文档执行宿主重做（undoRedoService 文本栈）；返回是否执行 */
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
  /** #111 图表导出（vscode 层注入：载荷校验 + showSaveDialog + writeFile）；
   *  report 回报取消/校验失败/写盘失败/成功 */
  exportDiagram?(
    payload: DiagramExportPayload,
    report: (result: { ok: boolean; reason?: DiagramExportFailReason }) => void,
  ): void
  /** #33 打开 Vsidian 设置页（vscode 层注入：createWebviewPanel；设置页
   *  不依赖文档会话，与 link.activate 同为面板级 UI 意图端口） */
  openSettings?(): void
  /** #33 设置快照拉取（vscode 层注入：SettingsService.getSnapshot；面板
   *  init 后的 settings.get 以 settings.snapshot 响应） */
  requestSettings?(): SettingsPayload
  /** #69 剪贴板写（直写）：vscode 层注入 env.clipboard.writeText。只读
   *  交互（不写文档、不入撤销栈），暂停态同样放行。#81 代码块复制同走
   *  此端口——入参 text 已由会话按文档 EOL 归一（CRLF 文档收到 \r\n） */
  writeClipboard?(text: string): void
  /** #69 剪贴板写（标题链接）：`[[笔记名#标题]]` 的拼接在 vscode 层——
   *  笔记名 = docUri 文件名去扩展名（Obsidian 语义），标题为 webview
   *  上报的条目原文（含行内标记，与宿主 findHeadingOffset 的字面匹配同源） */
  writeHeadingLinkClipboard?(docUri: string, heading: string): void
}

/** 会话通知（#4）：冲突暂停、复制请求、面板关闭时存在未确认输入等需要
 *  用户感知的事件；由 vscode 层注入回调呈现（警告通知 + 取回按钮） */
export type SessionNotice =
  | { type: 'conflict'; sessionId: string; docUri: string }
  | { type: 'copy-request'; sessionId: string; docUri: string }
  | {
      type: 'panel-closed-with-input'
      sessionId: string
      docUri: string
      fragments: string[]
      /** webview 防抖重报的最新全文快照（R-1）：含暂停后继续输入与暂缓集
       *  内容，比 fragments 更完整；复制取回时优先 */
      webviewText?: string
    }

export interface DocumentSessionOptions {
  docUri?: string
  onNotice?: (notice: SessionNotice) => void
  /** #38 面板视图状态回报回调：view.state 缓存后触发（宿主维护
   *  vsidian.activeMode context 与初始 reading 恢复决策的数据源） */
  onViewState?: (
    sessionId: string,
    state: Extract<WebviewToHost, { kind: 'view.state' }>,
  ) => void
  /** #96 R1 ready 即校准的语言供应者：每次 ready（含 webview 重载的重复
   *  ready）按返回值幂等补发一条 locale.changed。数据岛携带的是面板
   *  【创建时】的语言，重载后装回旧语言、未 ready 面板错过切换广播——
   *  都以此对齐当前生效语言（与 init 重发全文同模式）。会话保持纯逻辑：
   *  hostLocale + LOCALE_MESSAGES 的装配由 vscode 层注入；未注入不发 */
  requestLocale?: () => { lang: string; messages: Readonly<Record<string, string>> } | undefined
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
  /** 已收但仍在全局 queue 中等待执行的请求；关闭检查须同步看见。 */
  queued: Map<number, SerChange[]>
  /** seq → 已发送的 ack（幂等去重：重复消息重发同一 ack） */
  ackCache: Map<number, HostToWebview>
  lastViewState?: Extract<WebviewToHost, { kind: 'view.state' }>
  /** 暂停写回状态（#4）：不可安全应用外部更新或写回失败时置位 */
  suspended: boolean
  /** 暂停的真实原因（重载恢复提示透传，协议 session.suspended 的 reason） */
  suspendedReason: 'conflict' | 'host-error'
  /** 被拒绝请求的输入文本片段（用户未确认输入的宿主侧留存） */
  conflictFragments: string[]
  /** webview 冲突上报的本地全文快照（conflict.report） */
  conflictWebviewText?: string
  conflictWebviewVersion?: number
  /** 特殊空白格 IME 在写回前的候选快照；普通冲突快照不参与此判定。 */
  compositionPending?: boolean
  /** 候选快照用 CM6 Text 增量维护；全文只在关闭/复制时生成。 */
  compositionSnapshot?: Text
  /** 单调快照序号：迟到的旧报告不得覆盖更新的全文。 */
  lastConflictRevision: number
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
  /** #48 已应用未确认窗口的外部广播暂存：面板 pending 存在已应用未确认
   *  条目时，外部增量的坐标参考系（权威文本已含该编辑）与 webview 的
   *  ackedChain（不含）不一致——先行广播会让 webview 逆穿 unconfirmed
   *  时把该编辑的偏移计算两次（不重叠时静默错位 len(E)，重叠时误判冲突
   *  暂停）。暂存到 pending 确认后按 version 有序补发，保证 webview 收到
   *  ack(E) → doc.changed(X) 的参考系一致序列，其既有状态机自然正确。 */
  private readonly pendingExternal: { version: number; changes: SerChange[] }[] = []
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
      queued: new Map(),
      ackCache: new Map(),
      suspended: false,
      suspendedReason: 'conflict',
      conflictFragments: [],
      compositionPending: false,
      lastConflictRevision: 0,
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
      let queuedChanges = false
      for (const changes of panel.queued.values()) {
        queuedChanges ||= changes.length > 0
        for (const change of changes) {
          if (change.text) fragments.push(change.text) // 入队请求本身已是 LF 坐标与文本
        }
      }
      for (const p of panel.pending) {
        if (!p.confirmed) {
          this.collectFragments(fragments, p.changes)
        }
      }
      const snapshotText = panel.compositionSnapshot?.toString() ?? panel.conflictWebviewText
      const pendingComposition = panel.compositionPending && snapshotText !== undefined &&
        snapshotText !== this.newline.toLfText(this.doc.getText())
      if (panel.suspended || fragments.length > 0 || queuedChanges || pendingComposition) {
        this.notify({
          type: 'panel-closed-with-input',
          sessionId,
          docUri: this.docUri,
          fragments,
          // 快照随通知带走（面板即将注销，事后无从查询）；暂停后新输入
          // 与暂缓集内容只在快照里（R-1）
          webviewText: snapshotText,
        })
      }
    }
    this.panels.delete(sessionId)
    // #48 收口说明：此处不立即补发暂存的外部增量。被关闭面板可能持有
    // 「已应用未确认」pending（编辑已在权威文档中，其余面板尚未见过）：
    // 先补发更高 version 的外部增量会让随后到达的本笔回流（version 更低）
    // 被 webview 版本单调防线丢弃、增量落点错位。补发由后续路径完成：
    // apply 成功时本笔回流以外部变更身份有序入队（排在本批暂存量之前）
    // 带动补发，失败时由 processEditRequest 的失败分支收口。
  }

  dispose(): void {
    this.disposed = true
    this.panels.clear()
    this.versionLog.length = 0
    this.confirmedEchoes.length = 0
    this.pendingExternal.length = 0
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
      case 'sync.test.close':
        // 仅由测试模式的 provider 消费；若绕过面板入口则无副作用。
        return Promise.resolve()
      case 'settings.open':
        // #33 打开设置页：不依赖文档状态（无文档语义在宿主层闭合），
        // 暂停态同样放行（与 link.activate 同口径的只读交互）
        panel.port.openSettings?.()
        return Promise.resolve()
      case 'settings.get':
        // #33 设置快照拉取：响应权威快照（webview 不持久化设置）
        if (panel.port.requestSettings) {
          panel.port.send({ kind: 'settings.snapshot', values: panel.port.requestSettings() })
        }
        return Promise.resolve()
      case 'diagram.export': {
        // #111 图表导出：只读交互（不写文档、不入撤销栈），暂停态同样
        // 放行（与 clipboard.write 同口径）；结果回来源面板
        const report = (result: { ok: boolean; reason?: DiagramExportFailReason }): void => {
          panel.port.send({
            kind: 'diagram.export.result',
            reqId: message.reqId,
            ok: result.ok,
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
          })
        }
        if (panel.port.exportDiagram) {
          panel.port.exportDiagram(message, report)
        } else {
          report({ ok: false, reason: 'invalid' })
        }
        return Promise.resolve()
      }
      case 'settings.set':
        // #33 设置保存只在设置页 webview 链路（settingsPage 模块）处理，
        // 编辑器面板不会发出；到达此处无副作用
        return Promise.resolve()
      case 'keybindings.get':
      case 'keybindings.set':
      case 'keybindings.reset':
      case 'keybindings.resetAll':
      case 'keybindings.execute':
        // 快捷键端口在 provider / 设置页消费；此处仅保持协议穷尽。
        return Promise.resolve()
      case 'clipboard.write':
        // #69 剪贴板写：与 link.activate 同口径的只读交互（不受写回暂停
        // 影响）；两变体（text 直写 / linkHeading 宿主拼标题链接）分别
        // 转发到注入端口
        if ('text' in message) {
          panel.port.writeClipboard?.(message.text)
        } else if (message.linkHeading !== undefined) {
          panel.port.writeHeadingLinkClipboard?.(message.linkHeading.docUri, message.linkHeading.heading)
        }
        return Promise.resolve()
      case 'ready': {
        const wasReady = panel.ready
        this.sendInit(panel)
        if (wasReady) {
          // 重复 ready = webview 重载（B-2）：init 已重发权威全文，此后暂停
          // 面板的 view.state 不再代表冲突前的未确认输入
          panel.reloaded = true
        }
        // #96 R1 ready 即校准：语言变化只广播给切换瞬间 ready 的面板，
        // 重载（数据岛装回创建时语言）与未 ready 面板都会错过——每次
        // ready 按供应者现值幂等补发（webview 收到后原子换包并重渲染）
        const locale = this.options.requestLocale?.()
        if (locale) {
          panel.port.send({
            kind: 'locale.changed',
            lang: locale.lang,
            messages: locale.messages,
          })
        }
        if (panel.suspended) {
          // webview 重载（retainContextWhenHidden 关闭）后恢复暂停提示：
          // 快照保留在宿主侧，取回途径不受重载影响；reason 透传真实暂停
          // 原因（conflict / host-error），不硬编码
          panel.port.send({
            kind: 'session.suspended',
            version: this.doc.version,
            reason: panel.suspendedReason,
          })
        }
        return Promise.resolve()
      }
      case 'edit.request': {
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        // 已确认 seq 的重传直接回复原 ack；其他面板可能占住全局队列，
        // 若先登记 queued，关闭本面板时会把已经保存的输入误报为未确认。
        const cached = panel.ackCache.get(message.seq)
        if (cached) {
          panel.port.send(cached)
          return Promise.resolve()
        }
        if (!panel.queued.has(message.seq)) panel.queued.set(message.seq, message.changes)
        const task = this.queue.then(() => {
          // 同一个微任务中从 queued 移入 processEditRequest 的 pending；
          // 关闭面板不会观察到两者都为空的中间窗口。
          panel.queued.delete(message.seq)
          return this.processEditRequest(panel, message)
        })
        this.queue = task.catch(() => undefined)
        return task
      }
      case 'conflict.report': {
        if (message.docUri !== this.docUri) {
          return Promise.resolve() // C-6：与 edit.request 对称的 docUri 校验
        }
        // webview 冲突快照：与请求片段并存（fragments 是逐笔输入，全文是
        // 完整上下文），用户取回时优先最新 view.state，此处留存兜底
        if (message.revision > panel.lastConflictRevision) {
          panel.lastConflictRevision = message.revision
          panel.conflictWebviewText = message.text
          panel.conflictWebviewVersion = message.version
          if (message.compositionPending !== undefined) {
            panel.compositionPending = message.compositionPending
            panel.compositionSnapshot = message.compositionPending
              ? Text.of(message.text.split('\n'))
              : undefined
          }
        }
        return Promise.resolve()
      }
      case 'composition.changed': {
        if (message.docUri !== this.docUri || !panel.compositionPending ||
            !panel.compositionSnapshot || message.revision <= panel.lastConflictRevision) {
          return Promise.resolve()
        }
        let snapshot = panel.compositionSnapshot
        let nextStart = snapshot.length
        for (const change of [...message.changes].sort((a, b) => b.offset - a.offset)) {
          if (change.offset + change.length > nextStart) return Promise.resolve()
          snapshot = snapshot.replace(change.offset, change.offset + change.length,
            Text.of(change.text.split('\n')))
          nextStart = change.offset
        }
        panel.compositionSnapshot = snapshot
        panel.lastConflictRevision = message.revision
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
        this.options.onViewState?.(sessionId, message)
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
      case 'codeblock.copy': {
        // #81 代码块复制请求：webview 只上报代码体原文，剪贴板写入执行
        // 归宿主（webview 不触碰剪贴板权限）；只读交互，暂停态同样放行。
        // webview 出站恒为 LF（CM6 LF 模型，代码体不含 \r）——CRLF 文档按
        // 权威行尾归一后写入，复制产物与文档行尾一致
        if (!panel.ready || message.docUri !== this.docUri) {
          return Promise.resolve()
        }
        panel.port.writeClipboard?.(this.doc.eol === 2 ? message.text.replace(/\n/g, '\r\n') : message.text)
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
    // VSCode 的 dirty 状态变化也触发 onDidChangeTextDocument：没有内容变更，
    // 版本不推进。它不属于文本同步，不能进入版本日志或广播为外部修改；
    // 否则 IME 会缓冲这个空事件，确认时把待发候选误判为外部冲突。
    if (this.disposed || changes.length === 0) {
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
      // 外部变更广播（#48）：存在「已应用未确认」pending 的窗口期先暂存，
      // 由确认路径（回流匹配 / applyEdit resolve 兜底）补发
      this.queueExternalBroadcast(version, lfChanges)
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
        // 防御分支（resolver 未注入仅见于异常装配）：reason 码即全部反馈，
        // detail 无 webview 消费方，不带文案（#95 i18n 清理）
        : Promise.resolve({ ok: false, reason: 'read-error' } as ImageResolution)
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
      // #48 收口：与写回失败分支保持同一收口语义。请求串行化（全局队列）
      // 下本分支运行时不可能是任何 apply 窗口，暂存队列为空，此调用为
      // 防御性补发
      this.flushPendingExternal()
      return
    }
    const pending: PendingEdit = { seq: message.seq, changes: mapped, confirmed: false }
    panel.pending.push(pending)
    // #52：快照 apply 前版本——兜底确认时据此推导 E 实际落地的权威版本
    //（apply 窗口内到达的外部增量会把 doc.version 推进到高于 E 的值）
    const versionBeforeApply = this.doc.version
    const ok = await this.doc.applyChanges(mapped)
    const entry = panel.pending.find((p) => p === pending)
    if (!entry) {
      // 已被其他路径处理（resumePanel 清空 pending 等）。apply 失败时该编辑
      // 不进权威文档、不会有回流事件来触发补发，暂存的外部增量只能在此
      // 收口；成功时本笔回流将以外部变更身份按 version 有序入队，自然
      // 带动补发（见 queueExternalBroadcast 的有序插入）
      if (!ok) {
        this.flushPendingExternal()
      }
      return
    }
    if (!ok) {
      // 写回通道失败：编辑未进入权威文档，同样保留输入并暂停（不虚报成功）
      panel.pending.splice(panel.pending.indexOf(entry), 1)
      this.suspendPanel(panel, 'host-error')
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
      // #48 收口：失败 ack 已发（本面板将进入暂停、忽略后续外部增量），
      // 暂存的外部增量立即可见给其余面板——不会有回流事件来触发补发，
      // 不在此收口将滞留至下一次外部变更或任意 confirmPending
      this.flushPendingExternal()
      return
    }
    if (!entry.confirmed) {
      // applyEdit 已 resolve 但回流事件尚未到达（或被合并），以 E 实际落地的
      // 权威版本兜底确认；记录 (version, changes) 供迟到回流匹配，防止重复
      // 广播（C-4）。版本不得取 resolve 时点的 doc.version（#52）：窗口内
      // 到达的外部增量已把它推进，E 的广播会与随后补发的暂存增量同版本，
      // 被旁观面板的版本单调防线永久丢弃
      const version = this.fallbackConfirmVersion(versionBeforeApply)
      this.confirmPending(panel, entry, version)
      this.confirmedEchoes.push({ version, changes: mapped })
      while (this.confirmedEchoes.length > ACK_CACHE_LIMIT) {
        this.confirmedEchoes.shift()
      }
    }
  }

  /** 兜底确认的版本推导（#52）：E 的回流未到达时，(apply 前版本, 当前版本]
   *  内的其余版本号都已作为外部回流进过 versionLog（每次文档变更恰产生
   *  一个携带其版本的回流事件，全局队列串行化保证同一时刻至多一笔「已
   *  应用未确认」pending），E 实际应用的版本是区间内唯一缺失的版本号。
   *  取该值广播/确认，保证随后按 version 有序补发的暂存增量不被 webview
   *  的 C-4 单调防线丢弃。推导不出（版本号无一缺失，如回流被合并成单
   * 事件）时退回当前版本，维持既有兜底语义。
   *
   *  排序假设（换宿主适配层需重新验证）：apply 窗口内落地的外部变更，其
   *  回流事件先于 applyEdit 的 resolve 送达本会话——扩展宿主的同通道 RPC
   *  按序投递、onDidChangeTextDocument 事件同步派发共同保证这一先后。
   *  该假设成立，「resolve 时点的 versionLog」才完整覆盖窗口内除 E 外的
   *  全部外部版本，缺失值才是 E 的实际版本；反之（回流晚于 resolve）会把
   *  外部变更的版本误判给 E。 */
  private fallbackConfirmVersion(versionBeforeApply: number): number {
    const logged = new Set(this.versionLog.map((g) => g.version))
    for (let v = versionBeforeApply + 1; v < this.doc.version; v++) {
      if (!logged.has(v)) {
        return v
      }
    }
    return this.doc.version
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

  /** 暂停面板写回：在途未确认请求一并拒绝并留存输入（reason 记录真实
   *  暂停原因，供 webview 重载后的 session.suspended 透传） */
  private suspendPanel(panel: PanelEntry, reason: 'conflict' | 'host-error' = 'conflict'): void {
    if (panel.suspended) {
      return
    }
    panel.suspended = true
    panel.suspendedReason = reason
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
    // #48 收口说明：暂存外部增量的补发不在此处统一执行——两个调用点的
    // 失败 ack 在 suspendPanel 返回后才发出，先补发会让失败面板以含失败
    // 编辑的未确认参考系应用外部增量（短暂错位）；由调用点在 ack 发出后
    // 收口（见 processEditRequest）
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
    panel.compositionPending = false
    panel.compositionSnapshot = undefined
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
      webviewText: panel.compositionSnapshot?.toString() ?? panel.conflictWebviewText,
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
    this.broadcastExternal(version, lfChanges, panel)
    // #48：确认后参考系一致（本面板 ack 已发、其他面板已见本笔广播），
    // 暂存的外部增量可按序补发
    this.flushPendingExternal()
  }

  /** 广播一笔外部变更（doc.changed）给全部 ready 面板；exclude 排除变更
   *  发起面板（其以 edit.ack 获知本笔）。暂停面板照发：webview 侧忽略
   *  并在恢复时以全文对齐（版本单调防线不受过期增量影响）。 */
  private broadcastExternal(version: number, changes: SerChange[], exclude?: PanelEntry): void {
    for (const other of this.panels.values()) {
      if (other !== exclude && other.ready) {
        other.port.send({
          kind: 'doc.changed',
          version,
          changes,
          origin: 'external',
        })
      }
    }
  }

  /** 外部增量广播入口（#48）：无「已应用未确认」pending 时立即广播（与
   *  原行为一致）；否则按 version 有序暂存，由 pending 确认路径补发。
   *  有序插入兜住迟到回流（编辑回流晚于外部回流被处理）的乱序到达。 */
  private queueExternalBroadcast(version: number, lfChanges: SerChange[]): void {
    let index = this.pendingExternal.length
    while (index > 0 && this.pendingExternal[index - 1]!.version > version) {
      index--
    }
    this.pendingExternal.splice(index, 0, { version, changes: lfChanges })
    this.flushPendingExternal()
  }

  /** 暂存的外部增量是否已可广播：所有面板均无已应用未确认的 pending 条目 */
  private hasUnconfirmedPending(): boolean {
    for (const panel of this.panels.values()) {
      if (panel.pending.some((p) => !p.confirmed)) {
        return true
      }
    }
    return false
  }

  /** 补发暂存的外部增量（#48）：仅在无未确认 pending 时执行，按 version
   *  有序广播给全部 ready 面板（暂停面板在 webview 侧忽略，版本单调防线
   *  保证恢复时全文对齐不受过期增量影响）。原位清空（splice）保持数组
   *  引用稳定，广播期间重入的入队写进同一数组、不会重复消费。 */
  private flushPendingExternal(): void {
    if (this.pendingExternal.length === 0 || this.hasUnconfirmedPending()) {
      return
    }
    const queued = this.pendingExternal.splice(0)
    for (const item of queued) {
      this.broadcastExternal(item.version, item.changes)
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
