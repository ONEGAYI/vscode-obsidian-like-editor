// 空窗口命令激活实测启动器（#33）：以空启动参数（不开文件夹、不开文档）
// 启动 1.86.2 宿主运行 settingsActivation 迷你套件。主集成套件首例会显式
// activate 扩展，激活后的命令执行无法验证「contributes.commands 自动派生
// onCommand 激活」，故单独成套（套件内不得调用 ext.activate()）。
import { runTests } from '@vscode/test-electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 空目录工作区：无任何 Markdown 文档（工单语义：没有打开文档时命令可用），
// 同时避免 test-electron 恢复上一次会话的工作区（如 remote）导致启动失败
const emptyDir = mkdtempSync(path.join(tmpdir(), 'vsidian-act-'))
try {
  await runTests({
    version: '1.86.2',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'integration', 'settingsActivation', 'index.js'),
    // --new-window 阻止会话恢复；--disable-extensions 只禁第三方扩展，
    // extensionDevelopmentPath 的被测扩展仍加载
    launchArgs: [emptyDir, '--new-window', '--disable-extensions'],
    extensionTestsEnv: {
      VSIDIAN_TEST_HOOKS: '1',
    },
  })
} catch (err) {
  console.error('[runSettingsActivation] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(emptyDir, { recursive: true, force: true })
}
