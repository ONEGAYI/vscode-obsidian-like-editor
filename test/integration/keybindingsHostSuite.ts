// 独立桌面 CDP 探针的最小真宿主伴随套件：打开 fixture 并等待外部键盘驱动。
import * as vscode from 'vscode'
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export async function run(): Promise<void> {
  const directory = process.env['WORKSPACE_DIR']!
  const uri = vscode.Uri.file(path.join(directory, 'keyboard.md'))
  await vscode.commands.executeCommand('vscode.openWith', uri, 'onegayi.vsidian.editor')
  const extension = vscode.extensions.getExtension('onegayi.vsidian')
  if (extension && !extension.isActive) await extension.activate()
  const doc = await vscode.workspace.openTextDocument(uri)
  writeFileSync(path.join(directory, 'ready'), '')
  const done = path.join(directory, 'done')
  const request = path.join(directory, 'request.json')
  for (let i = 0; i < 300 && !existsSync(done); i++) {
    if (existsSync(request)) {
      const message = JSON.parse(readFileSync(request, 'utf8')) as {
        id: number; action: string; operationId?: string; bindings?: string[]; text?: string
      }
      unlinkSync(request)
      let result: unknown
      if (message.action === 'set') result = await vscode.commands.executeCommand(
        'onegayi.vsidian._test.setKeybindings', message.operationId, message.bindings, false)
      if (message.action === 'resetAll') result = await vscode.commands.executeCommand(
        'onegayi.vsidian._test.resetKeybindings')
      if (message.action === 'text') result = doc.getText()
      if (message.action === 'mode') result = await vscode.commands.executeCommand(
        'onegayi.vsidian._test.postToPanel', uri.toString(),
        { kind: 'view.mode.set', mode: message.text })
      if (message.action === 'replaceText') {
        const edit = new vscode.WorkspaceEdit()
        edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), message.text ?? '')
        result = await vscode.workspace.applyEdit(edit)
      }
      writeFileSync(path.join(directory, `response-${message.id}.json`), JSON.stringify(result))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!existsSync(done)) throw new Error('CDP 探针超时')
  writeFileSync(path.join(directory, 'result'), doc.getText())
}
