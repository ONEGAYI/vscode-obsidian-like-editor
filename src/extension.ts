// 扩展激活入口：注册 CustomTextEditorProvider（priority: option，经
// "重新打开方式"启用，不接管 .md 默认打开）与文档事件监听、测试钩子。
// #33 起：装配 Vsidian 独立设置链路（globalState 持久化 + 纯代码 schema
// + 设置页面板）并注册「打开设置」命令——命令不要求当前有任何文档，
// 空窗口同样可用。
import * as vscode from 'vscode'
import { createTextEditorProvider, VIEW_TYPE } from './host/textEditorProvider'
import { SettingsService } from './host/settingsService'
import { createSettingsPage } from './host/settingsPage'
import { PRODUCTION_SETTING_DEFINITIONS } from './shared/settings'

export function activate(context: vscode.ExtensionContext): void {
  // 设置存储：context.globalState（用户级，跨窗口一致、重启保留）+ 纯代码
  // schema——不使用 workspace.getConfiguration、不声明 contributes.
  // configuration，与 VSCode 统一设置中心完全解耦（AGENTS.md「插件设置入口」）
  const settingsService = new SettingsService(context.globalState, PRODUCTION_SETTING_DEFINITIONS)
  const settingsPage = createSettingsPage(context, settingsService)
  const provider = createTextEditorProvider(context, {
    service: settingsService,
    openPage: () => settingsPage.open(),
    closePage: () => settingsPage.close(),
    getPageInfo: () => settingsPage.getInfo(),
    injectPageMessage: (message) => settingsPage.injectMessage(message),
  })
  context.subscriptions.push(
    // enableScripts 在每个面板的 webview.options 上设置（provider 内）；
    // 注册选项仅接受 retainContextWhenHidden 等（1.86 类型契约）
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider),
    // #33 设置页入口：打开（或 reveal 已有）Vsidian 设置面板
    vscode.commands.registerCommand('onegayi.vsidian.openSettings', () => {
      settingsPage.open()
    }),
  )
}

export function deactivate(): void {
  // 资源经 context.subscriptions 自动释放
}
