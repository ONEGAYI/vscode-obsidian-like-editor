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
}

const wsDir = process.env['WORKSPACE_DIR'] ?? ''
if (!wsDir) {
  throw new Error('环境变量 WORKSPACE_DIR 未设置（应由 runTest.mjs 注入）')
}

const LF_DOC = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n- 列表项一\n- 列表项二\n'
const CRLF_DOC = '标题一\r\n正文 A 行\r\n正文 B 行\r\n'
const LF_DOC_AFTER_EDIT = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n插入的新段落\n\n- 列表项一\n- 列表项二\n'

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

async function waitViewState(file: string, match?: (v: ViewState) => boolean): Promise<ViewState> {
  return poll(`视图状态 ${file}`, async () => {
    const state = (await vscode.commands.executeCommand(CMD.viewState, wsUri(file).toString())) as ViewState | undefined
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

    const contributes = (ext!.packageJSON as { contributes?: { customEditors?: Array<{ priority?: string; selector?: Array<{ pattern?: string }> }> } }).contributes
    const editor = contributes?.customEditors?.[0]
    assert(editor?.priority === 'option', `priority 应为 option（不接管默认打开），实际 ${editor?.priority}`)
    const patterns = editor?.selector?.map((s) => s.pattern) ?? []
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
    // 全文模型承载完整文档；渲染行数应远小于总行数（CM6 视口虚拟渲染）
    assert(view.lineCount === totalLines, `全文模型行数应为 ${totalLines}，实际 ${view.lineCount}`)
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
    // 两个面板的 webview 都应看到新文本
    const expected = '广播前缀 split 起始行\n'
    await poll('双面板文本同步', async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, wsUri('split.md').toString())) as ViewState | undefined
      return v?.text === expected ? true : undefined
    })
    const doc = await vscode.workspace.openTextDocument(wsUri('split.md'))
    assert(doc.getText() === expected, '宿主文档应更新')
  }],
]
