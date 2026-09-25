// 安装态集成回归启动器（工单 #15）：把 vsce 产物 VSIX 经 CLI
// --install-extension 安装进 @vscode/test-electron 下载的 VSCode 1.86.2
// 便携宿主的隔离 extensions 目录，再以测试模式启动并运行与 runTest.mjs
// 完全相同的集成套件——加载的扩展代码是安装解压出的 VSIX 产物
// （extensionDevelopmentPath 指向安装解压目录，受 .vscodeignore 过滤后的
// 真实文件集合），安装注册链路由 CLI 安装步骤单独验证。
//
// 覆盖验收：VSIX 在 Windows 1.86 宿主的安装、打开（Reopen With 装载全文）、
// 编辑、保存与重开（磁盘回读）链路以安装产物跑通；套件与开发模式同一份，
// 结果差异只能来自打包清单缺漏（.vscodeignore 或产物路径问题）。
//
// 用法：node test/integration/runInstalled.mjs [VSIX 路径=根目录下最新 vsix]
// 前提：npm run compile（suite 产物）与 npx @vscode/vsce package（VSIX）。
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample, generateReadingSample, generateMermaidDenseSample } from '../perf/gen-sample.mjs'
import { writeFixtures, LARGE_DOC_LINES } from './fixtures.mjs'
import { buildTestHostArgs, resolveTestHostMode, runTestHost } from './testHost.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function resolveVsix() {
  if (process.argv[2]) {
    const p = path.resolve(process.argv[2])
    if (!existsSync(p)) {
      throw new Error(`VSIX 不存在：${p}`)
    }
    return p
  }
  const candidates = readdirSync(root).filter((f) => f.endsWith('.vsix')).sort()
  if (candidates.length === 0) {
    throw new Error('根目录没有 VSIX；先 npx @vscode/vsce package 或传路径参数')
  }
  return path.join(root, candidates[candidates.length - 1])
}

const wsDir = mkdtempSync(path.join(tmpdir(), 'vsidian-inst-'))
try {
  const vsix = resolveVsix()
  writeFixtures(wsDir, { generatePerfSample, generateReadingSample, generateMermaidDenseSample })
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: '1.86.2' })

  console.log(`[runInstalled] VSIX：${vsix}`)
  console.log(`[runInstalled] fixture 工作区：${wsDir}`)
  const cacheDir = path.join(root, '.vscode-test')
  const extensionsDir = path.join(cacheDir, 'extensions-installed')
  const userDataDir = path.join(cacheDir, 'user-data-installed')

  // 第一步：CLI 安装 VSIX 到隔离 extensions 目录（安装后 CLI 进程退出）。
  // 注：--install-extension 不能与 --extensionTestsPath 混在同一次启动里
  // （实测该组合不进入测试 runner），且须经 bin/code CLI 入口执行——
  // 直接用 GUI 主程序 exe 会拉起完整窗口而不返回。
  const cliPath =
    process.platform === 'win32'
      ? path.join(path.dirname(vscodeExecutablePath), 'bin', 'code.cmd')
      : path.join(path.dirname(vscodeExecutablePath), 'bin', 'code')
  const installArgs = [
    '--disable-updates',
    `--install-extension=${vsix}`,
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`,
  ]
  const installCode = await new Promise((resolve, reject) => {
    const shell = process.platform === 'win32'
    const exe = shell ? `"${cliPath}"` : cliPath
    const quoted = shell ? installArgs.map((a) => `"${a}"`) : installArgs
    const child = spawn(exe, quoted, { env: process.env, shell })
    child.stdout.on('data', (d) => process.stdout.write(d))
    child.stderr.on('data', (d) => process.stderr.write(d))
    child.on('error', reject)
    child.on('close', (c) => resolve(c ?? 1))
  })
  if (installCode !== 0) {
    throw new Error(`VSIX 安装失败，退出码 ${installCode}`)
  }
  console.log(`[runInstalled] VSIX 已安装到 ${extensionsDir}`)

  // 第二步：测试模式启动。VSCode 1.86 的 --extensionTestsPath 依赖
  // --extensionDevelopmentPath 同时存在（否则实测宿主静默挂起不进入 runner），
  // 故把 dev path 指向上一步安装解压出的扩展目录——加载的代码仍是 VSIX
  // 解压产物（受 .vscodeignore 过滤后的真实文件集合），而非仓库源码树；
  // 安装注册链路（清单解析/目录注册）已由第一步 CLI 安装单独验证。
  const installedDirs = readdirSync(extensionsDir).filter(
    (d) => d.startsWith('onegayi.'),
  )
  if (installedDirs.length === 0) {
    throw new Error(`安装目录中未找到扩展：${extensionsDir}`)
  }
  const installedExt = path.join(extensionsDir, installedDirs[installedDirs.length - 1])
  const args = buildTestHostArgs({
    workspaceDir: wsDir,
    testsPath: path.join(root, 'out', 'test', 'integration', 'suite', 'index.js'),
    extensionPath: installedExt,
    extensionsDir,
    userDataDir,
  })
  const mode = resolveTestHostMode()
  console.log(`[runInstalled] 测试宿主模式：${mode}`)
  const code = await runTestHost({
    executable: vscodeExecutablePath,
    args,
    mode,
    env: {
      ...process.env,
      WORKSPACE_DIR: wsDir,
      LARGE_DOC_LINES: String(LARGE_DOC_LINES),
      VSIDIAN_TEST_HOOKS: '1',
    },
  })
  if (code !== 0) {
    throw new Error(`安装态集成回归退出码 ${code}`)
  }
  console.log('[runInstalled] 安装态集成回归通过')
} catch (err) {
  console.error('[runInstalled] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(wsDir, { recursive: true, force: true })
}
