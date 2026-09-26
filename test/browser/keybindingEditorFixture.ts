import { WebviewSyncController } from '../../src/webview/syncController'
import { EditorView } from '@codemirror/view'
import type { WebviewToHost } from '../../src/shared/protocol'
import '../../src/webview/main.css'

const messages: unknown[] = []
let forwarded = 0
const controller = new WebviewSyncController({
  postMessage(message: WebviewToHost) {
    messages.push(message)
    if (message.kind === 'keybindings.execute') {
      if (message.id === 'find') controller.handleHostMessage({ kind: 'view.find.open' })
      else if (message.id === 'findNext' || message.id === 'findPrevious')
        controller.handleHostMessage({ kind: 'view.find.step',
          direction: message.id === 'findNext' ? 'next' : 'prev' })
      else controller.handleHostMessage({ kind: 'format.command', op: message.id as 'bold' })
    }
  },
  getState() { return undefined }, setState() {},
})
controller.mount(document.getElementById('app')!)
window.addEventListener('keydown', (event) => {
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) forwarded++
})
Object.assign(window, {
  initKeys(text: string) {
    controller.handleHostMessage({ kind: 'init', sessionId: 'keyboard-browser',
      docUri: 'file:///keyboard.md', version: 1, text })
  },
  updateKeys(overrides: Record<string, string[]>) {
    controller.handleHostMessage({ kind: 'keybindings.changed', overrides })
  },
  setMode(mode: 'live' | 'reading') {
    controller.handleHostMessage({ kind: 'view.mode.set', mode })
  },
  keyState() {
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
    return { text: view.state.doc.toString(), messages, forwarded,
      findOpen: document.querySelector('.vsidian-find')?.classList.contains('vsidian-find-open') }
  },
})
