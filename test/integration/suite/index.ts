// 集成测试套件入口：在真实 VSCode 1.86 宿主内运行。
// 组织方式为极简自研 runner（不引入 mocha 依赖），失败汇总后抛错使
// @vscode/test-electron 以非零码退出。
//
// 与扩展的交互全部走公开入口（vscode.openWith）与扩展注册的 _test 辅助命令
// （onegayi.vsidian._test.*）：webview 真实键盘输入无法在
// @vscode/test-electron 中模拟，"webview -> 宿主"链路经 injectWebviewMessage
// 注入（与真实 webview.onDidReceiveMessage 同一入口），宿主侧行为全部真实。
import * as vscode from 'vscode'
import { cases } from './cases'

export async function run(): Promise<void> {
  const failures: string[] = []
  for (const [name, fn] of cases) {
    try {
      await fn()
      console.log(`[集成测试][PASS] ${name}`)
    } catch (err) {
      failures.push(name)
      console.error(`[集成测试][FAIL] ${name}`, err)
    } finally {
      try {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      } catch {
        // 忽略清理失败
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`集成测试失败 ${failures.length} 项：${failures.join('；')}`)
  }
}
