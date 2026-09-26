// webview 启动入口：装配 acquireVsCodeApi、同步控制器与基础编辑键。
// CM6 扩展装配在 syncController 内（不含 history/basicSetup——撤销栈归宿主，
// 探索笔记 03 §3；撤销/重做转发 keymap 亦在 syncController 内装配，
// 优先于 defaultKeymap 的本地 no-op undo/redo 绑定）。
// #93 i18n：首帧从 HTML 数据岛装配语言包（早于任何视图挂载，t() 首帧即
// 就绪）；locale.changed 原子换包，编辑器文案消费方随 #94 迁移接入重渲染。
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import { WebviewSyncController } from './syncController'
import { bootLocaleFromDocument, handleLocaleChangedMessage } from './localeBoot'
import './main.css'
// #59 KaTeX 基础样式：esbuild 合并进 main.css，字体（仅 woff2）经 CSS url()
// 产物化到 out/webview/assets/（CSP font-src 已放行 cspSource 域）
import 'katex/dist/katex.min.css'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
  getState<T>(): T | undefined
  setState(state: unknown): void
}

// 语言包首帧装配（数据岛由宿主 HTML 生成点注入；缺失时取词回退键名）
bootLocaleFromDocument()

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
  // 语言切换：换包 + <html lang> 同步；常驻文本重渲染订阅方各自处理
  handleLocaleChangedMessage(event.data)
})
