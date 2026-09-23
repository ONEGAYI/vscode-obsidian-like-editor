// 性能样例生成器（工单 #5）：1千/1万/10万行的同构普通段落样例。
// 每 50 行一个二级标题（标题装饰切片的装饰对象），其余为固定宽度中文
// 普通段落行；同构保证三个体量的对比只差体量本身。
//
// 用法（CLI）：node test/perf/gen-sample.mjs <行数> <输出文件>
// 用法（import）：import { generatePerfSample } from './gen-sample.mjs'
export function generatePerfSample(lines) {
  const out = []
  for (let i = 1; i <= lines; i++) {
    out.push(
      i % 50 === 0
        ? `## 第 ${i} 节 标题样本行`
        : `第 ${i} 行 普通段落样本文本，固定宽度内容，用于体量对比测试。`,
    )
  }
  return out.join('\n') + '\n'
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const lines = Number(process.argv[2])
  const outFile = process.argv[3]
  if (!Number.isInteger(lines) || lines <= 0 || !outFile) {
    console.error('用法: node test/perf/gen-sample.mjs <行数> <输出文件>')
    process.exit(1)
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(outFile, generatePerfSample(lines), 'utf8')
  console.log(`[gen-sample] ${lines} 行 -> ${outFile}`)
}
