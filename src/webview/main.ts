// webview 启动入口：装配 acquireVsCodeApi、同步控制器与基础编辑键。
// CM6 扩展装配在 syncController 内（不含 history/basicSetup——撤销栈归宿主，
// 探索笔记 03 §3；基础编辑键取 defaultKeymap 中与本地历史无关的部分）。
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
// 基础编辑键（光标移动、删除、换行等；其中 undo/redo 绑定在未装本地
// history 扩展时为 no-op，权威撤销栈归宿主文本管线——#3 处理转发）
controller.mount(document.getElementById('app') ?? document.body, [
  keymap.of(defaultKeymap),
])

window.addEventListener('message', (event) => {
  controller.handleHostMessage(event.data)
})
