// 原生浏览器拖拽回归装配（#70）：生产 webview 控制器 + 真实布局，真实鼠标
// （mouse.down/move/up）驱动拖拽链路——jsdom 无布局测不了的三态落点容差
// 几何、落点指示真实绘制（dropHintPainted）、真实 pointer 事件序列在此落地。
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

/** 拖拽观测（断言用户看到的东西：指示类、probe 拖拽态、文档文本）。
 *  返回值经 Playwright evaluate 跨边界序列化——只含标量与可克隆结构 */
function readDrag() {
  const panel = document.querySelector<HTMLElement>('.vsidian-outline-panel')!
  const items = [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
  controller.handleHostMessage({ kind: 'view.state.request' }) // 同步回报最新 probe
  const probe = [...sent].reverse().find((m) => m.kind === 'view.state') as
    | { outline?: { draggingIndex: number | null; dropTargetIndex: number | null; dropPosition: string | null; dropHintPainted: boolean } }
    | undefined
  return {
    itemClasses: items.map((el) => el.className),
    itemTexts: items.map((el) => el.textContent ?? ''),
    draggingIndex: probe?.outline?.draggingIndex ?? null,
    dropTargetIndex: probe?.outline?.dropTargetIndex ?? null,
    dropPosition: probe?.outline?.dropPosition ?? null,
    dropHintPainted: probe?.outline?.dropHintPainted ?? false,
    text: controller.getView()!.state.doc.toString(),
  }
}

Object.assign(window, {
  initDrag(text: string) {
    controller.handleHostMessage({
      kind: 'init', sessionId: 'outline-drag', docUri: 'file:///d%3A/notes/drag.md',
      version: 1, text,
    })
  },
  controller,
  readDrag,
  /** 跳转观测（review-loops 第 2 轮：drop 后的下一次点击必须仍然生效） */
  readJump() {
    const view = controller.getView()!
    const head = view.state.selection.main.head
    const items = [...document.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
    return {
      caretLine: view.state.doc.lineAt(head).number,
      locatedIndex: items.findIndex((el) => el.classList.contains('vsidian-outline-located')),
    }
  },
  /** 宿主消息通道（测试钩子与真实点击同一委托） */
  post(msg: Record<string, unknown>) {
    controller.handleHostMessage(msg)
  },
  /** 出站消息（edit.request 观测） */
  sent: () => sent,
})
