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
  // 定向重跑：VSIDIAN_TEST_CASES=子串（逗号分隔任一命中即跑）只跑匹配
  // 用例（开发调试用；缺省跑全量）。代码块卡片分支曾用单子串变量
  // VSIDIAN_IT_FILTER（d351eda），main 侧 #86 已落多子串版本，合并取超集
  const filter = process.env['VSIDIAN_TEST_CASES']
  for (const [name, fn] of cases) {
    if (filter && !filter.split(',').some((part) => name.includes(part.trim()))) {
      continue
    }
    try {
      // #38：全局模式记忆（globalState）在同一集成进程内跨用例共享——
      // reading 记忆会让后续用例的新面板被恢复成阅读模式、source 记忆会
      // 把默认/显式打开弹回原生编辑器。每用例前重置为无历史基线。
      // 1.86.2 的 globalStorage 写入存在迟到回翻（前序用例的旧值广播滞后
      // 到达会把刚校验过的新值翻回，resetLastMode 注释记录过同类现象；
      // 实测残留 source 会让下一用例的 openWith 被弹回成原生编辑器、残留
      // reading 会让依赖 live 视图的断言等不到）：读回校验后加稳定窗复查，
      // 两轮都为 live 才放行
      for (let attempt = 0; ; attempt++) {
        await vscode.commands.executeCommand('onegayi.vsidian._test.resetLastMode')
        const settled = async (): Promise<boolean> => {
          const first = (await vscode.commands.executeCommand(
            'onegayi.vsidian._test.getLastMode')) as string | undefined
          if (first !== 'live') {
            return false
          }
          await new Promise((r) => setTimeout(r, 250))
          const second = (await vscode.commands.executeCommand(
            'onegayi.vsidian._test.getLastMode')) as string | undefined
          return second === 'live'
        }
        if (await settled() || attempt >= 10) {
          if (attempt >= 10) {
            // 放弃时不静默：真实回归（某路径反复写回非 live 值）会被吞成
            // 后续用例的莫名失败，留痕把归因窗口缩短到本用例
            const final = (await vscode.commands.executeCommand(
              'onegayi.vsidian._test.getLastMode')) as string | undefined
            console.warn(
              `[集成测试][WARN] 记忆重置 10 次未稳定为 live（最终读值 ${String(final)}），放行用例「${name}」`,
            )
          }
          break
        }
        await new Promise((r) => setTimeout(r, 50))
      }
      // #38 合并 main 后新增：每用例前重置设置键到默认（lineNumbers 开、
      // fixture 键清理）。设置 globalState 与模式记忆同层，同样存在 1.86.2
      // storage 迟到回翻（见 cases.ts 的 waitSettings 注释）——用例中断会在
      // "行号已关"状态留下残留，跨用例污染后续行号断言，读回校验后放行
      for (let attempt = 0; ; attempt++) {
        await vscode.commands.executeCommand('onegayi.vsidian._test.setSettings', {
          'editor.lineNumbers': true,
        })
        const readBack = (await vscode.commands.executeCommand(
          'onegayi.vsidian._test.getSettings')) as Record<string, unknown>
        if (readBack['editor.lineNumbers'] === true || attempt >= 10) {
          if (attempt >= 10) {
            console.warn(
              `[集成测试][WARN] 设置重置未稳定为 lineNumbers=true（最终 ${String(readBack['editor.lineNumbers'])}），放行用例「${name}」`,
            )
          }
          break
        }
        await new Promise((r) => setTimeout(r, 100))
      }
      await fn()
      console.log(`[集成测试][PASS] ${name}`)
    } catch (err) {
      failures.push(name)
      console.error(`[集成测试][FAIL] ${name}`, err)
    } finally {
      try {
        // closeAllEditors 偶发遗留 custom tab（webview 销毁时序）：残留的
        // 死面板会被后续用例的 openWith 重显成永不就绪状态（用例注记录过
        // 该陷阱），显式逐个关闭并复核，最多重试 5 轮
        for (let attempt = 0; attempt < 5; attempt++) {
          await vscode.commands.executeCommand('workbench.action.closeAllEditors')
          const leftovers = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .filter((t) => t.input instanceof vscode.TabInputCustom)
          if (leftovers.length === 0) {
            break
          }
          for (const tab of leftovers) {
            try {
              await vscode.window.tabGroups.close(tab)
            } catch {
              // 留给下一轮重试
            }
          }
        }
      } catch {
        // 忽略清理失败
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`集成测试失败 ${failures.length} 项：${failures.join('；')}`)
  }
}
