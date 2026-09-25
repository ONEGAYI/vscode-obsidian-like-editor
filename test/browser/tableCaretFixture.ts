// 原生浏览器输入回归：装配生产 webview 控制器，输入只由浏览器键盘/IME 发起。
import { WebviewSyncController } from '../../src/webview/syncController'
import '../../src/webview/main.css'

const controller = new WebviewSyncController({ postMessage() {}, getState() {}, setState() {} })
controller.mount(document.getElementById('app')!)
Object.assign(window, { initTable(text: string) {
  controller.handleHostMessage({ kind: 'init', sessionId: 'native-input',
    docUri: 'file:///table.md', version: 1, text })
}, controller })
