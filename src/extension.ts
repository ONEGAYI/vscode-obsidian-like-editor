// 扩展激活入口：注册 CustomTextEditorProvider（#38 起 priority: default，
// .md 默认打开即本扩展；可经「重新打开方式」或编辑器关联设置改回原生；
// 全局模式记忆为 source 时新开 .md 自动弹回原生编辑器）与文档事件监听、
// 三态视图命令、测试钩子。
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
