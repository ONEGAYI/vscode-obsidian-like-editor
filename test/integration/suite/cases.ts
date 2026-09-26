// 集成测试用例：验证工单 #2 的验收标准（激活/打开/编辑/保存/CRLF/视口）。
// fixture 工作区由 runTest.mjs 在临时目录动态生成（避免 git 换行转换干扰
// 字节级断言），路径经环境变量 WORKSPACE_DIR 传入。
import * as vscode from 'vscode'
import { LOCALE_MESSAGES, resolveLocale } from '../../../src/shared/locales'

/** #94 起编辑器 webview 文案随生效语言取词（auto 按宿主显示语言解析）——
 *  期望值与扩展装配同源计算，不再复制字面量 */
const editorMessages = () => LOCALE_MESSAGES[resolveLocale(undefined, vscode.env.language)]

const VIEW_TYPE = 'onegayi.vsidian.editor'
const EXT_ID = 'onegayi.vsidian'
const CMD = {
  sessionState: 'onegayi.vsidian._test.getSessionState',
  injectMessage: 'onegayi.vsidian._test.injectWebviewMessage',
  postToPanel: 'onegayi.vsidian._test.postToPanel',
  viewState: 'onegayi.vsidian._test.requestViewState',
  conflictState: 'onegayi.vsidian._test.getConflictState',
  closedInput: 'onegayi.vsidian._test.getLastClosedInput',
  viewStateCache: 'onegayi.vsidian._test.getPanelViewStateCache',
  resumePanel: 'onegayi.vsidian._test.resumePanel',
  perfProbe: 'onegayi.vsidian._test.perfProbe',
  readingPerf: 'onegayi.vsidian._test.readingPerf',
  linkLog: 'onegayi.vsidian._test.getLinkLog',
  // #38 三态记忆
  getLastMode: 'onegayi.vsidian._test.getLastMode',
  resetLastMode: 'onegayi.vsidian._test.resetLastMode',
  // #33 设置链路
  settingsPageInfo: 'onegayi.vsidian._test.settingsPageInfo',
  closeSettingsPage: 'onegayi.vsidian._test.closeSettingsPage',
  installSettingsFixture: 'onegayi.vsidian._test.installSettingsFixture',
  getSettings: 'onegayi.vsidian._test.getSettings',
  setSettings: 'onegayi.vsidian._test.setSettings',
  injectSettingsPageMessage: 'onegayi.vsidian._test.injectSettingsPageMessage',
}

const wsDir = process.env['WORKSPACE_DIR'] ?? ''
if (!wsDir) {
  throw new Error('环境变量 WORKSPACE_DIR 未设置（应由 runTest.mjs 注入）')
}

const LINKS_DOC_TEXT = [
  '# 链接样例',
  '',
  '[外部链接](https://example.com/obsidian-like) 与 [本地目标](./链接目标.md)。',
  '',
  '[空格目录目标](./子%20目录/目标%20二.md) 与自动链接 <https://autolink.example.com/x>。',
  '',
  '[无扩展名目标](./无扩展名目标)（省略扩展名按 Markdown 处理）。',
  '',
  '危险：[file](file:///d:/x.md) 与 [js](javascript:alert(1))。',
  '',
  '![好图](assets/图片%20一.png)',
  '',
].join('\n')
const IMAGES_DOC_TEXT = [
  '# 图片样例',
  '',
  '正常图片（中文与空格文件名）：',
  '',
  '![好图](assets/图片%20一.png)',
  '',
  '缺失图片（可重试错误态）：',
  '',
  '![缺失图](assets/不存在.png)',
  '',
  '结尾段。',
  '',
].join('\n')

const LF_DOC = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n- 列表项一\n- 列表项二\n'
const CRLF_DOC = '标题一\r\n正文 A 行\r\n正文 B 行\r\n'
// 在 '- 列表项一' 行首插入 '插入的新段落\n' 后的期望全文
const LF_DOC_AFTER_EDIT = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n插入的新段落\n- 列表项一\n- 列表项二\n'
// #6 模式切换 fixture（与 runTest.mjs 的 MODE_DOC 一致）
const MODE_DOC_TEXT = [
  '# 模式切换标题一',
  '',
  '第一段普通文本，包含中文与 emoji 🎉。',
  '',
  '## 中部二级标题',
  '',
  '- 普通列表项',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '```code',
  '代码块内容（含 # 伪标题 与 - [ ] 伪任务）',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')

function wsUri(name: string): vscode.Uri {
  return vscode.Uri.file(`${wsDir}/${name}`)
}

// #12 表格 fixture 内容（与 runTest.mjs 的 TABLE_DOC 字节一致）
const TABLE_DOC_TEXT = [
  '# 表格样例',
  '',
  '| 名字 | 数量 | 备注 |',
  '| --- | :---: | ---: |',
  '| 苹果 | 3 | 甲 |',
  '| `x|y` | 4 | 乙\\|丙 |',
  '',
  '结尾段落。',
  '',
].join('\n')

// #13 表格导航/结构操作 fixture（与 runTest.mjs 的 TABLE13_DOC 字节一致）：
// 表格前后有普通段落（区域不变断言），含对齐、行内代码管道
const TABLE13_DOC_TEXT = [
  '前导段落甲。',
  '',
  '| 名字 | 数量 |',
  '| --- | :---: |',
  '| 苹果 | 3 |',
  '| `x|y` | 4 |',
  '',
  '结尾段落乙。',
  '',
].join('\n')

async function poll<T>(
  label: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20000,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined) {
      return value
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(`断言失败：${message}`)
  }
}

async function openWithEditor(file: string, beside = false): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', wsUri(file), VIEW_TYPE, beside
    ? vscode.ViewColumn.Beside
    : undefined)
}

async function readDisk(file: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(wsUri(file))
  return Buffer.from(bytes).toString('utf8')
}

/** #38 全局模式记忆读取（容错语义同正式链路：无历史为 live） */
async function getLastMode(): Promise<string> {
  return (await vscode.commands.executeCommand(CMD.getLastMode)) as string
}

/** #38 全局模式记忆重置（模拟无历史）：globalState 在同一集成进程内共享，
 *  runner 已在每用例前重置，用例内再 reset 用于显式声明无记忆基线 */
async function resetLastMode(): Promise<void> {
  await vscode.commands.executeCommand(CMD.resetLastMode)
}

/** #38 记忆断言的读回等待：1.86.2 globalState 的 storage 广播滞后会把刚
 *  写入的值偶发回翻为旧值（环境特性，resetLastMode 注释与既有用例注记录
 *  过同类现象；三态循环用例连续三次写记忆后断言，实测偶发读到滞后值且
 *  回翻可持续数秒），经轮询读到期望值即通过 */
async function waitLastMode(expected: string): Promise<void> {
  await poll(`全局记忆为 ${expected}`, async () =>
    (await getLastMode()) === expected ? true : undefined, 10000)
}

/** #38 合并 main 后新增：设置写入的读回确认。1.86.2 globalState 存在
 *  跨键 storage 广播迟到回翻（同层键共享事件流）——#38 的模式记忆写入
 *  （toggle/切换链）与设置写入（setSettings）紧邻时，恢复值可被旧值迟到
 *  广播盖回（集成实测：#32 排版用例关行号采样后恢复 true 被回翻为 false，
 *  后续行号用例全暗）。写入后轮询读回到期望值再放行（与 resetLastMode 的
 *  稳定窗同款防护，作用于设置键） */
async function waitSettings(expected: Record<string, unknown>): Promise<void> {
  const stable = async (): Promise<boolean> => {
    for (let i = 0; i < 2; i++) {
      const snap = (await vscode.commands.executeCommand(CMD.getSettings)) as Record<string, unknown>
      if (Object.entries(expected).some(([k, v]) => snap[k] !== v)) {
        return false
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return true
  }
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await stable()) {
      return
    }
    await vscode.commands.executeCommand(CMD.setSettings, expected)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`等待超时：设置未稳定为 ${JSON.stringify(expected)}`)
}

/** 等待活动文本编辑器变为指定文档（#38：source 态切换的落位断言） */
async function waitActiveTextEditor(file: string): Promise<vscode.TextEditor> {
  const uri = wsUri(file).toString()
  return poll(`活动编辑器为 ${file}`, () => {
    const ed = vscode.window.activeTextEditor
    return ed && ed.document.uri.toString() === uri ? ed : undefined
  })
}

/** 等待活动 tab 变为指定文档的本扩展 custom editor（#38） */
async function waitActiveCustomTab(file: string): Promise<void> {
  const uri = wsUri(file).toString()
  await poll(`活动 tab 为 Vsidian 面板 ${file}`, () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab
    return tab?.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === VIEW_TYPE &&
      tab.input.uri.toString() === uri ? true : undefined
  })
}

/** 打开两个 .md 的原生文本 diff 并等待活动 tab 就位（#38 D10） */
async function openTextDiff(left: string, right: string, title: string): Promise<void> {
  // override 只认布尔 true（1.86 扩展主机 converter 限制，见 diff 陷阱笔记）：
  // 强制文本 diff，避免 default priority 把某一侧解析到 custom editor
  await vscode.commands.executeCommand('vscode.diff', wsUri(left), wsUri(right), title, {
    override: true,
  })
  await poll(`文本 diff 打开 ${title}`, () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab
    return tab?.input instanceof vscode.TabInputTextDiff ? true : undefined
  })
}

/** #38 单标签修复断言：统计指定文档在全部 tabGroups 的标签数。
 *  kind=native 数 TabInputText（原生源码态），kind=vsidian 数本扩展
 *  TabInputCustom——三态切换任何方向完成后，同文档只应剩一种各一个。
 *  比较与产品侧 isSameDocUri 同口径（win32 盘符大小写漂移实测存在）：
 *  严格 toString 会漏计漂移 uri，把清理失效误判为通过 */
function tabsOf(file: string, kind: 'native' | 'vsidian'): number {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  const norm = (u: string): string => (caseInsensitive ? u.toLowerCase() : u)
  const uri = norm(wsUri(file).toString())
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => {
      const input = t.input
      return kind === 'native'
        ? input instanceof vscode.TabInputText && norm(input.uri.toString()) === uri
        : input instanceof vscode.TabInputCustom &&
            input.viewType === VIEW_TYPE &&
            norm(input.uri.toString()) === uri
    }).length
}

interface SessionState {
  found: boolean
  panels: Array<{ sessionId: string; ready: boolean }>
  version: number
  appliedEdits: number
}

interface ViewState {
  text: string
  docLength: number
  lineCount: number
  renderedLines: number
  suspended?: boolean
  contentDomCount?: number
  headingLineCount?: number
  headingActiveText?: string
  headingHiddenText?: string
  headingFontPx?: number
  /** #6 模式切换观测 */
  viewMode?: 'live' | 'reading'
  selectionOffset?: number
  selectionHead?: number
  selectionAssoc?: number
  wordSegmenter?: boolean
  readingBlockCount?: number
  readingAnchorStart?: number
  /** #7 按需挂载观测 */
  readingTotalBlocks?: number
  readingMountedBlocks?: number
  readingContentDomCount?: number
  readingParseCount?: number
  readingVirtualized?: boolean
  readingAnchorTopPx?: number
  readingScrollTopPx?: number
  readingScrollHeightPx?: number
  cssProbe?: {
    liveHeadingDecorationColor: string | null
    readingHeadingDecorationColor: string | null
    readingVarProbe: string | null
    liveStrongDecorationColor: string | null
    liveInlineCodeDecorationColor: string | null
    liveCodeLineDecorationColor: string | null
    readingStrongDecorationColor: string | null
    liveTaskCheckboxDecorationColor: string | null
    readingTaskCheckboxDecorationColor: string | null
    liveLinkDecorationColor: string | null
    readingLinkDecorationColor: string | null
    readingImageDecorationColor: string | null
    liveTablePipeDecorationColor: string | null
    readingTableDecorationColor: string | null
    liveWikilinkDecorationColor: string | null
    readingWikilinkDecorationColor: string | null
    /** #59 公式字体观测：katex.min.css 生效时含 KaTeX 字体族 */
    liveMathFontFamily?: string | null
    readingMathFontFamily?: string | null
  }
  /** #8 双视图语法一致性观测 */
  liveSyntax?: {
    headingLines: number
    headerSpans: number
    strongSpans: number
    emphasisSpans: number
    inlineCodeSpans: number
    quoteLines: number
    codeLines: number
    listLines: number
    hrLines: number
    frontmatterLines: number
    taskGlyphs: number
    taskChecked: number
    tableLines?: number
    tableCells?: number
  }
  tableGrid?: {
    visibleRows: number
    selectedRowIsGrid: boolean
    selectedRowCells: string[]
    rowHandles: number
  }
  readingSyntax?: {
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
    tables?: number
  }
  /** #10 链接/图片观测 */
  liveLinkCount?: number
  liveImageCount?: number
  readingLinkCount?: number
  readingImageCount?: number
  /** #11 双链观测（live：widget+mark；reading：a.vsidian-wikilink） */
  liveWikilinkCount?: number
  readingWikilinkCount?: number
  /** #59 公式计数（live 视口渲染数 / 阅读挂载块内数） */
  liveMathCount?: number
  readingMathCount?: number
  /** #60 Mermaid 计数（live 视口渲染数 / 阅读挂载块内数） */
  liveMermaidCount?: number
  readingMermaidCount?: number
  imageStates?: { loading: number; loaded: number; error: number }
  /** #14 查找会话观测（首次打开后回报；匹配集来自文本模型全量计算） */
  find?: {
    open: boolean
    query: string
    caseSensitive: boolean
    total: number
    index: number
    currentFrom: number | null
    currentTo: number | null
  }
  /** #32 排版一致性探针（view.state 可选字段，协议正式校验）：
   *  各侧样本只在对应模式激活态断言（隐藏侧几何口径无意义） */
  typography?: {
    live: { fontFamily: string | null; fontSizePx: number | null; lineHeightPx: number | null; textInsetPx: number | null } | null
    reading: { fontFamily: string | null; fontSizePx: number | null; lineHeightPx: number | null; textInsetPx: number | null } | null
    liveList: { fontFamily: string | null; fontSizePx: number | null } | null
    readingList: { fontFamily: string | null; fontSizePx: number | null } | null
    liveQuote: { fontFamily: string | null; fontSizePx: number | null } | null
    readingQuote: { fontFamily: string | null; fontSizePx: number | null } | null
    liveTable: { fontFamily: string | null; fontSizePx: number | null } | null
    readingTable: { fontFamily: string | null; fontSizePx: number | null } | null
  }
  /** #33 设置快照缓存（宿主 snapshot/changed 下发后非空） */
  settings?: Record<string, unknown>
  /** #34 行号栏观测（first/last 为视口内首/末行号单元格文本） */
  lineGutter?: {
    on: boolean
    count: number
    first: string | null
    last: string | null
  }
  /** 绘制层探针（P0 回归）：正文可见性 / CM6 注入样式存活 / 行号禁选 / 明暗声明与光标实值 */
  paint?: {
    textVisible: boolean
    scrollerDisplay: string | null
    gutterUserSelect: string | null
    visibleLineNumbers?: string[]
    darkTheme: boolean
    caretColor: string | null
    table?: {
      cellVisible: boolean
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
      regionCellCount?: number
      regionBackgroundColor?: string | null
      regionTopBorderWidth?: string | null
      regionLeftBorderWidth?: string | null
    }
    /** #59 公式绘制：当前激活视图内首个公式的实际可见性与计数 */
    math?: {
      visible: boolean
      display: string | null
      count: number
    }
    /** #60 Mermaid 绘制：当前激活视图内图表容器的实际可见性与分态计数 */
    mermaid?: {
      visible: boolean
      display: string | null
      rendered: number
      error: number
      count: number
    }
    /** #106 分割线绘制：当前激活视图内首个渲染态横线的可见性与计数 */
    hr?: {
      visible: boolean
      display: string | null
      borderTopWidth: string | null
      count: number
    }
    quickActions?: {
      open: boolean
      togglePainted: boolean
      barPainted: boolean
      boldPainted: boolean
      activePainted: boolean
      menuPainted: boolean
      barBelowToolbar: boolean
      editorBelowBar: boolean
    }
    /** #79 代码块卡片绘制：当前激活视图内卡片头部的实际可见性与计数 */
    code?: {
      visible: boolean
      display: string | null
      label: string | null
      headerCount: number
      cardLineCount: number
      /** #80 视口内卡内行号文本序列 */
      lineNumberTexts?: string[] | null
      /** #81 呈现态复制按钮在场数 */
      copyCount?: number
      /** #82 收起态头部数 */
      foldedCount?: number
      /** #83 视口内 tok-* token 元素数 */
      tokenCount?: number
      /** 全部头部语言标签序列（DOM 顺序；渲染型围栏的 Mermaid 标签断言） */
      labels?: string[]
    }
    /** #55：标题行左缘绘制观测（distinct computed 值；无挂载标题行为 null） */
    heading?: {
      inviewCount: number
      boxShadowValues: string[]
      borderLeftWidthValues: string[]
    } | null
  }
  /** #53 右侧栏观测：布局态与绘制层证据（结构见 src/shared/protocol.ts SidebarProbe） */
  sidebar?: {
    open: boolean
    sidebarToolbarPainted: boolean
    togglePainted: boolean
    settingsPainted: boolean
    toggleBarStrokeWidth: string | null
    toggleFrameStrokeWidth: string | null
    mainWidthPx: number | null
    sidebarWidthPx: number | null
    toggleAriaLabel: string | null
    settingsAriaLabel: string | null
  }
  /** #54 大纲观测：面板态、绘制层证据与全文标题序列（protocol.ts OutlineProbe） */
  outline?: {
    active: boolean
    togglePainted: boolean
    panelPainted: boolean
    toggleIconSizePx: number | null
    panelScrollHeightPx: number | null
    panelClientHeightPx: number | null
    /** #65：items 含 plainText（剥标记可见文本）与 spans（白名单标记区间） */
    items: Array<{
      level: number
      text: string
      plainText: string
      spans: Array<{ kind: string; start: number; end: number }>
      line: number
    }>
    toggleAriaLabel: string | null
    panelAriaLabel: string | null
    /** #65 样式透传绘制证据（computed；jsdom 无 CSS 引擎时字段为 null） */
    style?: {
      itemFontWeight: string | null
      strongFontWeight: string | null
      codeFontFamily: string | null
      itemFontFamily: string | null
      itemColor: string | null
      headingColor: string | null
    }
    /** #66 当前控制域条目（视口顶行向上最近标题；null = 无标题/首标题前） */
    locatedItemIndex: number | null
    locatedText: string | null
    /** 高亮横条绘制证据（中心点命中 + computed 背景非全透明） */
    locatedPainted: boolean
    /** #67 展开档位（0=全部折叠、1–5=展开到 Hn） */
    expandLevel: number
    /** #67 可见条目索引序列（折叠遮蔽后的用户实际可见集） */
    visibleIndices: number[]
    /** #67 滑块行绘制证据（elementFromPoint 命中滑块容器） */
    sliderPainted: boolean
    /** #67 当前档圆点绘制证据（命中 active 圆点 + computed 背景非全透明） */
    sliderActiveDotPainted: boolean
    /** #67 折叠箭头绘制证据（首个箭头中心点命中） */
    chevronPainted: boolean
    /** #68 当前搜索词（空串 = 无过滤） */
    searchQuery: string
    /** #68 搜索态（词条非空） */
    searchActive: boolean
    /** #68 组合可见索引序列（折叠可见 ∩ 搜索保留；搜索关闭时与 visibleIndices 同值） */
    filteredVisibleIndices: number[]
    /** #68 工具条行绘制证据（elementFromPoint 命中工具条容器） */
    toolbarPainted: boolean
    /** #68 跳转到末尾按钮可访问名称 */
    jumpBottomAriaLabel: string | null
    /** #68 重置按钮可访问名称 */
    resetAriaLabel: string | null
    /** #68 搜索框 placeholder 文案 */
    searchPlaceholder: string | null
    /** #68 命中片段绘制证据（可见条目内 mark 命中 + computed 背景非全透明） */
    searchHitPainted: boolean
    /** #68 无匹配占位绘制证据 */
    nomatchPainted: boolean
    /** #69 右键菜单打开态 */
    menuOpen: boolean
    /** #69 菜单目标条目索引（items 下标；未打开为 null） */
    menuTargetIndex: number | null
    /** #69 菜单容器绘制证据（中心点 elementFromPoint 命中自身） */
    menuPainted: boolean
    /** #69 级联子菜单可见证据（hover/focus 展开；未展开为 false） */
    submenuVisible: boolean
    /** #69 重命名编辑态条目索引（null = 无编辑态） */
    renamingIndex: number | null
    /** #70 拖拽态源条目索引（null = 无拖拽；仅 moved 后回报） */
    draggingIndex: number | null
    /** #70 有效落点目标索引（null = 未悬停或落点无效） */
    dropTargetIndex: number | null
    /** #70 落点三态（null = 无有效落点） */
    dropPosition: 'before' | 'after' | 'inside' | null
    /** #70 落点指示绘制证据（指示条目中心命中 + 插入线/包裹高亮可读） */
    dropHintPainted: boolean
  }
}

/** #7 阅读视图探针回报（reading.perf.report） */
interface ReadingPerfReportData {
  scrollRounds: number
  totalBlocks: number
  baseline: { mountedBlocks: number; contentDomCount: number; scrollTopPx: number; scrollHeightPx: number }
  afterScroll: { mountedBlocks: number; contentDomCount: number; scrollTopPx: number; scrollHeightPx: number }
  parseCount: number
  maxMountedBlocks: number
  ok: boolean
}

/** 性能探针回报（perf.report，结构见 src/shared/protocol.ts） */
interface PerfReportData {
  typingRounds: number
  scrollRounds: number
  docLines: number
  baseline: { renderedLines: number; contentDomCount: number; headingLineCount: number; inviewHeadingCount: number }
  afterTyping: { renderedLines: number; contentDomCount: number; headingLineCount: number; inviewHeadingCount: number }
  afterScroll: { renderedLines: number; contentDomCount: number; headingLineCount: number; inviewHeadingCount: number }
  inputDelayMs: { samples: number[]; avgMs: number; maxMs: number }
  longTasks: { count: number; maxMs: number; totalMs: number } | null
  headingStats: { totalUpdates: number; lastUpdateScannedLines: number; fullBuildLines: number }
}

interface ConflictState {
  found: boolean
  sessionId?: string
  suspended?: boolean
  fragments?: string[]
  webviewText?: string
  webviewVersion?: number
}

/** #10 链接跳转执行日志（_test.getLinkLog 回报；#11 起含双链条目） */
interface LinkLogData {
  found: boolean
  log: Array<{
    kind: string
    href?: string
    reason?: string
    scheme?: string
    path?: string
    /** #11 双链条目字段 */
    target?: string
    heading?: string
    candidates?: string[]
    locate?: 'custom-panel' | 'text-editor' | 'none'
  }>
}

// ---- #11 双链 fixture 镜像（与 runTest.mjs 逐字节一致：标题 offset 断言依据） ----
const WIKILINKS_DOC_TEXT = [
  '# 双链样例',
  '',
  '正文含 [[目标笔记]] 与 [[子 目录/目标 二|别名]] 与 [[目标笔记#深处的标题]]。',
  '',
  '降级形态：![[嵌入目标]] 与 [[目标笔记^块]] 与 [[坏#]]。',
  '',
  '`行内代码 [[不装饰]]` 之后的正文。',
  '',
  '```text',
  '[[围栏内不装饰]]',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')
const TARGET_NOTE_TEXT = (() => {
  const out = ['# 目标笔记标题', '', '开篇段落。', '']
  for (let i = 1; i <= 200; i++) {
    out.push(`填充段落 ${i}：足够多的正文让「深处的标题」位于首屏之外。`, '')
  }
  out.push('# 深处的标题', '', '标题下的正文。', '')
  return out.join('\n')
})()
/** 屏外标题的源 offset（阅读挂载定位断言依据） */
const DEEP_HEADING_OFFSET = TARGET_NOTE_TEXT.indexOf('# 深处的标题')

/** CRLF 双链目标镜像（fixtures.mjs 的 WIKILINK_CRLF_TARGET_DOC 逐字节一致，
 *  LF 形态——标题 LF offset 断言依据：宿主 getText 保留 \r\n，直发宿主系
 *  坐标给 LF 坐标系的 webview 会按行数差漂移） */
const WIKILINK_CRLF_TARGET_LF = (() => {
  const out = ['# CRLF 目标标题', '', '开篇段落。', '']
  for (let i = 2; i <= 30; i++) {
    out.push(`第 ${i} 段正文。`, '')
  }
  out.push('## CRLF 深处小节', '', '小节内容。', '')
  return out.join('\n')
})()
/** CRLF 目标中部标题的 LF offset（定位断言依据；其前有 30+ 个 CRLF 行尾，
 *  宿主系 offset 比 LF offset 大出该行数） */
const CRLF_HEADING_LF_OFFSET = WIKILINK_CRLF_TARGET_LF.indexOf('## CRLF 深处小节')

/** 注入双链意图（与真实 webview 消息同一校验与处理入口；#11） */
async function injectWikilink(uri: string, target: string): Promise<void> {
  await vscode.commands.executeCommand(CMD.injectMessage, uri, {
    kind: 'wikilink.activate',
    sessionId: '',
    docUri: uri,
    target,
    srcStart: 0,
    srcEnd: 16,
  })
}

/** 等待双链执行日志中出现匹配条目（#11） */
async function waitWikilinkLog(
  uri: string,
  match: (e: LinkLogData['log'][number]) => boolean,
): Promise<LinkLogData['log'][number]> {
  return poll('双链执行日志', async () => {
    const data = (await vscode.commands.executeCommand(CMD.linkLog, uri)) as LinkLogData | undefined
    return data?.found ? data.log.find(match) : undefined
  })
}

async function waitSessionReady(file: string): Promise<SessionState> {
  return poll(`会话就绪 ${file}`, async () => {
    const state = (await vscode.commands.executeCommand(CMD.sessionState, wsUri(file).toString())) as SessionState | undefined
    if (state?.found && state.panels.some((p) => p.ready)) {
      return state
    }
    return undefined
  })
}

async function waitViewState(
  file: string,
  match?: (v: ViewState) => boolean,
  panelIndex = 0,
  /** 等待预算（默认 20s；mermaid 绘制层等重负载用例可放宽至 60s——
   *  独立桌面宿主下高负载时段的懒加载解析 + 渲染偶发击穿默认预算） */
  timeoutMs = 20000,
): Promise<ViewState> {
  return poll(`视图状态 ${file}`, async () => {
    const state = (await vscode.commands.executeCommand(CMD.viewState, wsUri(file).toString(), panelIndex)) as ViewState | undefined
    if (state && (!match || match(state))) {
      return state
    }
    return undefined
  }, timeoutMs)
}

/** #9 任务勾选 fixture（与 runTest.mjs 的 TASK_DOC 一致） */
const TASK_DOC_TEXT = [
  '# 任务清单标题',
  '',
  '- [ ] 未完成任务甲',
  '- [ ] 未完成任务甲',
  '- [x] 已完成任务',
  '',
  '结尾段落。',
  '',
].join('\n')
/** 点击第二个重复任务后的期望全文 */
const TASK_DOC_SECOND_TOGGLED = [
  '# 任务清单标题',
  '',
  '- [ ] 未完成任务甲',
  '- [x] 未完成任务甲',
  '- [x] 已完成任务',
  '',
  '结尾段落。',
  '',
].join('\n')

/** 用例表：名称 -> 执行函数 */
export const cases: Array<[string, () => Promise<void>]> = [
  ['激活与默认编辑器声明（#38 后接管 .md 默认打开）', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID)
    assert(ext, `扩展 ${EXT_ID} 未找到`)
    await ext!.activate()
    assert(ext!.isActive, '扩展激活失败')

    const contributes = (ext!.packageJSON as { contributes?: { customEditors?: Array<{ priority?: string; selector?: Array<{ filenamePattern?: string }> }> } }).contributes
    const editor = contributes?.customEditors?.[0]
    assert(editor?.priority === 'default', `priority 应为 default（默认编辑器接管 .md 打开），实际 ${editor?.priority}`)
    const patterns = editor?.selector?.map((s) => s.filenamePattern) ?? []
    assert(patterns.includes('*.md'), `selector 应含 *.md，实际 ${patterns.join(',')}`)
  }],

  ['标题栏三态按钮声明：三命令各一项、navigation 组、when 互斥与图标（#38）', async () => {
    // 静态断言（contributes.menus["editor/title"] 与 commands 声明）：运行时
    // 按钮显隐由 VSCode 按 when 求值，此处钉死声明形状。三按钮同一时刻至多
    // 一个可见的依据是 when 条件互斥：toReading/toSource 同以
    // activeCustomEditorId == 本编辑器 锁定 Vsidian 面板，再以 vsidian.activeMode
    // 的 live/reading 两值区分（同一 context key 不可能同时取两值）；toLive 以
    // !activeCustomEditorId 锁定非 custom 编辑器（.md/.markdown 源码态），与前
    // 两者的 activeCustomEditorId 断言互斥；三条均含 !isInDiffEditor 排除对比视图
    const ext = vscode.extensions.getExtension(EXT_ID)
    assert(ext, `扩展 ${EXT_ID} 未找到`)
    await ext!.activate()
    const contributes = (ext!.packageJSON as {
      contributes?: {
        commands?: Array<{ command?: string; icon?: string }>
        menus?: { 'editor/title'?: Array<{ command?: string; when?: string; group?: string }> }
      }
    }).contributes

    const items = contributes?.menus?.['editor/title'] ?? []
    assert(items.length === 3, `editor/title 应恰好三命令各一项，实际 ${items.length} 项`)
    const byCommand = new Map(items.map((i) => [i.command, i]))
    const iconByCommand = new Map((contributes?.commands ?? []).map((c) => [c.command, c.icon]))

    const tri: Array<[command: string, icon: string]> = [
      ['onegayi.vsidian.mode.toReading', '$(book)'],
      ['onegayi.vsidian.mode.toSource', '$(code)'],
      ['onegayi.vsidian.mode.toLive', '$(edit)'],
    ]
    for (const [command, icon] of tri) {
      assert(
        items.filter((i) => i.command === command).length === 1,
        `${command} 在 editor/title 应恰一项`,
      )
      assert(byCommand.get(command)?.group === 'navigation', `${command} 应在 navigation 组，实际 ${byCommand.get(command)?.group}`)
      assert(iconByCommand.get(command) === icon, `${command} 图标应为 ${icon}，实际 ${iconByCommand.get(command)}`)
      assert(byCommand.get(command)?.when?.includes('!isInDiffEditor') === true, `${command} 的 when 应含 !isInDiffEditor（对比视图无按钮）`)
    }

    // 面板内两态互斥（live/reading 二值区分）
    const readingWhen = byCommand.get('onegayi.vsidian.mode.toReading')?.when ?? ''
    const sourceWhen = byCommand.get('onegayi.vsidian.mode.toSource')?.when ?? ''
    assert(readingWhen.includes(`activeCustomEditorId == ${VIEW_TYPE}`), `toReading 的 when 应锁定本编辑器面板，实际 ${readingWhen}`)
    assert(readingWhen.includes('vsidian.activeMode == live'), `toReading 的 when 应限定 live 态，实际 ${readingWhen}`)
    assert(sourceWhen.includes(`activeCustomEditorId == ${VIEW_TYPE}`), `toSource 的 when 应锁定本编辑器面板，实际 ${sourceWhen}`)
    assert(sourceWhen.includes('vsidian.activeMode == reading'), `toSource 的 when 应限定 reading 态，实际 ${sourceWhen}`)
    // 源码态按钮与前两者互斥（!activeCustomEditorId + !activeWebviewPanelId 排除
    // 一切 custom editor 与 webview panel 语境）且限定 .md/.markdown。其中
    // !activeWebviewPanelId 排除内置 Markdown 预览（Ctrl+Shift+V 的 WebviewPanel
    // 形态 viewType 'markdown.preview'；custom editor 形态已被 !activeCustomEditorId
    // 排除——与 1.86 内置 markdown 扩展官方 when 子句同口径）
    const liveWhen = byCommand.get('onegayi.vsidian.mode.toLive')?.when ?? ''
    assert(liveWhen.includes('!activeCustomEditorId'), `toLive 的 when 应限定非 custom 编辑器（与面板内两命令互斥），实际 ${liveWhen}`)
    assert(liveWhen.includes('!activeWebviewPanelId'), `toLive 的 when 应排除 webview panel（内置 Markdown 预览），实际 ${liveWhen}`)
    assert(liveWhen.includes('resourceExtname == .md') && liveWhen.includes('resourceExtname == .markdown'), `toLive 的 when 应限定 .md/.markdown，实际 ${liveWhen}`)
  }],

  ['默认关联打开 .md 进入 Vsidian 面板（#38 默认编辑器）', async () => {
    // vscode.open 不带 override 走默认关联解析（双击文件同路径）；
    // showTextDocument 强制 EXCLUSIVE_ONLY 原生，验证不了默认关联
    await resetLastMode()
    await vscode.commands.executeCommand('vscode.open', wsUri('lf.md'))
    const session = await waitSessionReady('lf.md')
    assert(session.panels.length >= 1, '默认关联打开应进入 Vsidian 面板')
    const view = await waitViewState('lf.md', (v) => v.text === LF_DOC)
    assert(view.viewMode === 'live', '无记忆时新开面板应为实时预览')
  }],

  ['Reopen With 打开后 webview 就绪并装载全文（中文/emoji/CSP 链路）', async () => {
    // webview 脚本在 CSP 限制下成功执行的前提是收到 ready 与 view.state
    await openWithEditor('lf.md')
    const session = await waitSessionReady('lf.md')
    assert(session.panels.length >= 1, '面板数应为 1')
    assert(session.appliedEdits === 0, '未编辑期间不应产生任何写回')
    const view = await waitViewState('lf.md')
    assert(view.text === LF_DOC, `webview 全文与源文件不一致：${JSON.stringify(view.text)}`)
    assert(view.docLength === LF_DOC.length, '全文长度（UTF-16）不一致')
  }],

  // ---- 工单 #38：标题栏三态按钮 / 默认编辑器 / 全局模式记忆 / diff 防御 ----

  ['三态循环：live→reading→source→live 往返，未保存内容与 dirty 全程保留（#38）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const doc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    const diskBefore = await readDisk('mode.md')

    // 一笔未保存编辑（外部 applyEdit 写权威文档并广播，面板同步）——
    // 验证工单验收「不因纯视图切换写入 Markdown 或隐式保存」
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('mode.md'), new vscode.Range(0, 0, 0, 0), '未保存三态段落\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const editedText = `未保存三态段落\n\n${MODE_DOC_TEXT}`
    await poll('编辑生效', () => (doc.getText() === editedText ? true : undefined))
    await waitViewState('mode.md', (v) => v.text === editedText)
    assert(doc.isDirty, '编辑后文档应 dirty（未保存）')

    // live → reading：标题栏命令链路（显式目标 + editor/title 传 uri）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toReading', wsUri('mode.md'))
    const readingView = await waitViewState('mode.md', (v) => v.viewMode === 'reading' && v.text === editedText)
    assert((readingView.readingBlockCount ?? 0) >= 6, `阅读块数应 >=6，实际 ${readingView.readingBlockCount}`)
    await waitLastMode('reading')

    // reading → source：活动 tab 原位切换为原生文本编辑器（openWith 新开 +
    // 清理旧 custom tab；dirty 时保留旧标签防内容回退，见「单标签（dirty→
    // 源码）」用例的实测裁决），活动编辑器显示未保存内容
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    const sourceEditor = await waitActiveTextEditor('mode.md')
    assert(sourceEditor.document.getText() === editedText, '原生编辑器应显示未保存内容')
    assert(doc.isDirty, '切到源码编辑器后文档仍应 dirty（纯视图切换不得隐式保存）')
    await waitLastMode('source')

    // source → live：面板重建，内容与 dirty 一致、磁盘不写
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive', wsUri('mode.md'))
    const session = await waitSessionReady('mode.md')
    assert(session.panels.length >= 1, 'toLive 应重建 Vsidian 面板')
    const liveView = await waitViewState('mode.md', (v) => v.text === editedText)
    assert(liveView.viewMode === 'live', 'toLive 后应为实时预览')
    assert(liveView.selectionOffset !== undefined, '返回可编辑视图应有确定的源位置（光标已装载）')
    assert(doc.isDirty, '回到面板后文档仍应 dirty')
    assert(await readDisk('mode.md') === diskBefore, '三态往返全程不得写磁盘')
    await waitLastMode('live')
  }],

  ['三态循环命令：源码编辑器态执行 toggleViewMode 打开 Vsidian（#38）', async () => {
    // 命令面板路径（不带 uri 参数）；原语义为警告提示，#38 升级为打开 Vsidian
    const doc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    await vscode.window.showTextDocument(doc)
    assert(vscode.window.activeTextEditor !== undefined, '前置：原生文本编辑器活动')

    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const session = await waitSessionReady('mode.md')
    assert(session.panels.length >= 1, '循环命令应把源码态切到 Vsidian 面板')
    await waitViewState('mode.md', (v) => v.viewMode === 'live')
    await waitLastMode('live')
  }],

  ['全局模式记忆：reading 记忆下关闭面板再开新文档直接进阅读模式（#38）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const modeUri = wsUri('mode.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toReading', wsUri('mode.md'))
    await waitViewState('mode.md', (v) => v.viewMode === 'reading')
    await waitLastMode('reading')

    // 关闭该面板（非 dirty，安全关闭）：记忆不随面板消失
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await poll('面板关闭与会话释放', async () => {
      const s = (await vscode.commands.executeCommand(CMD.sessionState, modeUri)) as SessionState
      return s?.found === false ? true : undefined
    })
    await waitLastMode('reading')

    // 新开另一文档：resolve 恢复链路直接进 reading（面板就绪后下发）
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    const restored = await waitViewState('lf.md', (v) => v.viewMode === 'reading')
    assert(restored.text === LF_DOC, '恢复阅读模式的文本应为全文')
  }],

  ['全局模式记忆：source 记忆下新开 .md 弹回原生编辑器（#38 冷启动源码态）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    await waitActiveTextEditor('mode.md')
    await waitLastMode('source')

    // 记忆 source 时打开另一 .md：resolve 弹回原生编辑器（即使显式指定
    // Vsidian——「Reopen With 选 Vsidian 被弹回」属已知代价，可经铅笔按钮切回）
    await openWithEditor('lf.md')
    await waitActiveTextEditor('lf.md')
    const state = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('lf.md').toString())) as SessionState
    assert(state.found === false, '弹回路径不得装配 Vsidian 会话')
    // 注：「弹回不改写记忆」不做跨窗口断言——1.86.2 的 globalState 存在
    // storage 层广播滞后，跨事件窗口读取偶发被滞后值覆盖（环境特性，
    // 非本扩展写入）；弹回分支不写记忆由 viewCycle 单测与代码路径保证

    // 等弹回链的异步清理完成（resolve 早退的空 custom tab 经 void openWith +
    // closeStale 关闭）：清理先于用例结束，未清理的空 tab 会被后续用例的
    // openWith 重显（永不 ready），此 poll 是跨用例隔离的一部分
    await poll('弹回残留 tab 清理', () => {
      const stale = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputCustom &&
          t.input.viewType === VIEW_TYPE &&
          t.input.uri.toString() === wsUri('lf.md').toString())
      return stale.length === 0 ? true : undefined
    })
  }],

  ['多标签独立性：命令只作用于活动标签，非活动标签状态保留（#38）', async () => {
    // 构型：一个 Vsidian 面板（syntax.md）+ 一个原生 .md 标签（mode.md）
    // 并存。「不同文档的两个 custom tab」构型在 1.86 测试宿主下第二个面板
    // 的 webview 创建偶发不就绪（5/7 轮复现，环境 flaky），双 Vsidian 面板
    // 各自模式独立由 webview 每面板独立 PersistedState 的单测与人工清单
    // A21 覆盖；本用例全程单 custom tab，验证命令按活动标签实际状态动作
    await openWithEditor('syntax.md')
    await waitSessionReady('syntax.md')
    const syntaxUri = wsUri('syntax.md').toString()
    const modeText = (await vscode.workspace.openTextDocument(wsUri('mode.md'))).getText()

    // 并存一个原生 .md 标签并使其活动（syntax 面板变非活动）：
    // 非活动面板保留自身状态可查询。retainContextWhenHidden 关闭，tab
    // 不可见期间 webview 可能被卸载（view.state.request 无人应答），
    // 故先在面板可见时让宿主模式缓存就位，变非活动后以宿主缓存为
    // 观测面断言保留（CI 慢环境的 Linux 宿主曾因该竞速必超时）
    await waitViewState('syntax.md', (v) => v.viewMode === 'live')
    const modeDoc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    await vscode.window.showTextDocument(modeDoc)
    await waitActiveTextEditor('mode.md')
    const keptLive = (await vscode.commands.executeCommand(
      CMD.viewStateCache, syntaxUri,
    )) as { found: boolean; viewMode?: string }
    assert(keptLive.found && keptLive.viewMode === 'live', '非活动的 syntax 面板应保留自身状态')

    // 重显 syntax 面板使其活动（openWith 对已开面板是重显，不新建 tab），
    // toReading 只作用于 syntax；原生 mode 标签不受影响。不可见期间面板
    // 可能经卸载重载：先以 0 轮探针（纯往返，不动文档）等待 webview 恢复
    // 响应再下发模式命令，避免命令发给重载中的 webview 而丢失
    await vscode.commands.executeCommand('vscode.openWith', wsUri('syntax.md'), VIEW_TYPE)
    await waitActiveCustomTab('syntax.md')
    await vscode.commands.executeCommand(
      CMD.perfProbe, syntaxUri, { typingRounds: 0, scrollRounds: 0 })
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toReading', wsUri('syntax.md'))
    await waitViewState('syntax.md', (v) => v.viewMode === 'reading')
    const backToMode = await vscode.window.showTextDocument(modeDoc)
    assert(backToMode.document.getText() === modeText, '原生 mode 标签不得受 syntax 的模式切换影响')

    // syntax 面板活动时 toSource：非 dirty 切换，被替换的旧 tab 关闭、
    // 会话释放（dirty 场景的单标签行为见三态循环与单标签用例组）
    await vscode.commands.executeCommand('vscode.openWith', wsUri('syntax.md'), VIEW_TYPE)
    await waitActiveCustomTab('syntax.md')
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('syntax.md'))
    await waitActiveTextEditor('syntax.md')
    await poll('syntax 面板会话释放', async () => {
      const s = (await vscode.commands.executeCommand(CMD.sessionState, syntaxUri)) as SessionState
      return s?.found === false ? true : undefined
    })
  }],

  ['单标签（非 dirty）：双向切换后同文档在全部标签组仅一个标签（#38 修复验收）', async () => {
    // 用户人工验收缺陷的直接断言：1.86 的 openWith 对「同资源不同编辑器」
    // 是新开 tab（T1 查证 1.86.0 源码确认为既有行为，无原位替换命令可用），
    // 修复前源码态与预览态并存两个标签——修复后编排层关闭被替换的旧 tab
    //（Vsidian→源码关旧 custom tab；源码→Vsidian 关旧原生 tab）
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')

    // Vsidian → 源码：旧 custom tab 关闭，仅剩一个原生 tab
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    await waitActiveTextEditor('mode.md')
    await poll('toSource 后旧 Vsidian 标签关闭', () =>
      tabsOf('mode.md', 'vsidian') === 0 ? true : undefined)
    assert(tabsOf('mode.md', 'native') === 1,
      `toSource 后应有且仅有一个原生标签，实际 native=${tabsOf('mode.md', 'native')} vsidian=${tabsOf('mode.md', 'vsidian')}`)

    // 源码 → Vsidian：旧原生 tab 关闭，仅剩一个 Vsidian tab（修复的缺失方向）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive', wsUri('mode.md'))
    await waitActiveCustomTab('mode.md')
    await poll('toLive 后旧原生标签关闭', () =>
      tabsOf('mode.md', 'native') === 0 ? true : undefined)
    assert(tabsOf('mode.md', 'vsidian') === 1,
      `toLive 后应有且仅有一个 Vsidian 标签，实际 native=${tabsOf('mode.md', 'native')} vsidian=${tabsOf('mode.md', 'vsidian')}`)
    await waitViewState('mode.md', (v) => v.text === MODE_DOC_TEXT)
  }],

  ['单标签（dirty→源码）：保留旧 Vsidian 标签防内容回退，保存后切换复用清理（#38 用例 A）', async () => {
    // 1.86.2 实测裁决：关闭 dirty custom tab 会把 TextDocument revert 回
    // 磁盘内容（即使原生 tab 已打开同一文档）——dirty 保留旧标签为已知
    // 代价（mvp.md），保存后再次切换收敛回单标签
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const doc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    const diskBefore = await readDisk('mode.md')
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('mode.md'), new vscode.Range(0, 0, 0, 0), '单标签未保存甲\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const editedText = `单标签未保存甲\n\n${MODE_DOC_TEXT}`
    await poll('编辑生效', () => (doc.getText() === editedText ? true : undefined))
    await waitViewState('mode.md', (v) => v.text === editedText)
    assert(doc.isDirty, '前置：文档应 dirty')

    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    const sourceEditor = await waitActiveTextEditor('mode.md')
    assert(tabsOf('mode.md', 'native') === 1, `dirty toSource 后一个原生标签，实际 native=${tabsOf('mode.md', 'native')}`)
    assert(tabsOf('mode.md', 'vsidian') === 1, `dirty 保留旧 Vsidian 标签（防回退已知代价），实际 vsidian=${tabsOf('mode.md', 'vsidian')}`)
    assert(sourceEditor.document.getText() === editedText,
      'dirty 保留下原生编辑器应显示未保存内容（不得回退）')
    assert(doc.getText() === editedText, 'TextDocument 不得被 revert')
    assert(doc.isDirty, 'dirty 切源码后文档仍应 dirty')
    assert(await readDisk('mode.md') === diskBefore, '切换不得写磁盘')

    // 保存后再次切换：非 dirty 清理生效，双标签收敛为单标签
    await doc.save()
    assert(await readDisk('mode.md') === editedText, '保存后磁盘应为编辑内容')
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive', wsUri('mode.md'))
    await waitActiveCustomTab('mode.md')
    await poll('保存后 toLive 收敛单标签', () =>
      tabsOf('mode.md', 'native') === 0 ? true : undefined)
    assert(tabsOf('mode.md', 'vsidian') === 1, `保存后 toLive 应仅剩一个 Vsidian 标签，实际 vsidian=${tabsOf('mode.md', 'vsidian')}`)
    await waitViewState('mode.md', (v) => v.text === editedText && v.viewMode === 'live')

    // 恢复 fixture 基线（mode.md 磁盘内容被本用例保存改写，后续用例按
    // MODE_DOC_TEXT 断言——移除插入段并保存回基线；偏移系定位，插入段
    // 跨两行，行系 Range 会被钳位残留换行）
    const restore = new vscode.WorkspaceEdit()
    restore.replace(
      wsUri('mode.md'),
      new vscode.Range(doc.positionAt(0), doc.positionAt('单标签未保存甲\n\n'.length)),
      '',
    )
    assert(await vscode.workspace.applyEdit(restore), '恢复编辑应成功')
    await doc.save()
    assert(await readDisk('mode.md') === MODE_DOC_TEXT, '用例结束应恢复 mode.md 基线')
  }],

  ['单标签（dirty→预览）：保留旧原生标签防内容回退，保存后切换复用清理（#38 用例 B）', async () => {
    // 1.86.2 实测裁决：关闭 dirty 原生 tab 同样 revert（vscode-office 陷阱 3
    // 在本扩展构型下复现，与 custom 侧是否已持文档无关）——dirty 保留旧原生
    // 标签为最后手段，保存后再次切换收敛回单标签
    const doc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    await vscode.window.showTextDocument(doc)
    await waitActiveTextEditor('mode.md')
    const diskBefore = await readDisk('mode.md')
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('mode.md'), new vscode.Range(0, 0, 0, 0), '单标签未保存乙\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const editedText = `单标签未保存乙\n\n${MODE_DOC_TEXT}`
    await poll('编辑生效', () => (doc.getText() === editedText ? true : undefined))
    assert(doc.isDirty, '前置：文档应 dirty')

    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive', wsUri('mode.md'))
    await waitActiveCustomTab('mode.md')
    assert(tabsOf('mode.md', 'vsidian') === 1, `dirty toLive 后一个 Vsidian 标签，实际 vsidian=${tabsOf('mode.md', 'vsidian')}`)
    assert(tabsOf('mode.md', 'native') === 1, `dirty 保留旧原生标签（防回退已知代价），实际 native=${tabsOf('mode.md', 'native')}`)
    assert(doc.getText() === editedText, 'dirty 保留下 TextDocument 不得被 revert')
    assert(doc.isDirty, 'dirty 切预览后文档仍应 dirty')
    const view = await waitViewState('mode.md', (v) => v.text === editedText)
    assert(view.viewMode === 'live', 'toLive 后应为实时预览')
    assert(await readDisk('mode.md') === diskBefore, '切换不得写磁盘')

    // 保存后再次切换：非 dirty 清理生效，双标签收敛为单标签
    await doc.save()
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    await waitActiveTextEditor('mode.md')
    await poll('保存后 toSource 收敛单标签', () =>
      tabsOf('mode.md', 'vsidian') === 0 ? true : undefined)
    assert(tabsOf('mode.md', 'native') === 1, `保存后 toSource 应仅剩一个原生标签，实际 native=${tabsOf('mode.md', 'native')}`)
    assert(vscode.window.activeTextEditor?.document.getText() === editedText, '收敛后原生编辑器显示保存内容')

    // 恢复 fixture 基线（同用例 A：磁盘内容回到 MODE_DOC_TEXT 供后续用例；
    // 偏移系定位避免跨行 Range 被钳位）
    const restore = new vscode.WorkspaceEdit()
    restore.replace(
      wsUri('mode.md'),
      new vscode.Range(doc.positionAt(0), doc.positionAt('单标签未保存乙\n\n'.length)),
      '',
    )
    assert(await vscode.workspace.applyEdit(restore), '恢复编辑应成功')
    await doc.save()
    assert(await readDisk('mode.md') === MODE_DOC_TEXT, '用例结束应恢复 mode.md 基线')
  }],

  ['弹回防御（dirty）：source 记忆下 dirty 文档弹回不丢内容，空面板保留（#38 review-loop）', async () => {
    // review-loop V1：bounceToSource 曾无条件 dispose 空面板——按实测口径
    // 「1.86.2 关 dirty tab 会 revert TextDocument（custom 侧亦然）」，Hot
    // Exit 恢复 dirty 面板或原生 dirty + Reopen With 均可达该路径。契约：
    // dirty 时跳过 dispose（空面板保留为已知代价），内容与 dirty 不得回退；
    // 收尾经 toSource（活动位已在原生 tab = re-affirm 路径）复用清理收敛，
    // 顺带钉住 re-affirm 的物化与收敛契约
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    await waitActiveTextEditor('mode.md')
    await waitLastMode('source')

    const doc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    const diskBefore = await readDisk('mode.md')
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('mode.md'), new vscode.Range(0, 0, 0, 0), '弹回未保存丙\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const editedText = `弹回未保存丙\n\n${MODE_DOC_TEXT}`
    await poll('编辑生效', () => (doc.getText() === editedText ? true : undefined))
    assert(doc.isDirty, '前置：文档应 dirty')

    // 原生 dirty + 显式 Reopen With → Vsidian：resolve 弹回（已知代价路径）
    await openWithEditor('mode.md')
    await waitActiveTextEditor('mode.md')
    const modeUri = wsUri('mode.md').toString()
    await poll('弹回路径不装配会话（旧会话随 toSource 清理释放）', async () => {
      const s = (await vscode.commands.executeCommand(CMD.sessionState, modeUri)) as SessionState
      return s?.found === false ? true : undefined
    })
    // 弹回链（showTextDocument → dispose → 清扫）是异步 microtask + 宿主
    // 动作，断言立即读会跑在 dispose/revert 生效前（首跑实测）——先过
    // 稳定窗再断言终态（同 diff 用例的观察窗手法）
    await new Promise((r) => setTimeout(r, 1200))
    assert(doc.getText() === editedText, '弹回不得把 TextDocument revert 回磁盘内容')
    assert(doc.isDirty, '弹回后文档仍应 dirty')
    assert(await readDisk('mode.md') === diskBefore, '弹回不得写磁盘')
    assert(tabsOf('mode.md', 'vsidian') === 1,
      `dirty 弹回应保留空 Vsidian 标签（防回退代价），实际 vsidian=${tabsOf('mode.md', 'vsidian')}`)
    assert(tabsOf('mode.md', 'native') === 1, `弹回后一个原生标签，实际 native=${tabsOf('mode.md', 'native')}`)

    // 保存后 toSource（re-affirm 路径：活动位已在原生 tab）：物化原生控件
    // 并复用清理，空面板收敛单标签
    await doc.save()
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    const editor = await waitActiveTextEditor('mode.md')
    assert(editor.document.getText() === editedText, 're-affirm 后原生编辑器应显示保存内容')
    await poll('re-affirm 清理空面板', () =>
      tabsOf('mode.md', 'vsidian') === 0 ? true : undefined)

    // 恢复 fixture 基线（偏移系定位，同用例 A/B）
    const restore = new vscode.WorkspaceEdit()
    restore.replace(
      wsUri('mode.md'),
      new vscode.Range(doc.positionAt(0), doc.positionAt('弹回未保存丙\n\n'.length)),
      '',
    )
    assert(await vscode.workspace.applyEdit(restore), '恢复编辑应成功')
    await doc.save()
    assert(await readDisk('mode.md') === MODE_DOC_TEXT, '用例结束应恢复 mode.md 基线')
  }],

  ['diff 视图防御：三命令与循环命令均 no-op，不折叠对比（#38 D10）', async () => {
    await resetLastMode()
    await openTextDiff('lf.md', 'mode.md', 'diff 防御')

    for (const cmd of [
      'onegayi.vsidian.mode.toReading',
      'onegayi.vsidian.mode.toSource',
      'onegayi.vsidian.mode.toLive',
      'onegayi.vsidian.toggleViewMode',
    ]) {
      await vscode.commands.executeCommand(cmd, wsUri('lf.md'))
    }
    // 异步动作落地窗口（no-op 时无动作，留观察窗防误报通过）
    await new Promise((r) => setTimeout(r, 800))

    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
    assert(activeTab?.input instanceof vscode.TabInputTextDiff, '活动标签应仍为对比视图')
    const customTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputCustom)
    assert(customTabs.length === 0, 'diff 语境不得创建任何 Vsidian 面板')
    // 注：no-op 不写记忆不做跨窗口断言（1.86.2 globalState 广播滞后会偶发
    // 覆盖读取，环境特性）；reject 分支无 writeRemembered 由代码路径保证
  }],

  ['diff 弹回防御：source 记忆下 diff 语境的 resolve 不弹回（#38 D10）', async () => {
    // 先经真实命令链路把记忆写成 source
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toSource', wsUri('mode.md'))
    await waitActiveTextEditor('mode.md')
    await waitLastMode('source')

    // 打开含 lf.md 的文本 diff，再显式 resolve lf.md 的 Vsidian 面板：
    // lf.md 处于 diff 标签 → 弹回被跳过、正常装配（diff 完整性优先）
    await openTextDiff('lf.md', 'mode.md', 'diff 弹回')
    await openWithEditor('lf.md')
    const session = await waitSessionReady('lf.md')
    assert(session.panels.length >= 1, 'diff 语境下应跳过弹回、正常装配面板')
  }],


  ['注入编辑写回 TextDocument 并保存后磁盘回读一致（中文/emoji）', async () => {
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    // LF 文档中在 offset 33（组合 emoji 行后）插入新段落：模拟 webview 用户输入
    const insertAt = LF_DOC.indexOf('- 列表项一')
    await vscode.commands.executeCommand(CMD.injectMessage, wsUri('lf.md').toString(), {
      kind: 'edit.request',
      sessionId: '', // 由钩子按面板填充校验，此处留空由扩展侧测试钩子替换
      docUri: wsUri('lf.md').toString(),
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: insertAt, length: 0, text: '插入的新段落\n' }],
    })
    const doc = await vscode.workspace.openTextDocument(wsUri('lf.md'))
    await poll('文档内容更新', () => (doc.getText() === LF_DOC_AFTER_EDIT ? true : undefined))
    assert(doc.isDirty, '编辑后文档应处于 dirty 状态')
    const saved = await doc.save()
    assert(saved, '保存失败')
    const disk = await readDisk('lf.md')
    assert(disk === LF_DOC_AFTER_EDIT, `保存后磁盘回读不一致：${JSON.stringify(disk)}`)
  }],

  ['未编辑的文件保存不产生内容变化', async () => {
    const before = await readDisk('untouched.md')
    await openWithEditor('untouched.md')
    await waitSessionReady('untouched.md')
    const doc = await vscode.workspace.openTextDocument(wsUri('untouched.md'))
    assert(!doc.isDirty, '未编辑的文档不应为 dirty')
    await vscode.commands.executeCommand('workbench.action.files.saveAll')
    const after = await readDisk('untouched.md')
    assert(before === after, '未编辑文件内容发生变化')
    const session = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('untouched.md').toString())) as SessionState
    assert(session.appliedEdits === 0, '未编辑期间不应有任何 applyEdit')
  }],

  ['CRLF 文档：LF 坐标编辑转换为宿主 CRLF 坐标且既有换行保真', async () => {
    await openWithEditor('crlf.md')
    await waitSessionReady('crlf.md')
    // webview 收到的是 LF 化全文
    const view = await waitViewState('crlf.md')
    assert(view.text === CRLF_DOC.replace(/\r\n/g, '\n'), `CRLF 文档应 LF 化装载：${JSON.stringify(view.text)}`)

    // 在第二行行首（LF offset 4）插入新段落
    await vscode.commands.executeCommand(CMD.injectMessage, wsUri('crlf.md').toString(), {
      kind: 'edit.request',
      sessionId: '',
      docUri: wsUri('crlf.md').toString(),
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 4, length: 0, text: '新段落\n' }],
    })
    const doc = await vscode.workspace.openTextDocument(wsUri('crlf.md'))
    const expected = '标题一\r\n新段落\r\n正文 A 行\r\n正文 B 行\r\n'
    await poll('CRLF 文档更新', () => (doc.getText() === expected ? true : undefined))
    await doc.save()
    const disk = await readDisk('crlf.md')
    assert(disk === expected, `保存后 CRLF 保真失败：${JSON.stringify(disk)}`)
    assert(disk.includes('\r\n'), '磁盘换行应保持 CRLF')
  }],

  ['长文档：单一 EditorView 视口渲染，不为视口外内容创建 DOM', async () => {
    await openWithEditor('large.md')
    await waitSessionReady('large.md')
    const totalLines = Number(process.env['LARGE_DOC_LINES'] ?? '0')
    assert(totalLines > 1000, 'fixture 行数环境变量缺失')
    const view = await waitViewState('large.md', (v) => v.docLength > 0)
    // 全文模型承载完整文档（行数 >= 总行数，CM6 对末尾换行可能多计一行）；
    // 渲染行数应远小于总行数（CM6 视口虚拟渲染，不为视口外内容创建 DOM）
    assert(view.lineCount >= totalLines, `全文模型行数应 >= ${totalLines}，实际 ${view.lineCount}`)
    assert(view.renderedLines > 0 && view.renderedLines < 2000, `视口渲染行数应远小于总行数，实际 ${view.renderedLines}`)
  }],

  ['split 第二面板收到第一面板编辑的增量广播', async () => {
    await openWithEditor('split.md')
    await waitSessionReady('split.md')
    await openWithEditor('split.md', true)
    const twoPanels = await poll('双面板就绪', async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('split.md').toString())) as SessionState | undefined
      return state && state.panels.filter((p) => p.ready).length >= 2 ? state : undefined
    })
    assert(twoPanels.panels.length === 2, `split 后应有 2 个面板，实际 ${twoPanels.panels.length}`)

    await vscode.commands.executeCommand(CMD.injectMessage, wsUri('split.md').toString(), {
      kind: 'edit.request',
      sessionId: '',
      docUri: wsUri('split.md').toString(),
      seq: 1,
      baseVersion: twoPanels.version,
      changes: [{ offset: 0, length: 0, text: '广播前缀 ' }],
    })
    // 注入路径模拟的是"面板 1 的 webview 已本地应用并发消息"（真实场景中
    // 面板 1 乐观回显），因此断言聚焦面板 2 通过 doc.changed 广播同步文本
    const expected = '广播前缀 split 起始行\n'
    await poll('双面板文本同步', async () => {
      const v = (await vscode.commands.executeCommand(
        CMD.viewState,
        wsUri('split.md').toString(),
        1,
      )) as ViewState | undefined
      return v?.text === expected ? true : undefined
    })
    const doc = await vscode.workspace.openTextDocument(wsUri('split.md'))
    assert(doc.getText() === expected, '宿主文档应更新')
  }],

  ['webview 撤销/重做请求作用于宿主权威历史且无回声（转发链路）', async () => {
    // 双面板：注入的编辑经 doc.changed 广播让面板 2（真实 webview）同步到
    // 已编辑状态——单面板注入走确认路径只回 ack，真实 webview 未本地应用
    // 注入内容，无法验证回流后的视图回退
    await openWithEditor('undo.md')
    await waitSessionReady('undo.md')
    await openWithEditor('undo.md', true)
    await poll('双面板就绪', async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('undo.md').toString())) as SessionState | undefined
      return state && state.panels.filter((p) => p.ready).length >= 2 ? state : undefined
    })
    const uri = wsUri('undo.md').toString()
    const original = '撤销链路第一行\n撤销链路第二行\n'
    const doc = await vscode.workspace.openTextDocument(wsUri('undo.md'))
    const edited = '撤销链路第一行【插入】\n撤销链路第二行\n'

    // 编辑：第一行末（LF offset 7）插入；面板 2 经广播同步
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 7, length: 0, text: '【插入】' }],
    })
    await poll('编辑写入宿主文档', () => (doc.getText() === edited ? true : undefined))
    await waitViewState('undo.md', (v) => v.text === edited, 1)

    // webview 发起 undo（keymap 转发路径的消息形态）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('undo 回退宿主文档', () => (doc.getText() === original ? true : undefined))
    // undo 的逆变更广播给全部面板：webview 视图同步回退（以面板 1 断言）
    await waitViewState('undo.md', (v) => v.text === original, 1)

    // 无回声：undo/redo 作用于宿主历史，回流增量不得再次经 applyEdit 写回
    const afterUndo = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterUndo.appliedEdits === 1, `undo 后 appliedEdits 应保持 1（无回声写回），实际 ${afterUndo.appliedEdits}`)

    // redo 恢复
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'redo' })
    await poll('redo 恢复宿主文档', () => (doc.getText() === edited ? true : undefined))
    await waitViewState('undo.md', (v) => v.text === edited, 1)
    const afterRedo = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterRedo.appliedEdits === 1, `redo 后 appliedEdits 应保持 1，实际 ${afterRedo.appliedEdits}`)
  }],

  ['宿主全局 undo/redo 命令作用于同一文档历史（命令面板路径）', async () => {
    await openWithEditor('undo2.md')
    const session = await waitSessionReady('undo2.md')
    const uri = wsUri('undo2.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('undo2.md'))
    const oneEdit = '全局命令撤销甲行A\n全局命令撤销乙行\n'
    const twoEdits = '全局命令撤销甲行AB\n全局命令撤销乙行\n'

    // 两笔编辑（逐笔等待生效，第二笔携带推进后的版本）。
    // '全局命令撤销甲行'为 8 字符，行末插入点为 LF offset 8
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: session.version,
      changes: [{ offset: 8, length: 0, text: 'A' }],
    })
    await poll('第一笔编辑生效', () => (doc.getText() === oneEdit ? true : undefined))
    const s2 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 2,
      baseVersion: s2.version,
      changes: [{ offset: 9, length: 0, text: 'B' }],
    })
    await poll('第二笔编辑生效', () => (doc.getText() === twoEdits ? true : undefined))

    // 全局 undo 命令（命令面板/Ctrl+Z 同一落点，不经 webview 消息）：
    // 活动编辑器为 custom editor 时应作用于其 TextDocument 权威栈
    await vscode.commands.executeCommand('undo')
    await poll('全局 undo 撤销最后一笔', () => (doc.getText() === oneEdit ? true : undefined))

    await vscode.commands.executeCommand('redo')
    await poll('全局 redo 恢复', () => (doc.getText() === twoEdits ? true : undefined))

    // 全程不得产生回声写回
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 2, `appliedEdits 应保持 2，实际 ${st.appliedEdits}`)
    // 还原
    await vscode.commands.executeCommand('undo')
    await vscode.commands.executeCommand('undo')
    await poll('还原到已保存状态', () => (doc.getText() === '全局命令撤销甲行\n全局命令撤销乙行\n' ? true : undefined))
  }],

  ['webview 请求全文重同步获得权威全文（组合缓冲保守路径的宿主侧）', async () => {
    await openWithEditor('resync.md')
    await waitSessionReady('resync.md')
    const uri = wsUri('resync.md').toString()
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'sync.request' })
    const view = await waitViewState('resync.md', (v) => v.text === '重同步起始内容\n重同步第二段\n')
    assert(view.text === '重同步起始内容\n重同步第二段\n', `resync 后视图应装载宿主全文：${JSON.stringify(view.text)}`)
    // resync 不产生写回
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, `resync 不应产生 applyEdit，实际 ${st.appliedEdits}`)
  }],

  ['外部修改覆盖过期请求区间：保留输入并暂停写回（#4 冲突链路）', async () => {
    await openWithEditor('conflict.md')
    await waitSessionReady('conflict.md')
    const uri = wsUri('conflict.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('conflict.md'))

    // 外部修改（模拟另一来源）：替换第一行整行 [0,7)（LF 坐标）
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('conflict.md'), new vscode.Range(0, 0, 0, 7), '外部改写行')
    const appliedExternal = await vscode.workspace.applyEdit(extEdit)
    assert(appliedExternal, '外部修改应成功')
    const afterExternal = '外部改写行\n第二段原文乙\n'
    await poll('外部修改生效', () => (doc.getText() === afterExternal ? true : undefined))

    // 注入基于初始版本的过期请求，区间 [2,4) 落入被替换区：不可安全重定位
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 2, length: 2, text: '未确认输入' }],
    })
    // 权威文档不被污染：过期内容不得写入
    assert(doc.getText() === afterExternal, `权威文本被过期请求污染：${JSON.stringify(doc.getText())}`)
    const conflict = (await vscode.commands.executeCommand(CMD.conflictState, uri)) as ConflictState
    assert(conflict.found && conflict.suspended === true, `面板应处于暂停：${JSON.stringify(conflict)}`)
    assert(
      JSON.stringify(conflict.fragments) === JSON.stringify(['未确认输入']),
      `未确认输入片段应被保留：${JSON.stringify(conflict.fragments)}`,
    )

    // 真实 webview 收到 conflict ack：装载权威全文并进入暂停（横幅状态可观测）
    const suspendedView = await waitViewState('conflict.md', (v) => v.suspended === true && v.text === afterExternal)
    assert(suspendedView.text === afterExternal, `webview 应装载权威全文：${JSON.stringify(suspendedView.text)}`)

    // 暂停期间后续请求被拒绝且不写回
    const appliedBefore = ((await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState).appliedEdits
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 2,
      baseVersion: 2,
      changes: [{ offset: 0, length: 0, text: '暂停期输入' }],
    })
    assert(doc.getText() === afterExternal, '暂停期间不得写回权威文档')
    const afterState = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterState.appliedEdits === appliedBefore, `暂停期间不得 applyEdit，实际 ${afterState.appliedEdits}`)

    // 恢复：resumePanel 发 doc.resync，webview 解除暂停并恢复写回
    const resumed = (await vscode.commands.executeCommand(CMD.resumePanel, uri)) as boolean
    assert(resumed === true, 'resumePanel 应成功')
    const recovered = await waitViewState('conflict.md', (v) => v.suspended !== true && v.text === afterExternal)
    assert(recovered.suspended !== true, '恢复后视图不应处于暂停')
    const versionNow = ((await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState).version
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 3,
      baseVersion: versionNow,
      changes: [{ offset: 0, length: 0, text: '恢复后输入' }],
    })
    await poll('恢复后写回生效', () => (doc.getText() === `恢复后输入${afterExternal}` ? true : undefined))
    const conflictAfter = (await vscode.commands.executeCommand(CMD.conflictState, uri)) as ConflictState
    assert(conflictAfter.suspended === false, '恢复后不应处于暂停')
  }],

  ['真实 DOM 中文候选连续替换确认后正常写回并保存', async () => {
    const filename = 'ime-dom-commit.md'
    await vscode.workspace.fs.writeFile(wsUri(filename), Buffer.from('A文B\n'))
    await openWithEditor(filename)
    await waitSessionReady(filename)
    const uri = wsUri(filename).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(filename))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sync.test.composition', phase: 'start', text: '' })
    for (const candidate of ['n', 'ni', 'nih', 'nihao', '你好']) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sync.test.composition', phase: 'update', text: 'A' + candidate + 'B' })
      await waitViewState(filename, (v) => v.text === 'A' + candidate + 'B\n')
    }
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sync.test.composition', phase: 'end', text: '你好' })
    await poll('中文候选确认后权威文档一致', () => doc.getText() === 'A你好B\n' ? true : undefined)
    const state = await waitViewState(filename, (v) => v.text === 'A你好B\n')
    assert(state.suspended !== true, '真实 DOM 中文候选确认不得暂停写回')
    assert(await doc.save(), '中文文本应正常落盘')
    const bytes = await vscode.workspace.fs.readFile(wsUri(filename))
    assert(Buffer.from(bytes).toString('utf8') === 'A你好B\n', '保存后回读中文一致')
  }],

  ['外部替换与过期本地删除同区间：真实 1.86 宿主保留外部文本并暂停（#44）', async () => {
    await openWithEditor('ime-escape.md')
    const initial = await waitSessionReady('ime-escape.md')
    const uri = wsUri('ime-escape.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('ime-escape.md'))
    const external = new vscode.WorkspaceEdit()
    external.replace(wsUri('ime-escape.md'), new vscode.Range(0, 1, 0, 2), '外')
    assert(await vscode.workspace.applyEdit(external), '外部替换应成功')
    const authoritative = 'A外B\n'
    await poll('外部替换进入宿主文档', () => (doc.getText() === authoritative ? true : undefined))

    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request', sessionId: '', docUri: uri, seq: 1,
      baseVersion: initial.version,
      changes: [{ offset: 1, length: 1, text: '' }],
    })
    assert(doc.getText() === authoritative, '过期的同区间删除不得覆盖外部修改')
    const conflict = (await vscode.commands.executeCommand(CMD.conflictState, uri)) as ConflictState
    assert(conflict.found && conflict.suspended === true, `同区间真实重叠应暂停：${JSON.stringify(conflict)}`)
    await waitViewState('ime-escape.md', (v) => v.suspended === true && v.text === authoritative)
  }],

  ['冲突后输入立即留存：关闭面板通知含最后一笔（#21）', async () => {
    await openWithEditor('conflict.md')
    await waitSessionReady('conflict.md')
    const uri = wsUri('conflict.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('conflict.md'))
    const external = new vscode.WorkspaceEdit()
    external.replace(wsUri('conflict.md'), new vscode.Range(0, 0, 0, 7), '外部改写行')
    assert(await vscode.workspace.applyEdit(external), '制造冲突的外部编辑应成功')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 2, length: 2, text: '未确认输入' }],
    })
    const suspended = await waitViewState('conflict.md', (v) => v.suspended === true)
    const latest = `最后一笔${suspended.text}`
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit', offset: 0, text: '最后一笔', closeAfter: true,
    })
    // webview 同一事件内编辑并请求关闭；不预等宿主快照，以覆盖旧 500 ms 空窗。
    assert(doc.getText() !== latest, '暂停期输入不得写回权威文档')
    const closed = await poll('关闭通知携带最新输入', async () => {
      const state = (await vscode.commands.executeCommand(CMD.closedInput)) as
        | { docUri: string; webviewText?: string } | undefined
      return state?.docUri === uri ? state : undefined
    })
    assert(closed.webviewText === latest, `关闭通知缺最后一笔：${JSON.stringify(closed)}`)
  }],

  ['split 双面板冲突暂停只隔离冲突面板，第二面板正常写回（#4）', async () => {
    await openWithEditor('splitconflict.md')
    await waitSessionReady('splitconflict.md')
    await openWithEditor('splitconflict.md', true)
    await poll('双面板就绪', async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('splitconflict.md').toString())) as SessionState | undefined
      return state && state.panels.filter((p) => p.ready).length >= 2 ? state : undefined
    })
    const uri = wsUri('splitconflict.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('splitconflict.md'))

    // 外部修改第二行（LF [7,7+6) '分裂测试行二' → '外部第二行'）
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('splitconflict.md'), new vscode.Range(1, 0, 1, 6), '外部第二行')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const afterExternal = '分裂测试行一\n外部第二行\n'
    await poll('外部修改生效', () => (doc.getText() === afterExternal ? true : undefined))

    // 面板 1 注入过期冲突请求（区间落入被替换的第二行）：暂停只作用于面板 1
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 9, length: 2, text: '面板一输入' }],
    }, 0)
    const p1 = (await vscode.commands.executeCommand(CMD.conflictState, uri, 0)) as ConflictState
    assert(p1.found && p1.suspended === true, `面板 1 应暂停：${JSON.stringify(p1)}`)
    assert(doc.getText() === afterExternal, '权威文本不被过期请求污染')

    // 面板 2 的正常编辑仍可应用（广播同步面板 1，其暂停期忽略增量属预期）
    const versionNow = ((await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState).version
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: versionNow,
      changes: [{ offset: 0, length: 0, text: '二面板前缀' }],
    }, 1)
    await poll('面板 2 编辑生效', () => (doc.getText() === `二面板前缀${afterExternal}` ? true : undefined))
    const p2 = (await vscode.commands.executeCommand(CMD.conflictState, uri, 1)) as ConflictState
    assert(p2.found && p2.suspended === false, `面板 2 不应受冲突影响：${JSON.stringify(p2)}`)
    // 面板 2（真实 webview）视图保持可用：未进入暂停，且仍持有外部修改后的
    // 权威文本（注入路径面板 2 自身不回显，其文本来自外部变更广播）
    const v2 = await waitViewState('splitconflict.md', (v) => v.suspended !== true && v.text === afterExternal, 1)
    assert(v2.suspended !== true, '面板 2 视图不应处于暂停')
    assert(v2.text === afterExternal, `面板 2 文本应与权威一致：${JSON.stringify(v2.text)}`)
  }],

  ['标题装饰：光标位于标题正文时显示标记，其他标题隐藏标记', async () => {
    await openWithEditor('heading.md')
    await waitSessionReady('heading.md')
    // 光标初始在文档头的 # 标记处：该标记显形，另一标题的标记隐藏
    const view = await waitViewState('heading.md', (v) => (v.headingLineCount ?? 0) >= 2 && v.paint?.heading != null)
    assert((view.headingActiveText ?? '').startsWith('#'), `光标贴近的标题标记应显形（# 开头）：${JSON.stringify(view.headingActiveText)}`)
    assert((view.headingHiddenText ?? '').startsWith('#') === false, `另一标题标记应隐藏（不以 # 开头）：${JSON.stringify(view.headingHiddenText)}`)
    assert((view.headingHiddenText ?? '') === '中部二级标题', `另一标题行 DOM 文本应为标题内容：${JSON.stringify(view.headingHiddenText)}`)

    // #55 绘制层断言：标题行开头不绘制左缘竖线。正向控制先行——标题字号
    // 须实际大于正文字号（样式注入失效时控制先失败，左缘断言才有意义）
    const bodyFontPx = view.typography?.live?.fontSizePx
    assert(bodyFontPx != null && (view.headingFontPx ?? 0) > bodyFontPx,
      `正向控制失败：标题字号应大于正文（标题=${view.headingFontPx}px，正文=${bodyFontPx}px；样式注入失效会让左缘断言失去意义）`)
    const headingPaint = view.paint!.heading!
    assert(headingPaint.inviewCount >= 2,
      `视口内应挂载至少 2 个标题行（H1/H2）供绘制观测，实际 ${headingPaint.inviewCount}`)
    assert(JSON.stringify(headingPaint.boxShadowValues) === JSON.stringify(['none']),
      `标题行不得以 box-shadow 绘制左缘竖线：${JSON.stringify(headingPaint.boxShadowValues)}`)
    assert(JSON.stringify(headingPaint.borderLeftWidthValues) === JSON.stringify(['0px']),
      `标题行不得以 border-left 绘制左缘竖线：${JSON.stringify(headingPaint.borderLeftWidthValues)}`)

    const uri = wsUri('heading.md').toString()
    const bodyOffset = '# 顶部'.length
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: bodyOffset })
    const inBody = await poll('标题正文光标显形行首标记', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.selectionOffset === bodyOffset ? v : undefined
    })
    assert((inBody.headingActiveText ?? '').startsWith('#'), `光标在标题正文时 # 应保持显形：${JSON.stringify(inBody.headingActiveText)}`)
    // 光标位于标题正文时左缘同样无竖线（光标内外一致）
    const inBodyPaint = inBody.paint?.heading
    assert(inBodyPaint != null &&
      JSON.stringify(inBodyPaint.boxShadowValues) === JSON.stringify(['none']) &&
      JSON.stringify(inBodyPaint.borderLeftWidthValues) === JSON.stringify(['0px']),
      `光标在标题正文时标题行也不得绘制左缘竖线：${JSON.stringify(inBodyPaint)}`)

    // 外部编辑把普通行改成标题：装饰随文本增量更新（doc.changed 广播路径）
    const before = view.headingLineCount ?? 0
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('heading.md'), new vscode.Range(1, 0, 1, 9), '## 改后二级标题')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const updated = await waitViewState('heading.md', (v) => (v.headingLineCount ?? 0) === before + 1)
    assert((updated.headingLineCount ?? 0) === before + 1, '外部把普通行改为标题后，DOM 标题行应 +1')
    // 文档文本同时同步（同步与装饰互不干扰）
    assert(updated.text.includes('## 改后二级标题'), '装饰更新不影响文本同步')
  }],

  ['视口有界：10 万行内容 DOM 不超过 1 千行样例的 2 倍（#5）', async () => {
    const domCounts: Record<string, number> = {}
    const rendered: Record<string, number> = {}
    for (const file of ['perf-1k.md', 'perf-100k.md']) {
      await openWithEditor(file)
      await waitSessionReady(file)
      const totalLines = file === 'perf-1k.md' ? 1_000 : 100_000
      const v = await waitViewState(file, (s) => (s.contentDomCount ?? -1) > 0 && s.renderedLines > 0)
      // 全文模型承载全文；视口只渲染附近行（CM6 全文虚拟渲染不因装饰破坏）
      assert(v.lineCount >= totalLines, `${file} 全文模型行数应 >= ${totalLines}，实际 ${v.lineCount}`)
      assert(v.renderedLines > 0 && v.renderedLines < 2000, `${file} 视口渲染行数应有界，实际 ${v.renderedLines}`)
      domCounts[file] = v.contentDomCount ?? 0
      rendered[file] = v.renderedLines
    }
    // 体量增长 100 倍（1k → 100k），内容 DOM 数不超过 2 倍
    assert(
      domCounts['perf-100k.md'] <= 2 * domCounts['perf-1k.md'],
      `内容 DOM 数超界：1k=${domCounts['perf-1k.md']}，100k=${domCounts['perf-100k.md']}`,
    )
  }],

  ['滚动回收与输入路径：往返滚动 10 次后 DOM 回到基线附近，键入重扫与体量无关（#5）', async () => {
    await openWithEditor('perf-100k.md')
    await waitSessionReady('perf-100k.md')
    await waitViewState('perf-100k.md', (v) => (v.contentDomCount ?? -1) > 0)
    const report = (await vscode.commands.executeCommand(
      CMD.perfProbe,
      wsUri('perf-100k.md').toString(),
      { typingRounds: 30, scrollRounds: 10 },
    )) as PerfReportData | undefined
    assert(report, '性能探针应产生报告')
    // 回收：滚动结束后回顶，DOM 应回到基线附近（允许 1.5 倍测量抖动）
    assert(
      report.afterScroll.contentDomCount <= Math.ceil(report.baseline.contentDomCount * 1.5),
      `滚动后 DOM 未回收：基线 ${report.baseline.contentDomCount}，滚动后 ${report.afterScroll.contentDomCount}`,
    )
    // 键入路径增量：单字符插入的重扫行数与 10 万行体量无关（远小于全文）
    assert(
      report.headingStats.lastUpdateScannedLines <= 3,
      `键入重扫行数应与体量无关（<=3），实际 ${report.headingStats.lastUpdateScannedLines}`,
    )
    assert(report.headingStats.fullBuildLines >= 100_000, `初始全量构建应覆盖全文，实际 ${report.headingStats.fullBuildLines}`)
    // 输入延迟宽松上限（防极端回归；精确数据由 test/perf/runPerf.mjs 记录）
    assert(report.inputDelayMs.maxMs > 0 && report.inputDelayMs.maxMs < 500, `单次输入稳定耗时应 <500ms，实际 ${report.inputDelayMs.maxMs}ms`)
    // 探针不产生写回：宿主文档无 dirty 变化
    const doc = await vscode.workspace.openTextDocument(wsUri('perf-100k.md'))
    assert(!doc.isDirty, '性能探针不应污染宿主文档')
  }],

  // ---- 工单 #6：模式切换 / 源锚点 / 稳定样式契约 ----

  ['阅读模式一级标题字号与实时预览接近（#30）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const live = await waitViewState('mode.md', (v) => v.viewMode === 'live' && (v.headingFontPx ?? 0) > 0)
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await waitViewState('mode.md', (v) => v.viewMode === 'reading' && (v.headingFontPx ?? 0) > 0)
    const ratio = reading.headingFontPx! / live.headingFontPx!
    assert(ratio >= 0.85 && ratio <= 1.15,
      `一级标题字号差距过大：live=${live.headingFontPx}px，reading=${reading.headingFontPx}px，倍率=${ratio.toFixed(2)}`)
  }],

  ['模式切换：命令入口切换、未保存内容保留、不产生编辑历史（#6）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const uri = wsUri('mode.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('mode.md'))
    const diskBefore = await readDisk('mode.md')

    const liveView = await waitViewState('mode.md', (v) => v.viewMode === 'live')
    assert(liveView.viewMode === 'live', '初始应为实时预览模式')

    // 一笔未保存编辑：外部 applyEdit 写权威文档（dirty 未保存）并广播
    // doc.changed——真实 webview 经此同步到编辑后文本（注入 edit.request
    // 路径下真实面板不本地回显，无法验证未保存内容保留）
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('mode.md'), new vscode.Range(0, 0, 0, 0), '未保存新段落\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const editedText = `未保存新段落\n\n${MODE_DOC_TEXT}`
    await poll('编辑生效', () => (doc.getText() === editedText ? true : undefined))
    await waitViewState('mode.md', (v) => v.text === editedText)
    assert(doc.isDirty, '编辑后文档应 dirty（未保存）')
    const stateAfterEdit = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 正式命令切换到阅读模式（活动 tab 为本编辑器）
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const readingView = await poll('切换到阅读模式', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' ? v : undefined
    })
    // 未保存内容保留：阅读视图展示同一未保存文本
    assert(readingView.text === editedText, `阅读模式文本应为未保存全文：${JSON.stringify(readingView.text.slice(0, 40))}…`)
    assert((readingView.readingBlockCount ?? 0) >= 6, `阅读块数应 >=6（标题/段落/列表/任务/代码块），实际 ${readingView.readingBlockCount}`)
    // 切换不产生编辑历史、不触发保存
    const stateAfterToggle = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(stateAfterToggle.version === stateAfterEdit.version, `切换不得改变文档版本（${stateAfterEdit.version} → ${stateAfterToggle.version}）`)
    assert(stateAfterToggle.appliedEdits === stateAfterEdit.appliedEdits, `切换不得产生 applyEdit（${stateAfterEdit.appliedEdits} → ${stateAfterToggle.appliedEdits}）`)
    assert(doc.isDirty, '切换后文档仍应 dirty（未触发保存）')
    const diskMid = await readDisk('mode.md')
    assert(diskMid === diskBefore, '切换不得写磁盘')

    // 切回实时预览：内容与光标语义保留（三态命令显式指定目标，#38 起循环
    // 命令在 reading 态会切源码编辑器，回 live 须用显式命令）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive')
    const backView = await poll('切回实时预览', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'live' ? v : undefined
    })
    assert(backView.text === editedText, '切回实时预览后未保存内容不丢失')

    // 切换不在撤销栈：一次 undo 恰好回退那笔编辑（期间经历了 2 次模式切换）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('undo 回退唯一一笔编辑', () => (doc.getText() === MODE_DOC_TEXT ? true : undefined))
    assert(doc.getText() === MODE_DOC_TEXT, 'undo 应回到编辑前原文（切换未入撤销栈）')
  }],

  ['模式切换锚点：以源码位置锚点恢复段落与光标，非滚动百分比（#6）', async () => {
    await openWithEditor('mode-anchor.md')
    await waitSessionReady('mode-anchor.md')
    const uri = wsUri('mode-anchor.md').toString()

    // 初始光标在文档首（offset 0）
    const initial = await waitViewState('mode-anchor.md', (v) => v.selectionOffset !== undefined)
    assert(initial.selectionOffset === 0, `初始光标应在 0，实际 ${initial.selectionOffset}`)

    // 经 view.locate（#10 查找/跳转入口）把光标定位到第三段块首：
    // '模式锚点第一段文字\n\n中间段落文本\n\n' 长度 21
    const target = '模式锚点第一段文字\n\n中间段落文本\n\n'.length
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: target })
    const located = await poll('view.locate 定位光标', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.selectionOffset === target ? v : undefined
    })
    assert(located.selectionOffset === target, `定位后光标应在 ${target}，实际 ${located.selectionOffset}`)

    // 切到阅读：锚点映射到包含 target 的块（'最后段落结束' start=21）
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const readingView = await poll('阅读模式锚点', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingAnchorStart !== undefined ? v : undefined
    })
    assert(readingView.readingAnchorStart === target, `阅读锚点应为源块 start=${target}，实际 ${readingView.readingAnchorStart}`)
    assert(readingView.readingBlockCount === 3, `锚点文档应 3 块，实际 ${readingView.readingBlockCount}`)
    assert(readingView.text.includes('最后段落结束'), '阅读视图文本同步')

    // 切回实时预览：光标恢复到锚点块源 start（对应段落与光标，非百分比；
    // #38 起回 live 用显式命令，循环命令在 reading 态会切源码编辑器）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive')
    const backView = await poll('恢复光标', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'live' && v.selectionOffset === target ? v : undefined
    })
    assert(backView.selectionOffset === target, `切回后光标应恢复 ${target}，实际 ${backView.selectionOffset}`)
    // 全程无写回（定位与切换都不产生编辑历史）
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, `锚点链路不应产生写回，实际 ${st.appliedEdits}`)
  }],

  ['稳定样式契约：内部测试 CSS 片段经稳定类名/变量命中两种视图（#6）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const uri = wsUri('mode.md').toString()

    // live：探针片段经 .vsidian-heading-line-1 命中（text-decoration-color 无视觉影响）
    const liveView = await waitViewState('mode.md', (v) => v.cssProbe?.liveHeadingDecorationColor !== undefined && v.viewMode === 'live')
    assert(
      liveView.cssProbe!.liveHeadingDecorationColor === 'rgb(1, 2, 3)',
      `live 一级标题应被测试片段命中 rgb(1, 2, 3)，实际 ${liveView.cssProbe!.liveHeadingDecorationColor}`,
    )

    // reading：.vsidian-reading-heading-1 命中 + .vsidian-view-reading 变量可被覆盖读取
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const readingView = await poll('阅读模式样式探针', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.cssProbe?.readingHeadingDecorationColor !== undefined ? v : undefined
    })
    assert(
      readingView.cssProbe!.readingHeadingDecorationColor === 'rgb(4, 5, 6)',
      `阅读一级标题应被测试片段命中 rgb(4, 5, 6)，实际 ${readingView.cssProbe!.readingHeadingDecorationColor}`,
    )
    assert(
      readingView.cssProbe!.readingVarProbe === 'contract-ok',
      `阅读容器探针变量应被外部片段覆盖为 contract-ok，实际 ${readingView.cssProbe!.readingVarProbe}`,
    )
  }],

  ['webview 重载后恢复阅读模式（webview 状态持久化，#6）', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const uri = wsUri('mode.md').toString()

    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('进入阅读模式', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' ? true : undefined
    })

    // 重载 webview（Developer: Reload Webviews；retainContextWhenHidden 关闭：
    // 销毁重建同一 panel，走 getState 恢复）
    await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction')
    const restored = await poll('重载后恢复阅读模式', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.text === MODE_DOC_TEXT && (v.readingBlockCount ?? 0) > 0 ? v : undefined
    }, 30000)
    assert(restored.viewMode === 'reading', '重载后应恢复阅读模式')
    assert((restored.readingBlockCount ?? 0) >= 6, '重载后阅读视图应重建块结构')
  }],

  // ---- 工单 #7：阅读视图分块按需挂载与回收 ----

  ['阅读视图按需挂载：长文档只挂载窗口内块，屏外块无内容节点（#7）', async () => {
    await openWithEditor('reading-1k.md')
    await waitSessionReady('reading-1k.md')
    const uri = wsUri('reading-1k.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const view = await poll('切换并虚拟化', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? v : undefined
    })
    // 1000 块只挂载窗口：挂载量远小于块模型总量，容器元素数有界
    assert((view.readingTotalBlocks ?? 0) === 1000, `块模型应为 1000 块，实际 ${view.readingTotalBlocks}`)
    assert((view.readingMountedBlocks ?? 0) > 10, `挂载块数应非平凡（>10），实际 ${view.readingMountedBlocks}`)
    assert(
      (view.readingMountedBlocks ?? 0) < (view.readingTotalBlocks ?? 1) / 2,
      `挂载块数应远小于总量（按需挂载非全量渲染），实际 ${view.readingMountedBlocks}/${view.readingTotalBlocks}`,
    )
    assert((view.readingContentDomCount ?? 0) < (view.readingTotalBlocks ?? 1), '容器元素数应小于块总数')
    // 挂载块数即 DOM 块数（无隐藏副本）
    assert(view.readingBlockCount === view.readingMountedBlocks, 'readingBlockCount 应等于挂载块数（无隐藏整篇）')
  }],

  ['阅读视图 DOM 有界：体量增长 100 倍内容 DOM 不超过 2 倍（#7）', async () => {
    const domCounts: Record<string, number> = {}
    const mounted: Record<string, number> = {}
    for (const file of ['reading-1k.md', 'reading-100k.md']) {
      await openWithEditor(file)
      await waitSessionReady(file)
      const uri = wsUri(file).toString()
      await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
      const v = await poll(`切换并虚拟化 ${file}`, async () => {
        const s = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
        return s?.viewMode === 'reading' && s.readingVirtualized === true ? s : undefined
      })
      const total = file === 'reading-1k.md' ? 1_000 : 100_000
      assert((v.readingTotalBlocks ?? 0) === total, `${file} 块模型应为 ${total}，实际 ${v.readingTotalBlocks}`)
      assert((v.readingMountedBlocks ?? 0) > 0, `${file} 应有挂载块`)
      domCounts[file] = v.readingContentDomCount ?? 0
      mounted[file] = v.readingMountedBlocks ?? 0
    }
    // 体量增长 100 倍（1k → 100k 块），内容 DOM 数不超过 2 倍
    assert(
      domCounts['reading-100k.md'] <= 2 * domCounts['reading-1k.md'],
      `阅读内容 DOM 超界：1k=${domCounts['reading-1k.md']}，100k=${domCounts['reading-100k.md']}`,
    )
    assert(
      mounted['reading-100k.md'] <= 2 * mounted['reading-1k.md'],
      `挂载块数超界：1k=${mounted['reading-1k.md']}，100k=${mounted['reading-100k.md']}`,
    )
  }],

  ['阅读视图滚动回收：往返滚动 10 次回基线附近且零重复解析、零写回（#7）', async () => {
    await openWithEditor('reading-100k.md')
    await waitSessionReady('reading-100k.md')
    const uri = wsUri('reading-100k.md').toString()
    const sessionBefore = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('切换并虚拟化', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? true : undefined
    })
    const report = (await vscode.commands.executeCommand(
      CMD.readingPerf,
      uri,
      { scrollRounds: 10 },
    )) as ReadingPerfReportData | undefined
    assert(report && report.ok === true, `阅读探针应成功执行：${JSON.stringify(report)}`)
    assert(report!.totalBlocks === 100_000, `块模型应为 100000，实际 ${report!.totalBlocks}`)
    // 回收：滚动结束回顶，挂载块回到基线附近（允许 1.5 倍测量抖动）
    assert(
      report!.afterScroll.mountedBlocks <= Math.ceil(report!.baseline.mountedBlocks * 1.5),
      `滚动后挂载块未回收：基线 ${report!.baseline.mountedBlocks}，滚动后 ${report!.afterScroll.mountedBlocks}`,
    )
    assert(
      report!.afterScroll.contentDomCount <= Math.ceil(report!.baseline.contentDomCount * 1.5),
      `滚动后 DOM 未回收：基线 ${report!.baseline.contentDomCount}，滚动后 ${report!.afterScroll.contentDomCount}`,
    )
    assert(report!.afterScroll.scrollTopPx === 0, `回顶后 scrollTop 应为 0，实际 ${report!.afterScroll.scrollTopPx}`)
    // 解析与挂载分离：10 轮滚动全程解析次数不增（装载时 1 次）
    assert(report!.parseCount === 1, `滚动不得触发全文重解析，解析次数应为 1，实际 ${report!.parseCount}`)
    // 窗口有界：滚动全程最大挂载块数远小于块模型总量
    assert(report!.maxMountedBlocks < 1000, `最大挂载块数应有界（<1000），实际 ${report!.maxMountedBlocks}`)
    // 视图滚动零写回：文档版本与 applyEdit 数不变
    const sessionAfter = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(sessionAfter.version === sessionBefore.version, `滚动不得改变文档版本（${sessionBefore.version} → ${sessionAfter.version}）`)
    assert(sessionAfter.appliedEdits === sessionBefore.appliedEdits, `滚动不得产生写回（${sessionBefore.appliedEdits} → ${sessionAfter.appliedEdits}）`)
  }],

  ['阅读视图标题跳转：定位屏外标题块并真实挂载（#7）', async () => {
    await openWithEditor('reading-100k.md')
    await waitSessionReady('reading-100k.md')
    const uri = wsUri('reading-100k.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('切换并虚拟化', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? true : undefined
    })
    // 文档尾部附近的标题块（第 99950 块，屏外；不取最后一块——末块的理想
    // 滚动位置超出 maxScroll，浏览器 clamp 后无法置于视口顶，属正常布局行为）
    const headingText = '## 第 99950 节 阅读标题样本行'
    const doc = await vscode.workspace.openTextDocument(wsUri('reading-100k.md'))
    const headingOffset = doc.getText().indexOf(headingText)
    assert(headingOffset > 0, 'fixture 中应能找到末尾标题')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: headingOffset + 3 })
    const located = await poll('定位屏外标题', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.readingAnchorStart === headingOffset ? v : undefined
    })
    // 锚点是源码位置（标题块的源 start），且目标块已真实挂载（有布局顶位置）
    assert(located.readingAnchorStart === headingOffset, `锚点应为标题块 start=${headingOffset}，实际 ${located.readingAnchorStart}`)
    assert(located.readingAnchorTopPx !== undefined, '定位后目标块应已挂载（有布局顶位置）')
    assert((located.readingScrollTopPx ?? 0) > 0, `定位到文档尾部应发生滚动，实际 scrollTop=${located.readingScrollTopPx}`)
    // 仍保持按需挂载（定位不触发全量渲染）
    assert((located.readingMountedBlocks ?? 0) < (located.readingTotalBlocks ?? 1), '定位后仍应只挂载窗口块')
  }],

  ['阅读视图动态图片尺寸变化：布局偏移后锚点视觉位置稳定（#7）', async () => {
    await openWithEditor('reading-image.md')
    await waitSessionReady('reading-image.md')
    const uri = wsUri('reading-image.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('切换并虚拟化', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? true : undefined
    })
    // 定位到第 201 块（中部段落；每 50 块是标题，201 为普通段落）
    const anchorText = '第 201 段 阅读段落样本文本，固定宽度内容，用于体量对比测试。'
    const doc = await vscode.workspace.openTextDocument(wsUri('reading-image.md'))
    const anchorOffset = doc.getText().indexOf(anchorText)
    assert(anchorOffset > 0, 'fixture 中应能找到锚点段')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: anchorOffset })
    const before = await poll('定位锚点段', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.readingAnchorStart === anchorOffset && v.readingAnchorTopPx !== undefined ? v : undefined
    })
    // 注入图片到锚点上方 10 块（普通段落，仍在挂载窗口内、位于视口上方）：20px → 240px
    const imageText = '第 191 段 阅读段落样本文本，固定宽度内容，用于体量对比测试。'
    const imageOffset = doc.getText().indexOf(imageText)
    const grow = 240 // 初始占位 20px + 加载后增长 220px = 内容总高增量
    const ok = (await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'reading.test.image',
      srcStart: imageOffset,
      initialHeightPx: 20,
      finalHeightPx: 240,
      delayMs: 200,
    })) as boolean
    assert(ok === true, '图片注入消息应送达面板')
    const after = await poll('图片尺寸变化生效', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      const grew = (v?.readingScrollHeightPx ?? 0) - (before.readingScrollHeightPx ?? 0)
      return v && grew >= grow - 4 ? v : undefined
    }, 15000)
    // 源位置锚点不变（仍是同一块的 start）
    assert(after.readingAnchorStart === anchorOffset, `图片变化后锚点块不应漂移：${before.readingAnchorStart} → ${after.readingAnchorStart}`)
    // 视觉位置稳定：锚点块顶与 scrollTop 的差保持不变（上方内容增高由滚动补偿）
    const offsetBefore = (before.readingAnchorTopPx ?? 0) - (before.readingScrollTopPx ?? 0)
    const offsetAfter = (after.readingAnchorTopPx ?? 0) - (after.readingScrollTopPx ?? 0)
    assert(
      Math.abs(offsetAfter - offsetBefore) <= 2,
      `图片增高 ${grow}px 后锚点视觉位置应稳定：${offsetBefore} → ${offsetAfter}`,
    )
    // 内容总高按图片增量增长（高度表已按实测修正）
    const grew = (after.readingScrollHeightPx ?? 0) - (before.readingScrollHeightPx ?? 0)
    assert(Math.abs(grew - grow) <= 4, `内容总高应增长约 ${grow}px，实际 ${grew}`)
    // 零写回
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, `图片尺寸变化链路不应产生写回，实际 ${st.appliedEdits}`)
  }],

  // ---- 工单 #8：基础 Markdown 双模式显示与源码降级 ----

  ['双模式语义一致：live 装饰与 reading 渲染对同一样例语义相同（#8）', async () => {
    await openWithEditor('syntax.md')
    await waitSessionReady('syntax.md')
    const uri = wsUri('syntax.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('syntax.md'))
    const diskBefore = doc.getText()

    // live 侧：语法装饰统计（装饰集合级计数，与 DOM 无关）
    const live = await waitViewState('syntax.md', (v) => (v.liveSyntax?.headingLines ?? 0) >= 2)
    const ls = live.liveSyntax!
    // 样例语义：3 个标题（h1/h2/setext-h1）+ frontmatter 3 行 + 1 粗 + 1 斜 +
    // 1 行内码 + 2 引用行 + 3 围栏行 + 5 列表行（3 无序 + 2 有序）+ 1 HR +
    // 2 任务（1 勾选）；frontmatter 内伪标题不计入
    assert(ls.headingLines === 3, `标题行应为 3，实际 ${ls.headingLines}`)
    assert(ls.headerSpans === 3, `标题内容 span 应为 3，实际 ${ls.headerSpans}`)
    assert(ls.frontmatterLines === 4, `frontmatter 行应为 4，实际 ${ls.frontmatterLines}`)
    assert(ls.strongSpans === 2, `粗体 span 应为 2（正文+引用内），实际 ${ls.strongSpans}`)
    assert(ls.emphasisSpans === 1, `斜体 span 应为 1，实际 ${ls.emphasisSpans}`)
    assert(ls.inlineCodeSpans === 1, `行内代码 span 应为 1，实际 ${ls.inlineCodeSpans}`)
    assert(ls.quoteLines === 2, `引用行应为 2，实际 ${ls.quoteLines}`)
    assert(ls.codeLines === 3, `围栏代码行应为 3，实际 ${ls.codeLines}`)
    assert(ls.listLines === 5, `列表行应为 5，实际 ${ls.listLines}`)
    assert(ls.hrLines === 1, `水平线行应为 1，实际 ${ls.hrLines}`)
    assert(ls.taskGlyphs === 2 && ls.taskChecked === 1, `任务字形应为 2（1 勾选），实际 ${ls.taskGlyphs}/${ls.taskChecked}`)

    // reading 侧：同一样例的渲染语义
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('切换并读取阅读语义', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingSyntax !== undefined && v.readingSyntax.headings >= 3 ? v : undefined
    })
    const rs = reading.readingSyntax!
    assert(rs.headings === 3, `阅读标题应为 3，实际 ${rs.headings}`)
    assert(rs.strongCount === 2, `阅读粗体应为 2，实际 ${rs.strongCount}`)
    assert(rs.emphasisCount === 1, `阅读斜体应为 1，实际 ${rs.emphasisCount}`)
    assert(rs.inlineCodeCount === 1, `阅读行内代码应为 1（pre 内 code 不计），实际 ${rs.inlineCodeCount}`)
    assert(rs.blockquoteBlocks === 1, `阅读引用块应为 1，实际 ${rs.blockquoteBlocks}`)
    assert(rs.codeBlocks === 1, `阅读围栏块应为 1，实际 ${rs.codeBlocks}`)
    assert(rs.hrCount === 1, `阅读水平线应为 1（frontmatter 的 --- 不计），实际 ${rs.hrCount}`)
    assert(rs.listItems === 5, `阅读列表项应为 5，实际 ${rs.listItems}`)
    assert(rs.taskCheckboxes === 2 && rs.taskChecked === 1, `阅读任务勾选框应为 2（1 勾选），实际 ${rs.taskCheckboxes}/${rs.taskChecked}`)
    // 转义的 \* 不产生斜体（两种视图一致的边界语义）
    assert(reading.text.includes('\\*不斜体\\*'), '源文转义序列应原样保留')

    // 全程零写回：显示与切换不改写文本
    assert(reading.text === diskBefore, '双模式显示不得改写文档文本')
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, `显示链路不应产生写回，实际 ${st.appliedEdits}`)
  }],

  ['代码内伪语法不误解析：围栏内 # / [[ / 任务标记按源码呈现（#8）', async () => {
    await openWithEditor('syntax.md')
    await waitSessionReady('syntax.md')
    const uri = wsUri('syntax.md').toString()
    const live = await waitViewState('syntax.md', (v) => (v.liveSyntax?.codeLines ?? 0) === 3)
    // 围栏内的 "# 伪标题"、"[[伪双链]]"、"- [ ] 伪任务" 不产生标题/任务装饰：
    // 标题恰好 3 个（不含围栏内），任务恰好 2 个（不含围栏内）
    assert(live.liveSyntax!.headingLines === 3, `围栏内伪标题被误判：标题行 ${live.liveSyntax!.headingLines}`)
    assert(live.liveSyntax!.taskGlyphs === 2, `围栏内伪任务被误判：任务字形 ${live.liveSyntax!.taskGlyphs}`)
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式语义', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingSyntax !== undefined ? v : undefined
    })
    assert(reading.readingSyntax!.headings === 3, `阅读侧围栏内伪标题被误判：${reading.readingSyntax!.headings}`)
    assert(reading.readingSyntax!.taskCheckboxes === 2, `阅读侧围栏内伪任务被误判：${reading.readingSyntax!.taskCheckboxes}`)
  }],

  ['未支持语法局部源码降级：保留文本、无整篇重写、HTML 不执行（#8）', async () => {
    await openWithEditor('syntax.md')
    await waitSessionReady('syntax.md')
    const uri = wsUri('syntax.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('syntax.md'))
    const disk = doc.getText()
    const live = await waitViewState('syntax.md', (v) => (v.liveSyntax?.headingLines ?? 0) === 3)
    // 脚注 [^1] 与原始 HTML 在 live 侧无任何装饰（不产生 span/隐藏）
    // ——liveSyntax 计数不含脚注/HTML 语法（其只按普通段落装饰为 0 类）
    assert(live.text.includes('脚注 [^1] 文本'), '脚注文本保留')
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式读取', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingSyntax !== undefined ? v : undefined
    })
    // 脚注按普通段落渲染（保留文本）；原始 HTML 被转义为纯文本（无脚本元素）
    assert(reading.text === disk, '阅读渲染不得改写文档文本（无整篇格式化重写）')
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, '源码降级不产生写回')
  }],

  ['frontmatter 边界：头块按源码呈现，内部伪标题在两种视图都不解析（#8）', async () => {
    await openWithEditor('syntax.md')
    await waitSessionReady('syntax.md')
    const uri = wsUri('syntax.md').toString()
    const live = await waitViewState('syntax.md', (v) => (v.liveSyntax?.frontmatterLines ?? 0) === 4)
    assert(live.liveSyntax!.frontmatterLines === 4, `frontmatter 应为 4 行，实际 ${live.liveSyntax!.frontmatterLines}`)
    // '# frontmatter 内伪标题' 不产生标题装饰（标题恰 3：h1/h2/setext）
    assert(live.liveSyntax!.headingLines === 3, 'frontmatter 内伪标题不得判定为标题')
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式 frontmatter', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingSyntax !== undefined ? v : undefined
    })
    // 阅读侧标题也恰 3（frontmatter 内伪标题不渲染为 h1）
    assert(reading.readingSyntax!.headings === 3, `阅读侧 frontmatter 伪标题误判：${reading.readingSyntax!.headings}`)
  }],

  ['稳定样式契约扩展：span 级类名经测试片段命中两种视图（#8）', async () => {
    await openWithEditor('syntax.md')
    await waitSessionReady('syntax.md')
    const uri = wsUri('syntax.md').toString()
    // live：视口内粗体/行内码/代码行（DOM 渲染限于视口，样例首屏含目标）
    const live = await waitViewState('syntax.md', (v) => v.cssProbe?.liveStrongDecorationColor !== undefined && v.viewMode === 'live')
    assert(
      live.cssProbe!.liveStrongDecorationColor === 'rgb(7, 8, 9)',
      `live 粗体 span 应被片段命中 rgb(7, 8, 9)，实际 ${live.cssProbe!.liveStrongDecorationColor}`,
    )
    assert(
      live.cssProbe!.liveInlineCodeDecorationColor === 'rgb(10, 11, 12)',
      `live 行内代码 span 应被片段命中，实际 ${live.cssProbe!.liveInlineCodeDecorationColor}`,
    )
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式样式探针', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.cssProbe?.readingStrongDecorationColor !== undefined ? v : undefined
    })
    assert(
      reading.cssProbe!.readingStrongDecorationColor === 'rgb(16, 17, 18)',
      `阅读语义 strong 应被片段命中，实际 ${reading.cssProbe!.readingStrongDecorationColor}`,
    )
  }],

  ['大围栏按行细分：120 行围栏切为多块按需挂载，仍保持零重复解析（#8）', async () => {
    await openWithEditor('fence-chunk.md')
    await waitSessionReady('fence-chunk.md')
    const uri = wsUri('fence-chunk.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const view = await poll('切换并虚拟化', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? v : undefined
    })
    // 块模型：标题 + 3 片围栏 + 结尾段 = 5 块（120 行围栏按 60 行阈值切 3 片）
    assert((view.readingTotalBlocks ?? 0) === 5, `块模型应为 5（围栏切 3 片），实际 ${view.readingTotalBlocks}`)
    assert((view.readingMountedBlocks ?? 0) < (view.readingTotalBlocks ?? 1), '只挂载窗口内块')
    assert((view.readingParseCount ?? 0) === 1, `装载解析应为 1 次，实际 ${view.readingParseCount}`)
    // 滚动到围栏中部：中间片挂载、首片回收（按需挂载对细分片生效）
    const doc = await vscode.workspace.openTextDocument(wsUri('fence-chunk.md'))
    const midFence = doc.getText().indexOf('围栏内第 90 行')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: midFence })
    const located = await poll('定位围栏中部', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v && (v.readingScrollTopPx ?? 0) > 0 ? v : undefined
    })
    assert((located.readingMountedBlocks ?? 0) <= (located.readingTotalBlocks ?? 1), '细分片不触发全量挂载')
    assert((located.readingParseCount ?? 0) === 1, '滚动/定位不得重新解析')
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, '大围栏细分链路零写回')
  }],

  // ---- 工单 #9：两种模式的任务勾选 ----

  ['任务勾选（live）：点击 checkbox 精确写回重复任务之一并可撤销（#9）', async () => {
    await openWithEditor('task.md')
    await waitSessionReady('task.md')
    const uri = wsUri('task.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('task.md'))

    // live 侧初始：3 个任务 checkbox（2 未勾选 + 1 已勾选）
    const live = await waitViewState('task.md', (v) => (v.liveSyntax?.taskGlyphs ?? 0) === 3)
    assert(live.liveSyntax!.taskChecked === 1, `初始勾选数应为 1，实际 ${live.liveSyntax!.taskChecked}`)

    // 点击第二个重复任务（task.test.click 驱动真实 webview 内同一点击处理器）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'task.test.click', view: 'live', index: 1 })
    await poll('live 勾选写回权威文档', () => (doc.getText() === TASK_DOC_SECOND_TOGGLED ? true : undefined))
    // 重复任务行：只有第二个被改写，第一个保持原样
    assert(doc.getText().split('\n')[2] === '- [ ] 未完成任务甲', '第一个重复任务不得被误改')
    // live 装饰统计跟随：2 勾选
    const afterToggle = await waitViewState('task.md', (v) => (v.liveSyntax?.taskChecked ?? 0) === 2)
    assert(afterToggle.liveSyntax!.taskGlyphs === 3, '任务数不变')
    assert(afterToggle.text === TASK_DOC_SECOND_TOGGLED, 'webview 文本与权威一致')

    // 撤销在两种视图一致：undo 回退唯一一笔勾选编辑
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('undo 回退勾选', () => (doc.getText() === TASK_DOC_TEXT ? true : undefined))
    const afterUndo = await waitViewState('task.md', (v) => v.text === TASK_DOC_TEXT)
    assert(afterUndo.liveSyntax!.taskChecked === 1, `undo 后勾选数应回到 1，实际 ${afterUndo.liveSyntax!.taskChecked}`)

    // 无内容变化的重渲染不新增历史：同文 resync 后写回计数不再增长
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 1, `勾选写回应恰好 1 笔，实际 ${st.appliedEdits}`)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'sync.request' })
    await waitViewState('task.md', (v) => v.text === TASK_DOC_TEXT)
    const stAfter = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(stAfter.appliedEdits === st.appliedEdits, `同文重渲染不得新增写回（${st.appliedEdits} → ${stAfter.appliedEdits}）`)
  }],

  ['任务勾选（reading）：阅读模式点击 checkbox 写回并撤销，其余内容只读（#9）', async () => {
    await openWithEditor('task.md')
    await waitSessionReady('task.md')
    const uri = wsUri('task.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('task.md'))

    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('进入阅读模式并读取任务语义', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && (v.readingSyntax?.taskCheckboxes ?? 0) === 3 ? v : undefined
    })
    assert(reading.readingSyntax!.taskChecked === 1, `阅读初始勾选数应为 1，实际 ${reading.readingSyntax!.taskChecked}`)

    // 点击第一个任务（未勾选 → 勾选）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'task.test.click', view: 'reading', index: 0 })
    const firstToggled = TASK_DOC_TEXT.replace('- [ ] 未完成任务甲', '- [x] 未完成任务甲')
    await poll('reading 勾选写回权威文档', () => (doc.getText() === firstToggled ? true : undefined))
    const afterToggle = await waitViewState('task.md', (v) => (v.readingSyntax?.taskChecked ?? 0) === 2)
    assert(afterToggle.text === firstToggled, '阅读视图文本与权威一致')
    assert(afterToggle.readingSyntax!.taskCheckboxes === 3, '任务数不变')

    // 撤销：阅读模式发起的勾选同样在权威历史中回退，视图跟随
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('undo 回退勾选', () => (doc.getText() === TASK_DOC_TEXT ? true : undefined))
    const afterUndo = await waitViewState('task.md', (v) => (v.readingSyntax?.taskChecked ?? 0) === 1)
    assert(afterUndo.readingSyntax!.taskChecked === 1, 'undo 后阅读勾选数回到 1')

    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 1, `阅读勾选写回应恰好 1 笔，实际 ${st.appliedEdits}`)
  }],

  ['任务样式契约：两种视图的 checkbox 稳定类名经测试片段命中（#9）', async () => {
    await openWithEditor('task.md')
    await waitSessionReady('task.md')
    const uri = wsUri('task.md').toString()

    // live：任务行在首屏且非活动（光标在标题行）→ checkbox 已渲染
    const live = await waitViewState('task.md', (v) => v.cssProbe?.liveTaskCheckboxDecorationColor !== undefined && v.viewMode === 'live')
    assert(
      live.cssProbe!.liveTaskCheckboxDecorationColor === 'rgb(19, 20, 21)',
      `live 任务 checkbox 应被测试片段命中 rgb(19, 20, 21)，实际 ${live.cssProbe!.liveTaskCheckboxDecorationColor}`,
    )

    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式任务样式探针', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.cssProbe?.readingTaskCheckboxDecorationColor !== undefined ? v : undefined
    })
    assert(
      reading.cssProbe!.readingTaskCheckboxDecorationColor === 'rgb(22, 23, 24)',
      `阅读任务 checkbox 应被测试片段命中 rgb(22, 23, 24)，实际 ${reading.cssProbe!.readingTaskCheckboxDecorationColor}`,
    )
    // 样式链路零写回
    const st = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(st.appliedEdits === 0, `样式探针链路不应产生写回，实际 ${st.appliedEdits}`)
  }],

  ['C-5：活动 tab 非本面板文档时 webview 的 undo 请求被忽略', async () => {
    await openWithEditor('undo3.md')
    const session = await waitSessionReady('undo3.md')
    const uri = wsUri('undo3.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('undo3.md'))
    const original = '撤销守卫甲行\n撤销守卫乙行\n'
    const edited = '撤销守卫甲行【写入】\n撤销守卫乙行\n'
    assert(doc.getText() === original, `初始文本不符：${JSON.stringify(doc.getText())}`)
    // 面板注入编辑：'撤销守卫甲行' 为 6 字符，行末插入点 LF offset 6
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: session.version,
      changes: [{ offset: 6, length: 0, text: '【写入】' }],
    })
    await poll('编辑写入宿主文档', () => (doc.getText() === edited ? true : undefined))

    // 活动编辑器切到原生文本编辑器（同一文档）：custom editor 面板不再是活动 tab
    await vscode.window.showTextDocument(doc)

    // webview 发起 undo：必须被忽略——宿主 undo 命令作用于活动编辑器，
    // 归属不符时执行会撤销到错误目标（VSCode undo 栈按文档资源）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await new Promise((r) => setTimeout(r, 1000))
    assert(doc.getText() === edited, `活动 tab 非本面板时 undo 不得执行，实际 ${JSON.stringify(doc.getText())}`)
    // 还原（编辑器关闭前的清理在 runner finally 统一处理）
    await doc.save()
  }],

  ['ack 与 doc.changed 到达顺序：确认后的外部增量版本更高且内容一致（B 观测）', async () => {
    await openWithEditor('ackorder.md')
    await waitSessionReady('ackorder.md')
    await openWithEditor('ackorder.md', true)
    await poll('双面板就绪', async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('ackorder.md').toString())) as SessionState | undefined
      return state && state.panels.filter((p) => p.ready).length >= 2 ? state : undefined
    })
    const uri = wsUri('ackorder.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('ackorder.md'))
    const base = '顺序观测起始行\n顺序观测第二行\n'

    // 面板 1 注入编辑 '甲' → 宿主确认（ack ok，权威 v2）；广播让面板 2 的
    // 真实 webview 同步（注入路径的编辑不经发起面板自身 webview 显示）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 0, length: 0, text: '甲' }],
    }, 0)
    const afterFirst = await poll('第一笔确认', async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState | undefined
      return state && doc.getText() === `甲${base}` ? state : undefined
    })
    assert(afterFirst.version > 1, '确认后权威版本应推进')

    // 外部修改（其他来源，两面板均为 doc.changed 广播）：在 v2 权威的
    // offset 1 插 '乙'。发起面板收到 ack 的版本是 v2，此后到达的 doc.changed
    // 版本必须更高（v3）——否则被版本防线丢弃后内容失配
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.insert(wsUri('ackorder.md'), new vscode.Position(0, 1), '乙')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    const expected = `甲乙${base}`
    await poll('外部修改写入权威', () => (doc.getText() === expected ? true : undefined))
    // 面板 2 经历完整广播链（'甲' + '乙'）：内容与权威一致
    const panel2 = await waitViewState('ackorder.md', (v) => v.text === expected, 1)
    assert(panel2.text === expected, `面板 2 应同步到权威文本：${JSON.stringify(panel2.text)}`)
    // 发起面板（面板 1）注入路径无自身回显，本地为 base；外部增量 v3 未被
    // 版本防线误丢、正确应用在本地文本上（base 的 offset 1 插 '乙'）
    const panel1Expected = `顺乙${base.slice(1)}`
    const panel1 = await waitViewState('ackorder.md', (v) => v.text === panel1Expected, 0)
    assert(panel1.text === panel1Expected, `面板 1 应正确应用外部增量：${JSON.stringify(panel1.text)}`)
    const finalState = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(finalState.version > afterFirst.version, `外部增量版本必须大于 ack 版本（${finalState.version} <= ${afterFirst.version}）`)
  }],

  // ---- 工单 #10：普通链接打开与本地/SSH 工作区图片显示 ----

  ['live 渲染链接真实 DOM 单击：普通链接与双链均跳转、源文零写回（#28）', async () => {
    await openWithEditor('links.md')
    await waitSessionReady('links.md')
    const linkUri = wsUri('links.md').toString()
    const linkBefore = await readDisk('links.md')
    await waitViewState('links.md', (v) => (v.liveLinkCount ?? 0) >= 2)
    await vscode.commands.executeCommand(CMD.postToPanel, linkUri, {
      kind: 'link.test.mousedown', target: 'link', index: 1,
    })
    await waitWikilinkLog(linkUri, (e) => e.kind === 'doc' && e.path === wsUri('链接目标.md').fsPath)
    assert(await readDisk('links.md') === linkBefore, 'live 普通链接单击不得改写源文')

    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const wikiUri = wsUri('wikilinks.md').toString()
    const wikiBefore = await readDisk('wikilinks.md')
    await waitViewState('wikilinks.md', (v) => (v.liveWikilinkCount ?? 0) >= 1)
    await vscode.commands.executeCommand(CMD.postToPanel, wikiUri, {
      kind: 'link.test.mousedown', target: 'wikilink', index: 0,
    })
    await waitWikilinkLog(wikiUri, (e) => e.kind === 'wikilink-doc' && e.target === '目标笔记')
    assert(await readDisk('wikilinks.md') === wikiBefore, 'live 双链单击不得改写源文')
  }],

  ['链接跳转：宿主解析相对路径并打开工作区目标（中文/空格/%20 编码，#10）', async () => {
    await openWithEditor('links.md')
    const session = await waitSessionReady('links.md')
    const uri = wsUri('links.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('进入阅读模式', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' ? true : undefined
    })
    const versionBefore = session.version
    const diskBefore = await readDisk('links.md')

    // 阅读单击链路的消息形态（webview 上报原始 URI + 块源锚点）：
    // 空格目录与中文文件名经 %20 编码，宿主解码解析到磁盘真实路径
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'link.activate',
      sessionId: '',
      docUri: uri,
      href: './子%20目录/目标%20二.md',
      srcStart: 0,
      srcEnd: 10,
    })
    // 宿主以文本编辑器打开目标文档（真实 openTextDocument + showTextDocument）
    await poll('目标文档被打开', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === wsUri('子 目录/目标 二.md').toString()
        ? true
        : undefined,
    )
    const opened = vscode.window.activeTextEditor!.document
    assert(opened.getText().startsWith('# 目标 二'), `打开的目标内容不符：${JSON.stringify(opened.getText().slice(0, 20))}`)

    // 跳转全程只读：源文档零写回、磁盘不变
    const diskAfter = await readDisk('links.md')
    assert(diskAfter === diskBefore, '链接跳转不得改写源文档')
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState | undefined
    if (state?.found) {
      assert(state.version === versionBefore, `跳转不得改变文档版本（${versionBefore} → ${state.version}）`)
      assert(state.appliedEdits === 0, `跳转不得产生 applyEdit，实际 ${state.appliedEdits}`)
    }
  }],

  ['危险 scheme 与缺失目标：宿主拦截并给可见反馈，外链在测试钩子下不真开浏览器（#10）', async () => {
    await openWithEditor('links2.md')
    const session = await waitSessionReady('links2.md')
    const uri = wsUri('links2.md').toString()
    const diskBefore = await readDisk('links2.md')

    // file:// 与 javascript: —— 拦截（无编辑器切换，面板存活可读日志）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'link.activate', sessionId: '', docUri: uri,
      href: 'file:///d:/x.md', srcStart: 0, srcEnd: 5,
    })
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'link.activate', sessionId: '', docUri: uri,
      href: 'javascript:alert(1)', srcStart: 0, srcEnd: 5,
    })
    // 缺失目标：not-found 反馈（不打开任何编辑器）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'link.activate', sessionId: '', docUri: uri,
      href: './不存在的目标.md', srcStart: 0, srcEnd: 5,
    })
    // 外链 https：归类 external（测试钩子模式仅记录，不真开系统浏览器）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'link.activate', sessionId: '', docUri: uri,
      href: 'https://example.com/obsidian-like', srcStart: 0, srcEnd: 5,
    })
    const logData = await poll('链接执行日志就绪', async () => {
      const data = (await vscode.commands.executeCommand(CMD.linkLog, uri)) as LinkLogData | undefined
      return data && data.found && data.log.length >= 4 ? data : undefined
    })
    const kinds = logData.log.map((e) => `${e.kind}:${e.reason ?? e.scheme ?? ''}`)
    assert(kinds.includes('blocked:scheme'), `file:// 应被拦截，实际 ${JSON.stringify(logData.log)}`)
    assert(
      logData.log.some((e) => e.kind === 'blocked' && e.scheme === 'javascript'),
      `javascript: 应被拦截并给出协议名，实际 ${JSON.stringify(logData.log)}`,
    )
    assert(kinds.includes('not-found:'), `缺失目标应有 not-found 反馈，实际 ${JSON.stringify(logData.log)}`)
    assert(kinds.includes('external:'), `https 外链应归类 external，实际 ${JSON.stringify(logData.log)}`)
    assert(
      logData.log.every((e) => e.kind !== 'doc'),
      `拦截类意图不得打开编辑器，实际 ${JSON.stringify(logData.log)}`,
    )

    // 无扩展名目标：候选补 .md 后真实打开（放最后——面板随编辑器切换退场）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'link.activate', sessionId: '', docUri: uri,
      href: './无扩展名目标', srcStart: 0, srcEnd: 5,
    })
    await poll('无扩展名目标（补 .md）被打开', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === wsUri('无扩展名目标.md').toString()
        ? true
        : undefined,
    )
    const diskAfter = await readDisk('links2.md')
    assert(diskAfter === diskBefore, '链接执行不得改写源文档')
    assert(session.appliedEdits === 0, `链接执行不得产生 applyEdit，实际 ${session.appliedEdits}`)
  }],

  ['图片显示：本地工作区图片经宿主通道装载，缺失图进入可重试错误态，零写回（#10）', async () => {
    await openWithEditor('images.md')
    await waitSessionReady('images.md')
    const uri = wsUri('images.md').toString()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    // 真实 webview：宿主 asWebviewUri → img.src → load 事件 → loaded 态
    const view = await poll('图片装载完成', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      const s = v?.imageStates
      return v?.viewMode === 'reading' && s && s.loaded >= 1 && s.error >= 1 ? v : undefined
    }, 30000)
    assert((view.readingImageCount ?? 0) >= 2, `阅读图片数应 >=2，实际 ${view.readingImageCount}`)
    assert((view.readingLinkCount ?? 0) === 0, '图片样例不含链接')
    // loaded 只能由 img load 事件置位——宿主解析地址确实可加载
    assert((view.imageStates?.loaded ?? 0) === 1, `应有 1 张加载成功，实际 ${JSON.stringify(view.imageStates)}`)
    assert((view.imageStates?.error ?? 0) === 1, `缺失图应进入错误态，实际 ${JSON.stringify(view.imageStates)}`)
    // 零写回：文本不变、无 applyEdit、磁盘不变
    assert(view.text === IMAGES_DOC_TEXT, '图片装载不得改写文档文本')
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 0, `图片链路不得产生 applyEdit，实际 ${state.appliedEdits}`)
    const disk = await readDisk('images.md')
    assert(disk === IMAGES_DOC_TEXT, '图片链路不得写磁盘')
  }],

  ['live 视图链接/图片装饰与样式契约：视口内 span/widget 渲染且稳定类名可被外部片段命中（#10）', async () => {
    await openWithEditor('links.md')
    await waitSessionReady('links.md')
    const uri = wsUri('links.md').toString()
    // live 默认模式：视口内链接 span 与图片 widget（间接装饰，视口外不创建）
    const live = await waitViewState('links.md', (v) => (v.liveLinkCount ?? -1) >= 5 && (v.liveImageCount ?? -1) >= 1)
    assert((live.liveLinkCount ?? 0) >= 5, `live 链接 span 应 >=5（外链/本地/空格目录/无扩展名/危险×2/自动链接），实际 ${live.liveLinkCount}`)
    assert((live.liveImageCount ?? 0) >= 1, `live 图片 widget 应 >=1，实际 ${live.liveImageCount}`)
    assert(
      live.cssProbe!.liveLinkDecorationColor === 'rgb(19, 20, 21)',
      `live 链接 span 应被测试片段命中 rgb(19, 20, 21)，实际 ${live.cssProbe!.liveLinkDecorationColor}`,
    )
    // live 图片同样经宿主通道装载成功
    await poll('live 图片装载', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v && (v.imageStates?.loaded ?? 0) >= 1 ? true : undefined
    })
    // 阅读侧：链接与图片探针 + 挂载计数
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式链接/图片观测', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingLinkCount !== undefined && v.readingImageCount !== undefined ? v : undefined
    })
    assert((reading.readingLinkCount ?? 0) >= 5, `阅读链接数应 >=5，实际 ${reading.readingLinkCount}`)
    assert((reading.readingImageCount ?? 0) >= 1, `阅读图片数应 >=1，实际 ${reading.readingImageCount}`)
    assert(
      reading.cssProbe!.readingLinkDecorationColor === 'rgb(22, 23, 24)',
      `阅读链接应被测试片段命中 rgb(22, 23, 24)，实际 ${reading.cssProbe!.readingLinkDecorationColor}`,
    )
    assert(
      reading.cssProbe!.readingImageDecorationColor === 'rgb(25, 26, 27)',
      `阅读图片应被测试片段命中 rgb(25, 26, 27)，实际 ${reading.cssProbe!.readingImageDecorationColor}`,
    )
    // 全程零写回
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 0, `显示链路不得产生 applyEdit，实际 ${state.appliedEdits}`)
    assert(reading.text === LINKS_DOC_TEXT, '显示链路不得改写文档文本')
  }],

  // ---- 工单 #12：表格单元格编辑与双视图呈现 ----

  ['表格装饰与单元格编辑写回：转义管道保存回读保真、一次撤销一笔提交（#12）', async () => {
    await openWithEditor('table.md')
    await waitSessionReady('table.md')
    const uri = wsUri('table.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table.md'))
    const original = TABLE_DOC_TEXT
    const edited = TABLE_DOC_TEXT.replace('| 苹果 | 3 | 甲 |', '| 香蕉\\|果 | 3 | 甲 |')

    // live 装饰语义：4 行表格行（表头/分隔/2 数据行）、9 个单元格内容
    // mark（GFM 拆分：`x|y` 与 乙\|丙 均为单格）
    const view = await waitViewState('table.md', (v) => v.liveSyntax?.tableLines === 4 && v.liveSyntax?.tableCells === 9)
    assert(view.liveSyntax!.tableLines === 4, `表格行装饰应为 4，实际 ${view.liveSyntax!.tableLines}`)
    assert(view.liveSyntax!.tableCells === 9, `单元格装饰应为 9，实际 ${view.liveSyntax!.tableCells}`)

    // 单元格编辑（webview 键入钩子的输出形态：含管道符的新内容带转义）
    const at = original.indexOf('苹果')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, {
      kind: 'edit.request',
      sessionId: '',
      docUri: uri,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: at, length: 2, text: '香蕉\\|果' }],
    })
    await poll('单元格编辑写入权威', () => (doc.getText() === edited ? true : undefined))
    const saved = await doc.save()
    assert(saved, '保存失败')
    const disk = await readDisk('table.md')
    assert(disk === edited, `保存回读应保持转义管道：${JSON.stringify(disk.slice(0, 80))}`)
    assert(disk.includes('香蕉\\|果'), '磁盘内容应含转义管道')

    // 一次撤销 = 一笔单元格提交（宿主权威栈回流）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('undo 回退单元格编辑', () => (doc.getText() === original ? true : undefined))
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 1, `undo 不得产生回声写回，实际 ${state.appliedEdits}`)

    // live 表格管道符样式入口命中
    const liveProbe = await waitViewState('table.md', (v) => v.viewMode === 'live' && v.cssProbe?.liveTablePipeDecorationColor !== undefined)
    assert(
      liveProbe.cssProbe!.liveTablePipeDecorationColor === 'rgb(19, 20, 21)',
      `live 表格管道符应被测试片段命中 rgb(19, 20, 21)，实际 ${liveProbe.cssProbe!.liveTablePipeDecorationColor}`,
    )
  }],

  ['网格单元格全选删除与边界删除保留表格源码结构（P0）', async () => {
    const name = 'table-cell-delete.md'
    await openWithEditor(name)
    await waitSessionReady(name)
    const uri = wsUri(name).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(name))
    const before = doc.getText()
    const at = before.indexOf('苹果')
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 1, columnIndex: 0 })
    await waitViewState(name, (v) => v.tableGrid?.selectedRowIsGrid === true)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: at })
    await waitViewState(name, (v) => v.selectionOffset === at)
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
    }
    const paddingTrimmed = before.replace('| 苹果 |', '|苹果 |')
    const boundary = await waitViewState(name, (v) => v.text === paddingTrimmed)
    assert(boundary.tableGrid?.visibleRows === 3, '格首退格只能删格内空白，不能越过源管道')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'select-all' })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
    const cleared = before.replace('| 苹果 |', '| |')
    await poll('仅清空当前格写回', () => doc.getText() === cleared ? true : undefined)
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'delete' })
    }
    const afterPaddingDelete = before.replace('| 苹果 |', '| |')
    const rendered = await waitViewState(name, (v) => v.text === afterPaddingDelete)
    assert(rendered.tableGrid?.visibleRows === 3, '删除内容后仍须保留完整网格')
    assert(rendered.paint?.table?.cellVisible === true && rendered.paint.table.gridDisplay === 'grid',
      '删除后剩余文字须在网格绘制层可见')
    assert(await doc.save(), '清空单元格保存失败')
    assert(await readDisk(name) === afterPaddingDelete, '落盘内容只能清空当前格，表格标记必须完整')
  }],

  ['安全表格仅绘制段首行号，格内光标与设置切换不恢复重叠编号', async () => {
    await openWithEditor('table42.md')
    await waitSessionReady('table42.md')
    const uri = wsUri('table42.md').toString()
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    const expected = ['1', '2', '3', '7', '8', '9']
    const before = await waitViewState('table42.md', (v) => (v.paint?.visibleLineNumbers?.length ?? 0) > 0)
    assert(JSON.stringify(before.paint?.visibleLineNumbers) === JSON.stringify(expected),
      `表格只绘制段首 3，隐藏 4/5/6：${JSON.stringify(before.paint?.visibleLineNumbers)}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 1, columnIndex: 0 })
    const clicked = await waitViewState('table42.md', (v) => v.tableGrid?.selectedRowIsGrid === true)
    assert(JSON.stringify(clicked.paint?.visibleLineNumbers) === JSON.stringify(expected),
      `单元格激活后仍只绘制表格段首行号：${JSON.stringify(clicked.paint?.visibleLineNumbers)}`)
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': false })
    await waitViewState('table42.md', (v) => v.lineGutter?.on === false)
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    const restored = await waitViewState('table42.md', (v) => v.lineGutter?.on === true)
    assert(JSON.stringify(restored.paint?.visibleLineNumbers) === JSON.stringify(expected),
      '重新开启行号应保留表格段首策略')
  }],

  ['多表局部编辑并滚动返回后，安全表格内部行号保持隐藏', async () => {
    const name = 'table-gutter-edit.md'
    const source = '开头\n\n普通段落\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n' +
      Array.from({ length: 160 }, (_, i) => `中段${i}\n`).join('') +
      '\n| C | D |\n| --- | --- |\n| 丙 | 丁 |\n'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(source))
    await openWithEditor(name)
    await waitSessionReady(name)
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    await waitViewState(name, (v) => v.lineGutter?.on === true)
    const uri = wsUri(name).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(name))
    const assertFirstTableNumbers = async () => {
      const state = await waitViewState(name, (v) => v.paint?.visibleLineNumbers?.includes('5') === true)
      assert(!state.paint!.visibleLineNumbers!.includes('6') && !state.paint!.visibleLineNumbers!.includes('7'),
        `第一张表只应绘制段首5：${JSON.stringify(state.paint!.visibleLineNumbers)}`)
    }
    await assertFirstTableNumbers()
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'sync.test.edit', offset: 1, text: '新' })
    await poll('表外输入落到权威文本', () => doc.getText().startsWith('开新头') ? true : undefined)
    await assertFirstTableNumbers()
    const secondCell = doc.getText().indexOf('丙')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: secondCell })
    await waitViewState(name, (v) => v.selectionOffset === secondCell)
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'sync.test.edit', offset: secondCell, text: '新' })
    await poll('第二张表输入落到权威文本', () => doc.getText().includes('新丙') ? true : undefined)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: 0 })
    await waitViewState(name, (v) => v.selectionOffset === 0)
    await assertFirstTableNumbers()
  }],

  ['实时预览活动格保留网格与抓手，格内输入经 CM6 写回（#42）', async () => {
    await openWithEditor('table42.md')
    const beforeSession = await waitSessionReady('table42.md')
    const uri = wsUri('table42.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table42.md'))
    const before = doc.getText()
    assert(before === TABLE_DOC_TEXT, '独立表格 fixture 初始文本不符')
    const at = before.indexOf('苹果') + 2

    // 在真实 1.86.2 webview 内派发鼠标事件，点击第一数据行首格。
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 1, columnIndex: 0 })
    const appleCellStart = before.indexOf('| 苹果 |') + 1
    const clicked = await waitViewState('table42.md', (v) =>
      v.selectionOffset !== undefined && v.selectionOffset >= appleCellStart &&
      v.selectionOffset <= appleCellStart + ' 苹果 '.length)
    assert(clicked.tableGrid?.selectedRowIsGrid === true, '鼠标进入单元格后整行必须仍是网格')
    assert(clicked.tableGrid?.visibleRows === 3, '活动格不得撤掉表格网格行')
    assert(clicked.tableGrid?.rowHandles === 3, '活动格仍须保留 #43 点阵抓手')
    assert(clicked.tableGrid?.selectedRowCells[0]?.includes('苹果') === true, '点击应命中苹果单元格')
    assert(clicked.paint?.table?.cellVisible === true,
      '表格单元格文字须在绘制层命中，不能仅有 DOM 文本')
    assert(clicked.paint?.table?.gridDisplay === 'grid',
      `表格行须实际按网格绘制：${clicked.paint?.table?.gridDisplay}`)
    assert(Number.parseFloat(clicked.paint?.table?.cellBorderWidth ?? '') > 0,
      `表格单元格须实际绘出边框：${clicked.paint?.table?.cellBorderWidth}`)

    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 1, columnIndex: 0, point: 'middle' })
    const middle = await waitViewState('table42.md', (v) =>
      v.selectionOffset !== undefined && v.selectionOffset > before.indexOf('苹果') &&
      v.selectionOffset <= before.indexOf('苹果') + 2)
    assert(middle.tableGrid?.selectedRowIsGrid === true, '格内中部点击仍须保留网格')

    // 精确定位到内容末端后模拟格内输入；定位只改变选区，不触发 edit.request。
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: at })
    const located = await waitViewState('table42.md', (v) => v.selectionOffset === at)
    assert(located.text === before && doc.getText() === before, '进入单元格不得改写 Markdown')
    const afterLocate = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterLocate.appliedEdits === beforeSession.appliedEdits, '网格进入源码不得产生宿主编辑')

    // 真实 webview 内 CM6 事务写回，与网格显示不建立第二份输入状态。
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.type', text: '汁' })
    const edited = before.replace('苹果', '苹果汁')
    await poll('网格单元格编辑写回', () => (doc.getText() === edited ? true : undefined))
    const afterTyping = await waitViewState('table42.md', (v) => v.text === edited)
    assert(afterTyping.tableGrid?.selectedRowIsGrid === true, '键入后活动格仍须保持网格')
    assert(afterTyping.tableGrid?.selectedRowCells[0]?.includes('苹果汁') === true,
      '键入应只更新目标单元格的可见内容')
    assert(afterTyping.tableGrid?.selectedRowCells[1]?.includes('3') === true, '邻格内容不得改变')
    assert(afterTyping.tableGrid?.rowHandles === 3, '键入后点阵抓手仍须可用')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('table42.md', (v) => v.viewMode === 'reading')
    assert(reading.text === edited,
      `阅读模式应读取单元格最新文本：${JSON.stringify({ before, edited, actual: reading.text, host: doc.getText() })}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const live = await waitViewState('table42.md', (v) => v.viewMode === 'live')
    assert(live.text === edited, `切回实时预览后文本不一致：${JSON.stringify(live.text)}`)
    assert(await doc.save(), '网格单元格编辑保存失败')
    assert(await readDisk('table42.md') === edited, '网格单元格编辑的磁盘回读不一致')
  }],

  ['实时预览空单元格点击与输入仍在目标网格格内（#42）', async () => {
    await openWithEditor('table42-empty.md')
    const initial = await waitSessionReady('table42-empty.md')
    const uri = wsUri('table42-empty.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table42-empty.md'))
    const before = '| A | B |\n| --- | --- |\n| | 空 |\n'
    assert(doc.getText() === before, '空格 fixture 初始内容不符')
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 1, columnIndex: 0 })
    const emptyAt = before.indexOf('| | 空 |') + 1
    const clicked = await waitViewState('table42-empty.md', (v) => v.selectionOffset === emptyAt)
    assert(clicked.tableGrid?.selectedRowIsGrid === true, '空单元格点击后不得撤网格')
    assert(clicked.tableGrid?.selectedRowCells.length === 2, '空单元格所在行应保留两列')
    const afterClick = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterClick.appliedEdits === initial.appliedEdits, '空单元格点击不应写回')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.type', text: '新' })
    const edited = before.replace('| | 空 |', '|新 | 空 |')
    await poll('空单元格输入写回', () => doc.getText() === edited ? true : undefined)
    const live = await waitViewState('table42-empty.md', (v) => v.text === edited)
    assert(live.tableGrid?.selectedRowIsGrid === true, '空单元格输入后仍须保持网格')
    assert(live.tableGrid?.selectedRowCells[0]?.includes('新') === true, '空格输入应留在目标格')
  }],

  ['三列表格中格点击与空格输入：可见光标绘在目标列', async () => {
    const name = 'table-middle-click.md'
    const before = '| 左 | sss | 右 |\n| --- | --- | --- |\n| 带 |  | 末 |\n| 带 || 末 |\n'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(before))
    await openWithEditor(name)
    await waitSessionReady(name)
    const uri = wsUri(name).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(name))
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 0, columnIndex: 1, point: 'right-edge' })
    const header = await waitViewState(name, (v) => v.tableGrid?.selectedRowIsGrid === true)
    assert(header.paint?.table?.caretGridColumn === 1,
      `点击表头中格后光标须在中列绘出：${JSON.stringify(header.paint?.table)}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.domType', text: '中' })
    await poll('表头中格写回', () => doc.getText().includes('sss中') ? true : undefined)
    for (let i = 0; i < 8; i++) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.domType', text: 's' })
      const count = i + 1
      await poll(`表头中格第 ${count} 次输入写回`, () =>
        (doc.getText().split('\n')[0]?.match(/s/g)?.length ?? 0) === 3 + count ? true : undefined)
      const actual = doc.getText()
      const typed = await waitViewState(name, (v) => v.text === actual)
      assert(typed.paint?.table?.caretDomColumn === 1 &&
        (typed.paint?.table?.caretNativeRectHeight ?? 0) > 0 &&
        typed.paint?.table?.caretGridColumn === 1,
        `表头中格连续输入后光标须保持在中列（第 ${i + 1} 次）：${JSON.stringify(typed.paint?.table)}`)
    }
    assert(/^\| 左 \| [^|]*中[^|]* \| 右 \|/.test(doc.getText()),
      `表头中格连续输入须写回原格：${JSON.stringify(doc.getText().split('\n')[0])}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 1, columnIndex: 1, point: 'right-edge' })
    const empty = await waitViewState(name, (v) => v.tableGrid?.selectedRowIsGrid === true &&
      v.selectionOffset !== header.selectionOffset)
    assert(empty.paint?.table?.caretGridColumn === 1,
      `点击数据行空中格后光标须在中列绘出：${JSON.stringify(empty.paint?.table)}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.type', text: '空' })
    await poll('空中格写回', () => doc.getText().includes('| 带 |空  | 末 |') ? true : undefined)
    const latest = await waitViewState(name, (v) => v.tableGrid?.selectedRowCells[1]?.includes('空') === true)
    assert(latest.tableGrid?.selectedRowCells[2]?.includes('末') === true, '右格不得接收中格输入')
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 2, columnIndex: 1, point: 'right-edge' })
    const zero = await waitViewState(name, (v) => v.tableGrid?.selectedRowCells[1] === '')
    assert(zero.paint?.table?.caretGridColumn === 1,
      `点击零宽空中格后光标须在中列绘出：${JSON.stringify(zero.paint?.table)}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.type', text: '零' })
    await poll('零宽空中格写回', () => doc.getText().includes('| 带 |零| 末 |') ? true : undefined)
    assert(await doc.save(), '三列表格保存失败')
    assert((await readDisk(name)) === doc.getText(), '三列点击写回与磁盘回读须一致')
  }],

  ['跨行拖选可横跨表格；端点落在隐藏结构上收缩到内容边界（#57）', async () => {
    const name = 'table-cross-selection.md'
    const source = '前文\n\n| 带 | s是 | 送 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n\n后文'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(source))
    await openWithEditor(name)
    const initial = await waitSessionReady(name)
    const uri = wsUri(name).toString()
    // 表外 anchor → 表外 head（视觉跨过整表）：不再截断在表格边界
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.test.crossSelect', anchor: 1, head: source.indexOf('后文') + 1,
    })
    const across = await waitViewState(name, (v) => v.selectionHead === source.indexOf('后文') + 1)
    assert(across.paint?.table?.delimiterDisplay === 'none',
      `跨行选区覆盖表格时分隔行仍须隐藏：${JSON.stringify(across.paint?.table)}`)
    assert(across.paint?.table?.gridDisplay === 'grid', '跨行选区不撤下网格绘制')
    // head 落在分隔行（隐藏结构）：收缩到上一内容行末格内容尾
    const delimiterAt = source.indexOf('| --- | --- | --- |')
    const headerAt = source.indexOf('| 带 | s是 | 送 |')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.test.crossSelect', anchor: 1, head: delimiterAt + 3,
    })
    const snapped = await waitViewState(name, (v) =>
      v.selectionHead === headerAt + '| 带 | s是 | 送 |'.length - 2)
    assert(snapped.paint?.table?.delimiterDisplay === 'none',
      `选区端点收缩后分隔行不显形：${JSON.stringify(snapped.paint?.table)}`)
    assert(snapped.paint?.table?.gridDisplay === 'grid', '端点收缩后网格仍在绘制')
    const after = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(after.appliedEdits === initial.appliedEdits, '选区操作不能改写源文')
  }],

  ['跨格与整表选区删除：删除作用范围与可见选区一致（#57）', async () => {
    const name = 'table-cross-cell-delete.md'
    const source = '前文\n\n| 带 | s是 | 送 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n\n后文'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(source))
    await openWithEditor(name)
    await waitSessionReady(name)
    const uri = wsUri(name).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(name))
    // 场景 1：同行跨格（数据行三格内容全选）→ 只删可见内容，管道与分隔行保留。
    // 表头行不用于此场景：表头全部格删空会使表格解析消失，删除按防护语义拒绝。
    const rowAt = source.indexOf('| 甲 | 乙 | 丙 |')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.test.crossSelect', anchor: rowAt + 2, head: rowAt + 11,
    })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
    const rowCleared = source.replace('| 甲 | 乙 | 丙 |', '|  |  |  |')
    await poll('跨格删除写回', () => doc.getText() === rowCleared ? true : undefined)
    const state = await waitViewState(name, (v) => v.text === rowCleared && v.tableGrid?.visibleRows === 2)
    assert(state.paint?.table?.gridDisplay === 'grid' && state.paint.table.cellVisible === true,
      `跨格删除后网格与剩余文字须在绘制层可见：${JSON.stringify(state.paint?.table)}`)
    assert(state.paint?.table?.delimiterDisplay === 'none', '跨格删除后分隔行保持隐藏')
    assert(await doc.save(), '跨格删除保存失败')
    assert(await readDisk(name) === rowCleared, '跨格删除磁盘回读：结构完整、仅清空内容')

    // 场景 2：表外发起、横跨整表的选区（用户主路径）→ 一次删除整块，前后正文按选区保留
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.test.crossSelect', anchor: 1, head: rowCleared.length,
    })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
    const tableRemoved = '前'
    await poll('整表删除写回', () => doc.getText() === tableRemoved ? true : undefined)
    const removed = await waitViewState(name, (v) => v.text === tableRemoved)
    assert(removed.paint?.table?.gridDisplay == null,
      `整表删除后不得残留网格绘制：${JSON.stringify(removed.paint?.table)}`)
    assert(await doc.save(), '整表删除保存失败')
    assert(await readDisk(name) === tableRemoved, '整表删除磁盘回读：表格整块移除、前后正文不被误删')

    // 一次撤销 = 恢复删除前的表格（宿主权威栈回流）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('撤销整表删除', () => doc.getText() === rowCleared ? true : undefined)
  }],

  ['表格回车在格内换行，退格合行、保存回读与撤销保持完整表格', async () => {
    const name = 'table-cell-enter.md'
    const source = '| 左 | 中 | 右 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(source))
    await openWithEditor(name)
    await waitSessionReady(name)
    const uri = wsUri(name).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(name))
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 0, columnIndex: 1, point: 'right-edge' })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'enter' })
    const withBreak = source.replace('中', '中<br>')
    await poll('格内换行写回', () => doc.getText() === withBreak ? true : undefined)
    const state = await waitViewState(name, (v) => v.text === withBreak && v.paint?.table?.cellBreakDisplay === 'inline')
    assert(state.paint?.table?.cellVisible === true && state.paint.table.gridDisplay === 'grid', '换行后表格文字与网格须实际可见')
    assert(state.tableGrid?.visibleRows === 2, '回车不能增加或拆散表格行')
    assert(await doc.save(), '格内换行保存失败')
    assert(await readDisk(name) === withBreak, '格内换行磁盘回读须保真')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
    await poll('退格合行写回', () => doc.getText() === source ? true : undefined)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'enter' })
    await poll('再次格内换行', () => doc.getText() === withBreak ? true : undefined)
    await vscode.commands.executeCommand('undo')
    await poll('一次撤销格内换行', () => doc.getText() === source ? true : undefined)
    assert(await doc.save(), '恢复原表格保存失败')
    assert(await readDisk(name) === source, '合回原行后保存不得残留换行标记')
  }],

  ['中格空白连续删除后再输入仍保持表头网格样式', async () => {
    const name = 'table-middle-delete.md'
    const source = '| 带 |  | 送 |\n| --- | --- | --- |\n| 左 | 右 | 末 |\n'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(source))
    await openWithEditor(name)
    await waitSessionReady(name)
    const uri = wsUri(name).toString()
    const doc = await vscode.workspace.openTextDocument(wsUri(name))
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.cellClick', rowIndex: 0, columnIndex: 1, point: 'right-edge' })
    for (let i = 0; i < 2; i++) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'delete' })
    }
    await poll('中格空白退格后源文', () => doc.getText().startsWith('| 带 | | 送 |') ? true : undefined)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.domType', text: '是' })
    await poll('中格再次输入写回', () => doc.getText().startsWith('| 带 |是 | 送 |') ? true : undefined)
    const state = await waitViewState(name, (v) => v.tableGrid?.selectedRowCells[1]?.includes('是') === true)
    const backgrounds = state.paint?.table?.headerCellBackgrounds ?? []
    assert(backgrounds.length === 3 && backgrounds.every((color) => color === backgrounds[0]),
      `表头中格须与两侧同样绘制底色：${JSON.stringify(backgrounds)}`)
    assert(state.paint?.table?.gridDisplay === 'grid', '退格再输入后表头仍须是网格')
    for (let i = 0; i < 8; i++) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.domType', text: 's' })
      const count = i + 1
      await poll(`中格删空后第 ${count} 次输入写回`, () =>
        (doc.getText().split('\n')[0]?.match(/s/g)?.length ?? 0) === count ? true : undefined)
      const actual = doc.getText()
      const typed = await waitViewState(name, (v) => v.text === actual)
      assert(typed.selectionAssoc === -1,
        `中格末端输入后光标须向中格关联（第 ${count} 次）：${typed.selectionAssoc}`)
      assert(typed.paint?.table?.caretDomColumn === 1 &&
        (typed.paint?.table?.caretNativeRectHeight ?? 0) > 0,
      `浏览器原生光标须实际落在中格文字节点（第 ${count} 次）：${JSON.stringify(typed.paint?.table)}`)
      assert(typed.paint?.table?.caretGridColumn === 1,
        `中格删空后连续输入光标须留中列（第 ${count} 次）：${JSON.stringify(typed.paint?.table)}`)
    }
    assert(doc.getText().startsWith('| 带 |是ssssssss | 送 |'),
      `中格删空后文字须继续落入中列：${JSON.stringify(doc.getText().split('\n')[0])}`)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
    await poll('中格连续输入后可退格', () =>
      doc.getText().startsWith('| 带 |是sssssss | 送 |') ? true : undefined)
    const afterBackspace = await waitViewState(name, (v) => v.text === doc.getText())
    assert(afterBackspace.paint?.table?.caretDomColumn === 1,
      '连续输入后退格仍须把原生光标留在中格')
    assert(await doc.save(), '中格再次输入保存失败')
    assert((await readDisk(name)) === doc.getText(), '中格退格再输入的磁盘回读须一致')
  }],

  ['阅读视图表格：真实 table 只读呈现与样式入口（#12）', async () => {
    await openWithEditor('table.md')
    await waitSessionReady('table.md')
    const uri = wsUri('table.md').toString()
    await waitViewState('table.md', (v) => v.viewMode === 'live')

    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('table.md', (v) => v.viewMode === 'reading' && v.readingSyntax?.tables !== undefined)
    assert(reading.readingSyntax!.tables === 1, `阅读视图应渲染 1 张表格，实际 ${reading.readingSyntax!.tables}`)
    // fixture 数据行含 `x|y`：若错误地按管道切列，行内代码 token 会丢失。
    assert(reading.readingSyntax!.inlineCodeCount === 1,
      `阅读表格应保留行内代码，实际 ${reading.readingSyntax!.inlineCodeCount}`)
    // 只读语义：表格为语义标签渲染，无输入控件（任务勾选外的交互均不提供）
    assert(
      reading.cssProbe?.readingTableDecorationColor === 'rgb(22, 23, 24)',
      `阅读表格应被测试片段命中 rgb(22, 23, 24)，实际 ${reading.cssProbe?.readingTableDecorationColor}`,
    )
    // 切回 live：同一文本两视图共用（文本不变）
    const backText = reading.text
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const liveAgain = await waitViewState('table.md', (v) => v.viewMode === 'live')
    assert(liveAgain.text === backText, '两种视图共用同一文本，切换不得改变内容')
  }],

  ['编辑区查找：文本模型全量匹配、无匹配反馈与只读契约（#14）', async () => {
    await openWithEditor('find.md')
    const session0 = await waitSessionReady('find.md')
    const uri = wsUri('find.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('find.md'))
    const text = doc.getText()
    const diskBefore = await readDisk('find.md')

    // 打开（预置查询）：匹配总数 = 文本模型全量计数（非可见 DOM）；
    // '目标词' 在 fixture 中出现 4 次
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: '目标词' })
    let v = await waitViewState('find.md', (s) => s.find?.open === true && s.find?.total === 4)
    assert(v.find!.index === 1, `当前序号应为 1，实际 ${v.find!.index}`)
    assert(v.find!.currentFrom === text.indexOf('目标词'), '当前匹配应为文本模型中的首个命中')
    assert(v.selectionOffset === text.indexOf('目标词'), `live 定位应把光标移到当前匹配，实际 ${v.selectionOffset}`)

    // 下一项：光标与当前匹配同步前移（屏外段落同样定位——文本模型语义）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.step', direction: 'next' })
    v = await waitViewState('find.md', (s) => s.find?.index === 2)
    assert(v.find!.currentFrom === text.indexOf('目标词', text.indexOf('目标词') + 1), '第 2 个匹配应为段落二中的命中')
    assert(v.selectionOffset === v.find!.currentFrom, `光标应跟随当前匹配，实际 ${v.selectionOffset}`)

    // 中文与 emoji：🎉 匹配 1 次（码点安全）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: '🎉' })
    v = await waitViewState('find.md', (s) => s.find?.query === '🎉')
    assert(v.find!.total === 1, `emoji 查询应命中 1 次，实际 ${v.find!.total}`)
    assert(v.find!.currentFrom === text.indexOf('🎉'), 'emoji 命中应在码点边界上')

    // 无匹配：0/0 明确反馈
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: '不存在的词' })
    v = await waitViewState('find.md', (s) => s.find?.total === 0)
    const none = v.find!
    assert(none.index === 0, `无匹配时序号应为 0，实际 ${none.index}`)
    assert(none.currentFrom === null, '无匹配时当前区间为 null')

    // 关闭：会话回报关闭态
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.close' })
    v = await waitViewState('find.md', (s) => s.find?.open === false)

    // 只读契约：全程文档版本、applyEdit、文本与磁盘不变（查找不入撤销栈、
    // 不触发保存——保存内容不因查找改变）
    const session1 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(session1.version === session0.version, `查找不得改变文档版本（${session0.version} → ${session1.version}）`)
    assert(session1.appliedEdits === session0.appliedEdits, `查找不得产生写回（${session0.appliedEdits} → ${session1.appliedEdits}）`)
    assert(v.text === text, '查找后 webview 文本逐字节不变')
    assert(doc.getText() === text, '查找后权威文本不变')
    assert(!doc.isDirty, '查找后文档不得 dirty')
    assert(await readDisk('find.md') === diskBefore, '查找后磁盘字节不变')
  }],

  ['编辑区查找：阅读视图屏外匹配定位与按需挂载保持（#14）', async () => {
    await openWithEditor('reading-100k.md')
    await waitSessionReady('reading-100k.md')
    const uri = wsUri('reading-100k.md').toString()
    const sessionBefore = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    const doc = await vscode.workspace.openTextDocument(wsUri('reading-100k.md'))
    const text = doc.getText()
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('切换并虚拟化', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? true : undefined
    })

    // 唯一命中的屏外段落（第 9995 段，文档 9.995% 处，远在首屏之外）
    const para = '第 9995 段 阅读段落样本文本'
    const paraOffset = text.indexOf(para)
    assert(paraOffset > 0, 'fixture 中应存在目标段')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: para })
    let v = await waitViewState('reading-100k.md', (s) => s.find?.total === 1 && s.readingAnchorStart === paraOffset)
    assert(v.find!.currentFrom === paraOffset, `当前匹配应在文本模型中的唯一位置，实际 ${v.find!.currentFrom}`)
    // 阅读锚点 = 目标块源 start；目标块已真实挂载（有布局顶位置）且发生滚动
    assert(v.readingAnchorStart === paraOffset, `阅读锚点应为目标段块 start=${paraOffset}，实际 ${v.readingAnchorStart}`)
    assert(v.readingAnchorTopPx !== undefined, '屏外匹配定位后目标块应已挂载')
    assert((v.readingScrollTopPx ?? 0) > 0, `定位屏外匹配应发生滚动，实际 scrollTop=${v.readingScrollTopPx}`)
    // 不为查找常驻全文 DOM：仍只挂载窗口块；无重新解析
    assert((v.readingMountedBlocks ?? 0) < (v.readingTotalBlocks ?? 1), `定位后仍应只挂载窗口块（${v.readingMountedBlocks}/${v.readingTotalBlocks}）`)
    assert((v.readingParseCount ?? 0) === 1, `查找定位不得触发全文重解析，实际 ${v.readingParseCount}`)

    // 多匹配深跳：'阅读标题样本行' 每 50 块一个标题（100000/50=2000 个）。
    // 先 view.locate 回顶（参考位置确定：当前匹配取参考位置后首个），
    // 从第 1 个 prev 回绕到末个（第 100000 节，文档末尾屏外）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: 0 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: '阅读标题样本行' })
    v = await waitViewState('reading-100k.md', (s) => s.find?.total === 2000 && s.find?.index === 1)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.step', direction: 'prev' })
    // 循环导航：从第 1 个 prev 回绕到末个（第 100000 节）；末屏的视口顶块
    // 是它前面的块（#7 已知布局行为，maxScroll clamp），此处只断言匹配序号
    v = await waitViewState('reading-100k.md', (s) => s.find?.index === 2000)
    const lastHeadingLine = text.indexOf('## 第 100000 节 阅读标题样本行')
    const lastHeadingText = '## 第 100000 节 阅读标题样本行'
    assert(v.find!.currentFrom === lastHeadingLine + lastHeadingText.indexOf('阅读标题样本行'), `回绕后应为末个标题命中，实际 ${v.find!.currentFrom}`)
    // 末屏锚点语义下深跳断言改用可达视口顶的目标：第 99950 节（近末尾）
    const deepHeading = '## 第 99950 节 阅读标题样本行'
    const deepLineStart = text.lastIndexOf(deepHeading)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: '第 99950 节' })
    v = await waitViewState('reading-100k.md', (s) => s.find?.total === 1 && s.readingAnchorStart === deepLineStart)
    assert(v.find!.currentFrom === deepLineStart + deepHeading.indexOf('第 99950 节'), `唯一命中应在第 99950 节标题行，实际 ${v.find!.currentFrom}`)
    assert(v.readingAnchorStart === deepLineStart, `深跳后阅读锚点应为目标标题块 start=${deepLineStart}，实际 ${v.readingAnchorStart}`)
    assert(v.readingAnchorTopPx !== undefined, '深跳后目标块应已挂载')
    assert((v.readingParseCount ?? 0) === 1, '循环导航不得触发全文重解析')
    assert((v.readingMountedBlocks ?? 0) < (v.readingTotalBlocks ?? 1), '深跳后仍应只挂载窗口块')

    // 只读契约：版本/写回/文本不变
    const sessionAfter = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(sessionAfter.version === sessionBefore.version, `查找不得改变文档版本（${sessionBefore.version} → ${sessionAfter.version}）`)
    assert(sessionAfter.appliedEdits === sessionBefore.appliedEdits, '查找不得产生写回')
    assert(v.text === text, '查找后 webview 文本不变')

    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.close' })
    await waitViewState('reading-100k.md', (s) => s.find?.open === false)
  }],

  ['编辑区查找：模式切换会话保活与源锚点位置恢复（#14）', async () => {
    await openWithEditor('find.md')
    await waitSessionReady('find.md')
    const uri = wsUri('find.md').toString()
    const text = (await vscode.workspace.openTextDocument(wsUri('find.md'))).getText()
    const diskBefore = await readDisk('find.md')

    // live 导航到第 2 个匹配（段落二）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.open', query: '目标词' })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.step', direction: 'next' })
    let v = await waitViewState('find.md', (s) => s.find?.index === 2)
    const matchFrom = v.find!.currentFrom!
    assert(text.slice(matchFrom, matchFrom + 3) === '目标词', '当前匹配区间应还原为查询本身')

    // 切到阅读：会话保活，锚点映射到当前匹配所在块（等待定位落定：
    // 虚拟化滚动/实测修正期间的瞬时锚点以最终落定值为准）
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const para2Start = text.indexOf('第二段：又出现目标词了。')
    v = await poll('阅读模式保活与锚点落定', async () => {
      const s = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return s?.viewMode === 'reading' && s.find?.open === true && s.readingAnchorStart === para2Start ? s : undefined
    })
    assert(v.find!.index === 2, `会话保活：当前序号仍为 2，实际 ${v.find!.index}`)
    assert(v.readingAnchorStart === para2Start, `阅读锚点应为当前匹配块 start，实际 ${v.readingAnchorStart}`)

    // 切回 live：选区恢复到当前匹配（源锚点映射，非块首；#38 起回 live 用
    // 显式命令，循环命令在 reading 态会切源码编辑器）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive')
    v = await poll('切回 live 恢复', async () => {
      const s = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return s?.viewMode === 'live' && s.find?.open === true ? s : undefined
    })
    assert(v.selectionOffset === matchFrom, `切回后光标应恢复到当前匹配 ${matchFrom}，实际 ${v.selectionOffset}`)

    // 关闭后切换/状态不受影响；磁盘与版本保持
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.close' })
    await waitViewState('find.md', (s) => s.find?.open === false)
    const session = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(session.appliedEdits === 0, `查找与模式切换不得产生写回，实际 ${session.appliedEdits}`)
    assert(await readDisk('find.md') === diskBefore, '查找与模式切换后磁盘字节不变')
  }],

  // ---- 工单 #11：双链解析并跳转笔记与标题 ----

  ['双链显示：live widget/mark 与阅读 a 渲染，降级形态源码保真，稳定类名可被外部片段命中（#11）', async () => {
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const uri = wsUri('wikilinks.md').toString()
    const diskBefore = await readDisk('wikilinks.md')

    // live 默认模式：视口内 3 处合法双链（按名/别名/标题）为 widget；
    // 降级形态与代码上下文不装饰
    const live = await waitViewState('wikilinks.md', (v) => (v.liveWikilinkCount ?? -1) === 3)
    assert(live.liveWikilinkCount === 3, `live 双链数应为 3，实际 ${live.liveWikilinkCount}`)
    assert(
      live.cssProbe!.liveWikilinkDecorationColor === 'rgb(28, 29, 30)',
      `live 双链应被测试片段命中 rgb(28, 29, 30)，实际 ${live.cssProbe!.liveWikilinkDecorationColor}`,
    )
    // 阅读侧：a.vsidian-wikilink 数量与探针 + 降级形态按原文显示
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await poll('阅读模式双链观测', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingWikilinkCount !== undefined ? v : undefined
    })
    assert(reading.readingWikilinkCount === 3, `阅读双链数应为 3，实际 ${reading.readingWikilinkCount}`)
    assert(
      reading.cssProbe!.readingWikilinkDecorationColor === 'rgb(31, 32, 33)',
      `阅读双链应被测试片段命中 rgb(31, 32, 33)，实际 ${reading.cssProbe!.readingWikilinkDecorationColor}`,
    )
    assert(reading.text === WIKILINKS_DOC_TEXT, '显示链路不得改写文档文本')
    assert(reading.readingLinkCount === 3, `阅读 a 元素应恰为 3 个双链（无普通链接），实际 ${reading.readingLinkCount}`)
    // 全程零写回
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 0, `显示链路不得产生 applyEdit，实际 ${state.appliedEdits}`)
    assert(await readDisk('wikilinks.md') === diskBefore, '显示链路不得写磁盘')
  }],

  ['双链跳转：按名与显式路径解析并打开目标（文本编辑器），零写回（#11）', async () => {
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const uri = wsUri('wikilinks.md').toString()
    const diskBefore = await readDisk('wikilinks.md')
    const versionBefore = (await vscode.workspace.openTextDocument(wsUri('wikilinks.md'))).version

    // 按名查找：工作区内唯一 basename 命中（findFiles 按需，不建索引）。
    // 日志先于打开动作写入（文本编辑器打开会替换源面板——#10 同现象）
    await injectWikilink(uri, '目标笔记')
    let logData = await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-doc' && e.target === '目标笔记')
    assert(logData!.path === wsUri('目标笔记.md').fsPath, `按名目标路径不符：${logData!.path}`)
    await poll('按名目标被打开', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === wsUri('目标笔记.md').toString()
        ? true
        : undefined,
    )
    const opened = vscode.window.activeTextEditor!.document
    assert(opened.getText().startsWith('# 目标笔记标题'), '按名打开的目标内容不符')

    // 文本编辑器打开会替换源面板：重开源面板再注入
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    // 显式路径（含中文与空格目录）：文档相对 + 工作区相对双候选精确解析
    await injectWikilink(uri, '子 目录/目标 二')
    logData = await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-doc' && e.target === '子 目录/目标 二')
    assert(logData!.path === wsUri('子 目录/目标 二.md').fsPath, `显式路径目标不符：${logData!.path}`)
    assert(logData!.locate === 'none', `无标题目标不应定位，实际 ${logData!.locate}`)
    await poll('显式路径目标被打开', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === wsUri('子 目录/目标 二.md').toString()
        ? true
        : undefined,
    )

    // 跳转全程只读：源文档零写回、磁盘不变、版本不变
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 0, `双链跳转不得产生 applyEdit，实际 ${state.appliedEdits}`)
    assert(state.version === versionBefore, `跳转不得改变文档版本（${versionBefore} → ${state.version}）`)
    assert(await readDisk('wikilinks.md') === diskBefore, '双链跳转不得改写源文档')
  }],

  ['双链标题跳转（文本编辑器）：selection reveal 到标题行；缺失标题仍打开并记录（#11）', async () => {
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const uri = wsUri('wikilinks.md').toString()
    const diskBefore = await readDisk('wikilinks.md')

    // 标题目标：打开后 selection 落在标题行（1.86 API 面 reveal）
    await injectWikilink(uri, 'wikilink-target#深处小节')
    let logData = await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-doc' && e.heading === '深处小节')
    assert(logData!.locate === 'text-editor', `文本编辑器路径应记录 locate=text-editor，实际 ${logData!.locate}`)
    await poll('标题目标被打开', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === wsUri('wikilink-target.md').toString()
        ? true
        : undefined,
    )
    const editor = vscode.window.activeTextEditor!
    const selLine = editor.document.lineAt(editor.selection.active).text
    assert(selLine.trim() === '## 深处小节', `selection 应在标题行，实际「${selLine}」`)

    // 缺失标题：文档照常打开（不定位），日志记录 locate=none——缺失给可见反馈
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    await injectWikilink(uri, 'wikilink-target#不存在的小节')
    logData = await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-doc' && e.heading === '不存在的小节')
    assert(logData!.locate === 'none', `缺失标题应记录 locate=none，实际 ${logData!.locate}`)
    await poll('缺失标题目标仍被打开', () =>
      vscode.window.activeTextEditor?.document.uri.toString() === wsUri('wikilink-target.md').toString()
        ? true
        : undefined,
    )

    assert(await readDisk('wikilinks.md') === diskBefore, '标题跳转不得改写源文档')
  }],

  ['双链标题跳转（本扩展面板）：屏外标题挂载定位，不重新解析全文（#11）', async () => {
    // 源面板 + 目标面板并排（beside 保源面板存活）
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const sourceUri = wsUri('wikilinks.md').toString()
    await openWithEditor('目标笔记.md', true)
    const targetSession = await waitSessionReady('目标笔记.md')
    const targetUri = wsUri('目标笔记.md').toString()
    const diskSource = await readDisk('wikilinks.md')
    const diskTarget = await readDisk('目标笔记.md')

    // 目标面板切到阅读模式（活动 tab = 目标面板）
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const before = await poll('目标进入阅读模式', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, targetUri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingTotalBlocks !== undefined ? v : undefined
    })
    const totalBlocks = before.readingTotalBlocks!
    const parseBefore = before.readingParseCount ?? 0

    // 从源面板发起标题跳转：宿主 reveal 目标面板 + view.locate（块挂载定位）
    await injectWikilink(sourceUri, '目标笔记#深处的标题')
    const after = await poll('屏外标题挂载定位', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, targetUri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingAnchorStart === DEEP_HEADING_OFFSET ? v : undefined
    }, 30000)
    assert(after.readingAnchorStart === DEEP_HEADING_OFFSET, `阅读锚点应为屏外标题块 start，实际 ${after.readingAnchorStart}`)
    // 挂载定位不依赖已渲染 DOM：目标块此前在窗口外；定位后窗口覆盖目标
    assert((after.readingMountedBlocks ?? 0) < totalBlocks, `定位后挂载块数应有界（< ${totalBlocks}），实际 ${after.readingMountedBlocks}`)
    assert((after.readingParseCount ?? 0) === parseBefore, `定位不得触发全文重解析（${parseBefore} → ${after.readingParseCount}）`)
    const logData = await waitWikilinkLog(sourceUri, (e) => e.kind === 'wikilink-doc' && e.heading === '深处的标题')
    assert(logData!.locate === 'custom-panel', `本扩展面板路径应记录 locate=custom-panel，实际 ${logData!.locate}`)

    // 双侧零写回
    assert(targetSession.appliedEdits === 0, `目标面板不得产生 applyEdit，实际 ${targetSession.appliedEdits}`)
    assert(await readDisk('wikilinks.md') === diskSource, '跳转不得改写源文档')
    assert(await readDisk('目标笔记.md') === diskTarget, '跳转不得改写目标文档')
  }],

  ['双链标题跳转（CRLF 目标面板）：view.locate 坐标转 LF 系后定位正确（#11）', async () => {
    // 目标文档为 CRLF 行尾：findHeadingOffset 基于 getText()（宿主系，保留
    // \r\n）计算 offset，view.locate 发给 LF 坐标系的 webview 前必须转换——
    // 直发宿主系坐标在 30+ 个 CRLF 行尾的文档上定位漂移同数量字符
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const sourceUri = wsUri('wikilinks.md').toString()
    await openWithEditor('wikilink-crlf-target.md', true)
    const targetSession = await waitSessionReady('wikilink-crlf-target.md')
    const diskSource = await readDisk('wikilinks.md')
    const diskTarget = await readDisk('wikilink-crlf-target.md')
    assert(diskTarget.includes('\r\n'), '目标 fixture 应为 CRLF 行尾')

    // live 模式：view.locate 直接设置光标（LF 坐标），从源面板发起标题跳转
    await injectWikilink(sourceUri, 'wikilink-crlf-target#CRLF 深处小节')
    const logData = await waitWikilinkLog(sourceUri, (e) =>
      e.kind === 'wikilink-doc' && e.heading === 'CRLF 深处小节',
    )
    assert(logData!.locate === 'custom-panel', `面板路径应记录 locate=custom-panel，实际 ${logData!.locate}`)
    const located = await waitViewState('wikilink-crlf-target.md', (v) =>
      v.selectionOffset === CRLF_HEADING_LF_OFFSET,
    )
    assert(
      located.selectionOffset === CRLF_HEADING_LF_OFFSET,
      `CRLF 目标定位应落标题行 LF offset ${CRLF_HEADING_LF_OFFSET}，实际 ${located.selectionOffset}`,
    )

    // 双侧零写回
    assert(targetSession.appliedEdits === 0, `目标面板不得产生 applyEdit，实际 ${targetSession.appliedEdits}`)
    assert(await readDisk('wikilinks.md') === diskSource, '跳转不得改写源文档')
    assert(await readDisk('wikilink-crlf-target.md') === diskTarget, '跳转不得改写目标文档（CRLF 保真）')
  }],

  ['双链歧义与缺失：重名记录候选待选择（测试钩子不弹窗）、缺失提示、不支持降级、不自动建文件（#11）', async () => {
    await openWithEditor('wikilinks.md')
    await waitSessionReady('wikilinks.md')
    const uri = wsUri('wikilinks.md').toString()
    const diskBefore = await readDisk('wikilinks.md')
    const versionBefore = (await vscode.workspace.openTextDocument(wsUri('wikilinks.md'))).version

    // 重名（dup/甲.md 与 other/甲.md）：ambiguous——候选记录，不静默任选
    await injectWikilink(uri, '甲')
    const ambiguous = await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-ambiguous')
    assert((ambiguous!.candidates ?? []).length === 2, `重名应给出 2 个候选，实际 ${JSON.stringify(ambiguous!.candidates)}`)
    // 缺失目标：not-found（不自动创建文件）
    await injectWikilink(uri, '不存在的笔记')
    await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-not-found' && e.target === '不存在的笔记')
    // 不支持形态（块引用 ^）：宿主侧分类拒绝并反馈
    await injectWikilink(uri, '目标笔记^块')
    await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-unsupported' && e.target === '目标笔记^块')
    // 上述意图均不打开编辑器：日志中无 wikilink-doc（甲/不存在/^ 三者）
    const logAll = (await vscode.commands.executeCommand(CMD.linkLog, uri)) as LinkLogData
    assert(
      !logAll.log.some((e) => e.kind === 'wikilink-doc'),
      `拦截类双链意图不得打开编辑器，实际 ${JSON.stringify(logAll.log)}`,
    )
    // 不自动建文件
    let created = false
    try {
      await readDisk('不存在的笔记.md')
      created = true
    } catch {
      created = false
    }
    assert(!created, '缺失目标不得自动创建文件')

    // 拦截链路零写回（在会退场的 casenote 打开动作之前断言：会话仍在）
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 0, `歧义/缺失链路不得产生 applyEdit，实际 ${state.appliedEdits}`)
    assert(state.version === versionBefore, `版本不得变化（${versionBefore} → ${state.version}）`)

    // 大小写语义随宿主平台：两平台注入同名小写 'casenote'——Windows 本地
    //（NTFS 语义）不敏感命中 CaseNote.md；POSIX 宿主严格匹配为 not-found
    //（注入端不得按平台翻转：精确名 'CaseNote' 在严格语义下必然命中打开，
    // 与下方 not-found 断言矛盾，Linux 宿主上必超时）
    await injectWikilink(uri, 'casenote')
    if (process.platform === 'win32') {
      await poll('大小写不敏感目标被打开', () =>
        vscode.window.activeTextEditor?.document.uri.toString() === wsUri('CaseNote.md').toString()
          ? true
          : undefined,
      )
    } else {
      await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-not-found' && e.target === 'casenote')
    }

    assert(await readDisk('wikilinks.md') === diskBefore, '歧义/缺失链路不得改写源文档')
  }],

  ['表格行列选中在绘制层显示完整轮廓与高亮（#43）', async () => {
    await openWithEditor('table43-crlf.md')
    await waitSessionReady('table43-crlf.md')
    const uri = wsUri('table43-crlf.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.select', axis: 'row', index: 1 })
    const row = await waitViewState('table43-crlf.md', (v) =>
      v.paint?.table?.rowOutlineWidth != null && v.paint.table.regionCellCount === 2)
    const rowPaint = row.paint!.table!
    assert(rowPaint.cellVisible === true && rowPaint.gridDisplay === 'grid',
      '选中行的表格文字仍须真实可见且保持网格布局')
    assert(rowPaint.rowOutlineColor !== null && rowPaint.rowOutlineColor !== 'rgba(0, 0, 0, 0)',
      `选中行轮廓须有实色：${rowPaint.rowOutlineColor}`)
    const baseBorderWidth = Number.parseFloat(rowPaint.cellBorderWidth ?? '')
    assert(baseBorderWidth > 0 && Number.parseFloat(rowPaint.rowOutlineWidth ?? '') > baseBorderWidth,
      `选中行轮廓须比普通格线更醒目：格线=${rowPaint.cellBorderWidth}，轮廓=${rowPaint.rowOutlineWidth}`)
    assert(rowPaint.rowBackgroundColor !== null && rowPaint.rowBackgroundColor !== 'rgba(0, 0, 0, 0)',
      `选中行单元格须实际着色：${rowPaint.rowBackgroundColor}`)
    assert(rowPaint.regionCellCount === 2, `两格矩形选区须完整绘出：${rowPaint.regionCellCount}`)
    assert(rowPaint.regionBackgroundColor !== null && rowPaint.regionBackgroundColor !== 'transparent' &&
      rowPaint.regionBackgroundColor !== 'rgba(0, 0, 0, 0)',
      `矩形选区的单元格须实际着色：${rowPaint.regionBackgroundColor}`)
    assert(Number.parseFloat(rowPaint.regionTopBorderWidth ?? '') > baseBorderWidth &&
      Number.parseFloat(rowPaint.regionLeftBorderWidth ?? '') > baseBorderWidth,
      `矩形外围顶/左边框须比普通格线更醒目：格线=${rowPaint.cellBorderWidth}，顶/左=${rowPaint.regionTopBorderWidth}/${rowPaint.regionLeftBorderWidth}`)

    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.select', axis: 'column', index: 0 })
    const column = await waitViewState('table43-crlf.md', (v) => v.paint?.table?.columnBorderWidth != null)
    const colPaint = column.paint!.table!
    assert(colPaint.cellVisible === true && colPaint.gridDisplay === 'grid',
      '选中列的表格文字仍须真实可见且保持网格布局')
    assert(colPaint.columnBorderColor === rowPaint.rowOutlineColor,
      `行列轮廓须使用同一主题强调色：行=${rowPaint.rowOutlineColor}，列=${colPaint.columnBorderColor}`)
    assert(Number.parseFloat(colPaint.columnBorderWidth ?? '') > baseBorderWidth,
      `选中列两侧轮廓须比普通格线更醒目：格线=${colPaint.cellBorderWidth}，轮廓=${colPaint.columnBorderWidth}`)
    assert(Number.parseFloat(colPaint.columnRightBorderWidth ?? '') > baseBorderWidth,
      `选中列右侧轮廓须闭合：${colPaint.columnRightBorderWidth}`)
    assert(Number.parseFloat(colPaint.columnTopBorderWidth ?? '') > baseBorderWidth &&
      Number.parseFloat(colPaint.columnBottomBorderWidth ?? '') > baseBorderWidth,
      `选中列顶边和底边须闭合：${colPaint.columnTopBorderWidth}/${colPaint.columnBottomBorderWidth}`)
    assert(colPaint.columnBackgroundColor !== null && colPaint.columnBackgroundColor !== 'rgba(0, 0, 0, 0)',
      `选中列单元格须实际着色：${colPaint.columnBackgroundColor}`)
  }],

  ['点阵拖排行经真实 webview 鼠标处理器写回 CRLF，一次撤销（#43）', async () => {
    await openWithEditor('table43-crlf.md')
    await waitSessionReady('table43-crlf.md')
    const uri = wsUri('table43-crlf.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table43-crlf.md'))
    const original = TABLE13_DOC_TEXT.replace(/\n/g, '\r\n')
    const movedLf = TABLE13_DOC_TEXT.replace(
      '| 名字 | 数量 |\n| --- | :---: |\n| 苹果 | 3 |\n| `x|y` | 4 |',
      '| `x|y` | 4 |\n| --- | :---: |\n| 名字 | 数量 |\n| 苹果 | 3 |',
    )
    const moved = movedLf.replace(/\n/g, '\r\n')
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.test.drag', sourceIndex: 2, targetSlot: 0,
    })
    await poll('拖动写回权威 CRLF 文本', () => doc.getText() === moved ? true : undefined)
    const after = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(after.appliedEdits === before.appliedEdits + 1, '一次拖动必须只产生一笔 applyEdit')
    assert(await doc.save(), '拖排行保存失败')
    assert(await readDisk('table43-crlf.md') === moved, '拖排行保存回读丢失 CRLF 或顺序')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('一次撤销恢复原行序', () => doc.getText() === original ? true : undefined)
    await doc.save()
  }],

  ['创建空表格命令：行内拆分、上下空行、CRLF 回读与单次撤销', async () => {
    await openWithEditor('table-create-crlf.md')
    await waitSessionReady('table-create-crlf.md')
    const uri = wsUri('table-create-crlf.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table-create-crlf.md'))
    const original = '左文右文\r\n尾段\r\n'
    const expected = '左文\r\n\r\n|  |  |\r\n| --- | --- |\r\n|  |  |\r\n\r\n右文\r\n尾段\r\n'
    assert(doc.getText() === original, '创建表格夹具原文不符')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: 2 })
    const invoked = await vscode.commands.executeCommand('onegayi.vsidian.table.create')
    assert(invoked === true, '创建表格命令应在活动 Vsidian 编辑器中可用')
    await poll('创建表格写回 CRLF 文档', () => doc.getText() === expected ? true : undefined)
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 1, '创建表格应只产生一笔宿主编辑')
    assert(await doc.save(), '创建表格保存失败')
    assert(await readDisk('table-create-crlf.md') === expected, '创建表格保存回读未保留 CRLF 或上下文')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('创建表格一次撤销恢复原文', () => doc.getText() === original ? true : undefined)
    await doc.save()
  }],

  // ---- 工单 #13：表格键盘导航与增删行列 ----

  ['表格增删行列：命令路径写回权威文档、区域不变、一次撤销（#13）', async () => {
    await openWithEditor('table13.md')
    await waitSessionReady('table13.md')
    const uri = wsUri('table13.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table13.md'))
    const original = TABLE13_DOC_TEXT

    // 光标定位到「苹果」后（数据行内），经正式命令（命令面板路径）插入行
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: original.indexOf('苹果') + 1,
    })
    await vscode.commands.executeCommand('onegayi.vsidian.table.insertRowBelow')
    const inserted = original.replace(
      '| 苹果 | 3 |\n| `x|y` | 4 |',
      '| 苹果 | 3 |\n| | |\n| `x|y` | 4 |',
    )
    await poll('插入行写入权威', () => (doc.getText() === inserted ? true : undefined))
    // 表格外区域逐字节不变（无其他区域重排）
    assert(inserted.startsWith('前导段落甲。\n\n| 名字 | 数量 |\n| --- | :---: |\n'), '表格前区域被重排')
    assert(inserted.endsWith('\n\n结尾段落乙。\n'), '表格后区域被重排')
    // 焦点落点：新行首格（真实 webview 视图观测）
    const view = await waitViewState('table13.md', (v) => v.selectionOffset === inserted.indexOf('| | |') + 2)
    assert(view.selectionOffset === inserted.indexOf('| | |') + 2, `光标应落新行首格，实际 ${view.selectionOffset}`)

    // 撤销一次 = 回退一笔结构提交；一笔命令恰好一笔 applyEdit
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('undo 回原', () => (doc.getText() === original ? true : undefined))
    const state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits === 1, `插行应恰好 1 笔 applyEdit，实际 ${state.appliedEdits}`)

    // 保存回读：插行后保存，磁盘逐字一致（新行与对齐保持）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: original.indexOf('苹果') + 1,
    })
    await vscode.commands.executeCommand('onegayi.vsidian.table.insertRowBelow')
    await poll('再次插入', () => (doc.getText() === inserted ? true : undefined))
    assert(await doc.save(), '保存失败')
    const disk = await readDisk('table13.md')
    assert(disk === inserted, `保存回读不一致：${JSON.stringify(disk)}`)
    // 还原到 fixture 原文
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('还原', () => (doc.getText() === original ? true : undefined))
    await doc.save()
  }],

  ['表格结构语义：删表头升格、分隔行保护、插列对齐同步（#13）', async () => {
    await openWithEditor('table13.md')
    await waitSessionReady('table13.md')
    const uri = wsUri('table13.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table13.md'))
    const original = TABLE13_DOC_TEXT

    // 删表头：首个数据行升为新表头，分隔行随移到升格行之后、对齐保留
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: original.indexOf('名字') + 1,
    })
    await vscode.commands.executeCommand('onegayi.vsidian.table.deleteRow')
    const promoted = original.replace(
      '| 名字 | 数量 |\n| --- | :---: |\n| 苹果 | 3 |\n',
      '| 苹果 | 3 |\n| --- | :---: |\n',
    )
    await poll('删表头升格', () => (doc.getText() === promoted ? true : undefined))

    // 分隔行单独删除：拒绝（结构行保护，零写回）
    const beforeReject = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: promoted.indexOf(':---:'),
    })
    await vscode.commands.executeCommand('onegayi.vsidian.table.deleteRow')
    await new Promise((r) => setTimeout(r, 800))
    assert(doc.getText() === promoted, '分隔行删除必须被拒绝')
    const afterReject = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterReject.appliedEdits === beforeReject.appliedEdits, '拒绝的操作不得产生写回')

    // 插列（首列右侧）：表头/分隔/数据行同步插入，分隔行补默认对齐段
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: promoted.indexOf('苹果') + 1,
    })
    await vscode.commands.executeCommand('onegayi.vsidian.table.insertColumnRight')
    const columned = promoted
      .replace('| 苹果 | 3 |', '| 苹果 | | 3 |')
      .replace('| --- | :---: |', '| --- | --- | :---: |')
      .replace('| `x|y` | 4 |', '| `x|y` | | 4 |')
    await poll('插列写入', () => (doc.getText() === columned ? true : undefined))
    assert(await doc.save(), '保存失败')
    const disk = await readDisk('table13.md')
    assert(disk === columned, `插列保存回读不一致：${JSON.stringify(disk)}`)
    // 行内代码管道在结构操作后保真
    assert(disk.includes('`x|y`'), '行内代码单元格保真')

    // 删列（新插的空列）：对齐段同步删除
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: columned.indexOf('| 苹果 | | 3 |') + 7,
    })
    await vscode.commands.executeCommand('onegayi.vsidian.table.deleteColumn')
    const deleted = columned
      .replace('| 苹果 | | 3 |', '| 苹果 | 3 |')
      .replace('| --- | --- | :---: |', '| --- | :---: |')
      .replace('| `x|y` | | 4 |', '| `x|y` | 4 |')
    await poll('删列写入', () => (doc.getText() === deleted ? true : undefined))
    // 还原（删表头 + 插列 + 删列 = 三笔各撤销一次）
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    }
    await poll('还原', () => (doc.getText() === original ? true : undefined))
    await doc.save()
  }],

  ['表格 Tab 导航：真实 keymap 移动光标、边界不吞输入、零写回（#13）', async () => {
    await openWithEditor('table13.md')
    await waitSessionReady('table13.md')
    const uri = wsUri('table13.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table13.md'))
    const text = TABLE13_DOC_TEXT
    const session0 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 单元格内 Tab → 下一格内容首（table.test.key 驱动真实 keymap 链路）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: text.indexOf('苹果') + 1,
    })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'tab' })
    await waitViewState('table13.md', (v) => v.selectionOffset === text.indexOf('| 3 |') + 2)

    // 行末格 Tab → 下一表格行首格（跨行环绕）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'tab' })
    await waitViewState('table13.md', (v) => v.selectionOffset === text.indexOf('| `x|y` |') + 2)

    // Shift+Tab → 上一行末格内容尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'shift-tab' })
    await waitViewState('table13.md', (v) => v.selectionOffset === text.indexOf('3') + 1)

    // 表格外 Tab：不吞输入——无表格导航时不移动光标、不改文本
    const outside = text.indexOf('前导段落甲') + 2
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: outside })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'tab' })
    await new Promise((r) => setTimeout(r, 600))
    const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState
    assert(v.selectionOffset === outside, `表格外 Tab 不得移动光标，实际 ${v.selectionOffset}`)
    assert(v.text === text, '表格外 Tab 不得改写文本')

    // 末行末格 Tab：边界交默认（无动作）
    const lastCell = text.indexOf('4') + 1
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: lastCell })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'tab' })
    await new Promise((r) => setTimeout(r, 600))
    const v2 = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState
    assert(v2.selectionOffset === lastCell, `末行末格 Tab 应交默认（光标不动），实际 ${v2.selectionOffset}`)

    // 全程零写回：导航是纯选区操作
    const session1 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(session1.version === session0.version, `导航不得改变文档版本（${session0.version} → ${session1.version}）`)
    assert(session1.appliedEdits === session0.appliedEdits, `导航不得产生写回，实际 ${session1.appliedEdits}`)
    assert(doc.getText() === text, '导航后权威文本不变')
  }],

  ['阅读模式表格操作忽略：只读语义零写回，宿主按模式缓存给可见反馈（#13）', async () => {
    await openWithEditor('table13.md')
    await waitSessionReady('table13.md')
    const uri = wsUri('table13.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('table13.md'))
    const text = TABLE13_DOC_TEXT
    const session0 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 光标先落在表格内（live），再切换阅读模式——命令到达但视图只读
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: text.indexOf('苹果') + 1,
    })
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    await poll('进入阅读模式', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' ? true : undefined
    })
    // 模式主动回报刷新宿主缓存（宿主命令拦截的数据源；无缓存则退化为
    // 静默忽略后虚报成功）
    const cache = await poll('宿主模式缓存刷新', async () => {
      const c = (await vscode.commands.executeCommand(CMD.viewStateCache, uri, 0)) as
        | { found: boolean; viewMode?: string }
        | undefined
      return c?.found && c.viewMode === 'reading' ? c : undefined
    })
    assert(cache.viewMode === 'reading', `宿主模式缓存应为 reading，实际 ${cache.viewMode}`)
    // 正式命令路径（宿主注册器）：reading 面板被拦截给可见反馈，不投递
    // webview（活动 tab 为本面板）——零写回且命令完成不挂起
    const intercepted = (await vscode.commands.executeCommand(
      'onegayi.vsidian.table.insertRowBelow',
    )) as boolean
    assert(intercepted === true, '被拦截的命令仍应完成（true = 已处理并反馈）')
    // webview 直发路径同样只读（双重防线）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.command', op: 'insertRowBelow' })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'tab' })
    await new Promise((r) => setTimeout(r, 800))
    assert(doc.getText() === text, '阅读模式不得接受表格结构命令')
    const session1 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(session1.version === session0.version, `阅读模式命令不得改变版本（${session0.version} → ${session1.version}）`)
    assert(session1.appliedEdits === session0.appliedEdits, `阅读模式命令不得产生写回，实际 ${session1.appliedEdits}`)
    // 切回 live 验证面板仍可用（#38 起回 live 用显式命令）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive')
    await waitViewState('table13.md', (v) => v.viewMode === 'live')
  }],

  // ---- 工单 #32：两模式基础排版统一（共享 CSS 变量基线）----
  // 断言口径：同一文档（typography.md）在 live / reading 两态各取一次
  // view.state 的 typography 探针，对照激活侧样本的计算值一致；隐藏侧的
  // 几何口径（textInsetPx）不可用，各模式态只取各自激活侧。

  ['两模式正文基础排版一致：字体族/字号/行高/左留白（#32）', async () => {
    await openWithEditor('typography.md')
    await waitSessionReady('typography.md')
    const uri = wsUri('typography.md').toString()
    // 行号开启时 live 正文向右内缩（行号列+固定间距占宽，#34 流内列布局），
    // 左留白对照须在行号关闭态进行（此时两模式正文同处 --vsidian-content-
    // padding-inline 基线）；字体族/字号/行高不受布局影响
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': false })
    const live = await waitViewState('typography.md', (v) =>
      v.viewMode === 'live' &&
      v.lineGutter?.on === false &&
      v.typography?.live != null &&
      v.typography.live.fontSizePx != null &&
      v.typography.live.lineHeightPx != null &&
      v.typography.live.textInsetPx != null)
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await waitViewState('typography.md', (v) =>
      v.viewMode === 'reading' &&
      v.typography?.reading != null &&
      v.typography.reading.fontSizePx != null &&
      v.typography.reading.lineHeightPx != null &&
      v.typography.reading.textInsetPx != null)
    const l = live.typography!.live!
    const r = reading.typography!.reading!
    // 实测值输出（人工验收记录 A21 的数据来源）
    console.log(`[#32] 正文排版 live: font=${l.fontFamily} size=${l.fontSizePx}px line=${l.lineHeightPx}px inset=${l.textInsetPx}px`)
    console.log(`[#32] 正文排版 reading: font=${r.fontFamily} size=${r.fontSizePx}px line=${r.lineHeightPx}px inset=${r.textInsetPx}px`)
    assert(l.fontFamily === r.fontFamily,
      `正文字体族不一致：live=${l.fontFamily}，reading=${r.fontFamily}`)
    assert(Math.abs(l.fontSizePx! - r.fontSizePx!) < 0.5,
      `正文字号不一致：live=${l.fontSizePx}px，reading=${r.fontSizePx}px`)
    assert(Math.abs(l.lineHeightPx! - r.lineHeightPx!) < 0.5,
      `正文行高不一致：live=${l.lineHeightPx}px，reading=${r.lineHeightPx}px`)
    assert(l.textInsetPx! > 0 && Math.abs(l.textInsetPx! - r.textInsetPx!) < 0.5,
      `正文左留白不一致：live=${l.textInsetPx}px，reading=${r.textInsetPx}px（须为同一正留白且 >0）`)
    // 模式切换零写回（工单验收：不修改源文、不产生保存/撤销历史）
    const s0 = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(s0.appliedEdits === 0, `切换后不得产生写回，实际 ${s0.appliedEdits}`)
    const doc = await vscode.workspace.openTextDocument(wsUri('typography.md'))
    assert(!doc.isDirty, '切换不得触发保存')
    // 还原默认行号开启（跨用例状态清理，同 #34 既有用例约定）；恢复值经
    // waitSettings 读回确认，防 storage 迟到回翻把 false 盖回（见其注释）
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    await waitSettings({ 'editor.lineNumbers': true })
    await waitViewState('typography.md', (v) => v.lineGutter?.on === true)
  }],

  ['两模式列表/引用/表格基础排版一致（#32）', async () => {
    await openWithEditor('typography.md')
    await waitSessionReady('typography.md')
    const live = await waitViewState('typography.md', (v) =>
      v.viewMode === 'live' &&
      v.typography?.liveList != null &&
      v.typography?.liveQuote != null &&
      v.typography?.liveTable != null)
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await waitViewState('typography.md', (v) =>
      v.viewMode === 'reading' &&
      v.typography?.readingList != null &&
      v.typography?.readingQuote != null &&
      v.typography?.readingTable != null)
    const lt = live.typography!
    const rt = reading.typography!
    console.log(`[#32] 列表 live: font=${lt.liveList!.fontFamily} size=${lt.liveList!.fontSizePx}px / reading: font=${rt.readingList!.fontFamily} size=${rt.readingList!.fontSizePx}px`)
    console.log(`[#32] 引用 live: font=${lt.liveQuote!.fontFamily} size=${lt.liveQuote!.fontSizePx}px / reading: font=${rt.readingQuote!.fontFamily} size=${rt.readingQuote!.fontSizePx}px`)
    console.log(`[#32] 表格 live: font=${lt.liveTable!.fontFamily} size=${lt.liveTable!.fontSizePx}px / reading: font=${rt.readingTable!.fontFamily} size=${rt.readingTable!.fontSizePx}px`)
    for (const [name, a, b] of [
      ['列表', lt.liveList!, rt.readingList!],
      ['引用', lt.liveQuote!, rt.readingQuote!],
      ['表格', lt.liveTable!, rt.readingTable!],
    ] as const) {
      assert(a.fontFamily === b.fontFamily,
        `${name}字体族不一致：live=${a.fontFamily}，reading=${b.fontFamily}`)
      assert(Math.abs(a.fontSizePx! - b.fontSizePx!) < 0.5,
        `${name}字号不一致：live=${a.fontSizePx}px，reading=${b.fontSizePx}px`)
    }
  }],

  ['两模式同级标题基础排版一致（#32）', async () => {
    await openWithEditor('typography.md')
    await waitSessionReady('typography.md')
    const live = await waitViewState('typography.md', (v) => v.viewMode === 'live' && (v.headingFontPx ?? 0) > 0)
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await waitViewState('typography.md', (v) => v.viewMode === 'reading' && (v.headingFontPx ?? 0) > 0)
    console.log(`[#32] 一级标题字号 live=${live.headingFontPx}px，reading=${reading.headingFontPx}px（基线×同倍率）`)
    assert(Math.abs(live.headingFontPx! - reading.headingFontPx!) < 0.5,
      `一级标题字号不一致：live=${live.headingFontPx}px，reading=${reading.headingFontPx}px（同级标题须同基线同倍率）`)
  }],

  ['编辑器字号变更两模式按同一规则响应（#32）', async () => {
    await openWithEditor('typography.md')
    await waitSessionReady('typography.md')
    const before = await waitViewState('typography.md', (v) => v.viewMode === 'live' && (v.typography?.live?.fontSizePx ?? 0) > 0)
    const beforeSize = before.typography!.live!.fontSizePx!
    try {
      // 两模式基线同引 --vsidian-content-font-size → --vscode-editor-font-size：
      // 宿主向 webview 注入的该变量随配置即时更新（真宿主实测 14px → 18px）
      await vscode.workspace.getConfiguration('editor').update('fontSize', 18, vscode.ConfigurationTarget.Workspace)
      await poll('live 字号随配置更新', async () => {
        const v = (await vscode.commands.executeCommand(CMD.viewState, wsUri('typography.md').toString(), 0)) as ViewState | undefined
        const size = v?.typography?.live?.fontSizePx
        return typeof size === 'number' && Math.abs(size - 18) <= 0.5 ? v : undefined
      })
      await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
      const reading = await poll('reading 字号随配置更新', async () => {
        const v = (await vscode.commands.executeCommand(CMD.viewState, wsUri('typography.md').toString(), 0)) as ViewState | undefined
        const size = v?.typography?.reading?.fontSizePx
        return v?.viewMode === 'reading' && typeof size === 'number' && Math.abs(size - 18) <= 0.5 ? v : undefined
      })
      console.log(`[#32] 编辑器字号 ${beforeSize}px → 18px：live 与 reading 正文均同步为 ${reading.typography!.reading!.fontSizePx}px`)
    } finally {
      await vscode.workspace.getConfiguration('editor').update('fontSize', undefined, vscode.ConfigurationTarget.Workspace)
    }
  }],

  // ---- #33：独立设置页与设置数据链路 ----

  ['设置页：无文档时命令面板可打开、关闭后可重开（#33）', async () => {
    // 无文档前提：runner 每例结束 closeAllEditors，此处再显式兜底
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    const info0 = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as { open: boolean }
    assert(info0.open === false, '初始应无设置页打开')

    // 命令路径（命令面板入口）：不要求当前有任何 Vsidian 编辑器
    await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
    const info = await poll('设置页打开', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean; ready: boolean }
        | undefined
      return i?.open ? i : undefined
    })
    // webview 装载完成（ready 握手：页面已发 settings.get 拉取权威快照）
    await poll('设置页 webview 就绪', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { ready: boolean }
        | undefined
      return i?.ready ? true : undefined
    })
    assert(info.open === true, '设置页应处于打开状态')

    await vscode.commands.executeCommand(CMD.closeSettingsPage)
    await poll('设置页关闭', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean }
        | undefined
      return i && !i.open ? true : undefined
    })

    // 关闭后重开（生命周期）：再次打开得到新面板且 ready 握手重新完成
    await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
    await poll('设置页重开并就绪', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean; ready: boolean }
        | undefined
      return i?.open && i.ready ? true : undefined
    })
    await vscode.commands.executeCommand(CMD.closeSettingsPage)
  }],

  ['设置页：工具栏消息入口打开、标题归属 Vsidian、不改文档与撤销历史（#33）', async () => {
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    const uri = wsUri('lf.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('lf.md'))
    // lf.md 被早前用例编辑保存过（未还原）：以打开时的权威文本为基线，
    // 不假设 fixture 原文
    const original = doc.getText()

    // 先落一笔真实编辑（驱动撤销历史存在），再开/关设置页
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: 0,
      text: '# ',
    })
    const editedText = `# ${original}`
    await poll('编辑写入权威', () => (doc.getText() === editedText ? true : undefined))
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 工具栏入口（webview「设置」按钮产生的 settings.open 消息，经同一
    // 校验与 provider 拦截入口注入）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'settings.open' })
    const info = await poll('设置页经工具栏消息打开', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean; ready: boolean; title: string }
        | undefined
      return i?.open ? i : undefined
    })
    // 标题与界面归属 Vsidian（面板标题即命令面板/页头呈现）。#93 起标题经
    // t() 取词，随生效语言（auto 按宿主显示语言解析）——期望值与扩展装配
    // 同源计算，不再复制字面量
    const expectedTitle = LOCALE_MESSAGES[
      resolveLocale(undefined, vscode.env.language)
    ]['settings.pageTitle']
    assert(info.title === expectedTitle, `设置页标题应归属 Vsidian（${expectedTitle}），实际 ${info.title}`)
    await poll('设置页 webview 就绪', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { ready: boolean }
        | undefined
      return i?.ready ? true : undefined
    })

    // 打开期间文档零变更
    const duringOpen = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(doc.getText() === editedText, '打开设置页不得修改当前文档')
    assert(duringOpen.version === before.version, `打开设置页不得推进文档版本（${before.version} → ${duringOpen.version}）`)
    assert(duringOpen.appliedEdits === before.appliedEdits, '打开设置页不得产生写回')

    // 关闭设置页后：文档不变、撤销历史仍在（undo 一次回退此前编辑）
    await vscode.commands.executeCommand(CMD.closeSettingsPage)
    await poll('设置页关闭', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean }
        | undefined
      return i && !i.open ? true : undefined
    })
    assert(doc.getText() === editedText, '关闭设置页不得修改当前文档')
    // 设置页关闭后焦点回落的目标不受控（C-5：undo 守卫要求活动 tab 为本
    // 文档的 custom editor），先 reveal 再请求撤销
    await vscode.commands.executeCommand('vscode.openWith', wsUri('lf.md'), VIEW_TYPE)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('撤销历史保留', () => (doc.getText() === original ? true : undefined))
    await doc.save()
  }],

  ['设置链路：有效值保存回读、无效值拒绝、快照到达与广播已开编辑器（#33）', async () => {
    // fixture 定义经运行时注册并入（生产注册表为空——空状态页面的依据）
    const install = (await vscode.commands.executeCommand(CMD.installSettingsFixture)) as { ok: boolean }
    assert(install.ok === true, 'fixture 定义注册失败')

    // 有效值保存并回读（真实宿主 globalState 持久层）
    const okSet = (await vscode.commands.executeCommand(CMD.setSettings, { 'test.flag': true })) as { ok: boolean }
    assert(okSet.ok === true, '有效值应保存成功')
    const snap = (await vscode.commands.executeCommand(CMD.getSettings)) as Record<string, unknown>
    assert(snap['test.flag'] === true, `保存后回读应为 true，实际 ${String(snap['test.flag'])}`)

    // 无效值与未知键按定义拒绝（快照不被污染）
    const badType = (await vscode.commands.executeCommand(CMD.setSettings, { 'test.flag': 1 })) as { ok: boolean }
    assert(badType.ok === false, '类型不符的值必须被拒绝')
    const unknown = (await vscode.commands.executeCommand(CMD.setSettings, { 'unknown.key': true })) as { ok: boolean }
    assert(unknown.ok === false, '未知键必须被拒绝')
    const snap2 = (await vscode.commands.executeCommand(CMD.getSettings)) as Record<string, unknown>
    assert(snap2['test.flag'] === true, '拒绝的保存不得改变快照')

    // init 拉取链路：后打开的编辑器面板装载时收到当前设置（settings.get）。
    // 用 untouched.md（无任何用例编辑它）保证全新面板 init，不受前序用例
    // 的面板状态影响
    await openWithEditor('untouched.md')
    await waitSessionReady('untouched.md')
    const pulled = await waitViewState('untouched.md', (v) => v.settings?.['test.flag'] === true)
    assert(pulled.settings?.['test.flag'] === true, '面板装载后应拉取到当前设置快照')

    // 广播链路：宿主保存变更 → 已打开编辑器面板收到 settings.changed
    await vscode.commands.executeCommand(CMD.setSettings, { 'test.flag': false })
    const broadcast = await waitViewState('untouched.md', (v) => v.settings?.['test.flag'] === false)
    assert(broadcast.settings?.['test.flag'] === false, '设置变更应广播到已打开编辑器面板')

    // 设置页 webview → 宿主正式处理链路（注入与真实消息同一入口）：
    // settings.set 经设置页消息处理入口保存成功
    await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
    await poll('设置页就绪', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean; ready: boolean }
        | undefined
      return i?.open && i.ready ? true : undefined
    })
    await vscode.commands.executeCommand(CMD.injectSettingsPageMessage, {
      kind: 'settings.set',
      values: { 'test.flag': true },
    })
    await poll('设置页链路保存生效', async () => {
      const s = (await vscode.commands.executeCommand(CMD.getSettings)) as Record<string, unknown>
      return s['test.flag'] === true ? true : undefined
    })
    // 广播同样把变更带回已打开编辑器
    // 设置页打开期间其他面板可能被遮挡卸载（VSCode 默认卸载隐藏 webview），
    // 广播以「面板可见时」为准：关闭设置页使编辑器面板恢复（必要时重载）
    // 后，经 init 后的 settings.get 拉取链路看到最新值
    await vscode.commands.executeCommand(CMD.closeSettingsPage)
    const revived = await waitViewState('untouched.md', (v) => v.settings?.['test.flag'] === true)
    assert(revived.settings?.['test.flag'] === true, '设置页链路的保存应经拉取/广播到达编辑器面板')

    // 清理：恢复 fixture 默认值
    await vscode.commands.executeCommand(CMD.setSettings, { 'test.flag': false })
    await vscode.commands.executeCommand(CMD.closeSettingsPage)
  }],

  // ---- #96：语言设置项与切换即生效 ----

  ['语言设置：切换即生效——宿主换包、面板标题同步、持久化重开按新语言（#96）', async () => {
    // auto 基线：与扩展装配同源计算（宿主显示语言解析；测试宿主多为英文
    // 环境 → en，中文环境 → zh-cn，两种环境断言都成立）
    const autoLang = resolveLocale(undefined, vscode.env.language)
    const autoTitle = LOCALE_MESSAGES[autoLang]['settings.pageTitle']
    await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
    const info = await poll('设置页打开并就绪', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean; ready: boolean; title: string }
        | undefined
      return i?.open && i.ready ? i : undefined
    })
    assert(info.title === autoTitle,
      `auto 基线面板标题应按宿主语言（${autoLang} → ${autoTitle}），实际 ${info.title}`)

    // 已打开编辑器面板在场：切换时 locale.changed 广播路径真实执行
    // （与 settings.changed 同一 postToPanel 通道；webview 侧换包由浏览器
    // 套件与单测钉住，此处验证广播后会话保持健康）
    await openWithEditor('untouched.md', true)
    await waitSessionReady('untouched.md')

    // 切到 auto 反侧语言：宿主即时换包 → 已开设置页面板标题同步（真实
    // panel.title，用户在标签上看到的文字）
    const target = autoLang === 'en' ? 'zh-cn' : 'en'
    const targetTitle = LOCALE_MESSAGES[target]['settings.pageTitle']
    const saved = (await vscode.commands.executeCommand(CMD.setSettings, {
      'general.language': target,
    })) as { ok: boolean }
    assert(saved.ok === true, '语言设置保存应成功')
    await poll('面板标题随语言切换', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { title: string }
        | undefined
      return i?.title === targetTitle ? true : undefined
    })

    // 广播后编辑器会话保持健康（面板未被语言切换打断）
    const after = (await vscode.commands.executeCommand(CMD.sessionState, wsUri('untouched.md').toString())) as SessionState
    assert(after.found === true && after.panels.length >= 1,
      '语言切换广播后编辑器面板应仍在会话中')

    // 持久化重开回显：关闭重开设置页，新面板 HTML 按持久化偏好语言生成
    await vscode.commands.executeCommand(CMD.closeSettingsPage)
    await poll('设置页关闭', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean }
        | undefined
      return i && !i.open ? true : undefined
    })
    await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
    const reopened = await poll('设置页重开并就绪', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { open: boolean; ready: boolean; title: string }
        | undefined
      return i?.open && i.ready ? i : undefined
    })
    assert(reopened.title === targetTitle,
      `重开应按持久化语言（${target} → ${targetTitle}）显示标题，实际 ${reopened.title}`)
    await vscode.commands.executeCommand(CMD.closeSettingsPage)

    // 恢复 auto：宿主换包回到基线语言（不污染后续用例的标题断言）
    const back = (await vscode.commands.executeCommand(CMD.setSettings, {
      'general.language': 'auto',
    })) as { ok: boolean }
    assert(back.ok === true, '恢复 auto 应保存成功')
    await poll('宿主恢复 auto 语言', async () => {
      const i = (await vscode.commands.executeCommand(CMD.settingsPageInfo)) as
        | { title: string }
        | undefined
      return i?.title === autoTitle ? true : undefined
    })
  }],

  // ---- #34：实时预览源文件行号 ----

  ['实时预览默认显示从 1 起的源文件行号（结构混合与软换行不新增行号）', async () => {
    await openWithEditor('linenumbers.md')
    await waitSessionReady('linenumbers.md')
    const view = await waitViewState('linenumbers.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const g = view.lineGutter!
    // 首个源行行号为 1（默认开启；空行同样编号）
    assert(g.on === true, '行号默认应开启（定义默认 true）')
    assert(g.first === '1', `首个行号应为 1，实际 ${String(g.first)}`)
    // 行号数与源行数一致（视口覆盖小文档全文），软换行只增加视觉行
    assert(g.count === view.lineCount,
      `行号数应等于源行数 ${view.lineCount}，实际 ${g.count}`)
    assert(g.last === String(view.lineCount),
      `末行号应为源行数 ${view.lineCount}，实际 ${String(g.last)}`)
    // 软换行解耦观测：视觉行数 ≥ 源行数（长段折行时渲染行更多）
    assert(view.renderedLines >= view.lineCount,
      `视觉行 ${view.renderedLines} 不应少于源行 ${view.lineCount}`)
    console.log(`[#34] linenumbers.md：源行 ${view.lineCount}，行号 1..${String(g.last)}，视觉行 ${view.renderedLines}`)
  }],

  ['CRLF 文档行号与源文件行一致（规范化不改行数）', async () => {
    await openWithEditor('crlf.md')
    await waitSessionReady('crlf.md')
    const view = await waitViewState('crlf.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const doc = await vscode.workspace.openTextDocument(wsUri('crlf.md'))
    // webview LF 坐标行数 == 宿主 CRLF 文档行数（\r\n→\n 规范化不改行数）
    assert(view.lineCount === doc.lineCount,
      `webview 行数 ${view.lineCount} 应等于宿主 TextDocument 行数 ${doc.lineCount}`)
    const g = view.lineGutter!
    assert(g.first === '1', `首个行号应为 1，实际 ${String(g.first)}`)
    assert(g.last === String(view.lineCount),
      `末行号应为 ${view.lineCount}，实际 ${String(g.last)}`)
    console.log(`[#34] crlf.md：宿主 lineCount=${doc.lineCount}，行号 1..${String(g.last)}`)
  }],

  ['增删行与撤销重做后行号随源文更新', async () => {
    await openWithEditor('untouched.md')
    await waitSessionReady('untouched.md')
    const uri = wsUri('untouched.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('untouched.md'))
    const original = doc.getText()
    const before = await waitViewState('untouched.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const beforeLines = before.lineCount
    assert(before.lineGutter!.last === String(beforeLines), '初始行号应与源行一致')

    // 行首插入两行（sync.test.edit 走与用户输入同一写回链路）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: 0,
      text: '新行甲\n新行乙\n',
    })
    const afterInsert = await poll('插入后行号随动', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 2 && v.lineGutter?.last === String(beforeLines + 2)
        ? v
        : undefined
    })
    assert(afterInsert.lineGutter!.first === '1', '插入后首行行号仍为 1')
    await poll('编辑写入权威', () => (doc.getText() === `新行甲\n新行乙\n${original}` ? true : undefined))

    // 撤销：行号回落（宿主权威栈回流走 external 路径）
    await vscode.commands.executeCommand('vscode.openWith', wsUri('untouched.md'), VIEW_TYPE)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('撤销后行号回落', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines && v.lineGutter?.last === String(beforeLines) ? v : undefined
    })
    // 重做：行号恢复推进
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'redo' })
    await poll('重做后行号恢复', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 2 ? v : undefined
    })
    // 还原文档（再 undo 一次回到 fixture 原文，避免污染后续用例的行数假设）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('还原 fixture 原文', () => (doc.getText() === original ? true : undefined))
    if (doc.isDirty) {
      await doc.save()
    }
  }],

  ['设置页开关行号：已开编辑器立即生效、新面板拉取持久值、不改源文', async () => {
    // 两个已开面板（当前 + beside）：开关变更须同时到达
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    await openWithEditor('untouched.md', true)
    await waitSessionReady('untouched.md')
    const uriA = wsUri('lf.md').toString()
    await waitViewState('lf.md', (v) => v.lineGutter?.on === true)
    await waitViewState('untouched.md', (v) => v.lineGutter?.on === true)
    const docA = await vscode.workspace.openTextDocument(wsUri('lf.md'))
    const textBefore = docA.getText()
    const sessionBefore = (await vscode.commands.executeCommand(CMD.sessionState, uriA)) as SessionState

    // 关闭：经设置服务的正式保存链路（与设置页 settings.set 同一入口）
    const off = (await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': false })) as { ok: boolean }
    assert(off.ok === true, '关闭行号的设置保存应成功')
    const snap = (await vscode.commands.executeCommand(CMD.getSettings)) as Record<string, unknown>
    assert(snap['editor.lineNumbers'] === false, `保存后回读应为 false，实际 ${String(snap['editor.lineNumbers'])}`)
    const gA = await waitViewState('lf.md', (v) => v.lineGutter?.on === false)
    const gB = await waitViewState('untouched.md', (v) => v.lineGutter?.on === false)
    assert(gA.lineGutter!.count === 0 && gB.lineGutter!.count === 0, '关闭后行号 DOM 应移除')

    // 开关行号不改源文、不产生写回与撤销历史
    assert(docA.getText() === textBefore, '开关行号不得修改文档内容')
    const sessionAfter = (await vscode.commands.executeCommand(CMD.sessionState, uriA)) as SessionState
    assert(sessionAfter.version === sessionBefore.version,
      `开关行号不得推进文档版本（${sessionBefore.version} → ${sessionAfter.version}）`)
    assert(sessionAfter.appliedEdits === sessionBefore.appliedEdits, '开关行号不得产生写回')

    // 持久化口径：关闭全部面板后重开——新面板经 init 后 settings.get 拉到
    // 持久值（真实重启读取的是同一 globalState 键，人工验证条目覆盖重启）
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    const reopened = await waitViewState('lf.md', (v) => v.lineGutter?.on === false)
    assert(reopened.lineGutter!.count === 0, '重开面板应拉取到持久化的关闭状态')

    // 恢复默认开启（后续用例与人工验收的默认态）
    const on = (await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })) as { ok: boolean }
    assert(on.ok === true, '恢复行号的设置保存应成功')
    const restored = await waitViewState('lf.md', (v) => v.lineGutter?.on === true && (v.lineGutter?.count ?? 0) > 0)
    assert(restored.lineGutter!.first === '1', '恢复后行号应从 1 起')
    console.log(`[#34] 开关链路：两面板即时生效，重开面板拉取持久值 false，恢复后 count=${restored.lineGutter!.count}`)
  }],

  ['切换阅读模式无行号、切回实时预览按设置恢复', async () => {
    await openWithEditor('mode.md')
    await waitSessionReady('mode.md')
    const live = await waitViewState('mode.md', (v) => v.viewMode === 'live' && (v.lineGutter?.count ?? 0) > 0)
    assert(live.lineGutter!.first === '1', 'live 初始行号从 1 起')

    // 阅读模式：liveWrapper 整体隐藏（行号随之不可见），阅读视图是独立
    // DOM 子树（EditorView 挂在 liveWrapper 内），天然不渲染任何行号栏
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
    const reading = await waitViewState('mode.md', (v) => v.viewMode === 'reading')
    assert(reading.typography?.reading != null, '阅读视图应活跃渲染（其 DOM 子树不含行号栏）')
    assert(reading.lineGutter?.on === true, '阅读模式下设置开关态保持（切回恢复的依据）')
    console.log(`[#34] 阅读模式：viewMode=${reading.viewMode}，reading 块活跃渲染，liveWrapper 整体隐藏（行号不可见）`)

    // 阅读期间保持设置开；切回 live 后行号按设置恢复且从 1 起。
    // #38 起 toggleViewMode 为三态循环（reading 态下一次是 source），此处
    // 显式指定 toLive（合并 main 后 #34 用例的三态适配）
    await vscode.commands.executeCommand('onegayi.vsidian.mode.toLive', wsUri('mode.md'))
    const back = await waitViewState('mode.md', (v) => v.viewMode === 'live' && (v.lineGutter?.count ?? 0) > 0)
    assert(back.lineGutter!.first === '1', `切回 live 后行号应恢复从 1 起，实际 ${String(back.lineGutter!.first)}`)
    assert(back.lineGutter!.last === String(back.lineCount),
      `切回后末行号应为 ${back.lineCount}，实际 ${String(back.lineGutter!.last)}`)
  }],

  ['大文档行号 DOM 有界、流内列不覆盖正文且开关正文内缩（#34 布局契约）', async () => {
    await openWithEditor('large.md')
    await waitSessionReady('large.md')
    const uri = wsUri('large.md').toString()
    // 初始视口在顶部：行号 DOM 有界（远小于 10 万行）
    const top = await waitViewState('large.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const topG = top.lineGutter!
    assert(topG.count > 0 && topG.count < 2000,
      `行号 DOM 应有界（视口级），实际 ${topG.count}`)
    assert(topG.first === '1', '顶部行号从 1 起')
    // 流内列布局（用户修订 #32 旧契约）：开启行号时正文左缘 = 页面留白 +
    // 行号列 + 固定间距，即比关闭态右移（列宽随位数自适应，无降级机制）
    const insetOn = top.typography?.live?.textInsetPx
    assert(typeof insetOn === 'number' && insetOn > 24,
      `开启行号时正文左缘应右移到留白之外（> 24px），实际 ${String(insetOn)}`)

    // 滚动到底部：行号达 6 位（10 万行），列宽自适应变宽、正文相应再内缩。
    // 经正式定位消息 view.locate 驱动（scrollIntoView 官方滚动路径）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: Math.max(0, top.docLength - 1),
    })
    const bottom = await waitViewState('large.md', (v) =>
      (v.lineGutter?.last ?? '').length >= 6 && v.lineGutter?.on === true)
    const insetBottom = bottom.typography?.live?.textInsetPx
    assert(typeof insetBottom === 'number' && Math.abs(insetBottom - insetOn!) < 1,
      `滚动全程列宽应稳定（CM6 按文档最大行号预留列宽，正文内缩量恒定：` +
        `${insetOn} → ${String(insetBottom)}）——列宽自适应取代 scaleX 压缩的收益`)

    // 滚回顶部：列宽随位数回落，正文内缩量回到顶部档
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: 0 })
    const backTop = await waitViewState('large.md', (v) => v.lineGutter?.first === '1' && (v.lineGutter?.count ?? 0) > 0)
    const insetBack = backTop.typography?.live?.textInsetPx
    assert(typeof insetBack === 'number' && Math.abs(insetBack - insetOn!) < 1,
      `滚回顶部后正文内缩量应回落（${insetOn} → ${String(insetBack)}）`)

    // 关闭行号：列整体卸载，正文回到 24px 页面留白基线（= 阅读模式基线）
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': false })
    const off = await waitViewState('large.md', (v) => v.lineGutter?.on === false && v.lineGutter?.count === 0)
    const insetOff = off.typography?.live?.textInsetPx
    assert(typeof insetOff === 'number' && Math.abs(insetOff - 24) < 1,
      `关闭行号后正文左缘应回到 24px 基线（实际 ${String(insetOff)}）`)
    // 恢复默认开启
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    await waitViewState('large.md', (v) => v.lineGutter?.on === true && (v.lineGutter?.count ?? 0) > 0)
    console.log(`[#34] large.md：顶部 DOM=${topG.count}（有界），开启内缩 ${insetOn}px 恒定（列宽按 10 万行 6 位预留，滚动无回流），关闭基线 ${insetOff}px`)
  }],

  ['文档中部插入/粘贴多行与删除表格行后行号随源文更新', async () => {
    await openWithEditor('linenumbers.md')
    await waitSessionReady('linenumbers.md')
    const uri = wsUri('linenumbers.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('linenumbers.md'))
    const original = doc.getText()
    // 跨用例状态防御：前序用例（开关/大文档）会切换行号设置，卸载期间的
    // 隐藏面板可能错过后续广播——openWith reveal 的可能是幸存面板（实测
    // sessionId 为用例 1 的 panel-1）。显式确保开启：apply 对同值补丁仍会
    // 广播，幸存面板据此对齐当前全局值（与用例 4 的「恢复默认开启」同款
    // 清理动作）
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    const before = await waitViewState('linenumbers.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const beforeLines = before.lineCount
    assert(before.lineGutter!.last === String(beforeLines), '初始行号应与源行一致')

    // 中部插入多行（列表区行首）：行号整体推进
    const midOffset = original.indexOf('- 列表项甲\n')
    assert(midOffset > 0, 'fixture 应包含列表行（中部插入锚点）')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: midOffset,
      text: '中部新行一\n中部新行二\n中部新行三\n',
    })
    const afterMid = await poll('中部插入后行号随动', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 3 && v.lineGutter?.last === String(beforeLines + 3) ? v : undefined
    })
    assert(afterMid.lineGutter!.first === '1', '中部插入后首行行号仍为 1')

    // 粘贴多行（单事务大块插入，与用户粘贴同一 CM6 事务链路）：行号按新增行数推进
    const pasteText = Array.from({ length: 6 }, (_, i) => `粘贴第 ${i + 1} 行`).join('\n') + '\n'
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: afterMid.docLength,
      text: pasteText,
    })
    await poll('粘贴多行后行号随动', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 9 && v.lineGutter?.last === String(beforeLines + 9) ? v : undefined
    })
    // 等宿主写回完成（后续删除锚点按权威文本计算：中部插入使表格行 offset 后移）
    await poll('编辑写入权威', () =>
      doc.getText().includes('中部新行一\n') && doc.getText().endsWith(pasteText) ? true : undefined)

    // 删除行：定位到表格数据行后执行宿主表格命令（webview 经 CM6 事务真实删除整行）
    const tableRowOffset = doc.getText().indexOf('| 甲格 | 乙格 |')
    assert(tableRowOffset > 0, 'fixture 应包含表格数据行（删除锚点）')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate',
      offset: tableRowOffset + 2,
    })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.command',
      op: 'deleteRow',
    })
    await poll('删除行后行号回落', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 8 && v.lineGutter?.last === String(beforeLines + 8) ? v : undefined
    })

    // 三笔编辑逐次撤销（一笔 edit.request = 宿主撤销一次）：行号逐步回落至原文
    await vscode.commands.executeCommand('vscode.openWith', wsUri('linenumbers.md'), VIEW_TYPE)
    const undoSteps = [beforeLines + 9, beforeLines + 3, beforeLines]
    for (const expected of undoSteps) {
      await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
      await poll(`撤销后行号回落到 ${expected}`, async () => {
        const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
        return v?.lineCount === expected && v.lineGutter?.last === String(expected) ? v : undefined
      })
    }
    await poll('还原 fixture 原文', () => (doc.getText() === original ? true : undefined))
    if (doc.isDirty) {
      await doc.save()
    }
  }],

  ['外部变更（宿主 WorkspaceEdit）增删行后行号与源文同步', async () => {
    await openWithEditor('untouched.md')
    await waitSessionReady('untouched.md')
    const doc = await vscode.workspace.openTextDocument(wsUri('untouched.md'))
    const original = doc.getText()
    const before = await waitViewState('untouched.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const beforeLines = before.lineCount

    // 外部插入两行（模拟另一编辑器/其他扩展修改同一文件）：增量回流后行号随动。
    // Position 为 0 基行号：原文档末行（空行）是 line(beforeLines-1)，其行首即文末
    const insert = new vscode.WorkspaceEdit()
    insert.insert(wsUri('untouched.md'), new vscode.Position(beforeLines - 1, 0), '外部行甲\n外部行乙\n')
    assert(await vscode.workspace.applyEdit(insert), '外部插入应成功')
    const afterInsert = await poll('外部插入后行号随动', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, wsUri('untouched.md').toString(), 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 2 && v.lineGutter?.last === String(beforeLines + 2) ? v : undefined
    })
    // 独立断言 lineGutter 观测面（不依赖 text 断言）：开关态、首末行号、视口计数
    const g = afterInsert.lineGutter!
    assert(g.on === true, `外部变更后行号开关应保持，实际 ${String(g.on)}`)
    assert(g.first === '1', `首行行号应为 1，实际 ${String(g.first)}`)
    assert(g.count === beforeLines + 2, `小文档行号计数应等于源行数 ${beforeLines + 2}，实际 ${g.count}`)
    assert(doc.lineCount === beforeLines + 2, `宿主行数应同步为 ${beforeLines + 2}，实际 ${doc.lineCount}`)

    // 外部删除这两行（插入区间恰为两个新行 + 其后的末空行行首边界）：行号回落
    const remove = new vscode.WorkspaceEdit()
    remove.delete(wsUri('untouched.md'), new vscode.Range(beforeLines - 1, 0, beforeLines + 1, 0))
    assert(await vscode.workspace.applyEdit(remove), '外部删除应成功')
    const afterDelete = await poll('外部删除后行号回落', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, wsUri('untouched.md').toString(), 0)) as ViewState | undefined
      return v?.lineCount === beforeLines && v.lineGutter?.last === String(beforeLines) ? v : undefined
    })
    assert(afterDelete.lineGutter!.on === true, '外部变更不得改变行号开关态')
    await poll('外部删除落盘还原', () => (doc.getText() === original ? true : undefined))
    if (doc.isDirty) {
      await doc.save()
    }
    console.log(`[#34] 外部变更：插入后行号 1..${beforeLines + 2}，删除后回落 1..${beforeLines}`)
  }],

  ['CRLF 文档增删行后行号仍与源行一致', async () => {
    await openWithEditor('crlf.md')
    await waitSessionReady('crlf.md')
    const uri = wsUri('crlf.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('crlf.md'))
    const original = doc.getText()
    const before = await waitViewState('crlf.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    const beforeLines = before.lineCount
    assert(beforeLines === doc.lineCount, `初始两系行数应一致（${beforeLines} vs ${doc.lineCount}）`)

    // 行首插入两行（webview LF 坐标）：行号随动，写回后宿主文本保持 CRLF 保真
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: 0,
      text: '新 CRLF 行甲\n新 CRLF 行乙\n',
    })
    const afterInsert = await poll('CRLF 插入后行号随动', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 2 && v.lineGutter?.last === String(beforeLines + 2) ? v : undefined
    })
    assert(afterInsert.lineGutter!.first === '1', 'CRLF 插入后首行行号仍为 1')
    await poll('CRLF 写回保真', () =>
      doc.getText().startsWith('新 CRLF 行甲\r\n新 CRLF 行乙\r\n') ? true : undefined)

    // 撤销插入（宿主权威栈回流走 external 路径）：行号回落
    await vscode.commands.executeCommand('vscode.openWith', wsUri('crlf.md'), VIEW_TYPE)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('CRLF 撤销后行号回落', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines && v.lineGutter?.last === String(beforeLines) ? v : undefined
    })

    // 外部变更（宿主 WorkspaceEdit）追加 CRLF 行：行号随动且行数与宿主一致
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.insert(wsUri('crlf.md'), new vscode.Position(beforeLines, 0), '外部 CRLF 行\r\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部 CRLF 插入应成功')
    const afterExternal = await poll('CRLF 外部变更后行号随动', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.lineCount === beforeLines + 1 && v.lineGutter?.last === String(beforeLines + 1) ? v : undefined
    })
    assert(afterExternal.lineCount === doc.lineCount,
      `外部变更后行数应与宿主一致（${afterExternal.lineCount} vs ${doc.lineCount}）`)

    // 还原（撤销外部变更）并落盘
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('CRLF 还原原文', () => (doc.getText() === original ? true : undefined))
    if (doc.isDirty) {
      await doc.save()
    }
  }],

  // ---- #34 补充（P0 回归）：行号开启时正文真的可见 ----

  ['绘制层探针：行号开启时正文可见、CM6 注入样式存活、行号禁选（P0 回归）', async () => {
    // 由来：CSP style-src 未放行内联样式 → CM6 注入样式表被拒 → scroller
    // 退化 block → #34 行号栏与正文上下堆叠、正文被推出视口。既有 DOM
    // 数量/几何 x 坐标断言全部存活于该缺陷之上，唯有绘制层断言能拦住。
    await openWithEditor('linenumbers.md')
    await waitSessionReady('linenumbers.md')
    const on = await waitViewState('linenumbers.md', (v) => (v.lineGutter?.count ?? 0) > 0)
    assert(on.lineGutter?.on === true, '行号应默认开启')
    assert(on.paint?.textVisible === true,
      `行号开启时正文应可见（textVisible=${String(on.paint?.textVisible)}，` +
        `scrollerDisplay=${String(on.paint?.scrollerDisplay)}）`)
    assert(on.paint?.scrollerDisplay === 'flex',
      `CM6 注入样式应存活（scroller display 应为 flex，实际 ${String(on.paint?.scrollerDisplay)}；` +
        '若为 block 说明 CSP 拦截了 style-mod 注入的样式表）')
    assert(on.paint?.gutterUserSelect === 'none',
      `行号栏应禁选（user-select 应为 none，实际 ${String(on.paint?.gutterUserSelect)}）`)
    // 光标明暗自适应（深色主题黑底黑光标回归）：断言 dark 声明与 caret
    // 变体联动，不依赖测试宿主默认主题——浅色/深色宿主下均自洽成立
    const dark = on.paint?.darkTheme
    const caret = on.paint?.caretColor ?? null
    console.log(`[P0] darkTheme=${String(dark)}，caret-color=${String(caret)}`)
    assert(typeof dark === 'boolean', `dark 声明应为布尔（实际 ${String(dark)}）`)
    assert(caret !== null, 'caret-color 计算值应可读（caretColor 不应为 null）')
    if (dark) {
      assert(caret === 'rgb(255, 255, 255)' || caret === '#ffffff' || caret === '#fff',
        `dark 声明激活时 caret 应为 baseTheme dark 变体 white（实际 ${caret}；` +
          '非白说明明暗声明未接管 caret 颜色——黑底黑光标回归）')
    } else {
      assert(caret === 'rgb(0, 0, 0)' || caret === '#000000' || caret === '#000',
        `light 声明时 caret 应为 baseTheme light 变体 black（实际 ${caret}）`)
    }

    // 差分自证：关闭行号后正文仍可见（度量在两态下均有效）
    const okSet = (await vscode.commands.executeCommand(CMD.setSettings, {
      'editor.lineNumbers': false,
    })) as { ok: boolean }
    assert(okSet.ok === true, '关闭行号设置应成功')
    const off = await waitViewState('linenumbers.md', (v) => v.lineGutter?.on === false)
    assert(off.paint?.textVisible === true, '行号关闭后正文应仍可见（度量校准）')
    // 还原默认开启，避免影响后续用例（与 #34 既有用例同款跨用例状态清理）
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
    await waitViewState('linenumbers.md', (v) => v.lineGutter?.on === true)
  }],

  // ---- #53 顶栏图标化与右侧栏布局 ----

  ['右侧栏收起→展开→收起循环：绘制层证据与图标两态线宽（#53）', async () => {
    // 绘制层断言口径（视觉层断言必查）：侧栏可见性经 elementFromPoint 命中
    // 证明（display:none、零尺寸或覆盖遮挡时命中失败）；图标两态粗细经
    // computed stroke-width 证明（差异唯一来源是样式表的 open 类规则，
    // 样式失效时两态同值）。DOM 存在性与几何坐标不能替代这些证据。
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    const uri = wsUri('lf.md').toString()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 收起态：按钮与齿轮入口真实可见，侧栏不可见，竖线为细线
    const collapsed = await waitViewState('lf.md', (v) => v.sidebar !== undefined)
    assert(collapsed.sidebar!.open === false, '初始应为收起态')
    assert(collapsed.sidebar!.togglePainted === true,
      `切换按钮应真实可见（命中测试失败：${JSON.stringify(collapsed.sidebar)}）`)
    assert(collapsed.sidebar!.settingsPainted === true,
      `齿轮设置按钮应真实可见（命中测试失败：${JSON.stringify(collapsed.sidebar)}）`)
    assert(collapsed.sidebar!.sidebarToolbarPainted === false, '收起时侧栏顶栏不得可见（命中应失败）')
    assert(collapsed.sidebar!.settingsAriaLabel === editorMessages()['sidebar.settings'],
      `齿轮可访问名称应为「${editorMessages()['sidebar.settings']}」，实际 ${String(collapsed.sidebar!.settingsAriaLabel)}`)
    assert(collapsed.sidebar!.toggleAriaLabel === editorMessages()['sidebar.expand'],
      `收起态切换按钮名称应为「${editorMessages()['sidebar.expand']}」，实际 ${String(collapsed.sidebar!.toggleAriaLabel)}`)
    assert(Math.abs(parseFloat(collapsed.sidebar!.toggleBarStrokeWidth ?? 'x') - 1.5) < 0.01,
      `收起态图标竖线应为细线 1.5px，实际 ${String(collapsed.sidebar!.toggleBarStrokeWidth)}`)
    assert(collapsed.paint?.textVisible === true, '收起态正文应可见')
    const collapsedMainWidth = collapsed.sidebar!.mainWidthPx ?? 0
    assert(collapsedMainWidth > 0, '收起态主编辑区应有宽度')

    // 展开：侧栏顶栏真实绘制于右侧空出区域，竖线变粗，主编辑区收缩。
    // 谓词等待动画终态（宽度过渡期间命中/宽度瞬时失真，轮询至到位）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const opened = await waitViewState('lf.md', (v) => v.sidebar?.open === true &&
      v.sidebar.sidebarToolbarPainted === true && (v.sidebar.sidebarWidthPx ?? 0) > 200)
    assert(opened.sidebar!.sidebarToolbarPainted === true,
      `展开时侧栏顶栏应实际绘制（elementFromPoint 应命中侧栏：${JSON.stringify(opened.sidebar)}）`)
    assert(Math.abs(parseFloat(opened.sidebar!.toggleBarStrokeWidth ?? 'x') - 3) < 0.01,
      `展开态图标竖线应为粗线 3px，实际 ${String(opened.sidebar!.toggleBarStrokeWidth)}`)
    // 外框线宽两态恒定（对照：证明粗细变化只发生在竖线）
    assert(Math.abs(parseFloat(opened.sidebar!.toggleFrameStrokeWidth ?? 'x') -
      parseFloat(collapsed.sidebar!.toggleFrameStrokeWidth ?? 'x')) < 0.01,
      '图标外框线宽两态应恒定（差异只应在竖线）')
    assert(opened.sidebar!.toggleAriaLabel === editorMessages()['sidebar.collapse'],
      `展开态切换按钮名称应为「${editorMessages()['sidebar.collapse']}」，实际 ${String(opened.sidebar!.toggleAriaLabel)}`)
    assert((opened.sidebar!.sidebarWidthPx ?? 0) > 200,
      `侧栏应占出宽度（约 280px），实际 ${String(opened.sidebar!.sidebarWidthPx)}`)
    assert((opened.sidebar!.mainWidthPx ?? 0) < collapsedMainWidth - 200,
      `主编辑区宽度应随侧栏收缩（${collapsedMainWidth} → ${String(opened.sidebar!.mainWidthPx)}）`)
    assert(opened.sidebar!.togglePainted === true,
      '展开态切换按钮应仍可见（随主编辑区右边界移动后仍可命中）')
    assert(opened.paint?.textVisible === true, '展开态正文应仍可见（布局收缩不遮挡正文）')

    // 切换全程零写回、零版本推进（侧栏是纯视图状态）
    const afterToggle = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterToggle.version === before.version,
      `切换侧栏不得推进文档版本（${before.version} → ${afterToggle.version}）`)
    assert(afterToggle.appliedEdits === before.appliedEdits, '切换侧栏不得产生写回')

    // 收起回归：侧栏顶栏重新不可见、竖线回细线、名称回「展开右侧栏」
    // （谓词等待收起动画终态：主编辑区宽度复原到基线 ±2px）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const recollapsed = await waitViewState('lf.md', (v) => v.sidebar?.open === false &&
      v.sidebar.sidebarToolbarPainted === false &&
      Math.abs((v.sidebar.mainWidthPx ?? -999) - collapsedMainWidth) < 2)
    assert(recollapsed.sidebar!.sidebarToolbarPainted === false, '收起后侧栏顶栏应不可见')
    assert(Math.abs(parseFloat(recollapsed.sidebar!.toggleBarStrokeWidth ?? 'x') - 1.5) < 0.01,
      `收起回归后图标竖线应回细线 1.5px，实际 ${String(recollapsed.sidebar!.toggleBarStrokeWidth)}`)
    assert(recollapsed.sidebar!.toggleAriaLabel === editorMessages()['sidebar.expand'],
      `收起回归后名称应回「${editorMessages()['sidebar.expand']}」，实际 ${String(recollapsed.sidebar!.toggleAriaLabel)}`)
    assert(Math.abs((recollapsed.sidebar!.mainWidthPx ?? 0) - collapsedMainWidth) < 2,
      `收起回归后主编辑区宽度应复原（${collapsedMainWidth} → ${String(recollapsed.sidebar!.mainWidthPx)}）`)
  }],

  ['右侧栏与模式切换正交：两模式共用布局、零撤销记录、正文可编辑（#53）', async () => {
    // untouched.md 无任何前序用例编辑：全新面板 + 干净撤销栈基线
    await openWithEditor('untouched.md')
    await waitSessionReady('untouched.md')
    const uri = wsUri('untouched.md').toString()
    const baseline = '未触碰文档\n保持原样\n'
    const doc = await vscode.workspace.openTextDocument(wsUri('untouched.md'))
    assert(doc.getText() === baseline, 'untouched.md 应为 fixture 原文')
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // live 下展开侧栏
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('untouched.md', (v) => v.sidebar?.open === true)

    // 切到 reading：侧栏保持展开且同样真实绘制（两模式共用同一布局；
    // 谓词含绘制命中，等侧栏展开宽度过渡完成）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const readingOpen = await waitViewState('untouched.md',
      (v) => v.viewMode === 'reading' && v.sidebar?.open === true &&
        v.sidebar.sidebarToolbarPainted === true)
    assert(readingOpen.sidebar!.sidebarToolbarPainted === true,
      `阅读模式侧栏应同样展开绘制（${JSON.stringify(readingOpen.sidebar)}）`)
    assert((readingOpen.readingBlockCount ?? 0) > 0, '阅读模式正文应正常渲染（块数 > 0）')

    // 切回 live：侧栏状态不因模式切换丢失（谓词含绘制命中，维持终态等待）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const liveOpen = await waitViewState('untouched.md',
      (v) => v.viewMode === 'live' && v.sidebar?.open === true &&
        v.sidebar.sidebarToolbarPainted === true)
    assert(liveOpen.sidebar!.sidebarToolbarPainted === true, '切回 live 后侧栏应仍展开绘制')

    // 模式与侧栏切换全程零写回、零版本推进（不产生文档撤销记录）
    const afterSwitches = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterSwitches.version === before.version,
      `切换模式/侧栏不得推进文档版本（${before.version} → ${afterSwitches.version}）`)
    assert(afterSwitches.appliedEdits === before.appliedEdits, '切换不得产生写回')
    assert(doc.getText() === baseline, '切换不得修改文档内容')

    // 展开态下正文仍可编辑（布局不影响输入链路）：一笔编辑经标准链路写回
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: 0,
      text: '# ',
    })
    await poll('展开态编辑写入权威', () => (doc.getText() === `# ${baseline}` ? true : undefined))

    // 撤销一次即回原文：撤销栈里只有这笔编辑（侧栏/模式切换未入栈）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('撤销一次还原', () => (doc.getText() === baseline ? true : undefined))
    if (doc.isDirty) {
      await doc.save()
    }

    // 收起侧栏收尾（避免跨用例状态泄漏）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('untouched.md', (v) => v.sidebar?.open === false)
  }],

  // ---- #54 右侧栏大纲面板 ----

  ['大纲面板展开：绘制层可见与全文标题序列一致（#54）', async () => {
    // 绘制层断言口径（视觉层断言必查）：大纲按钮与面板可见性经
    // elementFromPoint 命中证明（侧栏收起 / 面板 display:none / 样式注入
    // 失效时命中必失败）；内容一致性经 view.state 的 outline.items 对拍
    // 源文本文档标题（跨级、同名不合并，伪标题排除）。
    await openWithEditor('outline.md')
    await waitSessionReady('outline.md')
    const uri = wsUri('outline.md').toString()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 收起态：大纲按钮在侧栏内（display:none 继承），命中必失败
    const collapsed = await waitViewState('outline.md', (v) => v.outline !== undefined)
    assert(collapsed.outline!.active === true, '大纲面板默认 active（展开侧栏即见大纲）')
    assert(collapsed.outline!.togglePainted === false, '侧栏收起时大纲按钮不得可见')
    assert(collapsed.outline!.toggleAriaLabel === editorMessages()['outline.label'],
      `大纲按钮可访问名称应为「${editorMessages()['outline.label']}」，实际 ${String(collapsed.outline!.toggleAriaLabel)}`)

    // 展开：按钮与面板真实绘制（elementFromPoint 命中），可访问名称齐备
    // （谓词等待展开动画终态：过渡期间面板中心点可能未入视口）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const opened = await waitViewState('outline.md', (v) => v.sidebar?.open === true &&
      v.outline?.togglePainted === true && v.outline.panelPainted === true)
    assert(opened.outline!.togglePainted === true,
      `大纲按钮应真实可见（命中失败：${JSON.stringify(opened.outline)}）`)
    assert(opened.outline!.panelPainted === true,
      `大纲面板应真实绘制（elementFromPoint 应命中面板：${JSON.stringify(opened.outline)}）`)
    // 图标尺寸 16px（P1-2 回归）：尺寸规则的类名曾写错（.vsidian-toolbar-actions
    // vs DOM 实际 .vsidian-sidebar-toolbar-actions），选择器永不匹配时 SVG 回退
    // 默认尺寸溢出 24px 按钮盒——computed 尺寸直接钉住「用户看到的图标大小」
    assert(Math.abs((opened.outline!.toggleIconSizePx ?? -1) - 16) < 0.01,
      `大纲按钮图标应为 16px（选择器命中与规则生效的 computed 证据），` +
        `实际 ${String(opened.outline!.toggleIconSizePx)}`)
    assert(opened.outline!.panelAriaLabel === editorMessages()['outline.label'],
      `大纲面板可访问名称应为「${editorMessages()['outline.label']}」，实际 ${String(opened.outline!.panelAriaLabel)}`)
    assert(opened.paint?.textVisible === true, '展开态正文应仍可见')

    // 内容一致：大纲 = 源文本文档标题的级别/文字/起始行序列（跨级、同名、
    // Setext 语义与伪标题排除一次对拍）
    const expected: Array<[number, string, number]> = [
      [1, '文档主标题', 6],
      [2, '同名标题', 8],
      [3, '三级标题', 12],
      [2, '同名标题', 14],
      [1, '跨级回一级', 16],
      [1, 'Setext 一级', 18],
      [2, 'Setext 二级', 21],
      [4, '四级标题', 24],
      [5, '五级标题', 26],
      [6, '六级标题', 28],
    ]
    const items = opened.outline!.items
    assert(items.length === expected.length,
      `大纲条目数应为 ${expected.length}（伪标题排除、同名不合并），实际 ${items.length}：${JSON.stringify(items)}`)
    for (let i = 0; i < expected.length; i++) {
      const [level, text, line] = expected[i]!
      assert(items[i]!.level === level && items[i]!.text === text && items[i]!.line === line,
        `大纲第 ${i + 1} 项应为 [${level}, ${text}, ${line}]，实际 ${JSON.stringify(items[i])}`)
    }

    // 展示大纲零写回：版本与写回计数不变（面板是纯视图状态）
    const afterOpen = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterOpen.version === before.version,
      `展开侧栏显示大纲不得推进文档版本（${before.version} → ${afterOpen.version}）`)
    assert(afterOpen.appliedEdits === before.appliedEdits, '显示大纲不得产生写回')

    // 收起侧栏收尾（避免跨用例状态泄漏）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲面板切换与编辑更新：active 两态绘制证据、文本变更后大纲跟随（#54）', async () => {
    await openWithEditor('outline.md')
    await waitSessionReady('outline.md')
    const uri = wsUri('outline.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline.md', (v) => v.sidebar?.open === true && v.outline?.panelPainted === true)

    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    const baselineItems = (await waitViewState('outline.md', (v) => v.outline !== undefined))
      .outline!.items

    // 点击大纲按钮：面板隐藏（绘制层证据翻转）、数据保留、零写回
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.click' })
    const hidden = await waitViewState('outline.md', (v) => v.outline?.active === false)
    assert(hidden.outline!.panelPainted === false,
      `active=false 后大纲面板不得绘制（${JSON.stringify(hidden.outline)}）`)
    assert(hidden.outline!.items.length === baselineItems.length, '面板隐藏不影响大纲数据')
    const afterHide = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterHide.version === before.version && afterHide.appliedEdits === before.appliedEdits,
      '切换大纲面板不得推进版本或产生写回（不写回、不入撤销历史）')

    // 再点回：面板重新绘制
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.click' })
    const shown = await waitViewState('outline.md', (v) => v.outline?.active === true)
    assert(shown.outline!.panelPainted === true, '重新激活后大纲面板应恢复绘制')

    // 编辑标题：大纲随当前文本（含未保存编辑）更新——文档末尾追加二级标题
    const endOffset = doc.getText().length
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'sync.test.edit',
      offset: endOffset,
      text: '\n## 集成新增标题\n',
    })
    const updated = await waitViewState('outline.md',
      (v) => v.outline !== undefined && v.outline.items.length === baselineItems.length + 1)
    const last = updated.outline!.items[updated.outline!.items.length - 1]!
    assert(last.level === 2 && last.text === '集成新增标题',
      `新增标题应入大纲末项 [2, 集成新增标题]，实际 ${JSON.stringify(last)}`)

    // 撤销这笔编辑（回到原文），大纲同步回落（撤销后写回链路的另一面）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    const undone = await waitViewState('outline.md', (v) =>
      v.outline !== undefined && v.outline.items.length === baselineItems.length)
    assert(undone.outline!.items.every((item, i) =>
      item.level === baselineItems[i]!.level && item.text === baselineItems[i]!.text),
      '撤销编辑后大纲应回落为原序列')
    if (doc.isDirty) {
      await doc.save()
    }

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲与模式切换正交：两模式下序列不变、面板持续绘制（#54）', async () => {
    await openWithEditor('outline.md')
    await waitSessionReady('outline.md')
    const uri = wsUri('outline.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const live = await waitViewState('outline.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true)
    const liveItems = live.outline!.items.map((i) => [i.level, i.text])

    // 切到阅读模式：大纲仍来自 CM6 全文（非阅读渲染），面板持续绘制
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('outline.md',
      (v) => v.viewMode === 'reading' && v.outline !== undefined)
    assert(reading.outline!.panelPainted === true,
      `阅读模式下大纲面板应持续绘制（${JSON.stringify(reading.outline)}）`)
    assert(
      JSON.stringify(reading.outline!.items.map((i) => [i.level, i.text])) === JSON.stringify(liveItems),
      '模式切换不得改变大纲序列（数据源是 CM6 全文，非阅读渲染）')
    assert((reading.readingBlockCount ?? 0) > 0, '阅读模式正文应正常渲染')

    // 切回 live：序列仍不变
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const backLive = await waitViewState('outline.md', (v) => v.viewMode === 'live' && v.outline !== undefined)
    assert(
      JSON.stringify(backLive.outline!.items.map((i) => [i.level, i.text])) === JSON.stringify(liveItems),
      '切回 live 后大纲序列应不变')

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline.md', (v) => v.sidebar?.open === false)
  }],

  ['长大纲面板可滚动：高度受宿主约束、超长内容溢出可滚（评审修复）', async () => {
    // P1-1 回归（视觉层断言）：修复前面板无高度约束（height:auto 长到内容
    // 高度），被宿主 overflow:hidden 裁剪——clientHeight==scrollHeight 使
    // overflow-y 永不激活，末条不可达，且面板中心点落到宿主可视区外使
    // panelPainted 误报 false（探针盲区，随本修复消解）。约束生效的另一半：
    // 条目不收缩（flex:0 0 auto），否则条目被压扁后内容总高不溢出、滚动
    // 依旧失效（overflow:hidden 使 flex item 的 min-height:auto 为 0）。
    // 断言口径：scrollHeight > clientHeight 证明高度被宿主 flex 链约束、
    // 条目未收缩且内容溢出（overflow-y:auto 由此激活滚动）；panelPainted
    // 证明面板在可视区内真实绘制；条目计数证明长大纲数据完整。
    await openWithEditor('outline-long.md')
    await waitSessionReady('outline-long.md')
    const uri = wsUri('outline-long.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const opened = await waitViewState('outline-long.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true)
    const scrollHeight = opened.outline!.panelScrollHeightPx
    const clientHeight = opened.outline!.panelClientHeightPx
    assert(scrollHeight !== null && clientHeight !== null,
      `长面板滚动几何应可读（scrollHeight/clientHeight 不为 null）：${JSON.stringify(opened.outline)}`)
    assert(clientHeight > 0, `面板可视高度应为正（实际 ${clientHeight}）`)
    assert(scrollHeight! > clientHeight! + 500,
      `长大纲（101 标题）面板内容应显著溢出可视区（scrollHeight ${scrollHeight} 应比 ` +
        `clientHeight ${clientHeight} 大 500px 以上；相等说明高度约束失效或条目被压扁，` +
        `条目数 ${opened.outline!.items.length}）`)
    assert(opened.outline!.items.length === 101,
      `长大纲条目应为 101 项（1 主标题 + 50 章 + 50 小节），实际 ${opened.outline!.items.length}`)
    assert(opened.outline!.items[100]!.text === '第 50 章小节',
      `末条应为「第 50 章小节」，实际 ${JSON.stringify(opened.outline!.items[100])}`)
    assert(opened.paint?.textVisible === true, '长大纲展开态正文应仍可见')

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-long.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲条目行内样式透传与主题色同源：标记渲染、字重与颜色绘制证据（#65）', async () => {
    // 绘制层断言口径（视觉层断言必查）：outline.style 经 computed style 读取
    // 条目与标记 span 的字重/字体族/颜色——CSS 注入失效（如 CSP 拦截）或
    // 选择器写错时取不到目标元素或值退化，数据层 plainText/spans 对拍源文档
    // 标题结构。fixture 见 fixtures.mjs 的 OUTLINE_STYLE_DOC。
    await openWithEditor('outline-style.md')
    await waitSessionReady('outline-style.md')
    const uri = wsUri('outline-style.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const opened = await waitViewState('outline-style.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline?.style !== undefined)

    // 数据层：plainText 剥标记、白名单 spans 结构、原文保留、双链/链接纯文本
    const expected: Array<[number, string, string, Array<{ kind: string; start: number; end: number }>, number]> = [
      [1, '**重点** 结论', '重点 结论', [{ kind: 'strong', start: 0, end: 2 }], 1],
      [2, '*斜体* 与 `代码`', '斜体 与 代码',
        [{ kind: 'emphasis', start: 0, end: 2 }, { kind: 'code', start: 5, end: 7 }], 2],
      [3, '~~删除线~~ 与 [[目标笔记|显示别名]]', '删除线 与 显示别名',
        [{ kind: 'strike', start: 0, end: 3 }], 3],
      [4, '[链接文字](https://example.com) 尾注', '链接文字 尾注', [], 4],
      [5, '***粗斜*** 与普通', '粗斜 与普通',
        [{ kind: 'emphasis', start: 0, end: 2 }, { kind: 'strong', start: 0, end: 2 }], 5],
    ]
    const items = opened.outline!.items
    assert(items.length === expected.length,
      `大纲条目数应为 ${expected.length}，实际 ${items.length}：${JSON.stringify(items)}`)
    for (let i = 0; i < expected.length; i++) {
      const [level, text, plainText, spans, line] = expected[i]!
      assert(items[i]!.level === level && items[i]!.text === text && items[i]!.line === line,
        `大纲第 ${i + 1} 项基础字段应为 [${level}, ${text}, ${line}]，实际 ${JSON.stringify(items[i])}`)
      assert(items[i]!.plainText === plainText,
        `第 ${i + 1} 项 plainText 应为 ${plainText}（标记字符不得透出），实际 ${JSON.stringify(items[i]!.plainText)}`)
      assert(JSON.stringify(items[i]!.spans) === JSON.stringify(spans),
        `第 ${i + 1} 项 spans 应为 ${JSON.stringify(spans)}，实际 ${JSON.stringify(items[i]!.spans)}`)
    }

    // 绘制层：条目常规字重（不继承标题级别加粗）与显式粗体段加重的对照
    const style = opened.outline!.style!
    const isRegular = (v: string | null) => v === '400' || v === 'normal'
    const isBold = (v: string | null) => v === '700' || v === 'bold'
    assert(style.itemFontWeight !== null, '条目 computed 字重应可读（面板已绘制且有条目）')
    assert(isRegular(style.itemFontWeight),
      `大纲条目应为常规字重（400/normal，不继承标题级别加粗），实际 ${style.itemFontWeight}`)
    assert(isBold(style.strongFontWeight),
      `显式 **粗体** 段应加重（700/bold），实际 ${String(style.strongFontWeight)}`)
    assert(style.codeFontFamily !== null && style.itemFontFamily !== null,
      '行内代码与条目的 computed 字体族应可读')

    // 主题色同源：大纲条目与正文标题引用同一变量族，当前主题下解析同值；
    // 大纲侧脱钩（改引别的变量/硬编码）时两值分叉，断言即失败
    assert(style.itemColor !== null && style.headingColor !== null,
      '条目与正文标题 computed 颜色应可读（两侧均有绘制内容）')
    assert(style.itemColor === style.headingColor,
      `大纲条目与正文标题应引用同一层级色变量族（同值），条目=${style.itemColor}，标题=${style.headingColor}`)

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-style.md', (v) => v.sidebar?.open === false)
  }],

  // ---- #66 大纲点击跳转与常驻高亮 ----

  ['大纲点击跳转与常驻高亮：双模式定位、绘制层高亮、零写回、防抖动护栏（#66）', async () => {
    // 断言口径（视觉层断言必查）：
    // - 点击跳转：live 光标落标题行首（selectionOffset 对拍宿主 offset）、
    //   reading 锚点为标题块 start（readingAnchorStart 对拍）——复用
    //   view.locate 双模式路径，零 edit.request / 版本不变
    // - 常驻高亮：locatedItemIndex/locatedText 状态对拍 + locatedPainted
    //   绘制层证据（elementFromPoint 命中 + computed 背景非全透明——
    //   样式注入失效时高亮横条不可见，此断言必失败）
    // - 防抖动护栏：跳转居中滚动后视口顶行在目标标题上方（上一控制域），
    //   程序性滚动不得把高亮反向改写回上一章——真宿主有真实滚动事件，
    //   护栏语义在此可真实验证（浏览器回归同款断言的宿主侧对应）
    await openWithEditor('outline-long.md')
    await waitSessionReady('outline-long.md')
    const uri = wsUri('outline-long.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-long.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-long.md', (v) => v.sidebar?.open === true && v.outline?.panelPainted === true)
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 首屏高亮：文档初始位于顶部，视口顶行在主标题控制域（首条目在面板
    // 可视区内——绘制层断言要求 located 条目可被 elementFromPoint 命中）
    const initial = await waitViewState('outline-long.md',
      (v) => v.outline?.locatedItemIndex === 0 && v.outline?.locatedPainted === true)
    assert(initial.outline!.locatedText === '长文档主标题',
      `首屏高亮应为主标题，实际 ${JSON.stringify(initial.outline!.locatedItemIndex)} ${String(initial.outline!.locatedText)}`)
    assert(initial.outline!.locatedPainted === true,
      `首屏高亮横条应真实绘制（命中 + 半透明背景）：${JSON.stringify(initial.outline)}`)

    // live 点击「第 30 章」（items[59]，标题行）：光标落标题行首 + 高亮即时落位。
    // 该条目在面板滚动区可视范围外（长大纲溢出），locatedPainted 的命中
    // 口径不适用（#67 的「高亮行滚进大纲可视区」落地前不断言），绘制层
    // 证据由首屏与下方 reading 可视区内条目覆盖
    const chapter30Line = initial.outline!.items[59]!.line
    assert(initial.outline!.items[59]!.text === '第 30 章',
      `items[59] 应为「第 30 章」，实际 ${JSON.stringify(initial.outline!.items[59])}`)
    const chapter30Offset = doc.offsetAt(new vscode.Position(chapter30Line - 1, 0))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.itemClick', index: 59 })
    const jumped = await waitViewState('outline-long.md',
      (v) => v.selectionOffset === chapter30Offset && v.outline?.locatedItemIndex === 59)
    assert(jumped.outline!.locatedText === '第 30 章', '跳转后 locatedText 应为目标标题')

    // 零写回：版本与写回计数不变（跳转是纯视图操作，不入撤销历史）
    const afterJump = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterJump.version === before.version && afterJump.appliedEdits === before.appliedEdits,
      `大纲跳转不得推进版本或产生写回（${before.version}/${before.appliedEdits} → ` +
        `${afterJump.version}/${afterJump.appliedEdits}）`)

    // 防抖动护栏：居中滚动的事件突发期（真宿主为真实 scroll 事件）过后，
    // 高亮不得被视口顶行重算反向改写（无护栏时会回到第 29 章的控制域）
    await new Promise((r) => setTimeout(r, 700))
    const guarded = await waitViewState('outline-long.md', (v) => v.selectionOffset === chapter30Offset)
    assert(guarded.outline!.locatedItemIndex === 59,
      `程序性滚动不得改写跳转高亮（实际 ${guarded.outline!.locatedItemIndex}；` +
        `无护栏时会被视口顶行重算到第 29 章附近）`)

    // reading 点击「第 2 章」（items[3]，面板可视区内——locatedPainted 的
    // elementFromPoint 命中口径成立）：锚点滚到标题块 + 高亮跟随 + 绘制层
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    await waitViewState('outline-long.md', (v) => v.viewMode === 'reading')
    const chapter2Line = initial.outline!.items[3]!.line
    assert(initial.outline!.items[3]!.text === '第 2 章',
      `items[3] 应为「第 2 章」，实际 ${JSON.stringify(initial.outline!.items[3])}`)
    const chapter2Offset = doc.offsetAt(new vscode.Position(chapter2Line - 1, 0))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.itemClick', index: 3 })
    const readingJumped = await waitViewState('outline-long.md',
      (v) => v.readingAnchorStart === chapter2Offset && v.outline?.locatedItemIndex === 3)
    assert(readingJumped.outline!.locatedPainted === true,
      `阅读模式高亮横条应真实绘制（located 条目在面板可视区内）：${JSON.stringify(readingJumped.outline)}`)
    assert((readingJumped.readingBlockCount ?? 0) > 0, '阅读正文应正常渲染')

    // 阅读跳转同样零写回
    const afterReading = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterReading.version === before.version && afterReading.appliedEdits === before.appliedEdits,
      '阅读模式跳转同样不得产生写回')

    // 模式切换即时重算：切回 live 后 located 即时重算（非 null；具体值随
    // 锚点恢复滚动位置而定）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const backLive = await waitViewState('outline-long.md',
      (v) => v.viewMode === 'live' && v.outline !== undefined && v.outline.locatedItemIndex !== null)
    assert(backLive.outline!.locatedItemIndex! >= 0, '切回 live 后应即时重算 located')

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-long.md', (v) => v.sidebar?.open === false)
  }],

  // ---- #67 大纲折叠滑块与手动折叠 ----

  ['大纲折叠滑块与手动折叠：档位语义、绘制层证据、滚动展开、编辑存活（#67）', async () => {
    // 断言口径（视觉层断言必查）：
    // - 档位语义：visibleIndices 状态对拍（档 1 = 展开 H1 父节点 → 51 条
    //   可见；档 0 = 只露顶层）——「展开到 Hn = 展开 level≤n 父节点」而非
    //   只显示 level≤n 标题
    // - 绘制层证据：sliderPainted/sliderActiveDotPainted（active 圆点命中
    //   + computed 实心）/chevronPainted（elementFromPoint 命中，样式注入
    //   失败时必失败）与 locatedPainted（#67 落地后补全的口径：高亮行
    //   滚进面板可视区后命中成立——跳转到面板滚动区深处的折叠条目）
    // - 滚动动态展开：view.locate 落进折叠区 → only-expand 展开当前路径
    //   （其余折叠区不动）、locatedPainted 成立
    // - 编辑存活：宿主 WorkspaceEdit 重命名后折叠视图不扰动（迁移保键）
    // - 零写回：滑块/箭头操作不推进版本、不产生写回
    await openWithEditor('outline-long.md')
    await waitSessionReady('outline-long.md')
    const uri = wsUri('outline-long.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-long.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    // 条目序列（101 项）：0=主标题(H1)；第 i 章 H2=index 2i-1、H3=index 2i
    const initial = await waitViewState('outline-long.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline.items.length === 101)
    assert(initial.outline!.expandLevel === 5, `默认档应为 5（实际 ${initial.outline!.expandLevel}）`)
    assert(initial.outline!.visibleIndices.length === 101, `默认档全展开应 101 条可见（实际 ${initial.outline!.visibleIndices.length}）`)
    assert(initial.outline!.sliderPainted === true,
      `滑块行应真实绘制（命中失败：${JSON.stringify(initial.outline)}）`)
    assert(initial.outline!.sliderActiveDotPainted === true,
      `当前档圆点应实心绘制（命中 + computed 背景：${JSON.stringify(initial.outline)}）`)
    assert(initial.outline!.chevronPainted === true,
      `折叠箭头应真实绘制（命中失败：${JSON.stringify(initial.outline)}）`)
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 档 1：展开 H1 父节点 → H2 直接子级全可见（51 条），H3 全折叠
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 1 })
    const level1 = await waitViewState('outline-long.md', (v) => v.outline?.expandLevel === 1)
    assert(level1.outline!.visibleIndices.length === 51,
      `档 1 应 51 条可见（实际 ${level1.outline!.visibleIndices.length}）`)
    assert(level1.outline!.visibleIndices[1] === 1 && level1.outline!.visibleIndices[2] === 3,
      '档 1 可见序列应为 0,1,3,…（H2 可见、H3 折叠）')
    assert(level1.outline!.sliderActiveDotPainted === true, '切档后当前档圆点应仍实心绘制')

    // 手动箭头叠加在档位上（档 1 下 H2 本就折叠中——档位精确集只含
    // level≤1 父节点）：点第 1 章箭头 = 展开（其 H3 可见），再点 = 折叠
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.chevronClick', index: 1 })
    const expanded = await waitViewState('outline-long.md',
      (v) => v.outline !== undefined && v.outline.visibleIndices.length === 52)
    assert(expanded.outline!.visibleIndices.includes(2), '档 1 下手动展开第 1 章后其小节应可见')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.chevronClick', index: 1 })
    const collapsed = await waitViewState('outline-long.md',
      (v) => v.outline !== undefined && v.outline.visibleIndices.length === 51)
    assert(!collapsed.outline!.visibleIndices.includes(2), '手动折叠第 1 章后其小节应不可见')
    // 点折叠中的父条目文字跳转：条目自身可见（折叠遮子不遮己），不触发展开
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.itemClick', index: 1 })
    const jumpParent = await waitViewState('outline-long.md', (v) => v.outline?.locatedItemIndex === 1)
    assert(jumpParent.outline!.visibleIndices.length === 51,
      '跳转到折叠中的父条目自身不得展开（自身可见，无祖先可展开）')
    assert(jumpParent.outline!.locatedPainted === true, '父条目高亮横条应真实绘制（面板可视区内）')

    // 跳转到被折叠遮蔽的深层条目（第 45 章 H3, index 90，面板滚动区深处）：
    // only-expand 展开其祖先链（第 45 章 H2）+ 高亮行滚进面板可视区——
    // #66 留下的「locatedPainted 暂不断言」口径在本票落地后的补全
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.itemClick', index: 90 })
    const jumpDeep = await waitViewState('outline-long.md', (v) => v.outline?.locatedItemIndex === 90)
    assert(jumpDeep.outline!.visibleIndices.length === 52,
      `跳转深层折叠条目应展开其祖先链（实际 ${jumpDeep.outline!.visibleIndices.length}）`)
    assert(jumpDeep.outline!.visibleIndices.includes(90), '展开后目标条目应可见')
    assert(jumpDeep.outline!.locatedPainted === true,
      `高亮行应滚进大纲面板可视区并真实绘制（${JSON.stringify(jumpDeep.outline)}）`)

    // 滑块/箭头操作零写回（纯视图状态）
    const afterCollapse = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterCollapse.version === before.version && afterCollapse.appliedEdits === before.appliedEdits,
      `折叠操作不得推进版本或产生写回（${before.version}/${before.appliedEdits} → ` +
        `${afterCollapse.version}/${afterCollapse.appliedEdits}）`)

    // 档 0 + 宿主 view.locate 落进折叠区：only-expand 展开当前路径（目标
    // 的祖先链 = 第 45 章 H2 + 主标题 H1——展开 H1 使全部 H2 作为直接子级
    // 可见，这是「展开祖先链让目标可见」的语义代价），其余 H3 折叠不动
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 0 })
    await waitViewState('outline-long.md', (v) => v.outline?.visibleIndices.length === 1)
    const targetLine = jumpDeep.outline!.items[90]!.line
    const targetOffset = doc.offsetAt(new vscode.Position(targetLine - 1, 0))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: targetOffset })
    const located = await waitViewState('outline-long.md', (v) => v.outline?.locatedItemIndex === 90)
    assert(located.outline!.visibleIndices.includes(90),
      `定位到折叠区应 only-expand 使目标可见（实际 ${JSON.stringify(located.outline!.visibleIndices)}）`)
    assert(!located.outline!.visibleIndices.includes(2) && !located.outline!.visibleIndices.includes(88),
      `其余 H3 不得被展开（only-expand 只动当前路径）：${JSON.stringify(located.outline!.visibleIndices)}`)
    assert(located.outline!.visibleIndices.length === 52,
      `可见集应为 H1 + 50 个 H2 + 目标 H3（52 条，实际 ${located.outline!.visibleIndices.length}）`)
    assert(located.outline!.locatedPainted === true, '定位后的高亮行应滚进可视区并真实绘制')

    // 编辑存活：宿主 WorkspaceEdit 重命名第 45 章标题 → 折叠视图不扰动。
    // 注意口径：doc 变化触发视口顶行重算 + only-expand（合法展开当前路径
    // 的邻章），故不精确对拍数组——断言当前路径仍展开、远端章节仍折叠
    const renameEdit = new vscode.WorkspaceEdit()
    const headingLine = jumpDeep.outline!.items[89]!.line - 1
    const lineText = doc.lineAt(headingLine)
    renameEdit.replace(
      wsUri('outline-long.md'),
      lineText.range,
      lineText.text.replace('第 45 章', '第 45 章改名'),
    )
    await vscode.workspace.applyEdit(renameEdit)
    const renamed = await waitViewState('outline-long.md',
      (v) => v.outline?.items[89] !== undefined && v.outline.items[89].text === '第 45 章改名')
    assert(renamed.outline!.visibleIndices.includes(89) && renamed.outline!.visibleIndices.includes(90),
      `重命名后当前展开路径应保持可见（实际 ${JSON.stringify(renamed.outline!.visibleIndices)}）`)
    assert(!renamed.outline!.visibleIndices.includes(2) && !renamed.outline!.visibleIndices.includes(20),
      `远端章节的 H3 不得因重命名被展开（实际 ${JSON.stringify(renamed.outline!.visibleIndices)}）`)

    // 档位持久化：切档 1 后重载 webview（Developer: Reload Webviews——
    // retainContextWhenHidden 关闭：销毁重建同一 panel，走 bridge state
    // 恢复，#6 模式记忆的同款验证路径）→ 档位恢复为 1；重载同时恢复锚点
    // （视口回到第 45 章区域），only-expand 会合法展开当前路径（至多
    // +2 条 H3），可见数允许 51–53 而非精确 51
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 1 })
    await waitViewState('outline-long.md', (v) => v.outline?.expandLevel === 1)
    await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction')
    // 档位先从持久化状态恢复；等待宿主全文同步后的条目重建，避免读到空大纲。
    const reopened = await waitViewState('outline-long.md',
      (v) => v.outline?.expandLevel === 1 && v.outline.visibleIndices.length >= 51)
    assert(reopened.outline!.visibleIndices.length >= 51 && reopened.outline!.visibleIndices.length <= 53,
      `重载后档 1 基础可见集应恢复（51–53 条，实际 ${reopened.outline!.visibleIndices.length}）`)

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-long.md', (v) => v.sidebar?.open === false)
  }],

  // ---- #68 大纲工具条与标题搜索 ----

  ['大纲工具条与标题搜索：过滤、片段高亮绘制、快照回放、重置与跳末（#68）', async () => {
    // 断言口径（视觉层断言必查）：
    // - 工具条装配与绘制：toolbarPainted（elementFromPoint 命中，样式注入
    //   失败时必失败）+ 按钮可访问名称 + placeholder 文案
    // - 搜索语义：filteredVisibleIndices 组合可见口径对拍（档 1 折叠下
    //   搜索命中 → 匹配路径展开可见）；清空回放进入前快照（QO 语义）
    // - 绘制层证据：searchHitPainted（可见条目内 mark 命中 + computed
    //   背景非全透明）与 nomatchPainted（无匹配占位真实可见）
    // - 重置三合一与跳转到末尾：状态对拍 + locatedPainted（高亮滚进
    //   可视区）+ locatedItemIndex 落末尾控制域 + 零写回（版本不推进）
    await openWithEditor('outline-long.md')
    await waitSessionReady('outline-long.md')
    const uri = wsUri('outline-long.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    const initial = await waitViewState('outline-long.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline.items.length === 101)
    assert(initial.outline!.toolbarPainted === true,
      `工具条行应真实绘制（命中失败：${JSON.stringify(initial.outline)}）`)
    assert(initial.outline!.jumpBottomAriaLabel === editorMessages()['outline.jumpBottom'],
      `跳末按钮可访问名称（实际 ${String(initial.outline!.jumpBottomAriaLabel)}）`)
    assert(initial.outline!.resetAriaLabel === editorMessages()['outline.reset'],
      `重置按钮可访问名称（实际 ${String(initial.outline!.resetAriaLabel)}）`)
    assert(initial.outline!.searchPlaceholder === editorMessages()['outline.searchPlaceholder'],
      `搜索框 placeholder（实际 ${String(initial.outline!.searchPlaceholder)}）`)
    assert(initial.outline!.searchActive === false, '初始应无搜索过滤')
    assert(initial.outline!.filteredVisibleIndices.length === 101,
      '搜索关闭时组合可见口径与折叠口径同值（101 条）')
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState

    // 档 1（H3 折叠遮蔽）下搜索「第 45 章」：命中第 45 章 H2（89）与
    // 「第 45 章小节」H3（90，子串命中），匹配路径自动展开——组合可见
    // 口径 = 主标题 + 89 + 90（其余 50 章 H2 折叠可见但不保留）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 1 })
    await waitViewState('outline-long.md', (v) => v.outline?.expandLevel === 1)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.searchInput', text: '第 45 章' })
    const filtered = await waitViewState('outline-long.md', (v) => v.outline?.searchActive === true)
    assert(filtered.outline!.filteredVisibleIndices.join(',') === '0,89,90',
      `搜索「第 45 章」组合可见应为 [0,89,90]（实际 ${JSON.stringify(filtered.outline!.filteredVisibleIndices)}）`)
    assert(filtered.outline!.searchQuery === '第 45 章', 'probe 应回报搜索词实值')

    // 清空回放进入搜索前的档 1 快照（H3 重新被折叠遮蔽）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.searchInput', text: '' })
    const restored = await waitViewState('outline-long.md', (v) => v.outline?.searchActive === false)
    assert(restored.outline!.visibleIndices.length === 51,
      `清空应回放档 1 快照（51 条，实际 ${restored.outline!.visibleIndices.length}）`)
    assert(restored.outline!.filteredVisibleIndices.length === 51, '清空后组合口径与折叠口径同值')

    // 搜索「第 1 章」：命中在面板顶部可视区——mark 片段高亮的绘制层证据
    // （elementFromPoint 命中 + computed 背景非全透明）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.searchInput', text: '第 1 章' })
    const hit = await waitViewState('outline-long.md',
      (v) => v.outline?.searchActive === true && v.outline.searchHitPainted === true)
    assert(hit.outline!.filteredVisibleIndices.join(',') === '0,1,2',
      `搜索「第 1 章」应保留主标题与第 1 章路径（实际 ${JSON.stringify(hit.outline!.filteredVisibleIndices)}）`)
    assert(hit.outline!.searchHitPainted === true,
      `命中片段 mark 应真实绘制（命中 + computed 背景：${JSON.stringify(hit.outline)}）`)

    // 无匹配：占位真实可见、组合可见口径为空、mark 不绘制
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.searchInput', text: '不存在的词条' })
    const nomatch = await waitViewState('outline-long.md', (v) => v.outline?.nomatchPainted === true)
    assert(nomatch.outline!.filteredVisibleIndices.length === 0, '无匹配时组合可见口径应为空')
    assert(nomatch.outline!.searchHitPainted === false, '无匹配时不得有命中片段绘制')
    assert(nomatch.outline!.nomatchPainted === true, '「无匹配」占位应真实可见')

    // 重置三合一：清搜索词 + 档位回默认 5 + 清手动折叠（档 1 整体替换）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.toolbarClick', action: 'reset' })
    const reset = await waitViewState('outline-long.md', (v) =>
      v.outline?.searchActive === false && v.outline.expandLevel === 5)
    assert(reset.outline!.filteredVisibleIndices.length === 101,
      `重置后应全展开 101 条（实际 ${reset.outline!.filteredVisibleIndices.length}）`)
    assert(reset.outline!.nomatchPainted === false, '重置后无匹配占位应消失')

    // 跳转到末尾：located 落末尾控制域（第 50 章小节 = index 100，面板
    // 滚动区深处——高亮行滚进可视区后命中成立）、正文文本零变化
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.toolbarClick', action: 'jump-bottom' })
    const bottom = await waitViewState('outline-long.md', (v) => v.outline?.locatedItemIndex === 100)
    assert(bottom.outline!.locatedText === '第 50 章小节',
      `跳末后控制域应为最后一个标题（实际 ${String(bottom.outline!.locatedText)}）`)
    assert(bottom.outline!.locatedPainted === true, '跳末后高亮行应滚进面板可视区并真实绘制')

    // 搜索/重置/跳末全程零写回（纯视图状态）
    const after = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(after.version === before.version && after.appliedEdits === before.appliedEdits,
      `工具条与搜索操作不得推进版本或产生写回（${before.version}/${before.appliedEdits} → ` +
        `${after.version}/${after.appliedEdits}）`)

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-long.md', (v) => v.sidebar?.open === false)
  }],

  // ---- #69 大纲右键菜单 ----

  ['大纲右键菜单开合与结构命令：绘制层证据、折叠状态对拍（#69）', async () => {
    // 断言口径（视觉层断言必查）：menuPainted 是菜单容器的 elementFromPoint
    // 命中（真实布局 + 浮层样式生效——样式失效时 DOM 存在但命中失败）；
    // 结构命令经 outline.test.contextMenu + menuClick 真实按钮点击链路驱动，
    // visibleIndices 状态对拍（与 #67 同口径）
    await openWithEditor('outline-menu.md')
    await waitSessionReady('outline-menu.md')
    const uri = wsUri('outline-menu.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline.items.length === 7)
    // 右键「加粗 Alpha」（index 1）：菜单打开、目标索引正确、真实绘制
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 1 })
    const opened = await waitViewState('outline-menu.md', (v) => v.outline?.menuOpen === true)
    assert(opened.outline!.menuTargetIndex === 1,
      `菜单目标应为条目 1（实际 ${String(opened.outline!.menuTargetIndex)}）`)
    assert(opened.outline!.menuPainted === true,
      `菜单应真实绘制（命中失败：${JSON.stringify(opened.outline)}）`)
    // 关闭后再开（开合幂等）：menuClose 后 menuOpen=false
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClose' })
    await waitViewState('outline-menu.md', (v) => v.outline?.menuOpen === false)
    // 结构命令（折叠同级）：主标题（index 0）的同级组 = 主、Setext、第二顶；
    // 折叠主标题遮 Alpha 与 Beta 子树（1–4 隐藏）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 0 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'collapseSiblings' })
    const collapsed = await waitViewState('outline-menu.md',
      (v) => v.outline?.menuOpen === false && v.outline.visibleIndices.length === 3)
    assert(JSON.stringify(collapsed.outline!.visibleIndices) === JSON.stringify([0, 5, 6]),
      `折叠同级后应只露顶层三标题（实际 ${JSON.stringify(collapsed.outline!.visibleIndices)}）`)
    // 展开同级（顶层组父节点键加回）：主标题展开 → 全部条目可见
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 0 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'expandSiblings' })
    const expanded = await waitViewState('outline-menu.md',
      (v) => v.outline?.visibleIndices.length === 7)
    assert(JSON.stringify(expanded.outline!.visibleIndices) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]),
      `展开同级后应全部可见（实际 ${JSON.stringify(expanded.outline!.visibleIndices)}）`)
    // 递归展开（目标须自身可见——递归展开只动目标子树、不展开目标祖先）：
    // 手动折叠 Beta（箭头）后对其递归展开，Beta 深恢复可见
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.chevronClick', index: 3 })
    await waitViewState('outline-menu.md', (v) => v.outline?.visibleIndices.length === 6)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 3 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'expandRecursively' })
    const recursed = await waitViewState('outline-menu.md',
      (v) => v.outline?.visibleIndices.length === 7)
    assert(JSON.stringify(recursed.outline!.visibleIndices) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]),
      `递归展开 Beta 后 Beta 深应恢复可见（实际 ${JSON.stringify(recursed.outline!.visibleIndices)}）`)
    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲复制五项经宿主剪贴板：端到端读写对拍（#69）', async () => {
    // 断言口径：复制走 webview→宿主 clipboard.write 消息桥，宿主
    // env.clipboard.writeText 写入系统剪贴板——集成侧以 readText 读回对拍
    // （端到端：webview 载荷计算 → 消息桥 → 宿主拼接 → 剪贴板全程真实）；
    // 标题链接另做「复制 → 注入定位」往返对拍（链路见下段注释）
    await openWithEditor('outline-menu.md')
    await waitSessionReady('outline-menu.md')
    const uri = wsUri('outline-menu.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline.items.length === 7)
    const copy = async (index: number, command: string): Promise<string> => {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index })
      await waitViewState('outline-menu.md', (v) => v.outline?.menuOpen === true)
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command })
      await waitViewState('outline-menu.md', (v) => v.outline?.menuOpen === false)
      return vscode.env.clipboard.readText()
    }
    // 标题（plainText：**加粗** 标记不透出）
    assert(await copy(1, 'copyHeading') === '加粗 Alpha', '复制标题应为剥标记可见文本')
    // 标题和兄弟标题（同父组 = Alpha、Beta，含自身）
    assert(await copy(1, 'copySiblings') === '加粗 Alpha\nBeta', '兄弟复制为同父全部标题逐行')
    // 标题和子标题（Alpha 子树 = Alpha、Alpha 子）
    assert(await copy(1, 'copyChildren') === '加粗 Alpha\nAlpha 子', '子标题复制含后代')
    // 标题链接（宿主拼 [[笔记名#标题]]：笔记名 = 文件名去扩展名；标题取条目
    // 原文（含 **加粗** 等行内标记）——宿主 findHeadingOffset 按 ATX 标题行
    // 字面文本比较，两侧口径同源才能定位回原标题；剥标记文本只服务「复制
    // 标题」纯文本场景，写进链接必然定位落空（review-loops 第 2 轮）
    const markedLink = await copy(1, 'copyLink')
    assert(markedLink === '[[outline-menu#**加粗** Alpha]]',
      `含标记标题的链接应为标题原文，实际 ${markedLink}`)
    // 纯文本标题链接（Beta，index 3）：无标记可剥，原文 == 可见文本，一期口径不变
    const plainLink = await copy(3, 'copyLink')
    assert(plainLink === '[[outline-menu#Beta]]', `纯文本标题链接应不变，实际 ${plainLink}`)
    // Setext 标题链接（index 5）：同样取原文（其不能定位属一期已知限制，见下方往返断言）
    const setextLink = await copy(5, 'copyLink')
    assert(setextLink === '[[outline-menu#Setext 标题]]',
      `Setext 标题链接应为标题原文，实际 ${setextLink}`)
    // 该段内容（整控制域源文含标题行，标记原样）
    assert(await copy(3, 'copySection') === '## Beta\n\nBeta 内容。\n\n#### Beta 深\n\n深内容。', '该段内容为整控制域源文')
    // Setext 标题的复制（plainText）
    assert(await copy(5, 'copyHeading') === 'Setext 标题', 'Setext 标题复制为可见文本')

    // ---- 端到端往返：复制出的链接能否定位回原标题（#69 写入端 × #11 读回端） ----
    // 剪贴板文本 → 剥 [[ ]] 得注入目标 → injectWikilink（与真实 webview 消息
    // 同一校验与处理入口）→ 宿主解析/定位 → 日志 locate + 面板实际落点对拍。
    // 这是本用例的核心契约：读取端按标题行字面文本比较，故写入端必须上报条目
    // 原文；剥标记口径下含标记标题的链接必然 locate=none（修复前实测形态）
    const fixtureText = await readDisk('outline-menu.md')
    /** 标题行在全文中的行首 offset（LF 系；整行全等匹配，避免子串误命中） */
    const headingOffsetOf = (lineText: string): number => {
      let offset = 0
      for (const line of fixtureText.split('\n')) {
        if (line.replace(/\r$/, '') === lineText) {
          return offset
        }
        offset += line.length + 1
      }
      throw new Error(`fixture 中不存在该标题行：${lineText}`)
    }
    const roundTrip = async (link: string, headingLine: string): Promise<void> => {
      assert(link.startsWith('[[outline-menu#') && link.endsWith(']]'),
        `标题链接形态应为 [[outline-menu#…]]，实际 ${link}`)
      const heading = headingLine.replace(/^#+ /, '')
      await injectWikilink(uri, link.slice(2, -2))
      const log = await waitWikilinkLog(uri, (e) => e.kind === 'wikilink-doc' && e.heading === heading)
      assert(log.locate !== 'none',
        `复制出的链接应定位回原标题「${heading}」，实际 locate=${String(log.locate)}`)
      assert(log.path === wsUri('outline-menu.md').fsPath,
        `定位目标应为 outline-menu.md，实际 ${String(log.path)}`)
      const offset = headingOffsetOf(headingLine)
      if (log.locate === 'custom-panel') {
        // 目标（outline-menu.md）即本面板自身：宿主 reveal 面板后发 view.locate，
        // live 态光标落标题行首——面板侧可见落点，不只看日志
        const view = await waitViewState('outline-menu.md', (v) => v.selectionOffset === offset)
        assert(view.selectionOffset === offset,
          `面板光标应落标题行首 offset ${offset}，实际 ${view.selectionOffset}`)
      } else {
        // 目标面为文本编辑器：以标题行 selection reveal。此处目标恒为本面板
        // 自身，该分支用于让落点断言不硬编码定位面（按日志回报的实际面取证据）
        const editor = await poll('标题跳转落到文本编辑器', () =>
          vscode.window.activeTextEditor?.document.uri.toString() === wsUri('outline-menu.md').toString()
            ? vscode.window.activeTextEditor
            : undefined)
        const line = editor.document.lineAt(editor.selection.active).text
        assert(line === headingLine, `文本编辑器 selection 应在标题行「${headingLine}」，实际「${line}」`)
      }
    }
    // 含标记标题（index 1）：写入端原文 → 读回端字面匹配原文，本轮修复的回归钉子
    await roundTrip(markedLink, '## **加粗** Alpha')
    // 纯文本标题（index 3）：原文 == 可见文本，两侧口径本来就一致（防误伤）
    await roundTrip(plainLink, '## Beta')
    // Setext 标题（index 5）：一期标题匹配规则明示「仅 ATX 标题行」（钉在
    // test/unit/wikilinkTarget.test.ts），其链接不能定位——已知限制，显式钉住
    // 而非静默略过
    await injectWikilink(uri, setextLink.slice(2, -2))
    const setextLog = await waitWikilinkLog(uri,
      (e) => e.kind === 'wikilink-doc' && e.heading === 'Setext 标题')
    assert(setextLog.locate === 'none',
      `一期已知限制：Setext 标题链接不定位（findHeadingOffset 仅认 ATX 标题行），实际 locate=${String(setextLog.locate)}`)
    // 不定位 = 面板光标停在上一跳落点（settle 窗等可能的定位消息到达后复查）
    const betaOffset = headingOffsetOf('## Beta')
    await new Promise((r) => setTimeout(r, 200))
    const settled = await waitViewState('outline-menu.md')
    assert(settled.selectionOffset === betaOffset,
      `Setext 链接不应移动光标（应保持 ${betaOffset}），实际 ${settled.selectionOffset}`)

    // 形态学已知限制（不另造 fixture）：标题含「] | # ^」时 wikilink 无法表达该
    // 标题——「]」触发扫描守卫、「|」切别名、「#」二次分割标题、「^」按块引用降级
    // （见 src/shared/wikilink.ts 与 outlineLinkHeading 注释）。此类标题的链接既
    // 不保证可表达也不保证可定位，属一期已知边界，本用例不覆盖。

    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲调整层级写回：钳制、单事务撤销、控制域外零变更（#69）', async () => {
    // 断言口径：写操作对权威文档生效（doc.getText 对拍）+ sessionState 的
    // version/appliedEdits 推进（单笔 edit.request）+ history.request undo
    // 完整回滚（单事务可一次撤销）
    await openWithEditor('outline-menu.md')
    await waitSessionReady('outline-menu.md')
    const uri = wsUri('outline-menu.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-menu.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md',
      (v) => v.sidebar?.open === true && v.outline?.items.length === 7)
    const original = doc.getText()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    // H1 减少钳制：零写回（版本与 appliedEdits 不动）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 0 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'levelDown' })
    await new Promise((r) => setTimeout(r, 150))
    const clamped = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(clamped.version === before.version && clamped.appliedEdits === before.appliedEdits,
      `H1 减少钳制不得写回（${before.version}/${before.appliedEdits} → ${clamped.version}/${clamped.appliedEdits}）`)
    // 递归增加 Beta（index 3，子树含 Beta 深）：一笔多段单事务
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 3 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'levelUpRecursive' })
    const upped = await waitViewState('outline-menu.md', (v) =>
      v.outline?.items[3] !== undefined && v.outline.items[3].level === 3 && v.outline.items[4].level === 5)
    assert(upped.outline!.items[3]!.text === 'Beta' && upped.outline!.items[4]!.text === 'Beta 深',
      '调级只改层级不改文字')
    const uppedText = doc.getText()
    assert(uppedText.includes('### Beta\n') && uppedText.includes('##### Beta 深'),
      '权威文档应重写 # 数量')
    assert(uppedText.includes('## **加粗** Alpha') && uppedText.includes('Setext 标题'),
      '控制域外内容零变更')
    const afterUp = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterUp.appliedEdits === before.appliedEdits + 1,
      `递归调级应为单笔写回（实际 +${afterUp.appliedEdits - before.appliedEdits}）`)
    // 撤销一次完整回滚（单事务）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-menu.md', (v) =>
      v.outline?.items[3] !== undefined && v.outline.items[3].level === 2 && v.outline.items[4].level === 4)
    assert(doc.getText() === original, '单次撤销应完整回滚递归调级')
    // Setext 调级：规范化为 ATX 单行（内容+下划线两行 → 一行）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 5 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'levelUp' })
    const setextUp = await waitViewState('outline-menu.md', (v) =>
      v.outline?.items[5] !== undefined && v.outline.items[5].level === 2)
    assert(setextUp.outline!.items[5]!.text === 'Setext 标题', 'Setext 调级保留标题文字')
    const setextText = doc.getText()
    assert(setextText.includes('## Setext 标题\n') && !setextText.includes('============'),
      'Setext 调级应规范化为 ATX 单行（下划线行消除）')
    assert(setextText.includes('# 第二顶\n\n内容。'), 'Setext 段后内容完整保留')
    // 撤销收尾回原文
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-menu.md', (v) => v.outline?.items[5] !== undefined && v.outline.items[5].level === 1)
    if (doc.isDirty) {
      await doc.save()
    }
    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲重命名与删除：编辑原文保留标记、整控制域删除、撤销回滚（#69）', async () => {
    await openWithEditor('outline-menu.md')
    await waitSessionReady('outline-menu.md')
    const uri = wsUri('outline-menu.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-menu.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md',
      (v) => v.sidebar?.open === true && v.outline?.items.length === 7 && v.outline.panelPainted === true)
    const original = doc.getText()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    // 重命名「**加粗** Alpha」（index 1）：编辑原文（标记是资产）+ renamingIndex 观测
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 1 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'rename' })
    const renaming = await waitViewState('outline-menu.md', (v) => v.outline?.renamingIndex === 1)
    assert(renaming.outline!.renamingIndex === 1, '重命名编辑态应回报条目索引')
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.renameKey', text: '**改名** 加粗', key: 'enter' })
    const renamed = await waitViewState('outline-menu.md', (v) =>
      v.outline?.items[1] !== undefined && v.outline.items[1].text === '**改名** 加粗')
    assert(renamed.outline!.items[1]!.plainText === '改名 加粗', '重命名后 plainText 剥标记')
    assert(renamed.outline!.renamingIndex === null, '提交后编辑态退出')
    assert(doc.getText().includes('## **改名** 加粗'), '权威文档整标题行替换（# 数量保持）')
    assert(renamed.outline!.items[0]!.text === '主标题' && renamed.outline!.items[2]!.text === 'Alpha 子',
      '重命名只影响目标条目')
    // Esc 取消零写回
    const editsAfterRename = ((await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState).appliedEdits
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 1 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'rename' })
    await waitViewState('outline-menu.md', (v) => v.outline?.renamingIndex === 1)
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.renameKey', text: '不该出现', key: 'escape' })
    await waitViewState('outline-menu.md', (v) => v.outline?.renamingIndex === null)
    const afterEsc = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterEsc.appliedEdits === editsAfterRename, 'Esc 取消不得写回')
    // 删除 Beta 段（index 3，跨级子树随段）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.contextMenu', index: 3 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.menuClick', command: 'delete' })
    const deleted = await waitViewState('outline-menu.md', (v) =>
      v.outline !== undefined && v.outline.items.length === 5)
    assert(JSON.stringify(deleted.outline!.items.map((i) => i.text)) ===
      JSON.stringify(['主标题', '**改名** 加粗', 'Alpha 子', 'Setext 标题', '第二顶']),
      '删除应移除 Beta 与 Beta 深两条（控制域整体）')
    const deletedText = doc.getText()
    assert(!deletedText.includes('Beta'), '权威文档不再含 Beta 段')
    assert(deletedText.includes('子内容。') && deletedText.includes('Setext 内容。'),
      '相邻段内容不丢失')
    // 撤销删除（重命名与删除各一笔，两次撤销回原文）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-menu.md', (v) => v.outline !== undefined && v.outline.items.length === 7)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-menu.md', (v) =>
      v.outline?.items[1] !== undefined && v.outline.items[1].text === '**加粗** Alpha')
    assert(doc.getText() === original, '两次撤销后应回到原文')
    const final = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(final.appliedEdits - before.appliedEdits === 2, '重命名与删除各一笔写回')
    if (doc.isDirty) {
      await doc.save()
    }
    // 收起侧栏收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-menu.md', (v) => v.sidebar?.open === false)
  }],

  // ---- #70 大纲拖拽排序 ----

  ['大纲拖拽三态写回：全文对拍、控制域外零变更、单事务撤销（#70）', async () => {
    // 断言口径：写操作对权威文档生效（doc.getText 全文对拍）+ sessionState 的
    // appliedEdits 每次拖拽恰好 +1（单笔 edit.request）+ history.request undo
    // 完整回滚（单事务可一次撤销）。outline.test.drag 驱动真实 pointer 事件
    // 序列（与用户拖拽同一处理器链）。fixture 条目序：0 甲(H1) 1 乙(H2)
    // 2 丁(H4,跨级挂乙) 3 丙(H2) 4 戊(H1)；甲的子树含乙丁丙
    await openWithEditor('outline-drag.md')
    await waitSessionReady('outline-drag.md')
    const uri = wsUri('outline-drag.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-drag.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-drag.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline.items.length === 5)
    const original = doc.getText()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    const drag = (from: number, to: number, position: string, action: string): Thenable<unknown> =>
      vscode.commands.executeCommand(CMD.postToPanel, uri,
        { kind: 'outline.test.drag', from, to, position, action })

    // before 落点：丁(H4) 拖到丙(H2) 之前 → 对齐 H2
    await drag(2, 3, 'before', 'drop')
    const beforeDrop = await waitViewState('outline-drag.md', (v) =>
      v.outline?.items[2] !== undefined && v.outline.items[2].text === '丁' && v.outline.items[2].level === 2)
    assert(beforeDrop.outline!.items.map((i) => [i.level, i.text]).map(String).join() ===
      [[1, '甲'], [2, '乙'], [2, '丁'], [2, '丙'], [1, '戊']].map(String).join(),
      'before 落点条目序与调级（实际 ' + JSON.stringify(beforeDrop.outline!.items.map((i) => [i.level, i.text])) + '）')
    assert(doc.getText() === [
      '---', 'title: 拖拽', '---', '',
      '# 甲', '甲内容。', '## 乙', '乙内容。', '## 丁', '丁内容。', '## 丙', '丙内容。', '# 戊', '戊内容。',
    ].join('\n'), 'before 落点全文对拍')
    let state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits - before.appliedEdits === 1, 'before 落点应为单笔写回')
    // 撤销一次完整回滚（单事务）
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-drag.md', (v) => v.outline?.items[2]?.text === '丁' && v.outline.items[2].level === 4)
    assert(doc.getText() === original, '单次撤销应完整回滚 before 拖拽')

    // #67 迁移交互：before 拖拽把丁移出乙子树后乙降格为叶（展开键被
    // safeFilter 丢弃），undo 回滚文本后乙重新成为父节点但键已丢——丁处于
    // 折叠遮蔽态。重设档位 5 恢复全展开再继续（隐藏条目不可拖是既定口径）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 5 })
    await waitViewState('outline-drag.md', (v) => v.outline?.visibleIndices.length === 5)
    // inside 落点：丁拖到丙内部 → 降 H3 成为丙的最后子级（物理移到丙段尾）
    await drag(2, 3, 'inside', 'drop')
    const insideDrop = await waitViewState('outline-drag.md', (v) =>
      v.outline?.items[3] !== undefined && v.outline.items[3].text === '丁' && v.outline.items[3].level === 3)
    assert(doc.getText() === [
      '---', 'title: 拖拽', '---', '',
      '# 甲', '甲内容。', '## 乙', '乙内容。', '## 丙', '丙内容。', '### 丁', '丁内容。', '# 戊', '戊内容。',
    ].join('\n'), 'inside 落点全文对拍')
    assert(JSON.stringify(insideDrop.outline!.items.map((i) => [i.level, i.text])) ===
      JSON.stringify([[1, '甲'], [2, '乙'], [2, '丙'], [3, '丁'], [1, '戊']]),
      'inside 落点条目序与调级')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-drag.md', (v) => v.outline?.items[3]?.text === '丙')
    assert(doc.getText() === original, '单次撤销应完整回滚 inside 拖拽')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 5 })
    await waitViewState('outline-drag.md', (v) => v.outline?.visibleIndices.length === 5)

    // after 落点：乙（含跨级子丁）拖到戊之后 → 乙升 H1、丁随行 H3；
    // 插入点为文档末尾（文末无尾换行 → 搬移段前置换行）
    await drag(1, 4, 'after', 'drop')
    const afterDrop = await waitViewState('outline-drag.md', (v) =>
      v.outline?.items[2] !== undefined && v.outline.items[2].text === '戊')
    assert(doc.getText() === [
      '---', 'title: 拖拽', '---', '',
      '# 甲', '甲内容。', '## 丙', '丙内容。', '# 戊', '戊内容。',
      '# 乙', '乙内容。', '### 丁', '丁内容。', '',
    ].join('\n'), 'after 落点全文对拍（子树随行递归调级 + 末尾前置换行）')
    assert(JSON.stringify(afterDrop.outline!.items.map((i) => [i.level, i.text])) ===
      JSON.stringify([[1, '甲'], [2, '丙'], [1, '戊'], [1, '乙'], [3, '丁']]),
      'after 落点条目序与子树递归调级')
    state = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(state.appliedEdits - before.appliedEdits === 3, '三态拖拽各一笔写回（累计 +3）')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-drag.md', (v) => v.outline?.items[1]?.text === '乙' && v.outline.items[1].level === 2)
    assert(doc.getText() === original, '单次撤销应完整回滚 after 拖拽（正文与大纲同步还原）')
    if (doc.isDirty) {
      await doc.save()
    }
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-drag.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲拖拽无效落点与悬停观测：拒绝零写回、落点指示绘制层证据（#70）', async () => {
    // 断言口径（视觉层断言必查）：dropHintPainted 是落点指示的中心点命中 +
    // computed 插入线/包裹高亮可读（样式失效时类在而视觉差异不在）；无效
    // 落点（拖入自身子树）不显示指示、drop 零写回；Esc 取消零写回
    await openWithEditor('outline-drag.md')
    await waitSessionReady('outline-drag.md')
    const uri = wsUri('outline-drag.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-drag.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-drag.md',
      (v) => v.sidebar?.open === true && v.outline?.panelPainted === true && v.outline.items.length === 5)
    const original = doc.getText()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    // 无效悬停：甲的子树含乙丁丙 → 目标乙（inside）无有效落点
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.drag', from: 0, to: 1, position: 'inside', action: 'hover' })
    const invalidHover = await waitViewState('outline-drag.md', (v) => v.outline?.draggingIndex === 0)
    assert(invalidHover.outline!.dropTargetIndex === null, '拖入自身子树不得出现有效落点')
    assert(invalidHover.outline!.dropPosition === null, '无效落点三态应为 null')
    assert(invalidHover.outline!.dropHintPainted === false, '无效落点不得绘制指示')
    // 有效悬停：丙 → 戊 上缘（before），绘制层证据成立
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.drag', from: 3, to: 4, position: 'before', action: 'hover' })
    const validHover = await waitViewState('outline-drag.md', (v) => v.outline?.dropTargetIndex === 4)
    assert(validHover.outline!.draggingIndex === 3, '悬停态应回报拖拽源')
    assert(validHover.outline!.dropPosition === 'before', '悬停态应回报三态')
    assert(validHover.outline!.dropHintPainted === true,
      `落点指示应真实绘制（命中失败：${JSON.stringify(validHover.outline)}）`)
    // 无效落点 drop（丁在甲子树内）：零写回
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.drag', from: 0, to: 2, position: 'after', action: 'drop' })
    await waitViewState('outline-drag.md', (v) => v.outline?.draggingIndex === null)
    await new Promise((r) => setTimeout(r, 150))
    const afterInvalid = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterInvalid.appliedEdits === before.appliedEdits, '无效落点 drop 不得写回')
    assert(doc.getText() === original, '无效落点 drop 后文档保持')
    // Esc 取消：零写回、状态清空
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.drag', from: 3, to: 0, position: 'after', action: 'escape' })
    const escaped = await waitViewState('outline-drag.md', (v) => v.outline?.draggingIndex === null)
    assert(escaped.outline!.dropTargetIndex === null, 'Esc 后落点清空')
    const afterEsc = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterEsc.appliedEdits === before.appliedEdits, 'Esc 取消不得写回')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-drag.md', (v) => v.sidebar?.open === false)
  }],

  ['大纲折叠与搜索态下的拖拽：视图状态随写回存活重算（#70）', async () => {
    // 折叠态：No-Expand 下拖可见条目（戊 → 甲之前），写回后折叠迁移语义
    // 保持（戊升至首位、甲的子树仍折叠遮蔽）；搜索态：词条保持、过滤对
    // 新序列重算
    await openWithEditor('outline-drag.md')
    await waitSessionReady('outline-drag.md')
    const uri = wsUri('outline-drag.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('outline-drag.md'))
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-drag.md',
      (v) => v.sidebar?.open === true && v.outline?.items.length === 5)
    const original = doc.getText()
    const before = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    // No-Expand：乙丁丙折叠遮蔽（可见 = 甲、戊）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 0 })
    await waitViewState('outline-drag.md', (v) =>
      JSON.stringify(v.outline?.visibleIndices) === JSON.stringify([0, 4]))
    // 戊(index 4) → 甲(index 0) 之前（before；两者皆可见，合法落点）
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.drag', from: 4, to: 0, position: 'before', action: 'drop' })
    const folded = await waitViewState('outline-drag.md', (v) =>
      v.outline?.items[0]?.text === '戊' && v.outline.items[0].level === 1)
    // 尾部换行说明：删除自 # 戊 行首起，丙内容行的终止符留在原位（行尾
    // 换行不属于被搬移的戊段——段自标题行首起算）
    assert(doc.getText() === [
      '---', 'title: 拖拽', '---', '',
      '# 戊', '戊内容。', '# 甲', '甲内容。', '## 乙', '乙内容。', '#### 丁', '丁内容。', '## 丙', '丙内容。', '',
    ].join('\n'), '折叠态拖拽写回全文对拍')
    // 折叠迁移：档位仍 0；戊（新首位，叶）与甲（父，子树仍折叠）可见
    assert(folded.outline!.expandLevel === 0, '档位不受拖拽影响')
    assert(JSON.stringify(folded.outline!.visibleIndices) === JSON.stringify([0, 1]),
      `折叠遮蔽语义应随写回存活（实际 ${JSON.stringify(folded.outline!.visibleIndices)}）`)
    // 撤销回原
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-drag.md', (v) => v.outline?.items[0]?.text === '甲')
    assert(doc.getText() === original, '撤销应回原文')
    // 搜索态：词条「丁」只保留 甲乙丁（丙戊过滤隐藏）；丁 → 甲之前
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.expandClick', level: 5 })
    await waitViewState('outline-drag.md', (v) => v.outline?.visibleIndices.length === 5)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.searchInput', text: '丁' })
    await waitViewState('outline-drag.md', (v) =>
      JSON.stringify(v.outline?.filteredVisibleIndices) === JSON.stringify([0, 1, 2]))
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'outline.test.drag', from: 2, to: 0, position: 'before', action: 'drop' })
    const searched = await waitViewState('outline-drag.md', (v) =>
      v.outline?.items[0]?.text === '丁' && v.outline.items[0].level === 1)
    assert(doc.getText() === [
      '---', 'title: 拖拽', '---', '',
      '# 丁', '丁内容。', '# 甲', '甲内容。', '## 乙', '乙内容。', '## 丙', '丙内容。', '# 戊', '戊内容。',
    ].join('\n'), '搜索态拖拽写回全文对拍')
    // 搜索态存活：词条保持，过滤对新序列重算（丁升至首位且无祖先 → 仅命中项可见）
    assert(searched.outline!.searchQuery === '丁' && searched.outline!.searchActive === true,
      '搜索词条与态应随写回保持')
    assert(JSON.stringify(searched.outline!.filteredVisibleIndices) === JSON.stringify([0]),
      `过滤可见集应重算（实际 ${JSON.stringify(searched.outline!.filteredVisibleIndices)}）`)
    // 清搜索、撤销回原、收尾
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'outline.test.searchInput', text: '' })
    await waitViewState('outline-drag.md', (v) => v.outline?.searchActive === false)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await waitViewState('outline-drag.md', (v) => v.outline?.items[0]?.text === '甲' && v.outline.items.length === 5)
    assert(doc.getText() === original, '撤销后应回原文')
    const final = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(final.appliedEdits - before.appliedEdits === 2, '折叠与搜索态拖拽各一笔写回')
    if (doc.isDirty) {
      await doc.save()
    }
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'sidebar.test.click' })
    await waitViewState('outline-drag.md', (v) => v.sidebar?.open === false)
  }],

  // ---- 工单 #59：公式渲染（KaTeX）实时预览/阅读/一致性 ----

  ['live 公式渲染与绘制层：渲染数、KaTeX 字体与真实可见（#59）', async () => {
    await openWithEditor('math.md')
    await waitSessionReady('math.md')
    const state = await waitViewState('math.md', (v) => (v.liveMathCount ?? -1) === 7)
    assert(state.liveMathCount === 7, `live 公式渲染数应为 7（6 合法 + 1 降级），实际 ${state.liveMathCount}`)
    // 绘制层断言（AGENTS 视觉层断言约定）：公式真的画出来（rect 有面积 +
    // elementFromPoint 命中），且 KaTeX 样式管线存活（字体族命中）
    assert(state.paint?.math?.visible === true,
      `公式应真实绘制（paint.math.visible=${String(state.paint?.math?.visible)}，` +
        `display=${String(state.paint?.math?.display)}）`)
    assert(state.paint?.math?.display !== 'none', '公式外层不得 display:none')
    assert(state.paint?.math?.count === 7, `绘制计数应为 7，实际 ${state.paint?.math?.count}`)
    assert((state.cssProbe?.liveMathFontFamily ?? '').includes('KaTeX'),
      `KaTeX 字体应生效（实际 ${state.cssProbe?.liveMathFontFamily}；若为 body 字体说明 CSS/字体管线失效）`)
    // 普通美元不被误判（$5 与 $10 不产生渲染态）
    assert(state.text.includes('$5 与 $10'), '源文普通美元应原样保留')
  }],

  ['live 光标进入公式显源码、离开恢复渲染且零写回（#59）', async () => {
    await openWithEditor('math.md')
    await waitSessionReady('math.md')
    const uri = wsUri('math.md').toString()
    const diskBefore = await readDisk('math.md')
    const before = await waitViewState('math.md', (v) => (v.liveMathCount ?? -1) === 7)
    // 光标移入首个行内公式（$E=mc^2$ 的区间内）→ 该公式退出渲染态
    const inlineAt = before.text.indexOf('$E=mc^2$')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: inlineAt + 3,
    })
    const editing = await waitViewState('math.md', (v) => (v.liveMathCount ?? -1) === 6)
    const editOffset = editing.selectionOffset ?? -1
    assert(editOffset >= inlineAt && editOffset <= inlineAt + 7,
      `光标应落在公式区间（实际 ${editOffset}）`)
    // 离开 → 恢复渲染
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    await waitViewState('math.md', (v) => (v.liveMathCount ?? -1) === 7)
    // 纯视图交互零写回：磁盘不变（显隐切换不产生编辑事务）
    assert(await readDisk('math.md') === diskBefore, '公式显隐交互不得改写源文')
  }],

  ['阅读模式公式渲染：块级独立成块、KaTeX 字体与绘制层（#59）', async () => {
    await openWithEditor('math.md')
    await waitSessionReady('math.md')
    const uri = wsUri('math.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('math.md', (v) =>
      v.viewMode === 'reading' && (v.readingMathCount ?? -1) === 7)
    assert(reading.readingMathCount === 7, `阅读公式数应为 7（6 KaTeX + 1 降级），实际 ${reading.readingMathCount}`)
    assert((reading.cssProbe?.readingMathFontFamily ?? '').includes('KaTeX'),
      `阅读 KaTeX 字体应生效（实际 ${reading.cssProbe?.readingMathFontFamily}）`)
    assert(reading.paint?.math?.visible === true, '阅读公式应真实绘制（rect + elementFromPoint）')
    assert((reading.readingTotalBlocks ?? 0) > 0, '阅读切块应正常')
  }],

  ['公式跨模式切换一致性：两模式计数对齐、文本不变、无写回（#59）', async () => {
    await openWithEditor('math.md')
    await waitSessionReady('math.md')
    const uri = wsUri('math.md').toString()
    const diskBefore = await readDisk('math.md')
    const live = await waitViewState('math.md', (v) => (v.liveMathCount ?? -1) === 7)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('math.md', (v) =>
      v.viewMode === 'reading' && (v.readingMathCount ?? -1) === 7)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const back = await waitViewState('math.md', (v) =>
      v.viewMode === 'live' && (v.liveMathCount ?? -1) === 7)
    assert(back.text === live.text, '模式切换不得改写文本')
    assert(back.docLength === live.docLength, '模式切换不得改变文档长度')
    assert(reading.text === live.text, '阅读渲染不写回')
    assert(await readDisk('math.md') === diskBefore, '模式切换不得触发磁盘写回')
  }],

  ['外部更新后公式与文本一致：新增公式进入渲染（#59）', async () => {
    await openWithEditor('math.md')
    await waitSessionReady('math.md')
    const doc = await vscode.workspace.openTextDocument(wsUri('math.md'))
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('math.md'), new vscode.Range(0, 0, 0, 0), '新增公式 $z^3$ 与块\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    await poll('外部修改生效', () => (doc.getText().startsWith('新增公式 $z^3$') ? true : undefined))
    // 面板同步外部增量：渲染数 +1（新增行内公式），原公式不变
    const after = await waitViewState('math.md', (v) => (v.liveMathCount ?? -1) === 8)
    assert(after.text.startsWith('新增公式 $z^3$'), '面板文本应含外部新增公式')
    // 切阅读模式：外部增量同样渲染
    await vscode.commands.executeCommand(CMD.postToPanel, wsUri('math.md').toString(), {
      kind: 'view.mode.set', mode: 'reading' })
    await waitViewState('math.md', (v) => v.viewMode === 'reading' && (v.readingMathCount ?? -1) === 8)
  }],
  // ---- 工单 #60：Mermaid 围栏块双模式渲染（live/reading/降级/一致性） ----

  ['live Mermaid 渲染与绘制层：渲染数、分态计数与真实可见（#60）', async () => {
    await openWithEditor('mermaid.md')
    await waitSessionReady('mermaid.md')
    const uri = wsUri('mermaid.md').toString()
    const diskBefore = await readDisk('mermaid.md')
    // 滚到文档尾部使全部围栏进入视口（光标停在围栏外段落，不抑制装饰）
    const tailAnchor = diskBefore.indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: tailAnchor,
    })
    const state = await waitViewState('mermaid.md', (v) =>
      (v.liveMermaidCount ?? -1) === 5 && v.paint?.mermaid?.rendered === 4, 0, 60000)
    assert(state.liveMermaidCount === 5,
      `live 围栏装饰数应为 5（4 有效 + 1 无效降级），实际 ${state.liveMermaidCount}`)
    // 绘制层断言（AGENTS 视觉层断言约定）：图真的画出来（rect 有面积 +
    // elementFromPoint 命中）；首图可能滚出视口，探针须命中任一有效图
    assert(state.paint?.mermaid?.visible === true,
      `图表应真实绘制（paint.mermaid.visible=${String(state.paint?.mermaid?.visible)}，` +
        `display=${String(state.paint?.mermaid?.display)}）`)
    assert(state.paint?.mermaid?.display !== 'none', '图表容器不得 display:none')
    assert(state.paint?.mermaid?.rendered === 4,
      `有效图渲染数应为 4，实际 ${state.paint?.mermaid?.rendered}`)
    assert(state.paint?.mermaid?.error === 1,
      `无效语法应恰有一个降级容器，实际 ${state.paint?.mermaid?.error}`)
    assert(state.paint?.mermaid?.count === 5, `容器总数应为 5，实际 ${state.paint?.mermaid?.count}`)
    assert(state.text === diskBefore, '渲染不得改写源文')
  }],

  ['live 光标进出围栏显隐零写回：进入显源码、离开恢复渲染（#60）', async () => {
    await openWithEditor('mermaid.md')
    await waitSessionReady('mermaid.md')
    const uri = wsUri('mermaid.md').toString()
    const diskBefore = await readDisk('mermaid.md')
    const tailAnchor = diskBefore.indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: tailAnchor,
    })
    const before = await waitViewState('mermaid.md', (v) => (v.liveMermaidCount ?? -1) === 5)
    // 光标移入首个围栏内容（graph TD 的 g 后）→ 该图退出渲染态显源码
    const fenceBody = before.text.indexOf('graph TD')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: fenceBody + 1,
    })
    const editing = await waitViewState('mermaid.md', (v) => (v.liveMermaidCount ?? -1) === 4)
    const editOffset = editing.selectionOffset ?? -1
    assert(editOffset >= fenceBody && editOffset <= fenceBody + 7,
      `光标应落在围栏区间（实际 ${editOffset}）`)
    // 离开（回到文档首，围栏外）→ 恢复渲染：进入 4、离开 5 的完整往返
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    const restored = await waitViewState('mermaid.md', (v) => (v.liveMermaidCount ?? -1) === 5)
    assert(restored.liveMermaidCount === 5,
      `光标离开围栏后应恢复全部 5 个装饰（4 有效 + 1 降级），实际 ${restored.liveMermaidCount}`)
    // 纯视图交互零写回：磁盘不变（显隐切换不产生编辑事务）
    assert(await readDisk('mermaid.md') === diskBefore, '围栏显隐交互不得改写源文')
  }],

  ['阅读模式 Mermaid 渲染：整块成块、绘制层与降级不吞后续块（#60）', async () => {
    await openWithEditor('mermaid.md')
    await waitSessionReady('mermaid.md')
    const uri = wsUri('mermaid.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('mermaid.md', (v) =>
      v.viewMode === 'reading' && (v.readingMermaidCount ?? -1) === 5 && v.paint?.mermaid?.rendered === 4, 0, 60000)
    assert(reading.readingMermaidCount === 5,
      `阅读图表容器数应为 5（4 渲染 + 1 降级），实际 ${reading.readingMermaidCount}`)
    assert(reading.paint?.mermaid?.visible === true, '阅读图表应真实绘制（rect + elementFromPoint）')
    assert(reading.paint?.mermaid?.error === 1, `无效语法应降级 1 个，实际 ${reading.paint?.mermaid?.error}`)
    // 大围栏豁免切片 + 降级不吞后续块：切块数合理且锚点块可定位
    assert((reading.readingTotalBlocks ?? 0) >= 5, `阅读切块应含全部图表块，实际 ${reading.readingTotalBlocks}`)
  }],

  ['Mermaid 跨模式切换一致性：两模式计数对齐、文本不变、无写回（#60）', async () => {
    await openWithEditor('mermaid.md')
    await waitSessionReady('mermaid.md')
    const uri = wsUri('mermaid.md').toString()
    const diskBefore = await readDisk('mermaid.md')
    const tailAnchor = diskBefore.indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: tailAnchor,
    })
    const live = await waitViewState('mermaid.md', (v) => (v.liveMermaidCount ?? -1) === 5, 0, 60000)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('mermaid.md', (v) =>
      v.viewMode === 'reading' && (v.readingMermaidCount ?? -1) === 5, 0, 60000)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'live' })
    const tailAnchor2 = (await readDisk('mermaid.md')).indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: tailAnchor2,
    })
    const back = await waitViewState('mermaid.md', (v) =>
      v.viewMode === 'live' && (v.liveMermaidCount ?? -1) === 5, 0, 60000)
    assert(back.text === live.text, '模式切换不得改写文本')
    assert(back.docLength === live.docLength, '模式切换不得改变文档长度')
    assert(reading.text === live.text, '阅读渲染不写回')
    assert(await readDisk('mermaid.md') === diskBefore, '模式切换不得触发磁盘写回')
  }],

  ['伪围栏与普通围栏不误渲染：边界样例零图表、正文完好（#60）', async () => {
    await openWithEditor('mermaid-edge.md')
    await waitSessionReady('mermaid-edge.md')
    const uri = wsUri('mermaid-edge.md').toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: (await readDisk('mermaid-edge.md')).indexOf('结尾段落'),
    })
    const live = await waitViewState('mermaid-edge.md', (v) => (v.liveMermaidCount ?? -1) === 0)
    assert(live.liveMermaidCount === 0, `普通围栏与伪围栏不得渲染图表，实际 ${live.liveMermaidCount}`)
    assert(live.text.includes('结尾段落保持可用。'), '伪围栏后的正文完好')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('mermaid-edge.md', (v) =>
      v.viewMode === 'reading' && (v.readingMermaidCount ?? -1) === 0)
    assert(reading.readingMermaidCount === 0, `阅读侧同样不渲染伪围栏，实际 ${reading.readingMermaidCount}`)
  }],

  ['外部更新后新增 Mermaid 围栏进入渲染（#60）', async () => {
    await openWithEditor('mermaid.md')
    await waitSessionReady('mermaid.md')
    const doc = await vscode.workspace.openTextDocument(wsUri('mermaid.md'))
    const extEdit = new vscode.WorkspaceEdit()
    extEdit.replace(wsUri('mermaid.md'), new vscode.Range(0, 0, 0, 0), '新增图：\n\n```mermaid\nC-->D\n```\n\n')
    assert(await vscode.workspace.applyEdit(extEdit), '外部修改应成功')
    await poll('外部修改生效', () => (doc.getText().startsWith('新增图：') ? true : undefined))
    const tailAnchor = doc.getText().indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, wsUri('mermaid.md').toString(), {
      kind: 'view.locate', offset: tailAnchor,
    })
    // 面板同步外部增量：围栏装饰 +1（新增有效图），原围栏不变
    const after = await waitViewState('mermaid.md', (v) => (v.liveMermaidCount ?? -1) === 6)
    assert(after.text.startsWith('新增图：'), '面板文本应含外部新增围栏')
    // 切阅读模式：外部增量同样渲染
    await vscode.commands.executeCommand(CMD.postToPanel, wsUri('mermaid.md').toString(), {
      kind: 'view.mode.set', mode: 'reading' })
    await waitViewState('mermaid.md', (v) =>
      v.viewMode === 'reading' && (v.readingMermaidCount ?? -1) === 6)
  }],
  ['格式命令：真实 Live 选区写回、绘制、一次撤销与运行时中文分词（#88）', async () => {
    await openWithEditor('lf.md')
    await waitSessionReady('lf.md')
    const uri = wsUri('lf.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('lf.md'))
    const before = doc.getText()
    const probe = await waitViewState('lf.md', (v) => v.wordSegmenter !== undefined)
    assert(probe.wordSegmenter === true, 'VSCode 1.86 webview 应提供 Intl.Segmenter 中文分词')
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.crossSelect', anchor: 0, head: 2 })
    await waitViewState('lf.md', (v) => v.selectionOffset === 0 && v.selectionHead === 2)
    assert(await vscode.commands.executeCommand('onegayi.vsidian.format.bold') === true,
      '格式命令应命中活动 Live 面板')
    await poll('格式写回权威文档', () => doc.getText() === '**中文**' + before.slice(2) ? true : undefined)
    const rendered = await waitViewState('lf.md', (v) => v.liveSyntax?.strongSpans === 1)
    assert(rendered.paint?.textVisible === true, '格式化后的正文应在绘制层可见')
    const session = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(session.appliedEdits === 1, `格式命令应仅提交一笔写回，实际 ${session.appliedEdits}`)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('格式一次撤销', () => doc.getText() === before ? true : undefined)
    const after = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(after.appliedEdits === 1, '宿主撤销回流不应产生新的写回')
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.crossSelect', anchor: 0, head: 0 })
    await waitViewState('lf.md', (v) => v.selectionOffset === 0 && v.selectionHead === 0)
    assert(await vscode.commands.executeCommand('onegayi.vsidian.format.bold') === true,
      '无选区格式命令应命中当前词')
    await poll('真实 webview 中文分词写回', () =>
      doc.getText() === '**中文**' + before.slice(2) ? true : undefined)

    await openWithEditor('format-crlf.md')
    await waitSessionReady('format-crlf.md')
    const crlfUri = wsUri('format-crlf.md').toString()
    const crlf = await vscode.workspace.openTextDocument(wsUri('format-crlf.md'))
    const crlfBefore = crlf.getText()
    assert(crlfBefore === CRLF_DOC, '格式命令应从独立 CRLF 原始样本开始')
    await vscode.commands.executeCommand(CMD.postToPanel, crlfUri,
      { kind: 'table.test.crossSelect', anchor: 4, head: 6 })
    await waitViewState('format-crlf.md', (v) => v.selectionOffset === 4 && v.selectionHead === 6)
    assert(await vscode.commands.executeCommand('onegayi.vsidian.format.bold') === true,
      'CRLF 文档的活动 Live 面板应接受格式命令')
    await poll('CRLF 格式写回', () =>
      crlf.getText() === '标题一\r\n**正文** A 行\r\n正文 B 行\r\n' ? true : undefined)
    await vscode.commands.executeCommand(CMD.injectMessage, crlfUri, { kind: 'history.request', op: 'undo' })
    await poll('CRLF 格式撤销', () => crlf.getText() === crlfBefore ? true : undefined)
  }],
  ['快速操作条：流内绘制、选区按钮与标题菜单写回（#89）', async () => {
    await openWithEditor('quick-actions-crlf.md')
    await waitSessionReady('quick-actions-crlf.md')
    const uri = wsUri('quick-actions-crlf.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('quick-actions-crlf.md'))
    const before = doc.getText()
    assert(before === CRLF_DOC, '操作条应从独立 CRLF 原始样本开始')
    const initial = await waitViewState('quick-actions-crlf.md', (v) => v.paint?.quickActions !== undefined)
    if (!initial.paint!.quickActions!.open) {
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'quick.test.click', action: 'toggle' })
    }
    const opened = await waitViewState('quick-actions-crlf.md', (v) => v.paint?.quickActions?.barPainted === true)
    const bar = opened.paint!.quickActions!
    assert(bar.togglePainted && bar.boldPainted && bar.barBelowToolbar && bar.editorBelowBar,
      `快速操作条和正文应在各自流内真实绘制：${JSON.stringify(bar)}`)

    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.crossSelect', anchor: 4, head: 6 })
    await waitViewState('quick-actions-crlf.md', (v) => v.selectionOffset === 4 && v.selectionHead === 6)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'quick.test.click', action: 'bold' })
    await poll('操作条粗体写回', () =>
      doc.getText() === '标题一\r\n**正文** A 行\r\n正文 B 行\r\n' ? true : undefined)
    const active = await waitViewState('quick-actions-crlf.md', (v) => v.paint?.quickActions?.activePainted === true)
    assert(active.paint?.quickActions?.activePainted === true,
      '粗体已应用态应有真实绘制的主题背景')
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('操作条粗体撤销', () => doc.getText() === before ? true : undefined)

    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'table.test.crossSelect', anchor: 0, head: 0 })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'quick.test.click', action: 'heading' })
    const popup = await waitViewState('quick-actions-crlf.md', (v) => v.paint?.quickActions?.menuPainted === true)
    assert(popup.paint?.quickActions?.menuPainted === true, '标题 popup 应真实绘制')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'quick.test.click', action: 'heading1' })
    await poll('标题菜单写回', () => doc.getText().startsWith('# 标题一\r\n') ? true : undefined)
    await vscode.commands.executeCommand(CMD.injectMessage, uri, { kind: 'history.request', op: 'undo' })
    await poll('标题菜单撤销', () => doc.getText() === before ? true : undefined)
  }],

  ['live 代码块卡片：呈现态头部绘制、编辑态保留、零写回与设置开关（#79/#80/#81）', async () => {
    await openWithEditor('code-card.md')
    await waitSessionReady('code-card.md')
    const uri = wsUri('code-card.md').toString()
    const diskBefore = await readDisk('code-card.md')
    // 定位到文档首（光标在全部围栏外）：顶部卡片在可视区内，绘制层命中
    // 才可断言（挂载缓冲外的滚动位置 rect 在视口外，elementFromPoint 不命中）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    // 呈现态：4 张卡片（js/text/裸围栏/未知语言）头部绘制，mermaid 走图表管线
    const present = await waitViewState('code-card.md', (v) => v.paint?.code?.headerCount === 4)
    assert(present.paint?.code?.visible === true, '卡片头部应真实绘制（rect + elementFromPoint）')
    assert(present.paint?.code?.label === 'JavaScript', `首块标签应为 JavaScript，实际 ${String(present.paint?.code?.label)}`)
    assert((present.liveMermaidCount ?? -1) === 1, `mermaid 围栏不套卡片且仍渲染图表，实际 ${present.liveMermaidCount}`)
    // #80 卡内行号：js 块 4 行从 1 起；文档行号槽照常显示（不因卡片隐藏）
    const ln = present.paint?.code?.lineNumberTexts
    assert(Array.isArray(ln) && ln.slice(0, 4).join(',') === '1,2,3,4',
      `js 块卡内行号应为 1..4，实际 ${JSON.stringify(ln)}`)
    // #81 呈现态每张卡片一个复制按钮
    assert(present.paint?.code?.copyCount === 4,
      `呈现态应 4 个复制按钮，实际 ${present.paint?.code?.copyCount}`)
    // #83 默认高亮：js 块产出 tok-* token
    assert((present.paint?.code?.tokenCount ?? 0) > 0,
      `默认高亮应产出 tok token，实际 ${present.paint?.code?.tokenCount}`)
    // 编辑态：光标进入首块代码体 → 头部与卡片行保留，复制按钮常驻
    //（渲染型围栏只有编辑态卡片——复制不能有死角）
    const body = present.text.indexOf('const a = 1')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: body + 2,
    })
    const editing = await waitViewState('code-card.md', (v) =>
      (v.selectionOffset ?? -1) >= body && (v.selectionOffset ?? -1) <= body + 6 &&
      v.paint?.code?.copyCount === 4)
    assert(editing.paint?.code?.headerCount === 4, `编辑态卡片头部应保留，实际 ${editing.paint?.code?.headerCount}`)
    // 离开恢复呈现态；纯视图交互零写回
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    await waitViewState('code-card.md', (v) =>
      (v.selectionOffset ?? 0) === 0 && v.paint?.code?.headerCount === 4 && v.paint?.code?.copyCount === 4)
    assert(await readDisk('code-card.md') === diskBefore, '卡片显隐交互不得改写源文')
    // #81 复制链路：点击 text 块（第 2 张）复制按钮 → 宿主剪贴板收到代码体
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.copy', index: 1,
    })
    await poll('剪贴板收到 text 块代码体', async () => {
      const text = await vscode.env.clipboard.readText()
      return text === 'hello' ? true : undefined
    })
    assert(await readDisk('code-card.md') === diskBefore, '复制不得改写源文')
    // #82 折叠：点击 text 块 chevron（第 2 张）→ 整块收起（行从 DOM 消失，
    // 头部保留、收起块无复制按钮）；卡片行 15 → 12
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.fold', index: 1,
    })
    const folded = await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 1 && v.paint.code.cardLineCount === 12)
    assert(folded.paint?.code?.headerCount === 4, '收起后头部横带保留')
    assert(folded.paint?.code?.copyCount === 3, '收起块不发射复制按钮')
    // 光标进入已折叠块 → 临时展开（折叠状态保留）
    const hello = folded.text.indexOf('hello')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: hello + 1,
    })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 0 && v.paint.code.cardLineCount === 15)
    // 离开 → 恢复收起；再次点击 chevron → 常驻展开
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 1 && v.paint.code.cardLineCount === 12)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.fold', index: 1,
    })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 0 && v.paint.code.cardLineCount === 15)
    assert(await readDisk('code-card.md') === diskBefore, '折叠交互不得改写源文')

    // ---- 设置开关段（#79–#83）。1.86.2 globalState 存在跨键迟到回翻
    // （settingsService.apply 注释记载）：紧邻的多次写入可把先前键的 overlay
    // 盖回旧值——每步写入后对**全量期望快照**做读回校验，不一致重写（≤3 次）
    const desired: Record<string, boolean> = {
      'codeblock.card': true,
      'codeblock.lineNumbers': true,
      'codeblock.copyButton': true,
      'codeblock.highlight': true,
    }
    const setCardSettings = async (patch: Record<string, boolean>): Promise<void> => {
      Object.assign(desired, patch)
      for (let attempt = 0; ; attempt++) {
        const applied = await vscode.commands.executeCommand(CMD.setSettings, patch) as { ok: boolean }
        assert(applied.ok === true, `设置保存应成功：${JSON.stringify(patch)}`)
        try {
          await waitSettings(desired)
          return
        } catch (error) {
          if (attempt >= 3) {
            throw error
          }
          // 迟到回翻：全量读回不一致 → 重写补丁
        }
      }
    }
    // 总开关：关闭 → 卡片形态消失（#83 起高亮独立：code 节由 token 驱动
    // 仍存在，头部与行类为 0）；重开 → 恢复（Compartment 热重配）
    await setCardSettings({ 'codeblock.card': false })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code !== undefined && v.paint.code.headerCount === 0 && v.paint.code.cardLineCount === 0)
    assert(await readDisk('code-card.md') === diskBefore, '设置切换不得改写源文')
    await setCardSettings({ 'codeblock.card': true })
    await waitViewState('code-card.md', (v) => v.paint?.code?.headerCount === 4)
    // #80 行号子开关：关闭 → 行号消失、卡片保留；重开恢复
    await setCardSettings({ 'codeblock.lineNumbers': false })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 4 && (v.paint.code.lineNumberTexts?.length ?? 0) === 0)
    await setCardSettings({ 'codeblock.lineNumbers': true })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 4 && (v.paint.code.lineNumberTexts?.length ?? 0) > 0)
    // #81 复制子开关：关闭 → 按钮消失、卡片保留；重开恢复
    await setCardSettings({ 'codeblock.copyButton': false })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 4 && (v.paint.code.copyCount ?? 0) === 0)
    await setCardSettings({ 'codeblock.copyButton': true })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 4 && (v.paint.code.copyCount ?? 0) === 4)
    // #83 高亮独立于卡片：关卡片仅高亮 → 无头部有 token；重开卡片关高亮 → 有头部无 token
    await setCardSettings({ 'codeblock.card': false })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 0 && (v.paint.code.tokenCount ?? 0) > 0)
    await setCardSettings({ 'codeblock.card': true, 'codeblock.highlight': false })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 4 && (v.paint.code.tokenCount ?? 0) === 0)
    await setCardSettings({ 'codeblock.highlight': true })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 4 && (v.paint.code.tokenCount ?? 0) > 0)

    // ---- 渲染型围栏（mermaid）接入卡片：编辑态外壳、呈现态让位（前段
    // headerCount 4 + liveMermaidCount 1 已断言）、折叠收起接管 SVG。
    // 呈现态 mermaid 无头部（让位 SVG）——折叠入口在编辑态：块内点
    // chevron（临时展开语义，折叠集更新）→ 离开后呈现态收起
    const mermaidBody = present.text.indexOf('graph TD')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: mermaidBody + 1,
    })
    const mEdit = await waitViewState('code-card.md', (v) =>
      v.paint?.code?.headerCount === 5 && (v.liveMermaidCount ?? -1) === 0)
    assert(mEdit.paint?.code?.labels?.includes('Mermaid') === true,
      `编辑态应出现 Mermaid 标签头部，实际 ${JSON.stringify(mEdit.paint?.code?.labels)}`)
    assert(mEdit.paint?.code?.cardLineCount === 19,
      `编辑态卡片行 15+4=19，实际 ${mEdit.paint?.code?.cardLineCount}`)
    assert(mEdit.paint?.code?.copyCount === 5,
      `mermaid 编辑态块同样常驻复制按钮（四张呈现态 + mermaid 编辑态），实际 ${mEdit.paint?.code?.copyCount}`)
    assert(await readDisk('code-card.md') === diskBefore, '渲染型围栏显隐交互不得改写源文')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.fold', index: 4,
    })
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    const mFolded = await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 1 && (v.liveMermaidCount ?? -1) === 0 && v.paint?.code?.headerCount === 5)
    assert(mFolded.paint?.code?.cardLineCount === 15,
      `收起后卡片行回到 15，实际 ${mFolded.paint?.code?.cardLineCount}`)
    assert(mFolded.paint?.code?.copyCount === 4, '收起块不发射复制按钮，四张普通卡片保持 4')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.fold', index: 4,
    })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 0 && (v.liveMermaidCount ?? -1) === 1 && v.paint?.code?.headerCount === 4)
    assert(await readDisk('code-card.md') === diskBefore, '渲染型围栏折叠交互不得改写源文')
  }],

  ['阅读模式代码块卡片：卡片/行号/高亮/复制/折叠与观感契约（#84）', async () => {
    await openWithEditor('code-card.md')
    await waitSessionReady('code-card.md')
    const uri = wsUri('code-card.md').toString()
    const diskBefore = await readDisk('code-card.md')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    // 4 张卡片头部绘制；行结构 = 内容行（js 4 + text/裸/zzz 各 1 = 7 行）
    const reading = await waitViewState('code-card.md', (v) =>
      v.viewMode === 'reading' && v.paint?.code?.headerCount === 4, 0, 60000)
    assert(reading.paint?.code?.visible === true, '阅读卡片头部应真实绘制（rect + elementFromPoint）')
    assert(reading.paint?.code?.label === 'JavaScript',
      `阅读首块标签应为 JavaScript，实际 ${String(reading.paint?.code?.label)}`)
    const ln = reading.paint?.code?.lineNumberTexts
    assert(Array.isArray(ln) && ln.slice(0, 4).join(',') === '1,2,3,4',
      `阅读 js 块卡内行号应为 1..4，实际 ${JSON.stringify(ln)}`)
    assert((reading.paint?.code?.tokenCount ?? 0) > 0, '阅读侧应有 tok 着色（与 Live 同词表）')
    assert((reading.paint?.code?.copyCount ?? 0) === 4, '阅读侧复制按钮在场')
    assert((reading.paint?.code?.cardLineCount ?? 0) === 7,
      `阅读行结构应为 7 个内容行，实际 ${reading.paint?.code?.cardLineCount}`)
    // 复制：点击 text 块（第 2 张）→ 宿主剪贴板收到代码体（与 Live 同通道）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.copy', index: 1,
    })
    await poll('阅读复制进剪贴板', async () => {
      const text = await vscode.env.clipboard.readText()
      return text === 'hello' ? true : undefined
    })
    // 折叠：收起 text 块 → 行消失（7→6）、头部保留；再点展开恢复
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.fold', index: 1,
    })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 1 && v.paint.code.cardLineCount === 6, 0, 60000)
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'codecard.test.fold', index: 1,
    })
    await waitViewState('code-card.md', (v) =>
      v.paint?.code?.foldedCount === 0 && v.paint.code.cardLineCount === 7, 0, 60000)
    assert(await readDisk('code-card.md') === diskBefore, '阅读卡片交互不得改写源文')
  }],

  // ---- 工单 #106：分割线渲染态与插入操作 ----

  ['live 分割线渲染与绘制层：全形态隐藏源文、真横线绘制（#106）', async () => {
    await openWithEditor('hr.md')
    await waitSessionReady('hr.md')
    const uri = wsUri('hr.md').toString()
    const diskBefore = await readDisk('hr.md')
    // 光标停在结尾段落（远离全部分割线行）：三条真分割线进入渲染态；
    // frontmatter 两条 --- 与 Setext 下划线（=== 与段落后的 ---）不计数
    const tailAnchor = diskBefore.indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: tailAnchor,
    })
    const state = await waitViewState('hr.md', (v) =>
      v.selectionOffset === tailAnchor && v.paint?.hr?.count === 3)
    // 绘制层断言（AGENTS 视觉层断言约定）：横线真的画出来（rect 有面积 +
    // elementFromPoint 命中）且以 border-top 落笔
    assert(state.paint?.hr?.visible === true,
      `分割线应真实绘制（paint.hr.visible=${String(state.paint?.hr?.visible)}，` +
        `display=${String(state.paint?.hr?.display)}）`)
    assert(state.paint?.hr?.display !== 'none', '分割线元素不得 display:none')
    assert(Number.parseFloat(state.paint?.hr?.borderTopWidth ?? '') > 0,
      `分割线须以 border-top 实际落笔：${String(state.paint?.hr?.borderTopWidth)}`)
    assert(state.text === diskBefore, '渲染不得改写源文')
  }],

  ['live 光标进出分割线行显隐零写回：进入显源码、离开恢复渲染（#106）', async () => {
    await openWithEditor('hr.md')
    await waitSessionReady('hr.md')
    const uri = wsUri('hr.md').toString()
    const diskBefore = await readDisk('hr.md')
    const tailAnchor = diskBefore.indexOf('结尾段落')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: tailAnchor,
    })
    await waitViewState('hr.md', (v) => v.paint?.hr?.count === 3)
    // 光标移入首条分割线行内 → 该线退出渲染态显源码（其余两条保持渲染）
    const hrAt = diskBefore.indexOf('\n---', diskBefore.indexOf('分割线前的段落文字')) + 1
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: hrAt + 1,
    })
    const editing = await waitViewState('hr.md', (v) => v.paint?.hr?.count === 2)
    const editOffset = editing.selectionOffset ?? -1
    assert(editOffset >= hrAt && editOffset <= hrAt + 3,
      `光标应落在分割线行区间（实际 ${editOffset}，期望 ${hrAt}..${hrAt + 3}）`)
    // 离开（回到文档首，分割线外）→ 恢复渲染：3 条的完整往返
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: 0,
    })
    const restored = await waitViewState('hr.md', (v) => v.paint?.hr?.count === 3)
    assert(restored.paint?.hr?.count === 3,
      `光标离开分割线行后应恢复 3 条渲染，实际 ${restored.paint?.hr?.count}`)
    // 纯视图交互零写回：磁盘不变（显隐切换不产生编辑事务，也不进撤销历史）
    assert(await readDisk('hr.md') === diskBefore, '分割线显隐交互不得改写源文')
  }],

  ['分割线插入操作：光标处成段插入并规整空行，阅读模式同源（#106）', async () => {
    await openWithEditor('hr.md')
    await waitSessionReady('hr.md')
    const uri = wsUri('hr.md').toString()
    const doc = await vscode.workspace.openTextDocument(wsUri('hr.md'))
    const diskBefore = await readDisk('hr.md')
    const anchor = diskBefore.indexOf('插入锚点在此行中')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: anchor,
    })
    await waitViewState('hr.md', (v) => v.selectionOffset === anchor)
    // 命令面板/快速操作条同源命令：行内光标处左右文字各自成段，分割线
    // 前后空行规整（该行原本无相邻空行 → 两侧各补一空行）
    await vscode.commands.executeCommand(CMD.postToPanel, uri,
      { kind: 'format.command', op: 'horizontalRule' })
    const inserted = diskBefore.replace(
      '结尾段落，分割线插入锚点在此行中。',
      '结尾段落，分割线\n\n---\n\n插入锚点在此行中。')
    await poll('分割线插入写回', () => (doc.getText() === inserted ? true : undefined))
    const edited = await waitViewState('hr.md', (v) => v.text === inserted)
    // 光标落在新分割线行尾：该行是控制域（触及显源码），计数暂保持 3
    assert(edited.selectionOffset === anchor + 5,
      `插入后光标应在新分割线行尾（期望 ${anchor + 5}，实际 ${edited.selectionOffset}）`)
    assert(edited.paint?.hr?.count === 3,
      `光标在新分割线行上时该线显源码不渲染（期望 3，实际 ${edited.paint?.hr?.count}）`)
    // 光标移到后段文字 → 新分割线恢复渲染
    const after = inserted.indexOf('插入锚点在此行中')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'view.locate', offset: after,
    })
    const rendered = await waitViewState('hr.md', (v) =>
      v.selectionOffset === after && v.paint?.hr?.count === 4)
    assert(rendered.paint?.hr?.visible === true, '新分割线应真实绘制')
    // 阅读模式：<hr> 原生渲染、数量与 Live 对齐（颜色与 Live 同源变量）
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.mode.set', mode: 'reading' })
    const reading = await waitViewState('hr.md', (v) =>
      v.viewMode === 'reading' && v.paint?.hr?.count === 4)
    assert(reading.paint?.hr?.visible === true, '阅读模式分割线应真实绘制（rect + elementFromPoint）')
    assert(Number.parseFloat(reading.paint?.hr?.borderTopWidth ?? '') > 0,
      `阅读分割线须以 border-top 实际落笔：${String(reading.paint?.hr?.borderTopWidth)}`)
  }],
]
