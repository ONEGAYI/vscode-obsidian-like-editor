// 原生浏览器搜索回归（#68）：装配生产 webview 控制器，工具条三控件、
// 真实键盘输入的搜索过滤与片段高亮（computed 背景的 mark）、无匹配占位、
// 清空回放、重置三合一与跳转到末尾的双模式滚动由真实输入与真实布局验证
// ——jsdom 无布局测不了的工具条绘制、display:none 过滤、滚动到底在此落地。
import { WebviewSyncController } from '../../src/webview/syncController'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { bootLocaleFromDocument } from '../../src/webview/localeBoot'
import '../../src/webview/main.css'

// #94：harness 页面注入语言数据岛，boot 与生产首帧同路径（无岛取词回退键名）
bootLocaleFromDocument()
const controller = new WebviewSyncController({ postMessage() {}, getState() { return undefined }, setState() {} })
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])

/** 大纲搜索观测（断言用户看到的东西：过滤隐藏、mark 绘制、工具条布局）。
 *  返回纯数据（DOM 元素与函数引用不可跨 evaluate 序列化；元素操作走
 *  locator，动态字段由专用的 readSearchMarks 等按需在 evaluate 内求值） */
function readSearch() {
  const sidebar = document.querySelector<HTMLElement>('.vsidian-sidebar')!
  const panel = sidebar.querySelector<HTMLElement>('.vsidian-outline-panel')!
  const items = [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
  const toolbar = sidebar.querySelector<HTMLElement>('.vsidian-outline-toolbar')!
  const search = toolbar.querySelector<HTMLInputElement>('.vsidian-outline-search')!
  const jumpBottom = toolbar.querySelector<HTMLButtonElement>('.vsidian-outline-jump-bottom')!
  const reset = toolbar.querySelector<HTMLButtonElement>('.vsidian-outline-reset')!
  return {
    hidden: items.map((el) => getComputedStyle(el).display === 'none'),
    toolbarDisplay: getComputedStyle(toolbar).display,
    toolbarHeightPx: toolbar.getBoundingClientRect().height,
    placeholder: search.getAttribute('placeholder'),
    searchValue: search.value,
    jumpBottomAria: jumpBottom.getAttribute('aria-label'),
    resetAria: reset.getAttribute('aria-label'),
  }
}

/** 动态字段（输入/命中随交互变化）：单独在 evaluate 内求值 */
function readSearchMarks() {
  const panel = document.querySelector<HTMLElement>('.vsidian-outline-panel')!
  const marks = [...panel.querySelectorAll<HTMLElement>(
    '.vsidian-outline-item:not(.vsidian-outline-hidden) mark.vsidian-outline-search-hit')]
  return {
    count: marks.length,
    texts: marks.map((el) => el.textContent ?? ''),
    firstBg: marks[0] ? getComputedStyle(marks[0]).backgroundColor : null,
    nomatchText: panel.querySelector<HTMLElement>('.vsidian-outline-nomatch')?.textContent ?? null,
  }
}

/** 正文滚动观测（live 与 reading 双模式的滚动到底证据） */
function readScroll() {
  const liveScroller = document.querySelector<HTMLElement>('.cm-scroller')
  const reading = document.querySelector<HTMLElement>('.vsidian-view-reading')
  const el = reading && getComputedStyle(reading).display !== 'none' ? reading : liveScroller
  if (!el) return null
  return {
    mode: el === reading ? 'reading' : 'live',
    top: el.scrollTop,
    height: el.scrollHeight,
    view: el.clientHeight,
    atBottom: el.scrollTop >= el.scrollHeight - el.clientHeight - 1,
  }
}

Object.assign(window, {
  initOutline(text: string) {
    controller.handleHostMessage({
      kind: 'init', sessionId: 'outline-search', docUri: 'file:///outline-search.md',
      version: 1, text,
    })
  },
  controller,
  readSearch,
  readSearchMarks,
  readScroll,
  post(msg: Record<string, unknown>) {
    controller.handleHostMessage(msg)
  },
})
