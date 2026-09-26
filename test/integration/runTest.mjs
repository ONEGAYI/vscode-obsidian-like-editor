// 集成测试启动器：生成临时 fixture 工作区，下载并启动 VSCode 1.86.2，
// 以 extensionDevelopmentPath 模式加载扩展后运行 out/test/integration/suite。
// fixture 内容见 fixtures.mjs（与 runInstalled.mjs 安装态回归共用同一套）。
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample, generateReadingSample, generateMermaidDenseSample } from '../perf/gen-sample.mjs'
import { writeFixtures, LARGE_DOC_LINES } from './fixtures.mjs'
import { buildTestHostArgs, resolveTestHostMode, runTestHost } from './testHost.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const wsDir = mkdtempSync(path.join(tmpdir(), 'vsidian-itest-'))
try {
  writeFixtures(wsDir, { generatePerfSample, generateReadingSample, generateMermaidDenseSample })

  console.log(`[runTest] fixture 工作区：${wsDir}`)
  const executable = await downloadAndUnzipVSCode({ version: '1.86.2' })
  const args = buildTestHostArgs({
    workspaceDir: wsDir,
    testsPath: path.join(root, 'out', 'test', 'integration', 'suite', 'index.js'),
    extensionPath: root,
    extensionsDir: path.join(root, '.vscode-test', 'extensions'),
    userDataDir: path.join(root, '.vscode-test', 'user-data'),
    disableExtensions: true,
  })
  // CI 的 xvfb 虚拟显示无 GPU，Electron GPU 进程反复崩溃会拖垮 webview 面板
  if (process.env.CI) {
    args.push('--disable-gpu')
  }
  const mode = resolveTestHostMode()
  console.log(`[runTest] 测试宿主模式：${mode}`)
  const code = await runTestHost({
    executable,
    args,
    mode,
    env: {
      ...process.env,
      WORKSPACE_DIR: wsDir,
      LARGE_DOC_LINES: String(LARGE_DOC_LINES),
      // C-11：开启 _test.* 测试钩子命令（生产/常规开发不注册）
      VSIDIAN_TEST_HOOKS: '1',
    },
    reportPath: path.join(root, '.vscode-test', 'integration-dev.log'),
  })
  if (code !== 0) throw new Error(`开发态集成回归退出码 ${code}`)
} catch (err) {
  console.error('[runTest] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(wsDir, { recursive: true, force: true })
}
