import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { WebviewSyncController } from '../../src/webview/syncController'
import { bootLocaleFromDocument } from '../../src/webview/localeBoot'
import '../../src/webview/main.css'

// #94：harness 页面注入语言数据岛，boot 与生产首帧同路径（无岛取词回退键名）
bootLocaleFromDocument()
let saved: unknown
const sent: unknown[] = []
const controller = new WebviewSyncController({
  postMessage(message) { sent.push(message) },
  getState<T>() { return saved as T | undefined },
  setState(state) { saved = state },
})
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])
Object.assign(window, {
  controller,
  initQuick(text: string) {
    controller.handleHostMessage({ kind: 'init', sessionId: 'quick', docUri: 'file:///quick.md', version: 1, text })
  },
  quickText() { return controller.getView()!.state.doc.toString() },
  quickSent() { return sent },
})
