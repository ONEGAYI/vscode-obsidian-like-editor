// 性能测量启动器（工单 #5）：生成 1千/1万/10万行样例 fixture，启动
// VSCode 1.86.2 宿主执行 test/perf/suite.ts，报告写入 docs/perf/data/。
//
// 用法：node test/perf/runPerf.mjs [输出目录=docs/perf/data]
import { runTests } from '@vscode/test-electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample } from './gen-sample.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'docs', 'perf', 'data'))
const SIZES = [
  ['1k', 1_000],
  ['10k', 10_000],
  ['100k', 100_000],
]

const wsDir = mkdtempSync(path.join(tmpdir(), 'oile-perf-'))
try {
  for (const [name, lines] of SIZES) {
    writeFileSync(path.join(wsDir, `perf-${name}.md`), generatePerfSample(lines), 'utf8')
  }
  mkdirSync(outDir, { recursive: true })
  console.log(`[runPerf] fixture 工作区：${wsDir}`)
  console.log(`[runPerf] 报告目录：${outDir}`)
  await runTests({
    version: '1.86.2',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'perf', 'suite.js'),
    launchArgs: [wsDir, '--disable-extensions'],
    extensionTestsEnv: {
      WORKSPACE_DIR: wsDir,
      PERF_REPORT_DIR: outDir,
      PERF_SIZES: SIZES.map(([n]) => n).join(','),
    },
  })
} catch (err) {
  console.error('[runPerf] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(wsDir, { recursive: true, force: true })
}
