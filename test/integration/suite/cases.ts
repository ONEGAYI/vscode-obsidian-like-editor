// 集成测试用例：验证工单 #2 的验收标准（激活/打开/编辑/保存/CRLF/视口）。
// fixture 工作区由 runTest.mjs 在临时目录动态生成（避免 git 换行转换干扰
// 字节级断言），路径经环境变量 WORKSPACE_DIR 传入。
import * as vscode from 'vscode'

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
): Promise<ViewState> {
  return poll(`视图状态 ${file}`, async () => {
    const state = (await vscode.commands.executeCommand(CMD.viewState, wsUri(file).toString(), panelIndex)) as ViewState | undefined
    if (state && (!match || match(state))) {
      return state
    }
    return undefined
  })
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
  ['激活与可选编辑器声明', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID)
    assert(ext, `扩展 ${EXT_ID} 未找到`)
    await ext!.activate()
    assert(ext!.isActive, '扩展激活失败')

    const contributes = (ext!.packageJSON as { contributes?: { customEditors?: Array<{ priority?: string; selector?: Array<{ filenamePattern?: string }> }> } }).contributes
    const editor = contributes?.customEditors?.[0]
    assert(editor?.priority === 'option', `priority 应为 option（不接管默认打开），实际 ${editor?.priority}`)
    const patterns = editor?.selector?.map((s) => s.filenamePattern) ?? []
    assert(patterns.includes('*.md'), `selector 应含 *.md，实际 ${patterns.join(',')}`)
  }],

  ['默认打开 .md 仍是原生文本编辑器（不自动接管）', async () => {
    const doc = await vscode.workspace.openTextDocument(wsUri('lf.md'))
    await vscode.window.showTextDocument(doc)
    assert(vscode.window.activeTextEditor !== undefined, '默认打开应得到原生 TextEditor')
    assert(vscode.window.activeTextEditor?.document.uri.toString() === wsUri('lf.md').toString(), '活动编辑器文档不符')
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
    const view = await waitViewState('heading.md', (v) => (v.headingLineCount ?? 0) >= 2)
    assert((view.headingActiveText ?? '').startsWith('#'), `光标贴近的标题标记应显形（# 开头）：${JSON.stringify(view.headingActiveText)}`)
    assert((view.headingHiddenText ?? '').startsWith('#') === false, `另一标题标记应隐藏（不以 # 开头）：${JSON.stringify(view.headingHiddenText)}`)
    assert((view.headingHiddenText ?? '') === '中部二级标题', `另一标题行 DOM 文本应为标题内容：${JSON.stringify(view.headingHiddenText)}`)

    const uri = wsUri('heading.md').toString()
    const bodyOffset = '# 顶部'.length
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.locate', offset: bodyOffset })
    const inBody = await poll('标题正文光标显形行首标记', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.selectionOffset === bodyOffset ? v : undefined
    })
    assert((inBody.headingActiveText ?? '').startsWith('#'), `光标在标题正文时 # 应保持显形：${JSON.stringify(inBody.headingActiveText)}`)

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

    // 切回实时预览：内容与光标语义保留
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
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

    // 切回实时预览：光标恢复到锚点块源 start（对应段落与光标，非百分比）
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
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
    const emptyAt = before.indexOf('| | 空 |') + 2
    const clicked = await waitViewState('table42-empty.md', (v) => v.selectionOffset === emptyAt)
    assert(clicked.tableGrid?.selectedRowIsGrid === true, '空单元格点击后不得撤网格')
    assert(clicked.tableGrid?.selectedRowCells.length === 2, '空单元格所在行应保留两列')
    const afterClick = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(afterClick.appliedEdits === initial.appliedEdits, '空单元格点击不应写回')
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.type', text: '新' })
    const edited = before.replace('| | 空 |', '| 新| 空 |')
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
    await poll('空中格写回', () => doc.getText().includes('| 带 |  空| 末 |') ? true : undefined)
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

  ['跨行选区不显露或选中安全表格分隔标记', async () => {
    const name = 'table-cross-selection.md'
    const source = '前文\n\n| 带 | s是 | 送 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n\n后文'
    await vscode.workspace.fs.writeFile(wsUri(name), Buffer.from(source))
    await openWithEditor(name)
    const initial = await waitSessionReady(name)
    const uri = wsUri(name).toString()
    await vscode.commands.executeCommand(CMD.postToPanel, uri, {
      kind: 'table.test.crossSelect', anchor: 1, head: source.indexOf('后文') + 1,
    })
    const state = await waitViewState(name, (v) => v.selectionHead === source.indexOf('| 带 | s是 | 送 |'))
    assert(state.paint?.table?.delimiterDisplay === 'none',
      `跨行选择后分隔行仍须隐藏：${JSON.stringify(state.paint?.table)}`)
    assert(state.paint?.table?.gridDisplay === 'grid', '跨行选择后表格仍须绘制为网格')
    const after = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(after.appliedEdits === initial.appliedEdits, '跨行选区不能改写源文')
  }],

  ['中格空白连续退格后再输入仍保持表头网格样式', async () => {
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
      await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'table.test.key', key: 'backspace' })
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

    // 切回 live：选区恢复到当前匹配（源锚点映射，非块首）
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
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

    // 大小写语义随宿主平台：Windows 本地（NTFS 语义）大小写不敏感命中
    //（面板此前未退场——以上拦截意图不打开编辑器）
    await injectWikilink(uri, process.platform === 'win32' ? 'casenote' : 'CaseNote')
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
    const row = await waitViewState('table43-crlf.md', (v) => v.paint?.table?.rowOutlineWidth != null)
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
    // 切回 live 验证面板仍可用
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
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
    // 还原默认行号开启（跨用例状态清理，同 #34 既有用例约定）
    await vscode.commands.executeCommand(CMD.setSettings, { 'editor.lineNumbers': true })
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
    // 标题与界面归属 Vsidian（面板标题即命令面板/页头呈现）
    assert(info.title === 'Vsidian 设置', `设置页标题应归属 Vsidian，实际 ${info.title}`)
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

    // 阅读期间保持设置开；切回 live 后行号按设置恢复且从 1 起
    await vscode.commands.executeCommand('onegayi.vsidian.toggleViewMode')
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
]
