// 原生浏览器右键菜单回归（#69）：装配生产 webview 控制器，真实右键点击、
// hover 级联、键盘 Esc/Enter 由真实输入与真实布局验证——jsdom 无布局测不
// 了的菜单浮层定位（不遮挡目标、右缘 clamp）、子菜单 :hover 展开、重命名
// 真实键盘链路在此落地。
import { WebviewSyncController } from '../../src/webview/syncController'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({
  postMessage(msg: unknown) {
    sent.push(msg as { kind: string })
  },
  getState() {
    return undefined
  },
  setState() {},
})
const sent: Array<{ kind: string; [k: string]: unknown }> = []
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])

/** 菜单观测（断言用户看到的东西：浮层几何、子菜单显隐、编辑态与文本）。
 *  注意：返回值经 Playwright evaluate 跨边界序列化——只含标量与可克隆
 *  结构，不得携带 DOM 元素（元素会被序列化成空对象，字段全 undefined） */
function readMenu() {
  const sidebar = document.querySelector<HTMLElement>('.vsidian-sidebar')!
  const menu = sidebar.querySelector<HTMLElement>('.vsidian-outline-menu')
  const input = document.querySelector<HTMLInputElement>('.vsidian-outline-rename-input')
  const rect = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null)
  return {
    menuExists: !!menu,
    menuRect: rect(menu),
    sidebarRect: sidebar.getBoundingClientRect(),
    inputExists: !!input,
    inputValue: input ? input.value : null,
    inputRect: rect(input),
    /** 任一级联子菜单 computed display（'none' = 未展开） */
    submenuDisplay: menu
      ? Array.from(menu.querySelectorAll<HTMLElement>('.vsidian-outline-menu-submenu'))
          .map((el) => getComputedStyle(el).display)
      : [],
    /** 全部菜单命令按钮（含子菜单内的叶子命令） */
    commands: menu
      ? Array.from(menu.querySelectorAll<HTMLButtonElement>('button[data-vsidian-command]'))
          .map((b) => b.dataset['vsidianCommand'] ?? '')
      : [],
    /** 视图当前文本（写回对拍） */
    text: controller.getView()!.state.doc.toString(),
  }
}

Object.assign(window, {
  initMenu(text: string) {
    controller.handleHostMessage({
      kind: 'init', sessionId: 'outline-menu', docUri: 'file:///d%3A/notes/menu.md',
      version: 1, text,
    })
  },
  controller,
  readMenu,
  /** 宿主消息通道（测试钩子与真实点击同一委托） */
  post(msg: Record<string, unknown>) {
    controller.handleHostMessage(msg)
  },
  /** 出站消息（剪贴板桥观测） */
  sent: () => sent,
})
