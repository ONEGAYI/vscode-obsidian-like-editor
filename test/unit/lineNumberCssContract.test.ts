// @vitest-environment jsdom
// #34 行号布局契约（钉子测试）：main.css 的行号列规则是行号呈现的单一
// 事实源（流内列 + 固定间距 + 字号公式 + 首视觉行锚定），JS 侧已无对应
// 常量（旧 scaleX 降级机制随 24px 带宽约束移除）。本测试读 CSS 源文本
// 钉住关键规则不被无意改动，并反向钉住降级机制不得复活。
// jsdom 声明仅为与 syncController 其余测试同环境（模块顶层引
// @codemirror/view）；本测试自身只读文件、不触 DOM。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

// vitest 由仓库根启动（npm run test:unit），cwd 即仓库根；jsdom 环境下
// import.meta.url 非 file 协议不可用于定位源文件
const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

/** 提取唯一匹配（不匹配或多次匹配直接失败，提示维护点） */
function extractOne(label: string, pattern: RegExp): RegExpMatchArray {
  const matches = [...css.matchAll(pattern)]
  expect(
    matches.length,
    `main.css 中「${label}」应恰好出现一次（模式 ${String(pattern)}，实际 ${matches.length} 处）`,
  ).toBe(1)
  return matches[0]!
}

describe('行号列布局与 main.css 的一致（#34 流内列改造后）', () => {
  it('固定间距变量：--vsidian-ln-gap 随 VSCode UI 字号缩放（×2）', () => {
    extractOne(
      '行号间距变量',
      /--vsidian-ln-gap:\s*calc\(var\(--vscode-font-size,\s*13px\)\s*\*\s*2\)/g,
    )
  })

  it('流内列布局：.cm-gutters 以 --vsidian-ln-gap 作右侧间距，无外扩/叠加残留', () => {
    const rule = extractOne('行号列规则', /\.cm-gutters\s*\{[^}]*\}/g)
    expect(rule[0], '行号列应以间距变量与正文相隔（margin-right）').toMatch(
      /margin-right:\s*var\(--vsidian-ln-gap\)/,
    )
    // 旧叠加布局（负边距入留白带 + 固定栏宽 + overflow 裁剪）不得回流
    expect(rule[0], '行号列不得回退为留白带内叠加（负边距）').not.toMatch(/margin-left:\s*calc/)
    expect(rule[0]).not.toMatch(/width:\s*var\(--vsidian-content-padding-inline\)/)
    expect(rule[0]).not.toMatch(/overflow:\s*hidden/)
  })

  it('行号字号公式：min(0.75 × 正文基准, 12px)，基准内层回退 14px', () => {
    const formula = extractOne(
      '行号字号公式',
      /font-size:\s*min\(calc\(var\(--vsidian-content-font-size,\s*(\d+)px\)\s*\*\s*([\d.]+)\),\s*(\d+)px\)/g,
    )
    expect(Number.parseFloat(formula[1]!)).toBe(14)
    expect(Number.parseFloat(formula[2]!)).toBe(0.75)
    expect(Number.parseFloat(formula[3]!)).toBe(12)
  })

  it('行号垂直锚定首个视觉行：禁用折行块居中，top 基线偏移公式完整在场', () => {
    const rule = css.match(/\.cm-gutterElement\s*\{[^}]*\}/g)
    expect(rule, '.cm-gutterElement 规则应存在').toBeTruthy()
    const block = rule![0]!
    expect(block, '行号单元格不得垂直居中于整块（应锚定首个视觉行）').not.toMatch(
      /align-items:\s*center/,
    )
    // 钉完整机制（#116 基线对齐）：offset 用 position:relative + top 纯视觉
    // 偏移（top 不参与盒高——CM6 行号测量 dummy 与表格隐藏行格是
    // height:0 内联的 border-box，任何垂直 padding 都会把 0 高格撑开、
    // 逐格下推整列）；系数 1.1 × (正文 − 行号字号) 为 Arial/Segoe UI
    // 双环境实测中值（top=0 时数字基线高于正文 4.0/3.67px @14px 基准），
    // 集成几何断言按基线差 ≤1px 钉住——只改一侧会漏检错位
    expect(
      block,
      '行号单元格应有 position:relative + top 基线偏移公式',
    ).toMatch(
      /position:\s*relative;[\s\S]*?top:\s*calc\(\s*1\.1 \* \(var\(--vsidian-content-font-size[^)]*\)\s*-\s*min\(0\.75 \* var\(--vsidian-content-font-size[^)]*\),\s*12px\)\)/,
    )
    // padding 防线：通用规则不得出现非零垂直 padding（0 高格撑开回潮）
    expect(block, '行号单元格垂直 padding 必须为零（防 0 高格撑开）').toMatch(
      /padding-top:\s*0/,
    )
  })

  it('降级机制不得复活：无 scaleX 压缩、无 --vsidian-ln-scale 变量', () => {
    expect(css, '行号列宽随位数自适应，不得复活水平压缩').not.toMatch(
      /scaleX\(var\(--vsidian-ln-scale/,
    )
    expect(css).not.toContain('--vsidian-ln-scale:')
  })
})

describe('表格行号格补偿（#116：表后错位与表段首行对齐）', () => {
  it('分隔行行号格清零 padding-top：0 高记账格不得被任何垂直 padding 撑开', () => {
    const rule = extractOne(
      '分隔行行号格规则',
      /\.cm-gutterElement\.vsidian-ln-table-delimiter\s*\{[^}]*\}/g,
    )
    expect(rule[0], '分隔行格应清零 padding-top（height:0 的 border-box 盒不得小于 padding）')
      .toMatch(/padding-top:\s*0/)
  })

  it('表头行行号格偏移 = 通用基线偏移 + 单元格下移量变量', () => {
    const rule = extractOne(
      '表头行行号格规则',
      /\.cm-gutterElement\.vsidian-ln-table-header\s*\{[^}]*\}/g,
    )
    expect(
      rule[0],
      '表头行格应在通用 top 基线偏移基础上叠加单元格下移量',
    ).toMatch(
      /top:\s*calc\(\s*1\.1 \* \(var\(--vsidian-content-font-size[^)]*\)\s*-\s*min\(0\.75 \* var\(--vsidian-content-font-size[^)]*\),\s*12px\)\)\s*\+\s*var\(--vsidian-table-cell-shift\)/,
    )
  })

  it('单元格下移量变量与单元格 padding/border 字面值同源（改一处不改另一处即红）', () => {
    const shift = extractOne(
      '单元格下移量变量',
      /--vsidian-table-cell-shift:\s*calc\((\d+)px \+ (\d+)px\)/g,
    )
    const cellRule = extractOne(
      '表格单元格规则',
      /\.vsidian-table-grid-row > \.vsidian-table-grid-cell(?:\s*,[^{]*)?\s*\{[^}]*\}/g,
    )
    const pad = cellRule[0].match(/padding:\s*(\d+)px\s+(\d+)px/)
    expect(pad, `单元格规则应含字面 padding：${cellRule[0]}`).toBeTruthy()
    expect(shift[1], 'shift 第一分量应等于单元格 padding 块轴值').toBe(pad![1])
    const border = cellRule[0].match(/border:\s*(\d+)px solid/)
    expect(border, '单元格规则应含字面 border').toBeTruthy()
    expect(shift[2], 'shift 第二分量应等于单元格 border 宽度').toBe(border![1])
  })
})
