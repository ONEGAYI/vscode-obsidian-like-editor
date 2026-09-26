// 集成测试启动器：生成临时 fixture 工作区，下载并启动 VSCode 1.86.2，
// 以 extensionDevelopmentPath 模式加载扩展后运行 out/test/integration/suite。
// fixture 内容见 fixtures.mjs（与 runInstalled.mjs 安装态回归共用同一套）。
//
// VSIDIAN_ITEST_SHARDS=N（N>=2）时并行起 N 个宿主。每片注入
// VSIDIAN_TEST_SHARD=k/N，并以独立便携目录隔离用户数据、扩展与主进程 IPC。
// 缺省 N=1 保持原有单宿主行为与 integration-dev.log 报告名。
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample, generateReadingSample, generateMermaidDenseSample } from '../perf/gen-sample.mjs'
import { writeFixtures, LARGE_DOC_LINES } from './fixtures.mjs'
import { buildTestHostArgs, cleanupTestDirs, createPortableShardHost, resolveTestHostMode, runTestHost } from './testHost.mjs'

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
const portableDirs = []
const testCacheDir = path.join(root, '.vscode-test')
const started = Date.now()
try {
  // 所有宿主结束后再清理便携目录；若一片启动异常，也不能清理仍在运行的其他片。
  const results = await Promise.allSettled(
    Array.from({ length: shardTotal }, async (_, i) => {
      const shard = i + 1
      const wsDir = mkdtempSync(path.join(tmpdir(), `vsidian-itest-s${shard}-`))
      wsDirs.push(wsDir)
      writeFixtures(wsDir, { generatePerfSample, generateReadingSample, generateMermaidDenseSample })
      const portable = sharded ? createPortableShardHost(testCacheDir, shard) : null
      if (portable) portableDirs.push(portable.portableDir)
      const args = buildTestHostArgs({
        workspaceDir: wsDir,
        testsPath: path.join(root, 'out', 'test', 'integration', 'suite', 'index.js'),
        extensionPath: root,
        extensionsDir: portable?.extensionsDir ?? path.join(testCacheDir, 'extensions'),
        userDataDir: portable?.userDataDir ?? path.join(testCacheDir, 'user-data'),
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
          ...(portable?.env ?? process.env),
          WORKSPACE_DIR: wsDir,
          LARGE_DOC_LINES: String(LARGE_DOC_LINES),
          // C-11：开启 _test.* 测试钩子命令（生产/常规开发不注册）
          VSIDIAN_TEST_HOOKS: '1',
          ...(sharded ? { VSIDIAN_TEST_SHARD: `${shard}/${shardTotal}` } : {}),
        },
        reportPath: path.join(testCacheDir, sharded ? `integration-dev-s${shard}.log` : 'integration-dev.log'),
      })
      console.log(`[runTest] 分片 ${shard}/${shardTotal} 宿主退出码 ${code}（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`)
      return code
    }),
  )
  const failures = results.flatMap((result, i) => result.status === 'rejected'
    ? [`${i + 1}: 启动异常 ${String(result.reason)}`]
    : result.value !== 0 ? [`${i + 1}: 退出码 ${result.value}`] : [])
  if (failures.length > 0) {
    throw new Error(`集成回归有 ${failures.length}/${shardTotal} 片失败（${failures.join('；')}），详见 .vscode-test/integration-dev*.log`)
  }
} catch (err) {
  console.error('[runTest] 运行失败', err)
  process.exitCode = 1
} finally {
  const cleanupFailures = [
    ...cleanupTestDirs(wsDirs, tmpdir()),
    ...cleanupTestDirs(portableDirs, testCacheDir),
  ]
  if (cleanupFailures.length > 0) {
    for (const failure of cleanupFailures) console.error(`[runTest] ${failure}`)
    process.exitCode = 1
  }
}
