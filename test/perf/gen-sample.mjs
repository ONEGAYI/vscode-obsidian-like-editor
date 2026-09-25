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

/** 为 10 KB / 100 KB / 1 MB 档选取最接近目标字节数的同构样例。 */
export function generateSampleNearBytes(targetBytes, makeSample) {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new RangeError('目标字节数必须是正整数')
  }
  let low = 1
  let high = 1
  while (Buffer.byteLength(makeSample(high), 'utf8') < targetBytes) {
    high *= 2
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (Buffer.byteLength(makeSample(mid), 'utf8') < targetBytes) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  const upper = makeSample(low)
  const lower = low > 1 ? makeSample(low - 1) : upper
  return Math.abs(Buffer.byteLength(lower, 'utf8') - targetBytes) <=
    Math.abs(Buffer.byteLength(upper, 'utf8') - targetBytes) ? lower : upper
}

/** 单行 12 万字，加短段落作为滚动回收的目标区。 */
export function generateLongLineSample(chars = 120_000) {
  return ['# 超长行性能样例', '', '长行：' + '字'.repeat(chars), '',
    ...Array.from({ length: 120 }, (_, i) => [`滚动目标段落 ${i + 1}`, '']).flat()].join('\n')
}

/** 多个独立图片块，进入阅读视口时才挂载图片节点。 */
export function generateImageDenseSample(count = 240) {
  const out = ['# 图片密集性能样例', '']
  for (let i = 1; i <= count; i++) {
    out.push(`![图片 ${i}](./probe-${(i - 1) % 24}.svg)`, '')
  }
  return out.join('\n')
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

// 公式密集样例（工单 #59）：行内公式与跨行 $$ 块交替（渲染缓存命中率与
// 装饰/块表增量的成本载体）；普通段落穿插（编辑目标行，验证击键不因屏外
// 公式常驻 DOM 而劣化）。
export function generateMathDenseSample(blocks = 240) {
  const out = ['# 公式密集性能样例', '']
  for (let i = 1; i <= blocks; i++) {
    const kind = i % 4
    if (kind === 1) {
      out.push(`第 ${i} 段 正文含行内公式 $a_${i}^2 + b_${i}^2 = c_${i}^2$ 与第二处 $\\sum_{k=1}^{n} k$，普通美元 5 元不算公式。`, '')
    } else if (kind === 2) {
      out.push('$$', `I_${i} = \\int_0^1 x_${i}^2 \\, dx = \\frac{1}{3}`, '$$', '')
    } else if (kind === 3) {
      out.push(`第 ${i} 段 混排 $$E_${i} = mc^2$$ 段内块与行内 $\\alpha_${i}$ 相邻。`, '')
    } else {
      out.push(`第 ${i} 段 普通段落样本行，固定宽度内容，作为击键延迟的测量目标。`, '')
    }
  }
  return out.join('\n')
}

// 图表密集样例（工单 #60）：中小 mermaid 围栏（流程图/时序图交替，同源
// 重复触发缓存克隆改写）与普通段落交替——一屏多图的渲染串行成本、滚动
// 往返的挂载/回收与缓存命中、块卸载释放 DOM 的观测载体。
export function generateMermaidDenseSample(blocks = 120) {
  const out = ['# 图表密集性能样例', '']
  for (let i = 1; i <= blocks; i++) {
    if (i % 3 === 0) {
      out.push('```mermaid', 'sequenceDiagram', `A_${i}->>B_${i}: 请求 ${i}`, `B_${i}-->>A_${i}: 响应 ${i}`, '```', '')
    } else if (i % 3 === 1) {
      out.push('```mermaid', 'flowchart LR', `S${i}-->T${i}`, '```', '')
    } else {
      out.push(`第 ${i} 段 普通段落样本行，固定宽度内容，作为滚动与击键的测量锚点。`, '')
    }
  }
  out.push('结尾段落。', '')
  return out.join('\n')
}

// 代码块密集样例（工单 #85）：js/python 围栏与普通段落交替——卡片装饰
// 全量重建、高亮解析缓存命中与击键增量的宿主车道数据载体。
export function generateCodeDenseSample(blocks = 200) {
  const out = ['# 代码块密集性能样例', '']
  for (let i = 1; i <= blocks; i++) {
    const kind = i % 3
    if (kind === 1) {
      out.push(
        '```js', `// 模块 ${i}`, `import { data${i} } from './m${i}'`, '',
        `export function calc${i}(x) {`, `  const y = x * ${i} + data${i}.length`,
        '  // 常规注释行', `  return y > 0 ? \`值${i}=\${y}\` : null`, '}', '```', '',
      )
    } else if (kind === 2) {
      out.push(
        '```python', `def calc_${i}(x):`, `    data = load(${i})`, '    # 常规注释',
        `    return [v * ${i} for v in data if v > 0]`, '```', '',
      )
    } else {
      out.push(`第 ${i} 段 普通段落样本行，固定宽度内容，作为击键延迟的测量目标。`, '')
    }
  }
  out.push('结尾段落。', '')
  return out.join('\n')
}

// 超大代码围栏样例（工单 #85）：单一超过高亮行数上限（4096）的 js 围栏——
// 着色跳过降级与块内击键成本的观测载体。
export function generateCodeGiantFenceSample(lines = 6000) {
  const out = ['# 超大代码围栏样例', '', '```js']
  for (let i = 1; i <= lines; i++) {
    out.push(`const v${i} = compute(${i}); // 行 ${i}`)
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
