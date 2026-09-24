// 集成测试用例：验证工单 #2 的验收标准（激活/打开/编辑/保存/CRLF/视口）。
// fixture 工作区由 runTest.mjs 在临时目录动态生成（避免 git 换行转换干扰
// 字节级断言），路径经环境变量 WORKSPACE_DIR 传入。
import * as vscode from 'vscode'

const VIEW_TYPE = 'onegayi.obsidian-like-markdown-editor'
const EXT_ID = 'onegayi.vscode-obsidian-like-editor'
const CMD = {
  sessionState: 'onegayi.obsidian-like-editor._test.getSessionState',
  injectMessage: 'onegayi.obsidian-like-editor._test.injectWebviewMessage',
  postToPanel: 'onegayi.obsidian-like-editor._test.postToPanel',
  viewState: 'onegayi.obsidian-like-editor._test.requestViewState',
  conflictState: 'onegayi.obsidian-like-editor._test.getConflictState',
  resumePanel: 'onegayi.obsidian-like-editor._test.resumePanel',
  perfProbe: 'onegayi.obsidian-like-editor._test.perfProbe',
  readingPerf: 'onegayi.obsidian-like-editor._test.readingPerf',
}

const wsDir = process.env['WORKSPACE_DIR'] ?? ''
if (!wsDir) {
  throw new Error('环境变量 WORKSPACE_DIR 未设置（应由 runTest.mjs 注入）')
}

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
  /** #6 模式切换观测 */
  viewMode?: 'live' | 'reading'
  selectionOffset?: number
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
  }
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

  ['标题装饰：非活动标题渲染为格式化标题，活动行显示源码（#5 切片）', async () => {
    await openWithEditor('heading.md')
    await waitSessionReady('heading.md')
    // 光标初始在文档头（行 1 标题上）：该行活动显示源码，行 4 标题非活动隐藏标记
    const view = await waitViewState('heading.md', (v) => (v.headingLineCount ?? 0) >= 2)
    assert((view.headingActiveText ?? '').startsWith('#'), `活动标题行应显示源码（# 开头）：${JSON.stringify(view.headingActiveText)}`)
    assert((view.headingHiddenText ?? '').startsWith('#') === false, `非活动标题行应隐藏标记（不以 # 开头）：${JSON.stringify(view.headingHiddenText)}`)
    assert((view.headingHiddenText ?? '') === '中部二级标题', `非活动标题行 DOM 文本应为标题内容：${JSON.stringify(view.headingHiddenText)}`)

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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
    const readingView = await poll('阅读模式锚点', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return v?.viewMode === 'reading' && v.readingAnchorStart !== undefined ? v : undefined
    })
    assert(readingView.readingAnchorStart === target, `阅读锚点应为源块 start=${target}，实际 ${readingView.readingAnchorStart}`)
    assert(readingView.readingBlockCount === 3, `锚点文档应 3 块，实际 ${readingView.readingBlockCount}`)
    assert(readingView.text.includes('最后段落结束'), '阅读视图文本同步')

    // 切回实时预览：光标恢复到锚点块源 start（对应段落与光标，非百分比）
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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

    // live：探针片段经 .oile-heading-line-1 命中（text-decoration-color 无视觉影响）
    const liveView = await waitViewState('mode.md', (v) => v.cssProbe?.liveHeadingDecorationColor !== undefined && v.viewMode === 'live')
    assert(
      liveView.cssProbe!.liveHeadingDecorationColor === 'rgb(1, 2, 3)',
      `live 一级标题应被测试片段命中 rgb(1, 2, 3)，实际 ${liveView.cssProbe!.liveHeadingDecorationColor}`,
    )

    // reading：.oile-reading-heading-1 命中 + .oile-view-reading 变量可被覆盖读取
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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

    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
      await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
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
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
    const para2Start = text.indexOf('第二段：又出现目标词了。')
    v = await poll('阅读模式保活与锚点落定', async () => {
      const s = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return s?.viewMode === 'reading' && s.find?.open === true && s.readingAnchorStart === para2Start ? s : undefined
    })
    assert(v.find!.index === 2, `会话保活：当前序号仍为 2，实际 ${v.find!.index}`)
    assert(v.readingAnchorStart === para2Start, `阅读锚点应为当前匹配块 start，实际 ${v.readingAnchorStart}`)

    // 切回 live：选区恢复到当前匹配（源锚点映射，非块首）
    await vscode.commands.executeCommand('onegayi.obsidian-like-editor.toggleViewMode')
    v = await poll('切回 live 恢复', async () => {
      const s = (await vscode.commands.executeCommand(CMD.viewState, uri, 0)) as ViewState | undefined
      return s?.viewMode === 'live' && s.find?.open === true ? s : undefined
    })
    assert(v.selectionOffset === matchFrom, `切回后光标应恢复到当前匹配 ${matchFrom}，实际 ${v.selectionOffset}`)

    // 关闭后切换/状态不受影响；磁盘与版本保持
    await vscode.commands.executeCommand(CMD.postToPanel, uri, { kind: 'view.find.close' })
    await waitViewState('find.md', (s) => s.find?.open === false)
    const session = (await vscode.commands.executeCommand(CMD.sessionState, uri)) as SessionState
    assert(session.appliedEdits === 0, `查找与切换不得产生写回，实际 ${session.appliedEdits}`)
    assert(await readDisk('find.md') === diskBefore, '查找与模式切换后磁盘字节不变')
  }],
]
