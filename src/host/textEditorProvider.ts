// CustomTextEditorProvider 实现与文档会话注册表。
//
// 选择 CustomTextEditorProvider（而非 CustomEditorProvider）：保存、dirty、
// Hot Exit 全部由 VSCode 标准文本管线自动处理，扩展只需实现
// resolveCustomTextEditor（探索笔记 02 §1）。
// 权威文本为 TextDocument；webview 编辑经 DocumentSession 校验后以
// WorkspaceEdit 写回；文档事件回流经 session 识别自家确认与外部变更。
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { DocumentSession, type HostDocumentPort } from './documentSession'
import type { HostToWebview, SerChange } from '../shared/protocol'

export const VIEW_TYPE = 'onegayi.obsidian-like-markdown-editor'

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
      // 变更经 onDidChangeTextDocument 回流广播，不经过 applyEdit（无回声）
      undo: () => Promise.resolve(vscode.commands.executeCommand('undo')).then(() => true, () => false),
      redo: () => Promise.resolve(vscode.commands.executeCommand('redo')).then(() => true, () => false),
    }
    fresh.session = new DocumentSession(port, { docUri: key })
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

      webviewPanel.webview.options = { enableScripts: true }
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

  // ---- 测试钩子命令：仅用于集成测试观测与注入，生产无副作用 ----
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
      async (uriStr: string, message: Record<string, unknown>) => {
        const entry = getEntry(vscode.Uri.parse(uriStr))
        const firstPanel = entry?.session.getInfo().panels[0]
        if (!entry || !firstPanel) {
          throw new Error(`无可用会话面板：${uriStr}`)
        }
        // 测试注入的消息与真实 webview 消息走同一校验与处理入口；
        // sessionId 由钩子按目标面板填充
        await entry.session.handleWebviewMessage(
          { ...message, sessionId: firstPanel.sessionId },
          firstPanel.sessionId,
        )
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
  )

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
<title>Obsidian-like Markdown Editor</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
