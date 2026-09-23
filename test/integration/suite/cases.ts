// 集成测试用例：验证工单 #2 的验收标准（激活/打开/编辑/保存/CRLF/视口）。
// fixture 工作区由 runTest.mjs 在临时目录动态生成（避免 git 换行转换干扰
// 字节级断言），路径经环境变量 WORKSPACE_DIR 传入。
import * as vscode from 'vscode'

const VIEW_TYPE = 'onegayi.obsidian-like-markdown-editor'
const EXT_ID = 'onegayi.vscode-obsidian-like-editor'
const CMD = {
  sessionState: 'onegayi.obsidian-like-editor._test.getSessionState',
  injectMessage: 'onegayi.obsidian-like-editor._test.injectWebviewMessage',
  viewState: 'onegayi.obsidian-like-editor._test.requestViewState',
  conflictState: 'onegayi.obsidian-like-editor._test.getConflictState',
  resumePanel: 'onegayi.obsidian-like-editor._test.resumePanel',
  perfProbe: 'onegayi.obsidian-like-editor._test.perfProbe',
}

const wsDir = process.env['WORKSPACE_DIR'] ?? ''
if (!wsDir) {
  throw new Error('环境变量 WORKSPACE_DIR 未设置（应由 runTest.mjs 注入）')
}

const LF_DOC = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n- 列表项一\n- 列表项二\n'
const CRLF_DOC = '标题一\r\n正文 A 行\r\n正文 B 行\r\n'
// 在 '- 列表项一' 行首插入 '插入的新段落\n' 后的期望全文
const LF_DOC_AFTER_EDIT = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n插入的新段落\n- 列表项一\n- 列表项二\n'

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
]
