// 任务 checkbox 真实鼠标回归（#116 缺陷二/三）：装配生产 webview 控制器，
// 点击只由 Playwright 原生鼠标发起（mousedown → mouseup → click 真链路，
// 合成事件测不到 CM6 在 mousedown 阶段放置光标的路径——缺陷二漏测原因）。
import { WebviewSyncController } from '../../src/webview/syncController'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import '../../src/webview/main.css'

// 桥接 stub：累计出站消息（edit.request 断言依据；生产链路由宿主消费）
const sent: unknown[] = []
const controller = new WebviewSyncController({
  postMessage(message) {
    sent.push(message)
  },
  getState() {
    return undefined
  },
  setState() {},
})
// defaultKeymap 提供 undo，验证勾选事务走标准编辑链（Ctrl+Z 可撤销）
controller.mount(document.getElementById('app')!, [keymap.of(defaultKeymap)])
Object.assign(window, {
  controller,
  initTaskDoc(text: string, mode: 'live' | 'reading') {
    controller.handleHostMessage({ kind: 'init', sessionId: 'task-click',
      docUri: 'file:///task.md', version: 1, text })
    if (mode === 'reading') {
      controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    }
  },
  taskDoc() {
    return controller.getView()!.state.doc.toString()
  },
  /** 光标位置（live 模式：断言光标未被鼠标移入标记区间） */
  taskHead() {
    return controller.getView()!.state.selection.main.head
  },
  taskSent() {
    return sent
  },
})
