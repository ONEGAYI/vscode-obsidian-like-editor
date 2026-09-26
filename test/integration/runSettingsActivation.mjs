// 空窗口命令激活实测启动器（#33）：以空启动参数（不开文件夹、不开文档）
// 启动 1.86.2 宿主运行 settingsActivation 迷你套件。主集成套件首例会显式
// activate 扩展，激活后的命令执行无法验证「contributes.commands 自动派生
// onCommand 激活」，故单独成套（套件内不得调用 ext.activate()）。
// 宿主启动走 testHost.mjs 共用策略（#45）：Windows 默认独立桌面不抢前台。
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTestHostArgs, resolveTestHostMode, runTestHost } from './testHost.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// 空目录工作区：无任何 Markdown 文档（工单语义：没有打开文档时命令可用）；
// 隔离 profile（--user-data-dir）同时避免会话恢复（如 remote）导致启动失败
const emptyDir = mkdtempSync(path.join(tmpdir(), 'vsidian-act-'))
try {
  const executable = await downloadAndUnzipVSCode({ version: '1.86.2' })
  const args = buildTestHostArgs({
    workspaceDir: emptyDir,
    testsPath: path.join(root, 'out', 'test', 'integration', 'settingsActivation', 'index.js'),
    extensionPath: root,
    extensionsDir: path.join(root, '.vscode-test', 'extensions'),
    userDataDir: path.join(root, '.vscode-test', 'user-data'),
    // --disable-extensions 只禁第三方扩展，extensionDevelopmentPath 的被测扩展仍加载
    disableExtensions: true,
  })
  const mode = resolveTestHostMode()
  console.log(`[runSettingsActivation] 测试宿主模式：${mode}`)
  const code = await runTestHost({
    executable,
    args,
    mode,
    env: {
      ...process.env,
      VSIDIAN_TEST_HOOKS: '1',
    },
    reportPath: path.join(root, '.vscode-test', 'settings-activation.log'),
  })
  if (code !== 0) throw new Error(`空窗口激活实测退出码 ${code}`)
} catch (err) {
  console.error('[runSettingsActivation] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(emptyDir, { recursive: true, force: true })
}
