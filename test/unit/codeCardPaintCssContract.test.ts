// 代码块卡片绘制 CSS 契约（工单 #79）：真实宿主的 computed style 与命中
// 测试验证实际呈现（集成 paint.code 探针），此处钉住对应源规则，防止样式
// 表被误删或只剩 DOM 类名而集成探针失效。
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

describe('代码块卡片 CSS 契约（#79）', () => {
  it('卡片行底色走公开变量 --vsidian-code-card-background（回落主题变量）', () => {
    expect(rule('#app .cm-editor .cm-scroller .cm-line.vsidian-code-card-line'))
      .toMatch(/background-color:\s*var\(--vsidian-code-card-background/)
  })

  it('变量默认值回落 VSCode 代码块背景（#app 根定义）', () => {
    expect(css).toMatch(/--vsidian-code-card-background:\s*var\(--vscode-textCodeBlock-background/)
  })

  it('首尾行圆角修饰存在（头部承担顶边，尾行承担底边）', () => {
    expect(rule('#app .cm-editor .cm-scroller .cm-line.vsidian-code-card-line.vsidian-code-card-edge-bottom'))
      .toMatch(/border-bottom-left-radius:\s*6px/)
    expect(rule('#app .cm-editor .cm-scroller .cm-line.vsidian-code-card-line.vsidian-code-card-edge-top'))
      .toMatch(/border-top-left-radius:\s*6px/)
  })

  it('头部横带：flex 布局、顶边圆角、底部分隔线、底色同源', () => {
    const header = rule('#app .cm-editor .cm-scroller .vsidian-code-card-header')
    expect(header).toMatch(/display:\s*flex/)
    expect(header).toMatch(/border-radius:\s*6px 6px 0 0/)
    expect(header).toMatch(/border-bottom:\s*1px solid var\(--vscode-editorGroup-border/)
    expect(header).toMatch(/background-color:\s*var\(--vsidian-code-card-background/)
  })

  it('语言标签加粗；按钮区内联排布（#81 复用容器）', () => {
    expect(rule('#app .cm-editor .cm-scroller .vsidian-code-card-header .vsidian-code-card-header-label'))
      .toMatch(/font-weight:\s*600/)
    expect(rule('#app .cm-editor .cm-scroller .vsidian-code-card-header .vsidian-code-card-header-actions'))
      .toMatch(/display:\s*inline-flex/)
  })

  it('卡内行号：右对齐、颜色与文档行号槽同源、禁选（#80）', () => {
    const ln = rule('#app .cm-editor .cm-scroller .vsidian-code-card-linenumber')
    expect(ln).toMatch(/display:\s*inline-block/)
    expect(ln).toMatch(/text-align:\s*right/)
    expect(ln).toMatch(/color:\s*var\(--vscode-editorLineNumber-foreground/)
    expect(ln).toMatch(/user-select:\s*none/)
  })
})
