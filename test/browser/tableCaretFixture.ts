// 原生浏览器输入回归：装配生产 webview 控制器，输入只由浏览器键盘/IME 发起。
import { WebviewSyncController } from '../../src/webview/syncController'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({ postMessage() {}, getState() {}, setState() {} })
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])
Object.assign(window, { initTable(text: string) {
  controller.handleHostMessage({ kind: 'init', sessionId: 'native-input',
    docUri: 'file:///table.md', version: 1, text })
}, readEditor() {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
  const head = view.state.selection.main.head
  return { text: view.state.doc.toString(), head, from: view.state.selection.main.from,
    to: view.state.selection.main.to, line: view.state.doc.lineAt(head).number }
}, controller })
