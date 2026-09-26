// 设置页 webview 启动入口（#33）：装配 acquireVsCodeApi 与设置页视图。
// 页面装载后立即拉取快照（settings.get）——retainContextWhenHidden 不开，
// 面板隐藏即释放、重开即重载，回显每次都以宿主权威值为准。
import { SettingsPageView } from './settingsPageView'
import { PRODUCTION_SETTING_DEFINITIONS } from '../shared/settings'
import { KeybindingSettingsSection } from './keybindingSettings'
import './settingsPage.css'

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

const vscode = acquireVsCodeApi()
const keybindings = new KeybindingSettingsSection({ postMessage: (message) => vscode.postMessage(message) })

const view = new SettingsPageView(
  { postMessage: (message) => vscode.postMessage(message) },
  PRODUCTION_SETTING_DEFINITIONS,
  [keybindings],
)
view.mount(document.getElementById('app') ?? document.body)
vscode.postMessage({ kind: 'settings.get' })
vscode.postMessage({ kind: 'keybindings.get' })

window.addEventListener('message', (event) => {
  view.handleHostMessage(event.data)
  keybindings.handleHostMessage(event.data)
})
