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
  // _test 钩子命令随扩展 activate 注册：runner 每用例前要调 resetLastMode，
  // 须先显式激活（首个用例自身的 activate 断言在其后执行）
  const ext = vscode.extensions.getExtension('onegayi.vsidian')
  if (ext && !ext.isActive) {
    await ext.activate()
  }
  for (const [name, fn] of cases) {
    try {
      // #38：全局模式记忆（globalState）在同一集成进程内跨用例共享——
      // reading 记忆会让后续用例的新面板被恢复成阅读模式、source 记忆会
      // 把默认/显式打开弹回原生编辑器。每用例前重置为无历史基线
      await vscode.commands.executeCommand('onegayi.vsidian._test.resetLastMode')
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
