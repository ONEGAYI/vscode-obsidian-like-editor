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

// 阅读视图样例（工单 #7）：每行一个独立块（空行分隔），供按需挂载的
// 体量对比与窗口有界性测量。每 50 块一个二级标题（标题跳转目标）。
export function generateReadingSample(blocks) {
  const out = []
  for (let i = 1; i <= blocks; i++) {
    if (i > 1) {
      out.push('')
    }
    out.push(
      i % 50 === 0
        ? `## 第 ${i} 节 阅读标题样本行`
        : `第 ${i} 段 阅读段落样本文本，固定宽度内容，用于体量对比测试。`,
    )
  }
  return out.join('\n') + '\n'
}

// 超大单块样例（工单 #7 限制记录）：一个 2 万行的未拆分代码围栏块，
// 用于实测"窗口无法在块内拆分"时的行为与成本。
export function generateGiantBlockSample(lines) {
  const out = ['# 超大单块样例', '', '```text']
  for (let i = 1; i <= lines; i++) {
    out.push(`围栏内第 ${i} 行：超大单块布局成本测量样本行，固定宽度文本。`)
  }
  out.push('```', '', '结尾段落。', '')
  return out.join('\n')
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
