// 原生浏览器点击回归（#66）：装配生产 webview 控制器，点击与滚动由浏览器
// 真实输入发起（Playwright locator.click / mouse.wheel），验证大纲点击跳转
// 与常驻高亮在真实布局下的行为。
import { WebviewSyncController } from '../../src/webview/syncController'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({ postMessage() {}, getState() {}, setState() {} })
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])
Object.assign(window, {
  initOutline(text: string) {
    controller.handleHostMessage({
      kind: 'init', sessionId: 'outline-jump', docUri: 'file:///outline.md',
      version: 1, text,
    })
  },
  controller,
  readCaret() {
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor')!)!
    const head = view.state.selection.main.head
    return { head, line: view.state.doc.lineAt(head).number, text: view.state.doc.toString() }
  },
  /** 大纲面板观测（断言用户可见的东西：located 类、computed 背景、
   *  条目文本序列；不做 DOM 存在性以外的几何断言） */
  readOutline() {
    const items = [...document.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
    return {
      count: items.length,
      texts: items.map((el) => el.textContent ?? ''),
      locatedIndex: items.findIndex((el) => el.classList.contains('vsidian-outline-located')),
      locatedBackground: (() => {
        const el = items.find((e) => e.classList.contains('vsidian-outline-located'))
        if (!el) return null
        return getComputedStyle(el).backgroundColor
      })(),
    }
  },
})
