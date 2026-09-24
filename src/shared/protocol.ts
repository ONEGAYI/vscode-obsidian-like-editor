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

/** 表格结构操作（#13）：宿主命令面板命令 → webview 在光标处执行（live 模式） */
export type TableEditOp =
  | 'insertRowAbove'
  | 'insertRowBelow'
  | 'deleteRow'
  | 'insertColumnLeft'
  | 'insertColumnRight'
  | 'deleteColumn'

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
   * 模拟图片加载后的布局变化（动态尺寸变化机制的验证载体） */
  | {
      kind: 'reading.test.image'
      srcStart: number
      initialHeightPx: number
      finalHeightPx: number
      delayMs: number
    }
  /** 测试钩子（#9）：按视图与序号点击真实任务 checkbox，驱动与用户点击
   *  完全相同的处理器链路（校验 → 出站 edit.request）。宿主测试无法向
   *  webview 派发真实鼠标事件，以此通道验证真实宿主内的勾选写回 */
  | { kind: 'task.test.click'; view: 'live' | 'reading'; index: number }
  /** 图片解析结果（#10）：reqId 对应 image.request。ok 时 src 为可直接作
   *  img.src 的地址——工作区文件经 asWebviewUri 的 webview 资源 URI
   *  （本地与远程工作区同通道）；失败附原因码供错误态与重试呈现 */
  | { kind: 'image.result'; reqId: number; ok: true; src: string }
  | {
      kind: 'image.result'
      reqId: number
      ok: false
      reason: 'blocked' | 'outside-workspace' | 'not-found' | 'read-error'
      detail?: string
    }
  /** 查找会话指令（#14）：open 打开 webview 内浮动查找面板（可预置查询词，
   *  焦点进输入框）；close 关闭并归还焦点；step 循环定位上一/下一匹配。
   *  查找是纯只读视图操作：不写文档、不产生编辑历史、无 webview→宿主消息 */
  | { kind: 'view.find.open'; query?: string }
  | { kind: 'view.find.close' }
  | { kind: 'view.find.step'; direction: 'next' | 'prev' }
  /** 表格结构操作（#13）：在面板光标处执行增删行列（仅 live 模式；阅读
   *  模式只读忽略）。变更经 webview 的 CM6 事务走标准出站链路
   *  （edit.request 一笔 = 宿主撤销一次） */
  | { kind: 'table.command'; op: TableEditOp }
  /** 测试钩子（#13）：向真实编辑器派发 Tab/Shift+Tab keydown（与用户按键
   *  同一 keymap 链路；纯选区导航，零写回）。宿主测试无法向 webview 派发
   *  真实键盘事件，以此通道验证导航装配 */
  | { kind: 'table.test.key'; key: 'tab' | 'shift-tab' }

/** webview → 宿主消息 */
export type WebviewToHost =
  /** webview 脚本加载完成，请求 init。
   *  已知限制（C-8）：ready 与 init 之间的毫秒级窗口内到达的 doc.changed
   *  会被未 ready 面板丢弃——装载以 init 全文为准，内容不丢；仅当窗口内
   *  版本推进且 init 竞态落后时理论可见，宿主按事件序串行发送可缓解 */
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
      /** live 侧语法装饰统计（#8 双视图语义一致性观测；装饰集合级计数，非 DOM） */
      liveSyntax?: LiveSyntaxProbe
      /** reading 侧渲染语义统计（#8 双视图语义一致性观测；小文档全量挂载时有效） */
      readingSyntax?: ReadingSyntaxProbe
      /** live 视口内链接 span 数（#10；间接装饰渲染结果，限于视口） */
      liveLinkCount?: number
      /** live 视口内图片 widget 数（#10） */
      liveImageCount?: number
      /** live 视口内双链数（#11；范围外 widget 与范围内 mark 共用类名） */
      liveWikilinkCount?: number
      /** 阅读挂载块内链接数（#10；屏外块不创建，无 DOM） */
      readingLinkCount?: number
      /** 阅读挂载块内图片数（#10） */
      readingImageCount?: number
      /** 阅读挂载块内双链数（#11；markdown-it 渲染的 a.vsidian-wikilink） */
      readingWikilinkCount?: number
      /** 图片槽位状态计数（#10：当前视图内 loading/loaded/error） */
      imageStates?: ImageStateCounts
      /** 查找会话观测（#14）：首次打开后回报（未打开过时缺省） */
      find?: FindSessionProbe
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
  /** 链接跳转意图（#10）：webview 只上报原始 URI 与源位置，执行归宿主——
   *  URI 解析与路径拼接（含 Windows/远程语义）只在宿主侧进行。阅读视图
   *  单击、实时预览 Ctrl/Cmd+单击产生；href 为源文原样（未解码/未规范化） */
  | {
      kind: 'link.activate'
      sessionId: string
      docUri: string
      href: string
      srcStart: number
      srcEnd: number
    }
  /** 双链跳转意图（#11）：与 link.activate 同通道语义，但目标是 Obsidian
   *  双链（按名/按路径在工作区内解析，非 URI）——分类走 wikilinkTarget
   *  而非 #10 的 URI 白名单。target 为 `[[` 与 `]]` 之间、`|` 之前的原文
   *  （未 trim；宿主解析自带规范化）。阅读视图单击、实时预览
   *  Ctrl/Cmd+单击产生；srcStart/srcEnd 覆盖整个 `[[…]]` 出现（阅读视图
   *  为所在块源锚点） */
  | {
      kind: 'wikilink.activate'
      sessionId: string
      docUri: string
      target: string
      srcStart: number
      srcEnd: number
    }
  /** 图片资源解析请求（#10）：非 http(s) 直连的工作区图源经宿主解析为
   *  webview 可加载地址（reqId 会话面板内自增，对应 image.result） */
  | { kind: 'image.request'; sessionId: string; docUri: string; reqId: number; src: string }
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
  /** .vsidian-heading-line 元素数 */
  headingLineCount: number
  /** .vsidian-heading-inview 元素数（间接装饰渲染结果） */
  inviewHeadingCount: number
  /** #15：webview JS 堆已用字节数（Chromium performance.memory）；环境不支持为 null */
  jsHeapBytes?: number | null
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
  /** #15：webview JS 堆已用字节数（Chromium performance.memory）；环境不支持为 null */
  jsHeapBytes?: number | null
}

/** 图片槽位状态计数（#10：图片生命周期观测，当前视图内计数） */
export interface ImageStateCounts {
  loading: number
  loaded: number
  error: number
}

/** CSS 契约探针回报（#6）：一段仅经稳定类名定位的内部测试 CSS 是否生效 */
export interface CssProbeReport {
  /** live 一级标题行经 `.vsidian-heading-line-1` 命中的属性值；无目标元素为 null */
  liveHeadingDecorationColor: string | null
  /** 阅读一级标题块经 `.vsidian-reading-heading-1` 命中的属性值；无目标元素为 null */
  readingHeadingDecorationColor: string | null
  /** `.vsidian-view-reading` 上被外部片段覆盖的探针变量值；未覆盖为空（null） */
  readingVarProbe: string | null
  /** #8：live 粗体 span 经 `.vsidian-strong` 命中的属性值；无目标为 null */
  liveStrongDecorationColor: string | null
  /** #8：live 行内代码 span 经 `.vsidian-inline-code` 命中的属性值；无目标为 null */
  liveInlineCodeDecorationColor: string | null
  /** #8：live 代码行经 `.vsidian-code-line` 命中的属性值；无目标为 null */
  liveCodeLineDecorationColor: string | null
  /** #8：阅读视图内语义 strong 经 `.vsidian-view-reading strong` 命中的属性值 */
  readingStrongDecorationColor: string | null
  /** #9：live 任务 checkbox 经 `.vsidian-task-checkbox` 命中的属性值；无目标为 null */
  liveTaskCheckboxDecorationColor: string | null
  /** #9：阅读任务 checkbox 经 `.vsidian-reading-task-checkbox` 命中的属性值 */
  readingTaskCheckboxDecorationColor: string | null
  /** #10：live 链接 span 经 `.vsidian-link` 命中的属性值；无目标为 null */
  liveLinkDecorationColor: string | null
  /** #10：阅读链接经 `.vsidian-reading-block a` 命中的属性值；无目标为 null */
  readingLinkDecorationColor: string | null
  /** #10：阅读图片经 `.vsidian-reading-block img.vsidian-image` 命中的属性值 */
  readingImageDecorationColor: string | null
  /** #12：live 表格管道符经 `.vsidian-table-pipe` 命中的属性值；无目标为 null */
  liveTablePipeDecorationColor: string | null
  /** #12：阅读表格经 `.vsidian-reading-block table` 命中的属性值；无目标为 null */
  readingTableDecorationColor: string | null
  /** #11：live 双链经 `.vsidian-wikilink` 命中的属性值；无目标为 null */
  liveWikilinkDecorationColor: string | null
  /** #11：阅读双链经 `.vsidian-reading-block a.vsidian-wikilink` 命中的属性值 */
  readingWikilinkDecorationColor: string | null
}

/** live 侧语法装饰统计（#8：装饰集合计数，覆盖标题/行内/块级/任务/降级观测） */
export interface LiveSyntaxProbe {
  /** 标题行数（#5 类） */
  headingLines: number
  /** 标题内容 span 数 */
  headerSpans: number
  strongSpans: number
  emphasisSpans: number
  inlineCodeSpans: number
  quoteLines: number
  codeLines: number
  listLines: number
  hrLines: number
  frontmatterLines: number
  /** 任务字形数与其中勾选数 */
  taskGlyphs: number
  taskChecked: number
  /** #12：表格行装饰数（表头+分隔+数据行） */
  tableLines: number
  /** #12：单元格内容 mark 数 */
  tableCells: number
}

/** reading 侧渲染语义统计（#8：DOM 级计数，用于双视图一致性对拍） */
export interface ReadingSyntaxProbe {
  headings: number
  strongCount: number
  emphasisCount: number
  inlineCodeCount: number
  blockquoteBlocks: number
  codeBlocks: number
  hrCount: number
  listItems: number
  taskCheckboxes: number
  taskChecked: number
  /** #12：表格元素数（块级 table 标签；虚拟化下仅统计已挂载块） */
  tables: number
}

/** 查找会话观测（#14）：匹配集来自 webview 全文文本模型（屏外内容同样计数） */
export interface FindSessionProbe {
  /** 面板当前是否打开（关闭后仍回报 open:false） */
  open: boolean
  query: string
  /** 大小写语义：默认 true（区分） */
  caseSensitive: boolean
  /** 匹配总数（文本模型全量计算） */
  total: number
  /** 当前匹配序号（1 基；无匹配为 0） */
  index: number
  /** 当前匹配区间（UTF-16 offset；无匹配为 null） */
  currentFrom: number | null
  currentTo: number | null
}

/** 表格结构操作码校验（#13） */
function isTableEditOp(v: unknown): v is TableEditOp {
  return (
    v === 'insertRowAbove' ||
    v === 'insertRowBelow' ||
    v === 'deleteRow' ||
    v === 'insertColumnLeft' ||
    v === 'insertColumnRight' ||
    v === 'deleteColumn'
  )
}

function isFindSessionProbe(v: unknown): v is FindSessionProbe {
  return (
    isObject(v) &&
    typeof v.open === 'boolean' &&
    isString(v.query) &&
    typeof v.caseSensitive === 'boolean' &&
    isNonNegativeInt(v.total) &&
    isNonNegativeInt(v.index) &&
    (v.currentFrom === null || isNonNegativeInt(v.currentFrom)) &&
    (v.currentTo === null || isNonNegativeInt(v.currentTo))
  )
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

/** #15：可选 JS 堆读数字段——缺省（旧探针）或 null（环境不支持）均合法，非正整数拒绝 */
function isOptionalJsHeap(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
}

function isPerfSnapshot(v: unknown): v is PerfSnapshot {
  return (
    isObject(v) &&
    isNonNegativeInt(v.renderedLines) &&
    isNonNegativeInt(v.contentDomCount) &&
    isNonNegativeInt(v.headingLineCount) &&
    isNonNegativeInt(v.inviewHeadingCount) &&
    isOptionalJsHeap(v.jsHeapBytes)
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
    isNullOrString(v.readingVarProbe) &&
    isNullOrString(v.liveStrongDecorationColor) &&
    isNullOrString(v.liveInlineCodeDecorationColor) &&
    isNullOrString(v.liveCodeLineDecorationColor) &&
    isNullOrString(v.readingStrongDecorationColor) &&
    isNullOrString(v.liveTaskCheckboxDecorationColor) &&
    isNullOrString(v.readingTaskCheckboxDecorationColor) &&
    isNullOrString(v.liveLinkDecorationColor) &&
    isNullOrString(v.readingLinkDecorationColor) &&
    isNullOrString(v.readingImageDecorationColor) &&
    isNullOrString(v.liveTablePipeDecorationColor) &&
    isNullOrString(v.readingTableDecorationColor) &&
    isNullOrString(v.liveWikilinkDecorationColor) &&
    isNullOrString(v.readingWikilinkDecorationColor)
  )
}

function isImageStateCounts(v: unknown): v is ImageStateCounts {
  return (
    isObject(v) &&
    isNonNegativeInt(v.loading) &&
    isNonNegativeInt(v.loaded) &&
    isNonNegativeInt(v.error)
  )
}

function isLiveSyntaxProbe(v: unknown): v is LiveSyntaxProbe {
  return (
    isObject(v) &&
    isNonNegativeInt(v.headingLines) &&
    isNonNegativeInt(v.headerSpans) &&
    isNonNegativeInt(v.strongSpans) &&
    isNonNegativeInt(v.emphasisSpans) &&
    isNonNegativeInt(v.inlineCodeSpans) &&
    isNonNegativeInt(v.quoteLines) &&
    isNonNegativeInt(v.codeLines) &&
    isNonNegativeInt(v.listLines) &&
    isNonNegativeInt(v.hrLines) &&
    isNonNegativeInt(v.frontmatterLines) &&
    isNonNegativeInt(v.taskGlyphs) &&
    isNonNegativeInt(v.taskChecked) &&
    isNonNegativeInt(v.tableLines) &&
    isNonNegativeInt(v.tableCells)
  )
}

function isReadingSyntaxProbe(v: unknown): v is ReadingSyntaxProbe {
  return (
    isObject(v) &&
    isNonNegativeInt(v.headings) &&
    isNonNegativeInt(v.strongCount) &&
    isNonNegativeInt(v.emphasisCount) &&
    isNonNegativeInt(v.inlineCodeCount) &&
    isNonNegativeInt(v.blockquoteBlocks) &&
    isNonNegativeInt(v.codeBlocks) &&
    isNonNegativeInt(v.hrCount) &&
    isNonNegativeInt(v.listItems) &&
    isNonNegativeInt(v.taskCheckboxes) &&
    isNonNegativeInt(v.taskChecked) &&
    isNonNegativeInt(v.tables)
  )
}

function isReadingPerfSnapshot(v: unknown): v is ReadingPerfSnapshot {
  return (
    isObject(v) &&
    isNonNegativeInt(v.mountedBlocks) &&
    isNonNegativeInt(v.contentDomCount) &&
    isNonNegativeNumber(v.scrollTopPx) &&
    isNonNegativeNumber(v.scrollHeightPx) &&
    isOptionalJsHeap(v.jsHeapBytes)
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
        (v.cssProbe === undefined || isCssProbeReport(v.cssProbe)) &&
        (v.liveSyntax === undefined || isLiveSyntaxProbe(v.liveSyntax)) &&
        (v.readingSyntax === undefined || isReadingSyntaxProbe(v.readingSyntax)) &&
        (v.liveLinkCount === undefined || isNonNegativeInt(v.liveLinkCount)) &&
        (v.liveImageCount === undefined || isNonNegativeInt(v.liveImageCount)) &&
        (v.liveWikilinkCount === undefined || isNonNegativeInt(v.liveWikilinkCount)) &&
        (v.readingLinkCount === undefined || isNonNegativeInt(v.readingLinkCount)) &&
        (v.readingImageCount === undefined || isNonNegativeInt(v.readingImageCount)) &&
        (v.readingWikilinkCount === undefined || isNonNegativeInt(v.readingWikilinkCount)) &&
        (v.imageStates === undefined || isImageStateCounts(v.imageStates)) &&
        (v.find === undefined || isFindSessionProbe(v.find))
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
    case 'link.activate':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isString(v.href) &&
        isNonNegativeInt(v.srcStart) &&
        isNonNegativeInt(v.srcEnd)
      )
    case 'wikilink.activate':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isString(v.target) &&
        isNonNegativeInt(v.srcStart) &&
        isNonNegativeInt(v.srcEnd)
      )
    case 'image.request':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isPositiveInt(v.reqId) &&
        isString(v.src)
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
    case 'task.test.click':
      return (
        (v.view === 'live' || v.view === 'reading') &&
        isNonNegativeInt(v.index)
      )
    case 'image.result':
      if (!isPositiveInt(v.reqId)) {
        return false
      }
      if (v.ok === true) {
        return isString(v.src)
      }
      if (v.ok === false) {
        return (
          (v.reason === 'blocked' ||
            v.reason === 'outside-workspace' ||
            v.reason === 'not-found' ||
            v.reason === 'read-error') &&
          (v.detail === undefined || isString(v.detail))
        )
      }
      return false
    case 'view.find.open':
      return v.query === undefined || isString(v.query)
    case 'view.find.close':
      return true
    case 'view.find.step':
      return v.direction === 'next' || v.direction === 'prev'
    case 'table.command':
      return isTableEditOp(v.op)
    case 'table.test.key':
      return v.key === 'tab' || v.key === 'shift-tab'
    default:
      return false
  }
}
