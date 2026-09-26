// 原生浏览器折叠回归（#67）：装配生产 webview 控制器，滑块点击/拖拽、
// 箭头折叠、滚动动态展开与编辑存活由真实输入与真实布局验证——jsdom 无
// 布局测不了的串珠绘制（computed 背景两态）、display:none 折叠、
// scrollIntoView 可视区滚动在此落地。
import { WebviewSyncController } from '../../src/webview/syncController'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({ postMessage() {}, getState() { return undefined }, setState() {} })
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])

/** 大纲面板观测（断言用户看到的东西：折叠隐藏、active 圆点 computed
 *  背景、高亮行与面板可视区的几何关系） */
function readOutline() {
  const panel = document.querySelector<HTMLElement>('.vsidian-outline-panel')!
  const items = [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
  const dots = [...document.querySelectorAll<HTMLButtonElement>('.vsidian-outline-slider-dot')]
  const activeDot = dots.find((d) => d.classList.contains('vsidian-outline-slider-active'))
  const located = items.find((el) => el.classList.contains('vsidian-outline-located')) ?? null
  const visibleRect = (el: HTMLElement | null) => {
    if (!el) return null
    const p = panel.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { within: r.top >= p.top - 0.5 && r.bottom <= p.bottom + 0.5, top: r.top, bottom: r.bottom, panelTop: p.top, panelBottom: p.bottom }
  }
  return {
    panel,
    items,
    dots,
    texts: items.map((el) => el.textContent ?? ''),
    hidden: items.map((el) => getComputedStyle(el).display === 'none'),
    expandLevel: activeDot ? Number(activeDot.dataset['vsidianLevel']) : -1,
    locatedText: located?.textContent ?? null,
    locatedVisibleInPanel: visibleRect(located)?.within ?? null,
    dotBg: (n: number) => getComputedStyle(dots[n]!).backgroundColor,
    chevronCount: panel.querySelectorAll('.vsidian-outline-chevron').length,
    /** #99 层级对齐引导线观测（itemIndex 行的第 guideIndex 条线；null =
     *  该行无此序号的线）。断言用户看到的东西：computed 背景非全透明
     *  （样式失效时无线可捕获）、1px 宽；visible 用 offsetParent 判定
     *  （display 不继承，祖先 display:none 子树内的 computed display 仍
     *  为 block，但 offsetParent 为 null——不参与布局即不可见） */
    guideOf: (itemIndex: number, guideIndex: number) => {
      const guides = items[itemIndex]!.querySelectorAll<HTMLElement>('.vsidian-outline-guide')
      const guide = guides[guideIndex]
      if (!guide) return null
      const cs = getComputedStyle(guide)
      return { bg: cs.backgroundColor, display: cs.display, width: cs.width, left: guide.style.left,
        visible: guide.offsetParent !== null }
    },
    /** #99 能量条填充条宽度（::after computed，px；样式失效时为 0） */
    fillPx: () => {
      const slider = document.querySelector<HTMLElement>('.vsidian-outline-slider')
      return slider ? Number.parseFloat(getComputedStyle(slider, '::after').width) : 0
    },
    /** 轨道全长（row 内容宽 - 两端让位 30px×2 = padding 24px + 珠半径
     *  6px；填充条宽度的换算基数，#99 加粗珠 12px 后同步） */
    trackPx: () => {
      const slider = document.querySelector<HTMLElement>('.vsidian-outline-slider')
      return slider ? slider.clientWidth - 60 : 0
    },
  }
}

Object.assign(window, {
  initOutline(text: string) {
    controller.handleHostMessage({
      kind: 'init', sessionId: 'outline-collapse', docUri: 'file:///outline.md',
      version: 1, text,
    })
  },
  controller,
  readOutline,
  /** 直接触发条目点击/箭头点击/选档的宿主消息通道（与真实点击同一委托） */
  post(msg: Record<string, unknown>) {
    controller.handleHostMessage(msg)
  },
  /** 在文档末尾追加文本（编辑触发 250ms 去抖重建 + 折叠迁移的真实链路） */
  appendText(text: string) {
    const view = controller.getView()!
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
    return view.state.doc.toString()
  },
  /** 替换首个匹配文字（重命名触发迁移） */
  replaceText(search: string, replacement: string) {
    const view = controller.getView()!
    const from = view.state.doc.toString().indexOf(search)
    if (from < 0) return null
    view.dispatch({ changes: { from, to: from + search.length, insert: replacement } })
    return view.state.doc.toString()
  },
})
