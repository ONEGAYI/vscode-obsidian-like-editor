// 原生浏览器悬停回归（#99）：装配生产 webview 控制器，光标形态与悬停
// 高亮由真实布局验证——jsdom 无布局测不了的 :hover 伪类着色、color-mix
// 浅一档色阶、located 优先不叠加在此落地。
import { WebviewSyncController } from '../../src/webview/syncController'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({ postMessage() {}, getState() { return undefined }, setState() {} })
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])

/** 大纲面板观测（断言用户看到的东西：条目 computed 背景与光标形态；
 *  悬停态由 Playwright locator.hover 真实驱动，不做类名存在性断言） */
function readOutline() {
  const items = [...document.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
  return {
    count: items.length,
    texts: items.map((el) => el.textContent ?? ''),
    locatedIndex: items.findIndex((el) => el.classList.contains('vsidian-outline-located')),
    bg: (n: number) => getComputedStyle(items[n]!).backgroundColor,
    cursor: (n: number) => getComputedStyle(items[n]!).cursor,
  }
}

Object.assign(window, {
  initOutline(text: string) {
    controller.handleHostMessage({
      kind: 'init', sessionId: 'outline-hover', docUri: 'file:///outline.md',
      version: 1, text,
    })
  },
  controller,
  readOutline,
})
