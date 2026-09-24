// 性能测量启动器（工单 #5/#7）：生成样例 fixture，启动 VSCode 1.86.2 宿主
// 执行 test/perf/suite.ts，报告写入 docs/perf/data/。
// - perf-{size}.md（#5）：同构普通段落（相邻行合并为大段），CM6 视口测量
// - reading-{size}.md（#7）：每行一块（空行分隔），阅读视图按需挂载测量
//
// 用法：node test/perf/runPerf.mjs [输出目录=docs/perf/data]
import { runTests } from '@vscode/test-electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample, generateReadingSample, generateGiantBlockSample } from './gen-sample.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = process.argv[2] ?? path.join(root, 'docs', 'perf', 'data')
const SIZES = [
  ['1k', 1_000],
  ['10k', 10_000],
  ['100k', 100_000],
]

const wsDir = mkdtempSync(path.join(tmpdir(), 'vsidian-perf-'))
try {
  for (const [name, lines] of SIZES) {
    writeFileSync(path.join(wsDir, `perf-${name}.md`), generatePerfSample(lines), 'utf8')
    writeFileSync(path.join(wsDir, `reading-${name}.md`), generateReadingSample(lines), 'utf8')
  }
  // 超大单块（#7 限制记录）：2 万行未拆分围栏
  writeFileSync(path.join(wsDir, 'reading-giant.md'), generateGiantBlockSample(20_000), 'utf8')
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
      // 测量经 _test.* 钩子命令驱动探针（与集成测试同一开关）
      VSIDIAN_TEST_HOOKS: '1',
    },
  })
} catch (err) {
  console.error('[runPerf] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(wsDir, { recursive: true, force: true })
}
