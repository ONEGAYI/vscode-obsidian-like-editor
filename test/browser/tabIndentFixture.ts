// 原生浏览器输入回归（#120 Tab/Shift+Tab 通用缩进）：装配生产 webview
// 控制器（缩进处理器经 extensions() 进入，位于 tableEditing 之后），按键
// 只由浏览器键盘发起。光标定位经 view.locate 消息走生产链路（与
// listEditingFixture 同口径）。
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
    controller.handleHostMessage({ kind: 'init', sessionId: 'tab-indent',
      docUri: 'file:///indent.md', version: 1, text })
  },
  locate(offset: number) {
    controller.handleHostMessage({ kind: 'view.locate', offset })
  },
  /** 选区定位（生产消息无选区形态，经视图直设模拟拖选后的状态） */
  selectRange(from: number, to: number) {
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
    view.dispatch({ selection: { anchor: from, head: to } })
  },
  readEditor() {
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
    const main = view.state.selection.main
    return { text: view.state.doc.toString(), head: main.head, from: main.from,
      to: main.to }
  },
})
