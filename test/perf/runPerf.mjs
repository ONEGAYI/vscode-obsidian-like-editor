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
import {
  generatePerfSample,
  generateReadingSample,
  generateGiantBlockSample,
  generateSampleNearBytes,
  generateLongLineSample,
  generateImageDenseSample,
  generateMathDenseSample,
  generateMermaidDenseSample,
  generateCodeDenseSample,
  generateCodeGiantFenceSample,
} from './gen-sample.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outDir = process.argv[2] ?? path.join(root, 'docs', 'perf', 'data')
const SIZES = [
  { name: '1k', lines: 1_000 },
  { name: '10k', lines: 10_000 },
  { name: '100k', lines: 100_000 },
  { name: '10kb', targetBytes: 10 * 1024 },
  { name: '100kb', targetBytes: 100 * 1024 },
  { name: '1mb', targetBytes: 1024 * 1024 },
]

const wsDir = mkdtempSync(path.join(tmpdir(), 'vsidian-perf-'))
try {
  for (const sample of SIZES) {
    const live = sample.lines
      ? generatePerfSample(sample.lines)
      : generateSampleNearBytes(sample.targetBytes, generatePerfSample)
    const reading = sample.lines
      ? generateReadingSample(sample.lines)
      : generateSampleNearBytes(sample.targetBytes, generateReadingSample)
    writeFileSync(path.join(wsDir, `perf-${sample.name}.md`), live, 'utf8')
    writeFileSync(path.join(wsDir, `reading-${sample.name}.md`), reading, 'utf8')
  }
  // 超大单块（#7 限制记录）：2 万行未拆分围栏
  writeFileSync(path.join(wsDir, 'reading-giant.md'), generateGiantBlockSample(20_000), 'utf8')
  writeFileSync(path.join(wsDir, 'perf-longline.md'), generateLongLineSample(), 'utf8')
  writeFileSync(path.join(wsDir, 'perf-images.md'), generateImageDenseSample(), 'utf8')
  // #59 公式密集档：行内/块级/段内公式交替（渲染缓存与装饰增量的载体）
  writeFileSync(path.join(wsDir, 'perf-math.md'), generateMathDenseSample(), 'utf8')
  // #60 图表密集档：中小 mermaid 围栏与段落交替（懒加载/串行渲染/缓存克隆
  // 改写/挂载回收的载体；量级默认 120 图，长档按需加大 blocks 参数）
  writeFileSync(path.join(wsDir, 'perf-mermaid.md'), generateMermaidDenseSample(), 'utf8')
  // #85 代码块密集档：js/python 围栏与段落交替（卡片重建/高亮缓存/击键增量）
  writeFileSync(path.join(wsDir, 'perf-code.md'), generateCodeDenseSample(), 'utf8')
  // #85 超大代码围栏（>4096 行）：着色跳过降级与块内击键成本
  writeFileSync(path.join(wsDir, 'perf-code-giant.md'), generateCodeGiantFenceSample(), 'utf8')
  for (let i = 0; i < 24; i++) {
    const width = 320 + (i % 4) * 80
    const height = 180 + (i % 6) * 60
    writeFileSync(path.join(wsDir, `probe-${i}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#5979a9"/></svg>`,
      'utf8')
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
      PERF_SIZES: SIZES.map((sample) => sample.name).join(','),
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
