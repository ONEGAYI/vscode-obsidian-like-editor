// 扩展激活入口（占位）：注册逻辑由集成测试驱动，在实现提交中补齐。
import * as vscode from 'vscode'

export function activate(_context: vscode.ExtensionContext): void {
  void vscode  // 占位引用，保持 esbuild external 配置生效
}

export function deactivate(): void {
  // 尚无需要释放的资源
}
