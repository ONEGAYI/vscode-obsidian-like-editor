// 原生浏览器输入回归（#119 列表/引用键位）：装配生产 webview 控制器，
// Enter/Backspace 只由浏览器键盘发起。光标定位经 view.locate 消息走
// 生产链路；KaTeX 样式与生产 webview 同源引入（同 tableCaretFixture）。
import 'katex/dist/katex.min.css'
import { WebviewSyncController } from '../../src/webview/syncController'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({
  postMessage(message) {
    ;(window as unknown as Record<string, unknown>)['__lastHostMessage'] = message
  },
  getState() {
    return undefined
  },
  setState() {},
})
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])
Object.assign(window, {
  initDoc(text: string) {
    controller.handleHostMessage({ kind: 'init', sessionId: 'list-editing',
      docUri: 'file:///list.md', version: 1, text })
  },
  locate(offset: number) {
    controller.handleHostMessage({ kind: 'view.locate', offset })
  },
  readEditor() {
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
    const head = view.state.selection.main.head
    return { text: view.state.doc.toString(), head, from: view.state.selection.main.from,
      to: view.state.selection.main.to }
  },
})
