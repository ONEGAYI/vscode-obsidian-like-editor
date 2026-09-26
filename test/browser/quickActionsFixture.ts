import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { WebviewSyncController } from '../../src/webview/syncController'
import '../../src/webview/main.css'

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
