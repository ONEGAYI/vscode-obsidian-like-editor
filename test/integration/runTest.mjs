// 集成测试启动器：生成临时 fixture 工作区，下载并启动 VSCode 1.86.2，
// 以 extensionDevelopmentPath 模式加载扩展后运行 out/test/integration/suite。
// fixture 内容见 fixtures.mjs（与 runInstalled.mjs 安装态回归共用同一套）。
//
// 分片并行（实验）：VSIDIAN_ITEST_SHARDS=N（N>=2）时并行起 N 个宿主，
// 每片注入 VSIDIAN_TEST_SHARD=k/N（套件入口按索引取模切片），并各自
// 隔离 fixture 工作区、extensions/user-data 目录与运行报告，互不共享
// 任何宿主级状态；缺省 N=1 保持单宿主全量串行的既有行为与报告命名。
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample, generateReadingSample, generateMermaidDenseSample } from '../perf/gen-sample.mjs'
import { writeFixtures, LARGE_DOC_LINES } from './fixtures.mjs'
import { buildTestHostArgs, resolveTestHostMode, runTestHost } from './testHost.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const shardTotal = Number(process.env.VSIDIAN_ITEST_SHARDS ?? '1')
if (!Number.isInteger(shardTotal) || shardTotal < 1) {
  console.error(`[runTest] VSIDIAN_ITEST_SHARDS 须为 >=1 整数，收到 ${JSON.stringify(process.env.VSIDIAN_ITEST_SHARDS)}`)
  process.exit(1)
}
const sharded = shardTotal > 1
if (sharded) {
  console.log(`[runTest] 分片并行：${shardTotal} 个宿主同时起跑（每片独立 fixture/存储/报告）`)
}

const executable = await downloadAndUnzipVSCode({ version: '1.86.2' })
const mode = resolveTestHostMode()
console.log(`[runTest] 测试宿主模式：${mode}；宿主 ${executable}`)
if (process.env.VSIDIAN_TEST_CASES) {
  console.log(`[runTest] 用例筛选：${JSON.stringify(process.env.VSIDIAN_TEST_CASES)}`)
}

const wsDirs = []
const started = Date.now()
// 实验参数：片间启动错峰毫秒数（VSCode 1.86 扩展测试宿主在启动窗口期
// 存在 IPC handle 竞争，错峰让先起者完成绑定后再起下一片）
const staggerMs = Number(process.env.VSIDIAN_ITEST_STAGGER_MS ?? '0')
try {
  const exitCodes = await Promise.all(
    Array.from({ length: shardTotal }, async (_, i) => {
      const shard = i + 1
      if (i > 0 && staggerMs > 0) {
        await new Promise((r) => setTimeout(r, i * staggerMs))
      }
      const wsDir = mkdtempSync(path.join(tmpdir(), `vsidian-itest-s${shard}-`))
      wsDirs.push(wsDir)
      writeFixtures(wsDir, { generatePerfSample, generateReadingSample, generateMermaidDenseSample })
      const args = buildTestHostArgs({
        workspaceDir: wsDir,
        testsPath: path.join(root, 'out', 'test', 'integration', 'suite', 'index.js'),
        extensionPath: root,
        extensionsDir: path.join(root, '.vscode-test', sharded ? `extensions-s${shard}` : 'extensions'),
        userDataDir: path.join(root, '.vscode-test', sharded ? `user-data-s${shard}` : 'user-data'),
        disableExtensions: true,
      })
      // CI 的 xvfb 虚拟显示无 GPU，Electron GPU 进程反复崩溃会拖垮 webview 面板
      if (process.env.CI) {
        args.push('--disable-gpu')
      }
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
          ...(sharded ? { VSIDIAN_TEST_SHARD: `${shard}/${shardTotal}` } : {}),
        },
        reportPath: path.join(root, '.vscode-test', sharded ? `integration-dev-s${shard}.log` : 'integration-dev.log'),
      })
      console.log(`[runTest] 分片 ${shard}/${shardTotal} 宿主退出码 ${code}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
      return code
    }),
  )
  const failed = exitCodes.filter((code) => code !== 0)
  if (failed.length > 0) {
    throw new Error(`分片并行集成回归有 ${failed.length}/${shardTotal} 片失败：退出码 [${exitCodes.join(', ')}]，详见 .vscode-test/integration-dev-s*.log`)
  }
} catch (err) {
  console.error('[runTest] 运行失败', err)
  process.exitCode = 1
} finally {
  for (const dir of wsDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
}
