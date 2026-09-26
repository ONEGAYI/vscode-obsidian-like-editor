// 图形化代码块按钮组与图表弹窗 CSS 契约（#111）：钉住悬停显隐、渲染成功态
// 联动与浮层定位规则，防止样式表被误删后集成绘制层探针失去对应源规则。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

function rule(selector: string, declaration?: RegExp): string {
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? []
  const found = blocks.filter((block) => block.split('{')[0]?.trim().endsWith(selector) &&
    (declaration === undefined || declaration.test(block.split('{')[1] ?? '')))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!
}

describe('按钮组 CSS 契约（#111 契约 1）', () => {
  it('frame 承担定位宿主（position:relative）', () => {
    expect(rule('#app .vsidian-graphic-frame')).toMatch(/position:\s*relative/)
  })

  it('按钮组绝对定位右上且默认不占位（display:none 基线）', () => {
    expect(rule('#app .vsidian-graphic-chrome')).toMatch(/position:\s*absolute/)
    expect(rule('#app .vsidian-graphic-chrome')).toMatch(/top:\s*6px/)
    expect(rule('#app .vsidian-graphic-chrome')).toMatch(/right:\s*6px/)
    expect(rule('#app .vsidian-graphic-chrome')).toMatch(/display:\s*none/)
  })

  it('仅在渲染成功态显示（降级/装载态无按钮）', () => {
    expect(
      rule('#app .vsidian-mermaid[data-vsidian-mermaid-state="rendered"] ~ .vsidian-graphic-chrome'),
    ).toMatch(/display:\s*flex/)
  })

  it('按钮悬停 frame 或 focus-visible 才显现（默认透明不可见）', () => {
    const btn = rule('#app .vsidian-graphic-chrome button')
    expect(btn).toMatch(/opacity:\s*0/)
    expect(btn).toMatch(/visibility:\s*hidden/)
    expect(
      rule('#app .vsidian-graphic-frame:hover .vsidian-graphic-chrome button'),
    ).toMatch(/opacity:\s*1/)
    expect(
      rule('#app .vsidian-graphic-chrome button:focus-visible'),
    ).toMatch(/visibility:\s*visible/)
  })

  it('按钮配色走 VSCode 主题变量（明暗跟随）', () => {
    expect(rule('#app .vsidian-graphic-chrome button')).toMatch(
      /background:\s*var\(--vscode-editorWidget-background/,
    )
  })
})

describe('图表弹窗 CSS 契约（#111 契约 4–5）', () => {
  it('全屏模态浮层固定覆盖、层级高于编辑器', () => {
    expect(rule('.vsidian-diagram-overlay')).toMatch(/position:\s*fixed/)
    expect(rule('.vsidian-diagram-overlay')).toMatch(/z-index:\s*10000/)
  })

  it('stage 平移画布居中且不产生滚动条（overflow:hidden）', () => {
    expect(rule('.vsidian-diagram-stage')).toMatch(/overflow:\s*hidden/)
    expect(rule('.vsidian-diagram-stage')).toMatch(/justify-content:\s*center/)
  })

  it('SVG 不受 max-width 约束（缩放写实际尺寸的前提）', () => {
    expect(rule('.vsidian-diagram-media svg')).toMatch(/max-width:\s*none/)
  })

  it('工具条底部居中胶囊、按钮配色走主题变量', () => {
    expect(rule('.vsidian-diagram-toolbar')).toMatch(/bottom:\s*18px/)
    expect(rule('.vsidian-diagram-toolbar')).toMatch(/transform:\s*translateX\(-50%\)/)
    expect(rule('.vsidian-diagram-toolbar')).toMatch(
      /background:\s*var\(--vscode-editorWidget-background/,
    )
  })
})
