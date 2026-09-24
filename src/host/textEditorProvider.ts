// CustomTextEditorProvider 实现与文档会话注册表。
//
// 选择 CustomTextEditorProvider（而非 CustomEditorProvider）：保存、dirty、
// Hot Exit 全部由 VSCode 标准文本管线自动处理，扩展只需实现
// resolveCustomTextEditor（探索笔记 02 §1）。
// 权威文本为 TextDocument；webview 编辑经 DocumentSession 校验后以
// WorkspaceEdit 写回；文档事件回流经 session 识别自家确认与外部变更。
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { DocumentSession, type HostDocumentPort, type SessionNotice } from './documentSession'
import type { HostToWebview, SerChange } from '../shared/protocol'

export const VIEW_TYPE = 'onegayi.obsidian-like-markdown-editor'

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

interface SessionEntry {
  session: DocumentSession
  doc: vscode.TextDocument
  /** 面板发送通道（测试钩子 requestViewState 复用） */
  sends: Map<string, (message: HostToWebview) => void>
  appliedEdits: number
}

export function createTextEditorProvider(
  context: vscode.ExtensionContext,
): vscode.CustomTextEditorProvider {
  const sessions = new Map<string, SessionEntry>()

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
    // 输入仍在宿主快照中——提示取回，不得误报已保存
    const preview = notice.fragments.join('\n')
    void vscode.window
      .showWarningMessage(
        `“${name}”的编辑器已关闭（或连接断开），存在未保存的未确认输入：${preview.slice(0, 120)}`,
        '复制未确认输入',
      )
      .then((pick) => {
        if (pick === '复制未确认输入') {
          const state = sessions.get(uriStr)?.session.getConflictState(notice.sessionId)
          void vscode.env.clipboard.writeText(
            state?.fragments.join('\n') ?? notice.fragments.join('\n'),
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
    const fresh: SessionEntry = { session: undefined as never, doc, sends: new Map(), appliedEdits: 0 }
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

  const provider: vscode.CustomTextEditorProvider = {
    resolveCustomTextEditor(document, webviewPanel, _token): void {
      const entry = openEntry(document)
      const send = (message: HostToWebview): void => {
        void webviewPanel.webview.postMessage(message)
      }
      const sessionId = entry.session.attachPanel({ send })
      entry.sends.set(sessionId, send)

      const messageSub = webviewPanel.webview.onDidReceiveMessage((message) => {
        void entry.session.handleWebviewMessage(message, sessionId)
      })
      const closeSub = webviewPanel.onDidDispose(() => {
        entry.session.detachPanel(sessionId)
        entry.sends.delete(sessionId)
        messageSub.dispose()
        closeSub.dispose()
        releaseEntryIfIdle(document.uri)
      })

      webviewPanel.webview.options = {
        enableScripts: true,
        // C-7：显式收紧资源根到扩展产物与样式目录（脚本/CSS 均在其内），
        // 不留整个扩展目录的默认可读面
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'out'),
          vscode.Uri.joinPath(context.extensionUri, 'media'),
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
    vscode.commands.registerCommand('onegayi.obsidian-like-editor.toggleViewMode', async () => {
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
        '请先聚焦一个 Obsidian-like Markdown Editor 编辑器面板，再切换实时预览/阅读模式',
      )
      return false
    }),
  )

  // ---- 测试钩子命令：仅集成测试经 runTest.mjs 注入 OILE_TEST_HOOKS=1 时
  // 注册（C-11），生产 VSIX 与常规 F5 开发不暴露 ----
  if (process.env.OILE_TEST_HOOKS === '1') {
    context.subscriptions.push(
    vscode.commands.registerCommand('onegayi.obsidian-like-editor._test.getSessionState', (uriStr: string) => {
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
      'onegayi.obsidian-like-editor._test.injectWebviewMessage',
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
      'onegayi.obsidian-like-editor._test.postToPanel',
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
      'onegayi.obsidian-like-editor._test.getConflictState',
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
      'onegayi.obsidian-like-editor._test.resumePanel',
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
      'onegayi.obsidian-like-editor._test.requestViewState',
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
      'onegayi.obsidian-like-editor._test.perfProbe',
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
      'onegayi.obsidian-like-editor._test.readingPerf',
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
    )
  }

  return provider
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
<title>Obsidian-like Markdown Editor</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
