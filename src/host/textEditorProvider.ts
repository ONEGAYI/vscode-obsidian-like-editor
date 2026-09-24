// CustomTextEditorProvider 实现与文档会话注册表。
//
// 选择 CustomTextEditorProvider（而非 CustomEditorProvider）：保存、dirty、
// Hot Exit 全部由 VSCode 标准文本管线自动处理，扩展只需实现
// resolveCustomTextEditor（探索笔记 02 §1）。
// 权威文本为 TextDocument；webview 编辑经 DocumentSession 校验后以
// WorkspaceEdit 写回；文档事件回流经 session 识别自家确认与外部变更。
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { DocumentSession, type HostDocumentPort, type SessionNotice } from './documentSession'
import {
  classifyImageTarget,
  classifyLinkTarget,
  imageBlockReasonOf,
  type ImageResolution,
  type LinkContext,
} from './linkTarget'
import {
  findHeadingOffset,
  resolveWikilinkFile,
  type WikilinkResolveContext,
} from './wikilinkTarget'
import { parseWikilinkInner } from '../shared/wikilink'
import { NewlineCoordinator } from '../shared/newline'
import { isWebviewToHost, type HostToWebview, type SerChange, type TableEditOp } from '../shared/protocol'

export const VIEW_TYPE = 'onegayi.vsidian.editor'

/** 活动标签是否为指定文档的本扩展 custom editor（C-5）。
 *  webview 转发的 undo/redo 经宿主全局命令执行，而该命令作用于活动
 *  编辑器——请求前必须确认活动 tab 归属本面板文档，否则会撤销其他文档 */
export function isActiveTabCustomEditorOf(
  tab: vscode.Tab | undefined,
  viewType: string,
  uriStr: string,
): boolean {
  const input = tab?.input
  return (
    input instanceof vscode.TabInputCustom &&
    input.viewType === viewType &&
    input.uri.toString() === uriStr
  )
}

/** 链接跳转执行日志（#10 测试钩子观测：VSIDIAN_TEST_HOOKS 下集成测试断言
 *  宿主收到的跳转意图与处置结果） */
export interface LinkLogEntry {
  kind: 'external' | 'doc' | 'blocked' | 'not-found'
  href: string
  /** blocked 的原因码 */
  reason?: string
  /** blocked-scheme 的协议名 */
  scheme?: string
  /** doc 的实际目标路径 */
  path?: string
}

/** 双链跳转执行日志（#11；与 LinkLogEntry 共用 linkLog 通道） */
export interface WikilinkLogEntry {
  kind:
    | 'wikilink-doc'
    | 'wikilink-ambiguous'
    | 'wikilink-not-found'
    | 'wikilink-no-workspace'
    | 'wikilink-unsupported'
    | 'wikilink-cancelled'
  /** 上报的原始 target（| 之前） */
  target: string
  /** wikilink-doc 的目标绝对路径 */
  path?: string
  /** 请求的标题目标（trim 后） */
  heading?: string
  /** ambiguous 的候选绝对路径 */
  candidates?: string[]
  /** wikilink-doc 的定位方式：custom-panel=本扩展面板挂载定位；
   *  text-editor=文本编辑器 selection reveal；none=无标题定位 */
  locate?: 'custom-panel' | 'text-editor' | 'none'
}

interface SessionEntry {
  session: DocumentSession
  doc: vscode.TextDocument
  /** 面板句柄（#13 表格命令需定位活动面板；写操作只作用于光标所在面板） */
  panels: Map<string, vscode.WebviewPanel>
  appliedEdits: number
  /** #10/#11 链接跳转执行日志（容量有界） */
  linkLog: Array<LinkLogEntry | WikilinkLogEntry>
}

/** 文档的资源根（#10）：图片 webview 资源许可面 = 工作区文件夹根
 *  （无工作区时为文档所在目录）——与链接/图片路径不得越过工作区边界的
 *  白名单口径一致 */
function imageResourceRoot(document: vscode.TextDocument): vscode.Uri {
  return (
    vscode.workspace.getWorkspaceFolder(document.uri)?.uri ??
    vscode.Uri.joinPath(document.uri, '..')
  )
}

/** 链接目标解析上下文（宿主文件系统语义：扩展宿主进程的平台即工作区
 *  文件系统所在机器——本地 Windows 是 win32，远程 SSH 宿主是远程平台，
 *  两类路径语义天然不混用） */
function linkContextOf(document: vscode.TextDocument): LinkContext {
  const docPath = document.uri.fsPath
  return {
    docDir: path.dirname(docPath),
    rootDir: imageResourceRoot(document).fsPath,
    isWindowsHost: process.platform === 'win32',
  }
}

export function createTextEditorProvider(
  context: vscode.ExtensionContext,
): vscode.CustomTextEditorProvider {
  const sessions = new Map<string, SessionEntry>()
  let lastClosedInput: { docUri: string; webviewText?: string; fragments: string[] } | undefined

  const getEntry = (uri: vscode.Uri): SessionEntry | undefined =>
    sessions.get(uri.toString())

  /** 向面板请求最新 view.state（面板存活时的最可靠未确认输入来源） */
  const fetchPanelText = async (
    entry: SessionEntry,
    sessionId: string,
    timeoutMs = 3000,
  ): Promise<string | undefined> => {
    const before = entry.session.getViewState(sessionId)
    entry.session.postToPanel(sessionId, { kind: 'view.state.request' })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = entry.session.getViewState(sessionId)
      if (state && state !== before) {
        return state.text
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return entry.session.getViewState(sessionId)?.text
  }

  /** 复制未确认输入：优先面板最新文本，回退宿主快照（fragments / report 全文） */
  const copyConflictInput = async (uriStr: string, sessionId: string): Promise<void> => {
    const entry = sessions.get(uriStr)
    if (!entry) {
      return
    }
    const state = entry.session.getConflictState(sessionId)
    // 重载后的暂停面板（B-2）：webview 已装载权威全文（init），view.state
    // 不再代表冲突前的未确认输入——跳过面板查询，直接用宿主留存的快照
    const live =
      state?.suspended && state.reloaded ? undefined : await fetchPanelText(entry, sessionId)
    const text = live ?? state?.webviewText ?? state?.fragments.join('\n') ?? ''
    if (text) {
      await vscode.env.clipboard.writeText(text)
      void vscode.window.showInformationMessage('未确认输入已复制到剪贴板')
    } else {
      void vscode.window.showWarningMessage('没有可复制的未确认输入')
    }
  }

  /** 恢复（放弃本地修改重新同步）：二次确认避免误丢输入 */
  const confirmResume = async (uriStr: string, sessionId: string): Promise<void> => {
    const entry = sessions.get(uriStr)
    if (!entry) {
      return
    }
    const name = vscode.workspace.asRelativePath(entry.doc.uri)
    const pick = await vscode.window.showWarningMessage(
      `将放弃“${name}”编辑器中未确认的本地修改，并以磁盘/权威内容重新同步。建议先复制未确认输入。`,
      '放弃本地修改并重新同步',
    )
    if (pick === '放弃本地修改并重新同步') {
      entry.session.resumePanel(sessionId)
    }
  }

  /** 会话通知呈现（#4）：冲突暂停、复制请求、面板关闭/断连时的未确认输入提醒 */
  const handleNotice = (uriStr: string, notice: SessionNotice): void => {
    const entry = sessions.get(uriStr)
    const name = entry ? vscode.workspace.asRelativePath(entry.doc.uri) : uriStr
    if (notice.type === 'conflict') {
      void vscode.window
        .showWarningMessage(
          `“${name}”的编辑已暂停：外部修改与未确认输入无法安全合并。未确认输入已保留，可随时取回。`,
          '复制未确认输入',
          '放弃本地修改并重新同步',
        )
        .then((pick) => {
          if (pick === '复制未确认输入') {
            void copyConflictInput(uriStr, notice.sessionId)
          } else if (pick === '放弃本地修改并重新同步') {
            void confirmResume(uriStr, notice.sessionId)
          }
        })
      return
    }
    if (notice.type === 'copy-request') {
      void copyConflictInput(uriStr, notice.sessionId)
      return
    }
    // panel-closed-with-input：面板关闭（或 SSH 断连触发的 dispose）时未确认
    // 输入仍在宿主快照中——提示取回，不得误报已保存。文本优先取 webview
    // 即时上报的全文快照（#21：含暂停后新输入与暂缓集内容），回退逐笔片段
    if (process.env.VSIDIAN_TEST_HOOKS === '1') {
      lastClosedInput = { docUri: notice.docUri, webviewText: notice.webviewText, fragments: notice.fragments }
    }
    const closedText = notice.webviewText ?? notice.fragments.join('\n')
    void vscode.window
      .showWarningMessage(
        `“${name}”的编辑器已关闭（或连接断开），存在未保存的未确认输入：${closedText.slice(0, 120)}`,
        '复制未确认输入',
      )
      .then((pick) => {
        if (pick === '复制未确认输入') {
          const state = sessions.get(uriStr)?.session.getConflictState(notice.sessionId)
          void vscode.env.clipboard.writeText(
            state?.webviewText ?? notice.webviewText ?? state?.fragments.join('\n') ?? notice.fragments.join('\n'),
          )
        }
      })
  }

  const openEntry = (doc: vscode.TextDocument): SessionEntry => {
    const key = doc.uri.toString()
    let entry = sessions.get(key)
    if (entry) {
      return entry
    }
    const fresh: SessionEntry = { session: undefined as never, doc, panels: new Map(), appliedEdits: 0, linkLog: [] }
    const port: HostDocumentPort = {
      get version() {
        return doc.version
      },
      getText: () => doc.getText(),
      applyChanges: async (changes: SerChange[]) => {
        const edit = new vscode.WorkspaceEdit()
        for (const c of changes) {
          edit.replace(
            doc.uri,
            new vscode.Range(doc.positionAt(c.offset), doc.positionAt(c.offset + c.length)),
            c.text,
          )
        }
        const ok = await vscode.workspace.applyEdit(edit)
        if (ok) {
          fresh.appliedEdits += 1
        }
        return ok
      },
      // 撤销/重做走宿主全局命令：活动编辑器为 CustomEditorInput 时，VSCode
      // 1.86 的 undo MultiCommand 含 custom-editor 实现（priority 105），直接
      // 调 undoRedoService.undo(resource) 作用于本文档的权威文本栈；产生的
      // 变更经 onDidChangeTextDocument 回流广播，不经过 applyEdit（无回声）。
      // C-5：webview 请求必须确认活动 tab 是本面板文档的 custom editor——
      // 全局命令作用于活动编辑器，归属不符时静默忽略（不得撤销其他文档）
      undo: async () => {
        if (!isActiveTabCustomEditorOf(vscode.window.tabGroups.activeTabGroup.activeTab, VIEW_TYPE, doc.uri.toString())) {
          return false
        }
        return vscode.commands.executeCommand('undo').then(() => true, () => false)
      },
      redo: async () => {
        if (!isActiveTabCustomEditorOf(vscode.window.tabGroups.activeTabGroup.activeTab, VIEW_TYPE, doc.uri.toString())) {
          return false
        }
        return vscode.commands.executeCommand('redo').then(() => true, () => false)
      },
    }
    fresh.session = new DocumentSession(port, {
      docUri: key,
      onNotice: (notice) => handleNotice(key, notice),
    })
    sessions.set(key, fresh)
    return fresh
  }

  const releaseEntryIfIdle = (uri: vscode.Uri): void => {
    const entry = sessions.get(uri.toString())
    if (entry && entry.session.getInfo().panels.length === 0) {
      entry.session.dispose()
      sessions.delete(uri.toString())
    }
  }

  // ---- #11 双链跳转执行（ADR-0002：按需 findFiles 解析，不建持久索引） ----

  /** 目标已是本扩展面板时等待其就绪（隐藏面板重载场景），返回可投递面板 */
  const waitForReadyPanel = async (
    entry: SessionEntry,
    timeoutMs = 5000,
  ): Promise<string | undefined> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const panel = entry.session.getInfo().panels.find((p) => p.ready)
      if (panel) {
        return panel.sessionId
      }
      if (Date.now() > deadline) {
        return undefined
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /** 当前工作区内（限定当前文档所属文件夹）的全部 .md 绝对路径，按需现查 */
  const findWorkspaceMdFiles = async (folder: vscode.Uri): Promise<string[]> => {
    const uris = await vscode.workspace.findFiles('**/*.md')
    const rootFsPath = folder.fsPath
    const out: string[] = []
    for (const uri of uris) {
      const rel = path.relative(rootFsPath, uri.fsPath)
      // 精确越界判定（与 linkTarget 的 isInsideRoot 同口径）：`..foo.md`
      // 是同级合法文件名，粗判 startsWith('..') 会误排除
      if (
        rel !== '' &&
        (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
      ) {
        continue // 多根工作区：只取当前文档所属文件夹内的文件
      }
      out.push(uri.fsPath)
    }
    return out
  }

  /**
   * 双链跳转执行（#11）：解析（按需 findFiles + 纯分类器）→ 重名 QuickPick
   * 选择 → 打开目标并定位标题。定位双路径：
   * - 目标已是本扩展面板：reveal 该面板（vscode.openWith 对已开面板是重显）
   *   后发 view.locate——reading 模式经 #14 的块挂载定位（屏外目标可定位），
   *   live 模式光标+滚动
   * - 其余：文本编辑器打开；有标题时以标题行 selection reveal（1.86 API 面）
   * 全程只读：不触碰 TextDocument、不建索引、不自动创建文件。
   * 测试钩子模式（VSIDIAN_TEST_HOOKS）下歧义只记录不弹 QuickPick（与 #10 外链
   * 不真开浏览器同口径）。
   */
  const executeWikilinkIntent = async (
    document: vscode.TextDocument,
    intent: { target: string; srcStart: number; srcEnd: number },
    log: Array<LinkLogEntry | WikilinkLogEntry>,
  ): Promise<void> => {
    const pushLog = (entry: WikilinkLogEntry): void => {
      log.push(entry)
      while (log.length > 64) {
        log.shift()
      }
    }
    const parsed = parseWikilinkInner(intent.target.trim())
    if (!parsed) {
      pushLog({ kind: 'wikilink-unsupported', target: intent.target })
      void vscode.window.showWarningMessage(
        `不支持的双链形态「[[${intent.target}]]」（块引用 ^、嵌入 ![[…]] 等属二期）：已按原文保留`,
      )
      return
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)
    const ctx: WikilinkResolveContext = {
      docDir: path.dirname(document.uri.fsPath),
      rootDir: (folder ? folder.uri : vscode.Uri.joinPath(document.uri, '..')).fsPath,
      isWindowsHost: process.platform === 'win32',
      hasWorkspace: folder !== undefined,
    }
    const mdFiles = ctx.hasWorkspace ? await findWorkspaceMdFiles(folder!.uri) : []
    const resolution = resolveWikilinkFile({ path: parsed.path }, ctx, mdFiles)
    if (resolution.kind === 'no-workspace') {
      pushLog({ kind: 'wikilink-no-workspace', target: parsed.path })
      void vscode.window.showWarningMessage(
        '当前文档不在任何工作区文件夹内：双链目标需要按工作区查找，未打开文件夹时无法跳转（链接文本保留）',
      )
      return
    }
    if (resolution.kind === 'not-found') {
      pushLog({ kind: 'wikilink-not-found', target: parsed.path, heading: parsed.heading ?? undefined })
      void vscode.window.showWarningMessage(
        `双链目标不存在：[[${parsed.path}]]（已按当前工作区按需查找；不会自动创建文件）`,
      )
      return
    }
    let targetPath: string
    if (resolution.kind === 'ambiguous') {
      const candidates = [...resolution.fsPaths]
      pushLog({ kind: 'wikilink-ambiguous', target: parsed.path, candidates })
      if (process.env.VSIDIAN_TEST_HOOKS === '1') {
        return // 集成测试环境无法驱动 QuickPick：只记录候选（手感留 #15 人工验证）
      }
      const items = candidates.map((p) => ({
        label: vscode.workspace.asRelativePath(vscode.Uri.file(p), false),
        description: p,
        fsPath: p,
      }))
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `找到多个双链目标「${parsed.path}」，请选择要打开的笔记`,
      })
      if (!pick) {
        pushLog({ kind: 'wikilink-cancelled', target: parsed.path, candidates })
        return
      }
      targetPath = pick.fsPath
    } else {
      targetPath = resolution.fsPath
    }

    const targetUri = vscode.Uri.file(targetPath)
    const display = `[[${parsed.path}${parsed.heading !== null ? `#${parsed.heading}` : ''}]]`
    // 标题定位：先读目标内容算 offset（openTextDocument 只装载不显示）。
    // offset 是宿主系（getText 保留 \r\n）——text-editor 分支用 positionAt
    // 在宿主系内闭合不受影响；面板分支发 view.locate 前须转 LF 系（见下）
    let headingOffset: { offset: number; end: number } | null = null
    let headingMissing = false
    let headingDoc: vscode.TextDocument | undefined
    if (parsed.heading !== null) {
      headingDoc = await vscode.workspace.openTextDocument(targetUri)
      headingOffset = findHeadingOffset(headingDoc.getText(), parsed.heading)
      headingMissing = headingOffset === null
    }

    const targetEntry = sessions.get(targetUri.toString())
    // 日志先于打开动作（与 #10 executeLinkIntent 同口径）：文本编辑器打开会
    // 替换源面板（会话退场），事后无从观测
    pushLog({
      kind: 'wikilink-doc',
      target: parsed.path,
      path: targetPath,
      heading: parsed.heading ?? undefined,
      locate: headingOffset ? (targetEntry ? 'custom-panel' : 'text-editor') : 'none',
    })
    if (targetEntry) {
      // 目标已是本扩展面板：reveal 面板后 view.locate（reading 挂载定位路径）。
      // CRLF 目标：findHeadingOffset 是宿主系坐标（getText 保留 \r\n），而
      // webview 全程 LF 坐标——发送前经 newline 协调器转换，否则按 \r\n 行数漂移
      await vscode.commands.executeCommand('vscode.openWith', targetUri, VIEW_TYPE)
      const sessionId = await waitForReadyPanel(targetEntry)
      if (headingOffset && headingDoc && sessionId) {
        const lfOffset = new NewlineCoordinator(headingDoc.getText()).hostOffsetToLf(headingOffset.offset)
        targetEntry.session.postToPanel(sessionId, { kind: 'view.locate', offset: lfOffset })
      }
    } else {
      const targetDoc = await vscode.workspace.openTextDocument(targetUri)
      if (headingOffset) {
        const selection = new vscode.Range(
          targetDoc.positionAt(headingOffset.offset),
          targetDoc.positionAt(headingOffset.end),
        )
        await vscode.window.showTextDocument(targetDoc, { selection })
      } else {
        await vscode.window.showTextDocument(targetDoc)
      }
    }
    if (headingMissing) {
      void vscode.window.showWarningMessage(
        `已在目标文档中打开${display}，但未找到标题「${parsed.heading}」（标题匹配：trim + 空白折叠 + 大小写不敏感的 ATX 标题）`,
      )
    }
  }

  const provider: vscode.CustomTextEditorProvider = {
    resolveCustomTextEditor(document, webviewPanel, _token): void {
      const entry = openEntry(document)
      const send = (message: HostToWebview): void => {
        void webviewPanel.webview.postMessage(message)
      }
      // ---- #10 链接跳转与图片资源执行（面板端口注入；URI 解析在宿主侧） ----
      const linkCtx = linkContextOf(document)
      const openLink = (intent: { href: string; srcStart: number; srcEnd: number }): void => {
        void executeLinkIntent(document, linkCtx, intent, entry.linkLog)
      }
      // #11 双链跳转执行端口（按需 findFiles 解析 + 打开/定位/反馈）
      const openWikilink = (intent: { target: string; srcStart: number; srcEnd: number }): void => {
        void executeWikilinkIntent(document, intent, entry.linkLog)
      }
      const resolveImage = async (src: string): Promise<ImageResolution> => {
        return resolveWorkspaceImage(src, linkCtx, webviewPanel.webview)
      }
      const sessionId = entry.session.attachPanel({ send, openLink, openWikilink, resolveImage })
      entry.panels.set(sessionId, webviewPanel)

      const messageSub = webviewPanel.webview.onDidReceiveMessage((message) => {
        if (process.env.VSIDIAN_TEST_HOOKS === '1' && isWebviewToHost(message) &&
          message.kind === 'sync.test.close' && message.sessionId === sessionId &&
          message.docUri === document.uri.toString()) {
          webviewPanel.dispose()
          return
        }
        void entry.session.handleWebviewMessage(message, sessionId)
      })
      const closeSub = webviewPanel.onDidDispose(() => {
        entry.session.detachPanel(sessionId)
        entry.panels.delete(sessionId)
        messageSub.dispose()
        closeSub.dispose()
        releaseEntryIfIdle(document.uri)
      })

      webviewPanel.webview.options = {
        enableScripts: true,
        // C-7：显式收紧资源根到扩展产物与样式目录（脚本/CSS 均在其内），
        // 不留整个扩展目录的默认可读面；#10 增补图片资源根（工作区文件
        // 经夹带 asWebviewUri 的地址需在许可面内——口径与路径白名单一致）
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'out'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          imageResourceRoot(document),
        ],
      }
      webviewPanel.webview.html = buildWebviewHtml(webviewPanel.webview, context.extensionUri)
    },
  }

  // 权威文档变更入口：一切来源（本扩展写回、原生编辑器、其他扩展、
  // undo/redo）的变更都进入 session 识别与广播
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const entry = getEntry(event.document.uri)
      if (!entry) {
        return
      }
      entry.session.handleDocChanged(
        event.contentChanges.map((c) => ({
          offset: c.rangeOffset,
          length: c.rangeLength,
          text: c.text,
        })),
        event.document.version,
      )
    }),
  )

  // ---- 模式切换命令（#6）：活动 tab 为本扩展 custom editor 时向其面板
  // 发送 view.mode.set；模式是 webview 视图状态，不写 TextDocument ----
  context.subscriptions.push(
    vscode.commands.registerCommand('onegayi.vsidian.toggleViewMode', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab
      const input = tab?.input
      // 1.86 类型契约：custom editor 的 tab input 为 TabInputCustom（uri + viewType）
      if (
        input instanceof vscode.TabInputCustom &&
        input.viewType === VIEW_TYPE
      ) {
        const entry = getEntry(input.uri)
        const panels = entry?.session.getInfo().panels.filter((p) => p.ready) ?? []
        if (panels.length > 0) {
          for (const panel of panels) {
            entry!.session.postToPanel(panel.sessionId, {
              kind: 'view.mode.set',
              mode: 'toggle',
            })
          }
          return true
        }
      }
      await vscode.window.showWarningMessage(
        '请先聚焦一个 Vsidian 编辑器面板，再切换实时预览/阅读模式',
      )
      return false
    }),
  )

  // ---- 查找命令（#14）：活动 tab 为本扩展 custom editor 时向其面板发送
  // view.find.open（webview 内浮动查找面板）。查找是纯只读视图操作 ----
  context.subscriptions.push(
    vscode.commands.registerCommand('onegayi.vsidian.find', async () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab
      const input = tab?.input
      if (
        input instanceof vscode.TabInputCustom &&
        input.viewType === VIEW_TYPE
      ) {
        const entry = getEntry(input.uri)
        const panels = entry?.session.getInfo().panels.filter((p) => p.ready) ?? []
        if (panels.length > 0) {
          for (const panel of panels) {
            entry!.session.postToPanel(panel.sessionId, { kind: 'view.find.open' })
          }
          return true
        }
      }
      await vscode.window.showWarningMessage(
        '请先聚焦一个 Vsidian 编辑器面板，再使用编辑区查找',
      )
      return false
    }),
  )

  // ---- 表格结构命令（#13）：活动 tab 为本扩展 custom editor 时向其面板发送
  // table.command（webview 在光标处执行，走标准出站链路）。与模式切换/查找
  // 不同，这是写操作：只发活动面板（表格上下文在各面板光标处独立） ----
  const TABLE_COMMANDS: Array<[string, TableEditOp | 'create']> = [
    ['onegayi.vsidian.table.create', 'create'],
    ['onegayi.vsidian.table.insertRowAbove', 'insertRowAbove'],
    ['onegayi.vsidian.table.insertRowBelow', 'insertRowBelow'],
    ['onegayi.vsidian.table.deleteRow', 'deleteRow'],
    ['onegayi.vsidian.table.insertColumnLeft', 'insertColumnLeft'],
    ['onegayi.vsidian.table.insertColumnRight', 'insertColumnRight'],
    ['onegayi.vsidian.table.deleteColumn', 'deleteColumn'],
  ]
  for (const [command, op] of TABLE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, async (): Promise<boolean> => {
        // 遍历全部会话找活动面板（vscode 无全局「webview 面板焦点」句柄）
        for (const entry of sessions.values()) {
          for (const [sessionId, panel] of entry.panels) {
            if (panel.active && entry.session.getInfo().panels.some((p) => p.sessionId === sessionId && p.ready)) {
              // 阅读模式只读：命令在 webview 侧会被忽略（写操作仅 live 执行），
              // 静默丢弃后仍返回成功属虚报——按宿主缓存的模式给出可见反馈
              // （模式经 view.state 主动回报保持常新；无缓存时不拦截，面板
              // 默认 live）。不 await：命令无需用户选择，通知停留即可
              const viewMode = entry.session.getViewState(sessionId)?.viewMode
              if (viewMode === 'reading') {
                void vscode.window.showWarningMessage(
                  '阅读模式为只读视图：切换到实时预览后再执行表格操作',
                )
                return true
              }
              entry.session.postToPanel(sessionId, op === 'create'
                ? { kind: 'table.create' }
                : { kind: 'table.command', op })
              return true
            }
          }
        }
        await vscode.window.showWarningMessage(
          op === 'create'
            ? '请先聚焦一个 Vsidian 编辑器面板，再创建表格'
            : '请先聚焦一个 Vsidian 编辑器面板（光标置于表格内），再执行表格操作',
        )
        return false
      }),
    )
  }

  // ---- 测试钩子命令：仅集成测试经 runTest.mjs 注入 VSIDIAN_TEST_HOOKS=1 时
  // 注册（C-11），生产 VSIX 与常规 F5 开发不暴露 ----
  if (process.env.VSIDIAN_TEST_HOOKS === '1') {
    context.subscriptions.push(
    vscode.commands.registerCommand('onegayi.vsidian._test.getSessionState', (uriStr: string) => {
      const entry = getEntry(vscode.Uri.parse(uriStr))
      if (!entry) {
        return { found: false, panels: [], version: 0, appliedEdits: 0 }
      }
      return {
        found: true,
        panels: entry.session.getInfo().panels,
        version: entry.doc.version,
        appliedEdits: entry.appliedEdits,
      }
    }),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.injectWebviewMessage',
      async (uriStr: string, message: Record<string, unknown>, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panel = entry?.session.getInfo().panels[panelIndex]
        if (!entry || !panel) {
          throw new Error(`无可用会话面板：${uriStr}`)
        }
        // 测试注入的消息与真实 webview 消息走同一校验与处理入口；
        // sessionId 由钩子按目标面板填充
        await entry.session.handleWebviewMessage(
          { ...message, sessionId: panel.sessionId },
          panel.sessionId,
        )
      },
    ),
    vscode.commands.registerCommand(
      // 宿主 → webview 方向的消息注入钩子：与 injectWebviewMessage（webview →
      // 宿主）对称，供集成测试驱动 view.mode.set / view.locate 等正式消息
      'onegayi.vsidian._test.postToPanel',
      async (uriStr: string, message: Record<string, unknown>, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panels = entry?.session.getInfo().panels.filter((p) => p.ready) ?? []
        const panel = panels[panelIndex]
        if (!entry || !panel) {
          throw new Error(`无可用会话面板：${uriStr}`)
        }
        entry.session.postToPanel(panel.sessionId, message as HostToWebview)
        return true
      },
    ),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.getConflictState',
      (uriStr: string, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panel = entry?.session.getInfo().panels[panelIndex]
        if (!entry || !panel) {
          return { found: false }
        }
        return { found: true, sessionId: panel.sessionId, ...entry.session.getConflictState(panel.sessionId) }
      },
    ),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.getLastClosedInput',
      () => lastClosedInput,
    ),
    vscode.commands.registerCommand(
      // 宿主缓存的 view.state（模式主动回报的观测面）：断言宿主侧写命令
      // 拦截所依据的 viewMode 缓存已就位/常新
      'onegayi.vsidian._test.getPanelViewStateCache',
      (uriStr: string, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panel = entry?.session.getInfo().panels[panelIndex]
        if (!entry || !panel) {
          return { found: false }
        }
        const cached = entry.session.getViewState(panel.sessionId)
        return { found: cached !== undefined, viewMode: cached?.viewMode }
      },
    ),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.getCachedViewState',
      (uriStr: string, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panel = entry?.session.getInfo().panels[panelIndex]
        return panel ? entry?.session.getViewState(panel.sessionId) : undefined
      },
    ),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.resumePanel',
      (uriStr: string, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panel = entry?.session.getInfo().panels[panelIndex]
        if (!entry || !panel) {
          return false
        }
        return entry.session.resumePanel(panel.sessionId)
      },
    ),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.requestViewState',
      async (uriStr: string, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panels = entry?.session.getInfo().panels.filter((p) => p.ready) ?? []
        const panel = panels[panelIndex]
        if (!entry || !panel) {
          return undefined
        }
        const before = entry.session.getViewState(panel.sessionId)
        entry.session.postToPanel(panel.sessionId, { kind: 'view.state.request' })
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const state = entry.session.getViewState(panel.sessionId)
          if (state && state !== before) {
            return state
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return entry.session.getViewState(panel.sessionId)
      },
    ),
    vscode.commands.registerCommand(
      'onegayi.vsidian._test.perfProbe',
      async (
        uriStr: string,
        options: { typingRounds: number; scrollRounds: number },
        panelIndex = 0,
      ) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panels = entry?.session.getInfo().panels.filter((p) => p.ready) ?? []
        const panel = panels[panelIndex]
        if (!entry || !panel) {
          return undefined
        }
        // 首次探针可能发生在上一报告之后：先记录旧值，轮询到新报告
        const before = entry.session.getLastPerfReport(panel.sessionId)
        entry.session.postToPanel(panel.sessionId, {
          kind: 'perf.probe',
          typingRounds: options.typingRounds,
          scrollRounds: options.scrollRounds,
        })
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const report = entry.session.getLastPerfReport(panel.sessionId)
          if (report && report !== before) {
            return report
          }
          await new Promise((r) => setTimeout(r, 200))
        }
        return entry.session.getLastPerfReport(panel.sessionId)
      },
    ),
    vscode.commands.registerCommand(
      // 阅读视图性能探针（#7）：与 perfProbe 同构的轮询通道
      'onegayi.vsidian._test.readingPerf',
      async (uriStr: string, options: { scrollRounds: number }, panelIndex = 0) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const panels = entry?.session.getInfo().panels.filter((p) => p.ready) ?? []
        const panel = panels[panelIndex]
        if (!entry || !panel) {
          return undefined
        }
        const before = entry.session.getLastReadingPerfReport(panel.sessionId)
        entry.session.postToPanel(panel.sessionId, {
          kind: 'reading.perf',
          scrollRounds: options.scrollRounds,
        })
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const report = entry.session.getLastReadingPerfReport(panel.sessionId)
          if (report && report !== before) {
            return report
          }
          await new Promise((r) => setTimeout(r, 200))
        }
        return entry.session.getLastReadingPerfReport(panel.sessionId)
      },
    ),
    vscode.commands.registerCommand(
      // 链接跳转执行日志（#10）：集成测试经注入 link.observe 消息断言宿主
      // 收到的意图与处置（external/blocked/doc/not-found）
      'onegayi.vsidian._test.getLinkLog',
      (uriStr: string) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        return { found: !!entry, log: entry ? [...entry.linkLog] : [] }
      },
    ),
    )
  }

  return provider
}

/** blocked 链接的用户可见反馈文案（拦截不静默——验收标准要求） */
function blockedLinkMessage(
  target: Extract<ReturnType<typeof classifyLinkTarget>, { kind: 'blocked' }>,
): string {
  switch (target.reason) {
    case 'empty':
      return `链接目标为空（空白或仅锚点）：本期不支持页内锚点定位`
    case 'scheme':
      return `不允许打开的链接协议「${target.scheme || '//'}」：仅支持 http/https 与工作区内路径`
    case 'escape':
      return `链接指向工作区之外，已拦截：${target.detail ?? ''}`
    case 'windows-drive-on-posix':
      return `远程（POSIX）工作区不支持 Windows 盘符路径链接`
  }
}

/**
 * 链接跳转意图执行（#10）：分类 → external 经 env.openExternal 外开；
 * doc 按候选探测存在性（精确优先、无扩展名补 .md）后以文本编辑器打开；
 * blocked/not-found 给用户可见反馈。全程只读：不触碰 TextDocument。
 */
async function executeLinkIntent(
  document: vscode.TextDocument,
  ctx: LinkContext,
  intent: { href: string; srcStart: number; srcEnd: number },
  log: Array<LinkLogEntry | WikilinkLogEntry>,
): Promise<void> {
  const pushLog = (entry: LinkLogEntry): void => {
    log.push(entry)
    while (log.length > 64) {
      log.shift()
    }
  }
  const target = classifyLinkTarget(intent.href, ctx)
  if (target.kind === 'external') {
    pushLog({ kind: 'external', href: intent.href })
    if (process.env.VSIDIAN_TEST_HOOKS === '1') {
      // 集成测试环境不真开系统浏览器（CI 无浏览器且产生噪声）；
      // 分类正确性已由单测钉死，真实外开留给人工验收（#15）
      return
    }
    const ok = await vscode.env.openExternal(vscode.Uri.parse(target.url))
    if (!ok) {
      void vscode.window.showWarningMessage(`无法打开外部链接：${target.url}`)
    }
    return
  }
  if (target.kind === 'blocked') {
    pushLog({ kind: 'blocked', href: intent.href, reason: target.reason, scheme: target.scheme })
    void vscode.window.showWarningMessage(blockedLinkMessage(target))
    return
  }
  for (const fsPath of target.candidates) {
    const uri = vscode.Uri.file(fsPath)
    try {
      await vscode.workspace.fs.stat(uri)
    } catch {
      continue
    }
    pushLog({ kind: 'doc', href: intent.href, path: fsPath })
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc)
    return
  }
  pushLog({ kind: 'not-found', href: intent.href })
  void vscode.window.showWarningMessage(
    `链接目标不存在：${intent.href}（已按相对当前文档目录解析）`,
  )
  void document // 意图源自本文档；名称留给后续 #11 锚点定位使用
}

/**
 * 工作区图片解析（#10）：白名单分类 → 存在性探测 → asWebviewUri 转为
 * webview 可加载地址。本地与远程（SSH）工作区同通道——webview 资源服务
 * 按远程权威路由（真实远程宿主表现属 #15 人工验证项）。
 */
async function resolveWorkspaceImage(
  src: string,
  ctx: LinkContext,
  webview: vscode.Webview,
): Promise<ImageResolution> {
  const target = classifyImageTarget(src, ctx)
  if (target.kind === 'blocked') {
    return {
      ok: false,
      reason: imageBlockReasonOf(target),
      detail: target.scheme ?? target.detail,
    }
  }
  const uri = vscode.Uri.file(target.fsPath)
  try {
    await vscode.workspace.fs.stat(uri)
  } catch {
    return { ok: false, reason: 'not-found', detail: target.fsPath }
  }
  return { ok: true, src: webview.asWebviewUri(uri).toString() }
}

function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomUUID()
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.js'),
  )
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'main.css'),
  )
  // 稳定样式契约内部测试片段（#6）：验证外部样式表可经稳定类名/变量
  // 定位两种视图；一期不提供用户 CSS 加载（见 docs/design/obsidian-selector-map.md）
  const probeCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'css-contract-probe.css'),
  )
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https:`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<link href="${probeCssUri}" rel="stylesheet">
<title>Vsidian</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
