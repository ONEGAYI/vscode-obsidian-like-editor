// @vitest-environment jsdom
// #34 行号降级公式与 main.css 的双写钉子（契约测试）：
// syncController 的 LN_* 常量与 main.css 的留白带变量 / .cm-gutterElement
// 字号规则是同一知识的两处落点——CSS 管呈现（栏宽、字号、间隙），JS 管
// 降级档位计算（scale 公式的带宽与字号入参）。运行时读取不可行（CSS 变量
// 含 var() 引用时 getComputedStyle 返回原始声明文本而非解析值；读
// .cm-gutterElement 的 computed fontSize 又依赖元素在行号开启且视口渲染后
// 存在，早于档位计算的时点无元素可读），故以读 CSS 源文本 + 正则提值的
// 方式钉住两处一致：改任一侧而不改另一侧时本测试立即失配。
// jsdom 声明仅为与 syncController 其余测试同环境（模块顶层引
// @codemirror/view）；本测试自身只读文件、不触 DOM。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  LN_BAND_PX,
  LN_GAP_PX,
  LN_FONT_RATIO,
  LN_FONT_CAP_PX,
  LN_FONT_BASE_FALLBACK_PX,
} from '../../src/webview/syncController'

// vitest 由仓库根启动（npm run test:unit），cwd 即仓库根；jsdom 环境下
// import.meta.url 非 file 协议不可用于定位源文件
const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

/** 提取唯一匹配（不匹配或多次匹配直接失败，提示维护双写点） */
function extractOne(label: string, pattern: RegExp): RegExpMatchArray {
  const matches = [...css.matchAll(pattern)]
  expect(
    matches.length,
    `main.css 中「${label}」应恰好出现一次（模式 ${String(pattern)}，实际 ${matches.length} 处）`,
  ).toBe(1)
  return matches[0]!
}

function px(value: string | undefined): number {
  return Number.parseFloat(value ?? '')
}

describe('行号降级公式与 main.css 的双写一致（#34）', () => {
  it('留白带宽度：LN_BAND_PX 与 --vsidian-content-padding-inline 相等', () => {
    const band = extractOne('留白带变量', /--vsidian-content-padding-inline:\s*([\d.]+)px/g)
    expect(px(band[1])).toBe(LN_BAND_PX)
  })

  it('行号与正文间隙：LN_GAP_PX 与 .cm-gutterElement 右 padding 相等', () => {
    const gap = extractOne('行号单元格右 padding', /padding-right:\s*([\d.]+)px/g)
    expect(px(gap[1])).toBe(LN_GAP_PX)
  })

  it('行号垂直锚定首个视觉行：禁用折行块居中，顶部补偿公式在场', () => {
    // .cm-gutterElement 规则块内不得再出现 align-items: center——单元格
    // 高度与源码行块同步（软换行为多视觉行总高），垂直居中会把数字放到
    // 折行块中心（折 2 行低半行、折 3 行低整行，用户验收实测）
    const rule = css.match(/\.cm-gutterElement\s*\{[^}]*\}/g)
    expect(rule, '.cm-gutterElement 规则应存在').toBeTruthy()
    const block = rule![0]!
    expect(block, '行号单元格不得垂直居中于整块（应锚定首个视觉行）').not.toMatch(
      /align-items:\s*center/,
    )
    // 顶部锚定的半差补偿：(正文行高 − 行号行高) / 2，行高比两侧同为 1.5
    expect(
      block,
      '行号单元格应有首视觉行居中的 padding-top 补偿公式',
    ).toMatch(/padding-top:\s*calc\(\s*\(1\.5 \* var\(--vsidian-content-font-size\)/)
  })

  it('行号字号公式：回退基准/比例/上限与 .cm-lineNumbers 字号规则一致', () => {
    // font-size: min(calc(var(--vsidian-content-font-size, 14px) * 0.75), 12px)
    const formula = extractOne(
      '行号字号公式',
      /font-size:\s*min\(calc\(var\(--vsidian-content-font-size,\s*(\d+)px\)\s*\*\s*([\d.]+)\),\s*(\d+)px\)/g,
    )
    expect(px(formula[1])).toBe(LN_FONT_BASE_FALLBACK_PX)
    expect(px(formula[2])).toBe(LN_FONT_RATIO)
    expect(px(formula[3])).toBe(LN_FONT_CAP_PX)
    // 公式内层回退基准与 #app 变量组的内层回退也是同一知识（两处 14px）
    const baseVar = extractOne(
      '正文基准字号变量的内层回退',
      /--vsidian-content-font-size:\s*var\(--vscode-editor-font-size,\s*(\d+)px\)/g,
    )
    expect(px(baseVar[1])).toBe(LN_FONT_BASE_FALLBACK_PX)
  })
})
