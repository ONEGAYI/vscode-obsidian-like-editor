// 消息协议单一事实源：宿主（extension host）与 webview 两端共享的消息类型
// 与结构校验。两端不依赖 vscode / DOM，位置一律使用全文 UTF-16 code unit
// offset（与 TextDocument.contentChanges 的 rangeOffset/rangeLength 及
// CodeMirror 的文档定位同构）。
//
// 设计依据：探索笔记 02 §5（协议设计建议）、§6（陷阱清单）。

/** 一次变更：把全文 [offset, offset+length) 替换为 text（与 contentChanges 同构） */
export interface SerChange {
  offset: number
  length: number
  text: string
}

/** 宿主 → webview 消息 */
export type HostToWebview =
  /** ready 后首发：全文 + 当前权威版本 */
  | { kind: 'init'; sessionId: string; docUri: string; version: number; text: string }
  /** 编辑请求已应用（或被拒绝）。
   *  失败语义（#4 起）：conflict = 不可安全应用（重定位失败/版本异常/日志缺口），
   *  宿主已保留该请求的输入并暂停面板写回；error = 写回通道失败（applyEdit）。
   *  两者均附权威全文：webview 无未确认输入时重置装载，有则保留本地输入。 */
  | { kind: 'edit.ack'; seq: number; ok: true; version: number }
  | { kind: 'edit.ack'; seq: number; ok: false; reason: 'conflict' | 'error'; version: number; text?: string }
  /** 权威文档发生变更：变更增量（同指变更前文档） */
  | { kind: 'doc.changed'; version: number; changes: SerChange[]; origin: 'external' }
  /** 全文重同步（应 sync.request 或宿主主动）：webview 以全文重置本地文档；
   *  对暂停中的面板兼作恢复信号（重置并解除暂停） */
  | { kind: 'doc.resync'; version: number; text: string }
  /** 面板处于暂停写回状态（webview 重载后由 init 后跟随下发，恢复暂停提示） */
  | { kind: 'session.suspended'; version: number; reason: 'conflict' | 'host-error' }
  /** 请求 webview 回报视图诊断（文本与渲染行数，供测试与性能观测） */
  | { kind: 'view.state.request' }
  /** 性能探针（#5）：webview 测量输入延迟/长任务/滚动回收并回报 perf.report。
   *  探针编辑带 externalSync 注解，不产生写回（测量不污染宿主文档） */
  | { kind: 'perf.probe'; typingRounds: number; scrollRounds: number }
  /** 模式切换指令（#6）：live=实时预览，reading=阅读，toggle=翻转当前。
   *  模式是 webview 视图状态：不写 TextDocument、不入撤销栈；宿主命令
   *  与 webview 按钮（内部走同一状态机）共用此消息入口 */
  | { kind: 'view.mode.set'; mode: 'live' | 'reading' | 'toggle' }
  /** 定位请求（#6 起，为 #10 查找/跳转预留的宿主 → webview 入口）：
   *  把光标移动到源 offset 并滚动到可见（live）；reading 模式滚动到
   *  对应锚点块。纯视图操作：不写文档、不产生编辑历史 */
  | { kind: 'view.locate'; offset: number }
  /** 阅读视图性能探针（#7）：reading 模式下对阅读容器往返滚动并回报
   *  挂载/回收/解析次数。要求当前处于 reading 模式，否则回报失败态 */
  | { kind: 'reading.perf'; scrollRounds: number }
  /** 测试钩子（#7）：向包含 srcStart 的挂载块注入无网络图片并延迟改高，
   *  模拟图片加载后的布局变化（动态尺寸变化机制的验证载体） */
  | {
      kind: 'reading.test.image'
      srcStart: number
      initialHeightPx: number
      finalHeightPx: number
      delayMs: number
    }

/** webview → 宿主消息 */
export type WebviewToHost =
  /** webview 脚本加载完成，请求 init */
  | { kind: 'ready' }
  /** 编辑请求：seq 会话内单调递增；baseVersion 为发送方自认的权威版本 */
  | {
      kind: 'edit.request'
      sessionId: string
      docUri: string
      seq: number
      baseVersion: number
      changes: SerChange[]
    }
  /** 撤销/重做请求：作用于宿主 TextDocument 权威历史（探索笔记 03 §4） */
  | { kind: 'history.request'; op: 'undo' | 'redo' }
  /** 请求宿主回发全文重同步（外部变更与本地状态无法安全对齐时） */
  | { kind: 'sync.request' }
  /** 冲突/暂停时的本地全文快照上报：宿主保存供用户取回未确认输入 */
  | { kind: 'conflict.report'; sessionId: string; docUri: string; version: number; text: string }
  /** 暂停横幅按钮动作：copy = 请求宿主复制未确认输入；resume = 请求恢复（重新同步） */
  | { kind: 'conflict.action'; sessionId: string; docUri: string; action: 'copy' | 'resume' }
  /** 视图诊断回报 */
  | {
      kind: 'view.state'
      text: string
      docLength: number
      lineCount: number
      renderedLines: number
      /** 面板是否处于暂停写回状态（#4；可选字段向后兼容） */
      suspended?: boolean
      /** .cm-content 内全部元素数（#5 视口渲染 DOM 有界性观测） */
      contentDomCount?: number
      /** DOM 中标题行数（直接装饰渲染结果） */
      headingLineCount?: number
      /** 第一个源码态（活动）标题行的 DOM 文本 */
      headingActiveText?: string
      /** 第一个隐藏标记态（非活动）标题行的 DOM 文本 */
      headingHiddenText?: string
      /** 当前视图模式（#6；缺省 live，向后兼容） */
      viewMode?: 'live' | 'reading'
      /** live 光标主位置（UTF-16 offset；#6 锚点恢复观测） */
      selectionOffset?: number
      /** 阅读容器内块元素数（#6；#7 起为挂载块数，屏外块不创建） */
      readingBlockCount?: number
      /** 当前阅读锚点块的源 start（源码位置锚点，非滚动百分比） */
      readingAnchorStart?: number
      /** 阅读块模型总数（#7：全文切块结果，与挂载无关） */
      readingTotalBlocks?: number
      /** 阅读挂载块数（#7：当前窗口内真实创建的块） */
      readingMountedBlocks?: number
      /** 阅读容器内全部元素数（#7 DOM 有界性观测，含 spacer） */
      readingContentDomCount?: number
      /** 阅读全文解析累计次数（#7：滚动不得使其增长） */
      readingParseCount?: number
      /** 阅读视图是否虚拟化（#7：false 为无布局回退全量渲染） */
      readingVirtualized?: boolean
      /** 锚点块元素顶部位置（#7：px；锚点块未挂载时为估计位置） */
      readingAnchorTopPx?: number
      /** 阅读容器滚动位置与内容总高（#7：px） */
      readingScrollTopPx?: number
      readingScrollHeightPx?: number
      /** 稳定样式契约探针（#6 内部测试 CSS 验证入口）：目标元素不存在时字段为 null */
      cssProbe?: CssProbeReport
    }
  /** 阅读视图性能探针回报（#7）：滚动往返期间的挂载/回收与解析观测 */
  | {
      kind: 'reading.perf.report'
      scrollRounds: number
      totalBlocks: number
      baseline: ReadingPerfSnapshot
      afterScroll: ReadingPerfSnapshot
      /** 探针全程的全文解析次数（滚动不得使其增长；装载时为 1 起） */
      parseCount: number
      /** 探针期间出现过的最大挂载块数（窗口有界性） */
      maxMountedBlocks: number
      /** 非阅读模式下执行探针时为 false（探针未执行） */
      ok: boolean
    }
  /** 性能探针回报（#5）：快照为 DOM 计数，输入延迟含 rAF 稳定等待 */
  | {
      kind: 'perf.report'
      typingRounds: number
      scrollRounds: number
      docLines: number
      baseline: PerfSnapshot
      afterTyping: PerfSnapshot
      afterScroll: PerfSnapshot
      inputDelayMs: { samples: number[]; avgMs: number; maxMs: number }
      /** 宿主不支持 PerformanceObserver('longtask') 时为 null */
      longTasks: { count: number; maxMs: number; totalMs: number } | null
      headingStats: { totalUpdates: number; lastUpdateScannedLines: number; fullBuildLines: number }
    }

/** 性能快照（#5）：一次观测时点的 DOM 计数 */
export interface PerfSnapshot {
  /** .cm-line 行元素数 */
  renderedLines: number
  /** .cm-content 内全部元素数 */
  contentDomCount: number
  /** .oile-heading-line 元素数 */
  headingLineCount: number
  /** .oile-heading-inview 元素数（间接装饰渲染结果） */
  inviewHeadingCount: number
}

/** 阅读视图性能快照（#7）：一次观测时点的挂载与滚动状态 */
export interface ReadingPerfSnapshot {
  /** 挂载块数 */
  mountedBlocks: number
  /** 容器内全部元素数（含 spacer） */
  contentDomCount: number
  /** 容器 scrollTop（px） */
  scrollTopPx: number
  /** 容器 scrollHeight（px） */
  scrollHeightPx: number
}

/** CSS 契约探针回报（#6）：一段仅经稳定类名定位的内部测试 CSS 是否生效 */
export interface CssProbeReport {
  /** live 一级标题行经 `.oile-heading-line-1` 命中的属性值；无目标元素为 null */
  liveHeadingDecorationColor: string | null
  /** 阅读一级标题块经 `.oile-reading-heading-1` 命中的属性值；无目标元素为 null */
  readingHeadingDecorationColor: string | null
  /** `.oile-view-reading` 上被外部片段覆盖的探针变量值；未覆盖为空（null） */
  readingVarProbe: string | null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isString(v: unknown): boolean {
  return typeof v === 'string'
}

/** 非负数值（含小数）：滚动位置/元素位置等亚像素观测量 */
function isNonNegativeNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

export function isSerChange(v: unknown): v is SerChange {
  return (
    isObject(v) &&
    isNonNegativeInt(v.offset) &&
    isNonNegativeInt(v.length) &&
    isString(v.text)
  )
}

function isSerChangeArray(v: unknown): v is SerChange[] {
  return Array.isArray(v) && v.every(isSerChange)
}

function isPerfSnapshot(v: unknown): v is PerfSnapshot {
  return (
    isObject(v) &&
    isNonNegativeInt(v.renderedLines) &&
    isNonNegativeInt(v.contentDomCount) &&
    isNonNegativeInt(v.headingLineCount) &&
    isNonNegativeInt(v.inviewHeadingCount)
  )
}

function isNullOrString(v: unknown): boolean {
  return v === null || isString(v)
}

function isCssProbeReport(v: unknown): v is CssProbeReport {
  return (
    isObject(v) &&
    isNullOrString(v.liveHeadingDecorationColor) &&
    isNullOrString(v.readingHeadingDecorationColor) &&
    isNullOrString(v.readingVarProbe)
  )
}

function isReadingPerfSnapshot(v: unknown): v is ReadingPerfSnapshot {
  return (
    isObject(v) &&
    isNonNegativeInt(v.mountedBlocks) &&
    isNonNegativeInt(v.contentDomCount) &&
    isNonNegativeNumber(v.scrollTopPx) &&
    isNonNegativeNumber(v.scrollHeightPx)
  )
}

/** 宿主侧校验 webview 消息；非法消息必须整体丢弃，不部分读取字段 */
export function isWebviewToHost(v: unknown): v is WebviewToHost {
  if (!isObject(v)) {
    return false
  }
  switch (v.kind) {
    case 'ready':
      return true
    case 'edit.request':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isPositiveInt(v.seq) &&
        isNonNegativeInt(v.baseVersion) &&
        isSerChangeArray(v.changes)
      )
    case 'history.request':
      return v.op === 'undo' || v.op === 'redo'
    case 'sync.request':
      return true
    case 'conflict.report':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isNonNegativeInt(v.version) &&
        isString(v.text)
      )
    case 'conflict.action':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        (v.action === 'copy' || v.action === 'resume')
      )
    case 'view.state':
      return (
        isString(v.text) &&
        isNonNegativeInt(v.docLength) &&
        isNonNegativeInt(v.lineCount) &&
        isNonNegativeInt(v.renderedLines) &&
        (v.suspended === undefined || typeof v.suspended === 'boolean') &&
        (v.contentDomCount === undefined || isNonNegativeInt(v.contentDomCount)) &&
        (v.headingLineCount === undefined || isNonNegativeInt(v.headingLineCount)) &&
        (v.headingActiveText === undefined || isString(v.headingActiveText)) &&
        (v.headingHiddenText === undefined || isString(v.headingHiddenText)) &&
        (v.viewMode === undefined || v.viewMode === 'live' || v.viewMode === 'reading') &&
        (v.selectionOffset === undefined || isNonNegativeInt(v.selectionOffset)) &&
        (v.readingBlockCount === undefined || isNonNegativeInt(v.readingBlockCount)) &&
        (v.readingAnchorStart === undefined || isNonNegativeInt(v.readingAnchorStart)) &&
        (v.readingTotalBlocks === undefined || isNonNegativeInt(v.readingTotalBlocks)) &&
        (v.readingMountedBlocks === undefined || isNonNegativeInt(v.readingMountedBlocks)) &&
        (v.readingContentDomCount === undefined || isNonNegativeInt(v.readingContentDomCount)) &&
        (v.readingParseCount === undefined || isNonNegativeInt(v.readingParseCount)) &&
        (v.readingVirtualized === undefined || typeof v.readingVirtualized === 'boolean') &&
        (v.readingAnchorTopPx === undefined || isNonNegativeNumber(v.readingAnchorTopPx)) &&
        (v.readingScrollTopPx === undefined || isNonNegativeNumber(v.readingScrollTopPx)) &&
        (v.readingScrollHeightPx === undefined || isNonNegativeNumber(v.readingScrollHeightPx)) &&
        (v.cssProbe === undefined || isCssProbeReport(v.cssProbe))
      )
    case 'reading.perf.report':
      return (
        isNonNegativeInt(v.scrollRounds) &&
        isNonNegativeInt(v.totalBlocks) &&
        isReadingPerfSnapshot(v.baseline) &&
        isReadingPerfSnapshot(v.afterScroll) &&
        isNonNegativeInt(v.parseCount) &&
        isNonNegativeInt(v.maxMountedBlocks) &&
        typeof v.ok === 'boolean'
      )
    case 'perf.report':
      return (
        isNonNegativeInt(v.typingRounds) &&
        isNonNegativeInt(v.scrollRounds) &&
        isNonNegativeInt(v.docLines) &&
        isPerfSnapshot(v.baseline) &&
        isPerfSnapshot(v.afterTyping) &&
        isPerfSnapshot(v.afterScroll) &&
        isObject(v.inputDelayMs) &&
        Array.isArray(v.inputDelayMs.samples) &&
        v.inputDelayMs.samples.every((s) => typeof s === 'number' && s >= 0) &&
        typeof v.inputDelayMs.avgMs === 'number' &&
        typeof v.inputDelayMs.maxMs === 'number' &&
        (v.longTasks === null ||
          (isObject(v.longTasks) &&
            isNonNegativeInt(v.longTasks.count) &&
            typeof v.longTasks.maxMs === 'number' &&
            typeof v.longTasks.totalMs === 'number')) &&
        isObject(v.headingStats) &&
        isNonNegativeInt(v.headingStats.totalUpdates) &&
        isNonNegativeInt(v.headingStats.lastUpdateScannedLines) &&
        isNonNegativeInt(v.headingStats.fullBuildLines)
      )
    default:
      return false
  }
}

/** webview 侧校验宿主消息 */
export function isHostToWebview(v: unknown): v is HostToWebview {
  if (!isObject(v)) {
    return false
  }
  switch (v.kind) {
    case 'init':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isNonNegativeInt(v.version) &&
        isString(v.text)
      )
    case 'edit.ack':
      if (!isPositiveInt(v.seq) || !isNonNegativeInt(v.version)) {
        return false
      }
      if (v.ok === true) {
        return true
      }
      if (v.ok === false) {
        return (
          (v.reason === 'conflict' || v.reason === 'error') &&
          (v.text === undefined || isString(v.text))
        )
      }
      return false
    case 'doc.changed':
      return (
        isNonNegativeInt(v.version) &&
        isSerChangeArray(v.changes) &&
        v.origin === 'external'
      )
    case 'doc.resync':
      return isNonNegativeInt(v.version) && isString(v.text)
    case 'session.suspended':
      return (
        isNonNegativeInt(v.version) &&
        (v.reason === 'conflict' || v.reason === 'host-error')
      )
    case 'view.state.request':
      return true
    case 'perf.probe':
      return isPositiveInt(v.typingRounds) && isPositiveInt(v.scrollRounds)
    case 'view.mode.set':
      return v.mode === 'live' || v.mode === 'reading' || v.mode === 'toggle'
    case 'view.locate':
      return isNonNegativeInt(v.offset)
    case 'reading.perf':
      return isPositiveInt(v.scrollRounds)
    case 'reading.test.image':
      return (
        isNonNegativeInt(v.srcStart) &&
        isNonNegativeInt(v.initialHeightPx) &&
        isNonNegativeInt(v.finalHeightPx) &&
        isNonNegativeInt(v.delayMs)
      )
    default:
      return false
  }
}
