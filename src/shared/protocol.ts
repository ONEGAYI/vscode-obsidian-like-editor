// 消息协议单一事实源：宿主（extension host）与 webview 两端共享的消息类型
// 与结构校验。两端不依赖 vscode / DOM，位置一律使用全文 UTF-16 code unit
// offset（与 TextDocument.contentChanges 的 rangeOffset/rangeLength 及
// CodeMirror 的文档定位同构）。
//
// 设计依据：探索笔记 02 §5（协议设计建议）、§6（陷阱清单）。

import type { SettingsPayload } from './settings'

/** 设置快照类型随协议消息透出（载荷单一事实源仍在 shared/settings） */
export type { SettingsPayload }

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
   *  模式是 webview 视图状态：不写 TextDocument、不入撤销栈。#38 起切换
   *  入口迁移宿主标题栏三态命令与命令面板命令（宿主推导显式目标后经
   *  此消息驱动）；'toggle' 保留兼容，新链路不再使用 */
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
  /** 在当前光标/选区建立两列两内容行的空表格，仍走 CM6 文本事务。 */
  | { kind: 'table.create' }
  /** 测试钩子（#13）：向真实编辑器派发 Tab/Shift+Tab keydown（与用户按键
   *  同一 keymap 链路；纯选区导航，零写回）。宿主测试无法向 webview 派发
   *  真实键盘事件，以此通道验证导航装配 */
  | { kind: 'table.test.key'; key: 'tab' | 'shift-tab' | 'select-all' | 'backspace' | 'delete' | 'enter' }
  /** 测试钩子（#42）：在真实 webview 网格单元格派发鼠标点击及当前位置输入。 */
  | { kind: 'table.test.cellClick'; rowIndex: number; columnIndex: number; point?: 'edge' | 'middle' | 'right-edge' }
  | { kind: 'table.test.crossSelect'; anchor: number; head: number }
  | { kind: 'table.test.type'; text: string }
  | { kind: 'table.test.domType'; text: string }
  /** 测试钩子（#43）：点击真实行/列抓手，验证选中态实际绘制。 */
  | { kind: 'table.test.select'; axis: 'row' | 'column'; index: number }
  /** 测试钩子（#43）：真实 webview DOM 的点阵抓手拖动事件。 */
  | { kind: 'table.test.drag'; sourceIndex: number; targetSlot: number }
  /** 测试钩子（#53）：点击主编辑区顶栏的侧栏切换按钮，驱动与用户点击同一
   *  处理器（纯视图状态翻转，零写回）。宿主测试无法向 webview 派发真实鼠标
   *  事件，以此通道验证真实宿主内的布局切换与绘制 */
  | { kind: 'sidebar.test.click' }
  /** 测试钩子（#54）：点击侧栏顶栏的大纲按钮，驱动与用户点击同一处理器
   *  （纯视图状态翻转，零写回）。与 sidebar.test.click 同通道形态 */
  | { kind: 'outline.test.click' }
  /** 测试钩子（#66）：点击第 index 个真实大纲条目，驱动与用户点击同一
   *  委托处理器（纯视图跳转：live 落光标居中 / reading 滚动到块，零写回） */
  | { kind: 'outline.test.itemClick'; index: number }
  /** 测试钩子（#21）：在真实 webview 的 CM6 中输入，验证暂停态即时留存。 */
  | { kind: 'sync.test.edit'; offset: number; text: string; closeAfter?: boolean }
  /** 测试钩子：组合候选写入首行 DOM，经过 CM6 MutationObserver 的真实输入链。 */
  | { kind: 'sync.test.composition'; phase: 'start' | 'update' | 'end'; text: string }
  /** 测试钩子：真实 webview DOM 的渲染链接 mousedown。 */
  | { kind: 'link.test.mousedown'; target: 'wikilink' | 'link'; index: number; ctrlKey?: boolean }
  /** 设置快照（#33）：当前生效设置的全量键值对。两个消费方向——设置页
   *  ready 后请求-响应回填（settings.get）；编辑器面板 init 后主动拉取。
   *  values 整体下发而非逐项布尔：#34 起新增设置项不需要改协议形态 */
  | { kind: 'settings.snapshot'; values: SettingsPayload }
  /** 设置变更通知（#33）：任一设置项保存成功后广播到全部已打开 Vsidian
   *  编辑器面板与设置页（含变更发起页面）。values 仍为全量快照；消费方按
   *  需读取关心的键（#34 场景：editor.lineNumbers 触发 CM6 扩展热重配） */
  | { kind: 'settings.changed'; values: SettingsPayload }

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
  | { kind: 'conflict.report'; sessionId: string; docUri: string; version: number; revision: number; text: string;
      /** 仅空白表格格 IME 暂缓：快照仍含未提交候选文本；结束时显式清除。 */
      compositionPending?: boolean }
  /** 空白格组合候选的 LF 增量：首笔 conflict.report 已提供全文基线。 */
  | { kind: 'composition.changed'; sessionId: string; docUri: string; revision: number; changes: SerChange[] }
  /** 测试钩子（#21）：编辑事务结束后立即关闭面板，检验快照与关闭竞争。 */
  | { kind: 'sync.test.close'; sessionId: string; docUri: string }
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
      /** 当前视图首个一级标题的实际字号（px；真实宿主样式回归观测） */
      headingFontPx?: number
      /** 当前视图模式（#6；缺省 live，向后兼容） */
      viewMode?: 'live' | 'reading'
      /** live 光标主位置（UTF-16 offset；#6 锚点恢复观测） */
      selectionOffset?: number
      selectionHead?: number
      selectionAssoc?: number
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
      /** #42：网格 DOM 与活动格、#43 抓手的真实宿主观测 */
      tableGrid?: { visibleRows: number; selectedRowIsGrid: boolean; selectedRowCells: string[]; rowHandles: number }
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
      /** 当前生效设置快照（#33 起缓存宿主下发的值；#34 行号等设置的观测面） */
      settings?: SettingsPayload
      /** #34 行号栏观测（设置开关态与视口内渲染结果；旧 webview 缺省） */
      lineGutter?: LineGutterProbe
      /** #32 排版一致性探针（两模式基础排版对照采样；旧 webview 缺省） */
      typography?: TypographyProbe
      /** 绘制层探针（P0 回归）：正文可见性与 CM6 注入样式存活观测 */
      paint?: PaintProbe
      /** 右侧栏观测（#53；布局态与绘制层证据，旧 webview 缺省） */
      sidebar?: SidebarProbe
      /** 大纲观测（#54；面板态、绘制层证据与标题序列，旧 webview 缺省） */
      outline?: OutlineProbe
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
  /** 打开 Vsidian 设置页（#33）：编辑器工具栏「设置」按钮 → 宿主
   *  createWebviewPanel。无 sessionId/docUri——打开设置页不依赖任何文档
   *  会话（无文档打开时同样可用） */
  | { kind: 'settings.open' }
  /** 请求设置快照（#33）：设置页 ready 后与编辑器面板 init 后拉取当前值，
   *  宿主以 settings.snapshot 响应（webview 不持久化设置，权威在宿主） */
  | { kind: 'settings.get' }
  /** 保存设置（#33）：设置页上送变更键值对（批，原子生效）。宿主按定义
   *  校验：通过才持久化并广播 settings.changed；拒绝时向来源设置页回
   *  settings.snapshot 以权威值恢复显示 */
  | { kind: 'settings.set'; values: SettingsPayload }
  /** 性能探针回报（#5）：快照为 DOM 计数，输入延迟含 rAF 稳定等待 */
  | {
      kind: 'perf.report'
      typingRounds: number
      scrollRounds: number
      docLines: number
      /** 首次探针输入 dispatch 且完成两个 rAF 后的 wall clock 时间 */
      firstInputSettledEpochMs: number
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

/** #34 行号栏观测（view.state 扩展字段）：开关生效态与视口内渲染结果。
 *  口径注意：采集不判 viewMode——reading 态 liveWrapper 仅 display:none
 *  而 DOM 仍在，count/first/last 仍统计隐藏的 live gutter（与 TypographyProbe
 *  对隐藏侧的显式声明同理），不得据此断言"reading 态行号在渲染"。 */
export interface LineGutterProbe {
  /** 设置开关生效态（快照缺键时为定义默认 true） */
  on: boolean
  /** `.cm-lineNumbers .cm-gutterElement` 数（CM6 原生视口有界，远小于全文行数） */
  count: number
  /** 首个行号单元格文本（源行编号起点观测；栏未装配为 null） */
  first: string | null
  /** 末个行号单元格文本（视口尾行号观测；栏未装配为 null） */
  last: string | null
}

/**
 * 绘制层探针（view.state 扩展字段）：守护"正文真的可见"这一用户级事实。
 * 由来（P0）：CSP `style-src` 未放行内联样式时，CM6（style-mod）注入的
 * baseTheme 样式表被浏览器拒绝（el.sheet 为 null），.cm-scroller 退化
 * block——无行号时与 flex 视觉等价从未暴露，行号栏加入后 gutter 与正文
 * 上下堆叠、正文被推出视口。既有用例只断言 DOM 数量与几何 x 坐标，均
 * 存活于该缺陷之上，故补此探针断言绘制层。
 * jsdom 无布局能力（rect 恒 0），textVisible 恒 false，不作单测断言依据。
 */
export interface PaintProbe {
  /** 首个含文本行：首字符 rect 在视口内且 elementFromPoint 命中内容区。
   *  覆盖物（冲突暂停横幅、查找面板等绝对定位元素）遮挡首 8 行文本时同样
   *  返回 false——失败排障时先排除覆盖物再怀疑 CSP 样式失效 */
  textVisible: boolean
  /** `.cm-scroller` computed display：CM6 baseTheme 存活时为 'flex' */
  scrollerDisplay: string | null
  /** 行号栏 computed user-select（'none' = 禁选；栏未装配为 null） */
  gutterUserSelect: string | null
  /** 真宿主中通过文字可见性、面积与命中检查的行号文本。 */
  visibleLineNumbers?: string[]
  /** CM6 明暗声明当前激活态（EditorView.darkTheme facet 实值）。随宿主
   *  body 主题 class 动态跟随；激活后 baseTheme 内建变体接管 caret 等
   *  颜色——本扩展不硬编码光标色（深色主题黑底黑光标回归的观测位） */
  darkTheme: boolean
  /** `.cm-content` computed caret-color（'rgb(...)' 文本）。未启用
   *  drawSelection 时 CM6 光标即原生 caret，颜色由 baseTheme 明暗变体
   *  决定（light=black / dark=white）；jsdom 无 CSS 引擎为 null */
  caretColor: string | null
  /** #42/#43 表格绘制：真宿主文本命中与计算样式；无表格/未选中为 null。 */
  table?: {
    cellVisible: boolean
    /** 真宿主光标（零宽格使用格内绘制指示）的命中列；无可见光标时为 null。 */
    caretGridColumn?: number | null
    delimiterDisplay?: string | null
    headerCellBackgrounds?: string[]
    caretDomColumn?: number | null
    caretNativeRectHeight?: number | null
    cellBreakDisplay?: string | null
    gridDisplay: string | null
    cellBorderWidth: string | null
    rowOutlineColor: string | null
    rowOutlineWidth: string | null
    rowBackgroundColor: string | null
    columnBorderColor: string | null
    columnBorderWidth: string | null
    columnRightBorderWidth: string | null
    columnTopBorderWidth: string | null
    columnBottomBorderWidth: string | null
    columnBackgroundColor: string | null
  }
  /** #55 标题行绘制观测：视口内已挂载的 .vsidian-heading-inview 行的
   *  distinct 计算值（box-shadow 应为 'none'、border-left-width 应为
   *  '0px'——标题行不得绘制左缘竖线）；无挂载标题行为 null。
   *  jsdom 无 CSS 引擎，值不可作单测断言依据（同 textVisible 口径） */
  heading?: {
    inviewCount: number
    boxShadowValues: string[]
    borderLeftWidthValues: string[]
  } | null
}

/** #32 排版一致性探针：正文基础排版四项样本（null = 元素缺失/不可读） */
export interface TypographySample {
  /** computed font-family（浏览器归一化串） */
  fontFamily: string | null
  fontSizePx: number | null
  /** computed line-height 换算 px；'normal'（未解析为长度）为 null */
  lineHeightPx: number | null
  /** 正文文本左缘相对滚动容器左缘（几何口径，含中间层 padding/border；
   *  display:none 侧 rect 全 0，不可作断言依据——各模式态取各自激活侧） */
  textInsetPx: number | null
}

/** #32 排版一致性探针：继承型元素样本（列表/引用/表格——行高与缩进属
 *  各自语义，只对照字体族与字号） */
export interface TypographyInheritSample {
  fontFamily: string | null
  fontSizePx: number | null
}

/** #32 排版一致性探针（view.state 可选字段）：两模式基础排版对照采样。
 *  各侧样本只在对应模式激活态断言（隐藏侧几何口径 textInsetPx 无意义）。 */
export interface TypographyProbe {
  /** live 正文：.cm-content（scroller 基线字体作用面，视口常驻） */
  live: TypographySample | null
  /** reading 正文：首个阅读块内段落（虚拟化下须已挂载） */
  reading: TypographySample | null
  liveList: TypographyInheritSample | null
  readingList: TypographyInheritSample | null
  liveQuote: TypographyInheritSample | null
  readingQuote: TypographyInheritSample | null
  liveTable: TypographyInheritSample | null
  readingTable: TypographyInheritSample | null
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

/**
 * 右侧栏观测（#53）：布局态与绘制层证据。命中类字段（*Painted）走
 * elementFromPoint——侧栏/按钮只有真实绘制（非 display:none、非零尺寸、
 * 无覆盖遮挡）时才可能命中，几何或存在性探针测不出样式失效；线宽字段
 * 是 computed stroke-width 文本（图标两态粗细差异的唯一来源是样式表的
 * vsidian-sidebar-open 类规则）。jsdom 无布局与 CSS 引擎：命中恒 false、
 * 线宽/宽度容错为 null，真宿主断言见集成。
 */
export interface SidebarProbe {
  /** 侧栏展开态（状态机实值） */
  open: boolean
  /** 侧栏顶栏中心点 elementFromPoint 命中侧栏容器（展开态的绘制证据） */
  sidebarToolbarPainted: boolean
  /** 侧栏切换按钮中心点命中按钮自身（按钮真实可见且可点） */
  togglePainted: boolean
  /** 齿轮设置按钮中心点命中自身（图标化入口真实可见） */
  settingsPainted: boolean
  /** 切换图标竖线 computed stroke-width（收起细线 1.5px / 展开粗线 3px） */
  toggleBarStrokeWidth: string | null
  /** 切换图标外框 computed stroke-width（两态恒定对照） */
  toggleFrameStrokeWidth: string | null
  /** 主编辑区内容宽度 px（收起=全宽；展开=随侧栏收缩）；无布局为 null */
  mainWidthPx: number | null
  /** 侧栏宽度 px（收起时元素不占位为 0）；无布局为 null */
  sidebarWidthPx: number | null
  /** 切换按钮可访问名称（状态一致性观测：随收起/展开变化） */
  toggleAriaLabel: string | null
  /** 齿轮设置按钮可访问名称 */
  settingsAriaLabel: string | null
}

/**
 * 大纲观测（#54）：面板态与绘制层证据。命中类字段（*Painted）走
 * elementFromPoint——面板只有真实绘制（侧栏展开 + 面板 active + 样式表
 * 显隐规则生效）时才可能命中，样式失效（如 CSP 拦截注入）时 DOM 存在但
 * 命中失败。items 是全文标题序列（数据源 = CM6 全文解析，含未保存编辑；
 * 与视口渲染和 live/reading 模式无关）。jsdom 无布局与 CSS 引擎：命中恒
 * false，名称容错为 null（probe 未装配时字段缺省），真宿主断言见集成。
 */
export interface OutlineProbe {
  /** 大纲面板 active 态（状态机实值；侧栏收起时面板同样不可见） */
  active: boolean
  /** 大纲按钮中心点 elementFromPoint 命中自身（侧栏展开 + 按钮真实绘制） */
  togglePainted: boolean
  /** 大纲面板容器中心点命中面板内（面板内容真实绘制，非 display:none） */
  panelPainted: boolean
  /** 大纲按钮图标 computed 宽度 px（预期 16px：选择器写错或样式失效时
   *  SVG 回退默认尺寸溢出按钮盒，可测出死选择器回归） */
  toggleIconSizePx: number | null
  /** 大纲面板 scrollHeight px（内容总高；无布局环境为 0 或 null） */
  panelScrollHeightPx: number | null
  /** 大纲面板 clientHeight px（可视高；scrollHeight > clientHeight 即
   *  面板高度被宿主约束且内容溢出——overflow-y:auto 由此激活滚动） */
  panelClientHeightPx: number | null
  /** 全文标题序列（级别 1–6 / 文字 / 起始行 1 基） */
  items: Array<{ level: number; text: string; line: number }>
  /** 大纲按钮可访问名称 */
  toggleAriaLabel: string | null
  /** 大纲面板可访问名称（role=region + aria-label） */
  panelAriaLabel: string | null
  /** #66 当前控制域条目索引（items 下标；null = 无标题、首标题之前或
   *  无布局环境）。以视口顶部行向上最近标题为准（locateOutlineIndex） */
  locatedItemIndex: number | null
  /** located 条目的文字（locatedItemIndex 的冗余可读形态；null 同上） */
  locatedText: string | null
  /** 高亮横条绘制证据（#66）：located 条目中心点 elementFromPoint 命中
   *  自身且 computed background-color 非全透明（半透明横条真实绘制；
   *  条目在面板可视区外或 jsdom 无布局时为 false） */
  locatedPainted: boolean
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

function isTableGridProbe(v: unknown): boolean {
  return isObject(v) && isNonNegativeInt(v.visibleRows) &&
    typeof v.selectedRowIsGrid === 'boolean' &&
    Array.isArray(v.selectedRowCells) && v.selectedRowCells.every(isString) &&
    isNonNegativeInt(v.rowHandles)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** #33 设置载荷校验：键 → 标量值（boolean/number/string）。协议层只约束
 *  形态（键值对可序列化）；键是否已定义、值是否符合类型语义由
 *  shared/settings 的定义校验判定——两层职责分离 */
function isSettingsPayload(v: unknown): v is SettingsPayload {
  if (!isObject(v)) {
    return false
  }
  for (const key of Object.keys(v)) {
    const value = v[key]
    if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') {
      return false
    }
  }
  return true
}

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

/** #34 行号栏观测校验：on 布尔、count 非负整数、first/last 字符串或 null */
function isLineGutterProbe(v: unknown): v is LineGutterProbe {
  return (
    isObject(v) &&
    typeof v.on === 'boolean' &&
    isNonNegativeInt(v.count) &&
    (v.first === null || isString(v.first)) &&
    (v.last === null || isString(v.last))
  )
}

/** #53 右侧栏观测校验：open/命中布尔、线宽与名称字符串或 null、宽度非负数或 null */
function isSidebarProbe(v: unknown): v is SidebarProbe {
  return (
    isObject(v) &&
    typeof v.open === 'boolean' &&
    typeof v.sidebarToolbarPainted === 'boolean' &&
    typeof v.togglePainted === 'boolean' &&
    typeof v.settingsPainted === 'boolean' &&
    isNullOrString(v.toggleBarStrokeWidth) &&
    isNullOrString(v.toggleFrameStrokeWidth) &&
    (v.mainWidthPx === null || isNonNegativeNumber(v.mainWidthPx)) &&
    (v.sidebarWidthPx === null || isNonNegativeNumber(v.sidebarWidthPx)) &&
    isNullOrString(v.toggleAriaLabel) &&
    isNullOrString(v.settingsAriaLabel)
  )
}

/** #54 大纲条目序列校验：level 1–6 整数、text 字符串（可为空）、line 正整数 */
function isOutlineItems(v: unknown): v is OutlineProbe['items'] {
  return (
    Array.isArray(v) &&
    v.every(
      (item) =>
        isObject(item) &&
        typeof item.level === 'number' && Number.isInteger(item.level) &&
        item.level >= 1 && item.level <= 6 &&
        isString(item.text) &&
        typeof item.line === 'number' && Number.isInteger(item.line) && item.line >= 1,
    )
  )
}

/** #54 大纲观测校验：active/命中布尔、图标尺寸与滚动几何（null 或非负数）、
 *  items 序列、名称字符串或 null；#66 located 索引（null 或非负整数）、
 *  文字（字符串或 null）、绘制命中布尔 */
function isOutlineProbe(v: unknown): v is OutlineProbe {
  return (
    isObject(v) &&
    typeof v.active === 'boolean' &&
    typeof v.togglePainted === 'boolean' &&
    typeof v.panelPainted === 'boolean' &&
    (v.toggleIconSizePx === null || isNonNegativeNumber(v.toggleIconSizePx)) &&
    (v.panelScrollHeightPx === null || isNonNegativeNumber(v.panelScrollHeightPx)) &&
    (v.panelClientHeightPx === null || isNonNegativeNumber(v.panelClientHeightPx)) &&
    isOutlineItems(v.items) &&
    isNullOrString(v.toggleAriaLabel) &&
    isNullOrString(v.panelAriaLabel) &&
    (v.locatedItemIndex === null || isNonNegativeInt(v.locatedItemIndex)) &&
    isNullOrString(v.locatedText) &&
    typeof v.locatedPainted === 'boolean'
  )
}

/** 绘制层探针校验：textVisible/darkTheme 布尔；display/userSelect/caretColor 字符串或 null */
function isPaintProbe(v: unknown): v is PaintProbe {
  return (
    isObject(v) &&
    typeof v.textVisible === 'boolean' &&
    isNullOrString(v.scrollerDisplay) &&
    isNullOrString(v.gutterUserSelect) &&
    (v.visibleLineNumbers === undefined || (Array.isArray(v.visibleLineNumbers) &&
      v.visibleLineNumbers.every((number) => typeof number === 'string'))) &&
    typeof v.darkTheme === 'boolean' &&
    isNullOrString(v.caretColor) &&
    (v.table === undefined || (
      isObject(v.table) &&
      typeof v.table.cellVisible === 'boolean' &&
      (v.table.caretGridColumn === undefined || v.table.caretGridColumn === null ||
        isNonNegativeInt(v.table.caretGridColumn)) &&
      isNullOrString(v.table.gridDisplay) &&
      (v.table.delimiterDisplay === undefined || isNullOrString(v.table.delimiterDisplay)) &&
      (v.table.headerCellBackgrounds === undefined || (Array.isArray(v.table.headerCellBackgrounds) &&
        v.table.headerCellBackgrounds.every(isString))) &&
      (v.table.caretDomColumn === undefined || v.table.caretDomColumn === null || isNonNegativeInt(v.table.caretDomColumn)) &&
      (v.table.caretNativeRectHeight === undefined || v.table.caretNativeRectHeight === null || isNonNegativeNumber(v.table.caretNativeRectHeight)) &&
      (v.table.cellBreakDisplay === undefined || v.table.cellBreakDisplay === null || isString(v.table.cellBreakDisplay)) &&
      isNullOrString(v.table.cellBorderWidth) &&
      isNullOrString(v.table.rowOutlineColor) &&
      isNullOrString(v.table.rowOutlineWidth) &&
      isNullOrString(v.table.rowBackgroundColor) &&
      isNullOrString(v.table.columnBorderColor) &&
      isNullOrString(v.table.columnBorderWidth) &&
      isNullOrString(v.table.columnRightBorderWidth) &&
      isNullOrString(v.table.columnTopBorderWidth) &&
      isNullOrString(v.table.columnBottomBorderWidth) &&
      isNullOrString(v.table.columnBackgroundColor)
    )) &&
    (v.heading === undefined || v.heading === null || (
      isObject(v.heading) &&
      isNonNegativeInt(v.heading.inviewCount) &&
      Array.isArray(v.heading.boxShadowValues) && v.heading.boxShadowValues.every(isString) &&
      Array.isArray(v.heading.borderLeftWidthValues) && v.heading.borderLeftWidthValues.every(isString)
    ))
  )
}

/** #32 排版样本校验：字体族字符串或 null、字号/行高/几何 inset 非负数或 null */
function isTypographySample(v: unknown): v is TypographySample {
  return (
    isObject(v) &&
    isNullOrString(v.fontFamily) &&
    (v.fontSizePx === null || isNonNegativeNumber(v.fontSizePx)) &&
    (v.lineHeightPx === null || isNonNegativeNumber(v.lineHeightPx)) &&
    (v.textInsetPx === null || isNonNegativeNumber(v.textInsetPx))
  )
}

function isTypographyInheritSample(v: unknown): v is TypographyInheritSample {
  return (
    isObject(v) &&
    isNullOrString(v.fontFamily) &&
    (v.fontSizePx === null || isNonNegativeNumber(v.fontSizePx))
  )
}

/** #32 排版一致性探针校验：八个采样位各为 null（元素缺失/不可读）或合法样本 */
function isTypographyProbe(v: unknown): v is TypographyProbe {
  return (
    isObject(v) &&
    (v.live === null || isTypographySample(v.live)) &&
    (v.reading === null || isTypographySample(v.reading)) &&
    (v.liveList === null || isTypographyInheritSample(v.liveList)) &&
    (v.readingList === null || isTypographyInheritSample(v.readingList)) &&
    (v.liveQuote === null || isTypographyInheritSample(v.liveQuote)) &&
    (v.readingQuote === null || isTypographyInheritSample(v.readingQuote)) &&
    (v.liveTable === null || isTypographyInheritSample(v.liveTable)) &&
    (v.readingTable === null || isTypographyInheritSample(v.readingTable))
  )
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
        isPositiveInt(v.revision) &&
        isString(v.text) &&
        (v.compositionPending === undefined || typeof v.compositionPending === 'boolean')
      )
    case 'composition.changed':
      return isString(v.sessionId) && isString(v.docUri) &&
        isPositiveInt(v.revision) && isSerChangeArray(v.changes)
    case 'sync.test.close':
      return isString(v.sessionId) && isString(v.docUri)
    case 'settings.open':
      return true
    case 'settings.get':
      return true
    case 'settings.set':
      return isSettingsPayload(v.values)
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
        (v.headingFontPx === undefined || isNonNegativeNumber(v.headingFontPx)) &&
        (v.viewMode === undefined || v.viewMode === 'live' || v.viewMode === 'reading') &&
        (v.selectionOffset === undefined || isNonNegativeInt(v.selectionOffset)) &&
        (v.selectionHead === undefined || isNonNegativeInt(v.selectionHead)) &&
        (v.selectionAssoc === undefined || (typeof v.selectionAssoc === 'number' &&
          Number.isInteger(v.selectionAssoc) && v.selectionAssoc >= -1 && v.selectionAssoc <= 1)) &&
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
        (v.tableGrid === undefined || isTableGridProbe(v.tableGrid)) &&
        (v.readingSyntax === undefined || isReadingSyntaxProbe(v.readingSyntax)) &&
        (v.liveLinkCount === undefined || isNonNegativeInt(v.liveLinkCount)) &&
        (v.liveImageCount === undefined || isNonNegativeInt(v.liveImageCount)) &&
        (v.liveWikilinkCount === undefined || isNonNegativeInt(v.liveWikilinkCount)) &&
        (v.readingLinkCount === undefined || isNonNegativeInt(v.readingLinkCount)) &&
        (v.readingImageCount === undefined || isNonNegativeInt(v.readingImageCount)) &&
        (v.readingWikilinkCount === undefined || isNonNegativeInt(v.readingWikilinkCount)) &&
        (v.imageStates === undefined || isImageStateCounts(v.imageStates)) &&
        (v.find === undefined || isFindSessionProbe(v.find)) &&
        (v.settings === undefined || isSettingsPayload(v.settings)) &&
        (v.lineGutter === undefined || isLineGutterProbe(v.lineGutter)) &&
        (v.paint === undefined || isPaintProbe(v.paint)) &&
        (v.sidebar === undefined || isSidebarProbe(v.sidebar)) &&
        (v.outline === undefined || isOutlineProbe(v.outline)) &&
        (v.typography === undefined || isTypographyProbe(v.typography))
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
        isPositiveInt(v.firstInputSettledEpochMs) &&
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
    case 'table.create':
      return true
    case 'table.test.key':
      return v.key === 'tab' || v.key === 'shift-tab' || v.key === 'select-all' || v.key === 'enter' ||
        v.key === 'backspace' || v.key === 'delete'
    case 'table.test.cellClick':
      return isNonNegativeInt(v.rowIndex) && isNonNegativeInt(v.columnIndex) &&
        (v.point === undefined || v.point === 'edge' || v.point === 'middle' || v.point === 'right-edge')
    case 'table.test.crossSelect':
      return isNonNegativeInt(v.anchor) && isNonNegativeInt(v.head)
    case 'table.test.type':
    case 'table.test.domType':
      return isString(v.text)
    case 'table.test.select':
      return (v.axis === 'row' || v.axis === 'column') && isNonNegativeInt(v.index)
    case 'table.test.drag':
      return isNonNegativeInt(v.sourceIndex) && isNonNegativeInt(v.targetSlot)
    case 'sidebar.test.click':
      return true
    case 'outline.test.click':
      return true
    case 'outline.test.itemClick':
      return isNonNegativeInt(v.index)
    case 'sync.test.edit':
      return isNonNegativeInt(v.offset) && isString(v.text) &&
        (v.closeAfter === undefined || typeof v.closeAfter === 'boolean')
    case 'sync.test.composition':
      return (v.phase === 'start' || v.phase === 'update' || v.phase === 'end') && isString(v.text)
    case 'link.test.mousedown':
      return (v.target === 'wikilink' || v.target === 'link') && isNonNegativeInt(v.index) &&
        (v.ctrlKey === undefined || typeof v.ctrlKey === 'boolean')
    case 'settings.snapshot':
      return isSettingsPayload(v.values)
    case 'settings.changed':
      return isSettingsPayload(v.values)
    default:
      return false
  }
}
