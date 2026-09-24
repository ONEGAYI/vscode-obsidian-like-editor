// 扩展激活入口：注册 CustomTextEditorProvider（priority: option，经
// "重新打开方式"启用，不接管 .md 默认打开）与文档事件监听、测试钩子。
import * as vscode from 'vscode'
import { createTextEditorProvider, VIEW_TYPE } from './host/textEditorProvider'

export function activate(context: vscode.ExtensionContext): void {
  const provider = createTextEditorProvider(context)
  context.subscriptions.push(
    // enableScripts 在每个面板的 webview.options 上设置（provider 内）；
    // 注册选项仅接受 retainContextWhenHidden 等（1.86 类型契约）
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider),
  )
}

export function deactivate(): void {
  // 资源经 context.subscriptions 自动释放
}
