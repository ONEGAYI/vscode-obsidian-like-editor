// webview 启动入口：装配 acquireVsCodeApi、同步控制器与基础编辑键。
// CM6 扩展装配在 syncController 内（不含 history/basicSetup——撤销栈归宿主，
// 探索笔记 03 §3；撤销/重做转发 keymap 亦在 syncController 内装配，
// 优先于 defaultKeymap 的本地 no-op undo/redo 绑定）。
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { WebviewSyncController } from './syncController'
import './main.css'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState<T>(): T | undefined
  setState(state: unknown): void
}

const vscode = acquireVsCodeApi()

const controller = new WebviewSyncController({
  postMessage: (message) => vscode.postMessage(message),
  getState: <T,>() => vscode.getState<T>(),
  setState: (state) => vscode.setState(state),
})
// 基础编辑键（光标移动、删除、换行等）；撤销/重做绑定被 syncController
// 内更高优先级的转发 keymap（Mod-Z / Mod-Shift-Z / Mod-Y → history.request）
// 截获，权威撤销栈归宿主文本管线
controller.mount(document.getElementById('app') ?? document.body, [
  keymap.of(defaultKeymap),
])

window.addEventListener('message', (event) => {
  controller.handleHostMessage(event.data)
})
