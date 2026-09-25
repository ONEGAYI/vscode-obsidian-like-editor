// 公式绘制 CSS 契约（工单 #59）：钉住 main.css 末尾公式区块的关键规则——
// live 块级公式布局、阅读块级容器、编辑态源码显形与降级态样式。真实宿主
// 的 computed style / elementFromPoint 断言在集成 paint.math 与 cssProbe
// （liveMathFontFamily 含 KaTeX 字体族）；此处防止样式表被误删或只剩类名。
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

describe('公式渲染 CSS 契约（#59）', () => {
  it('live 块级公式独立成块并居中，横向溢出走滚动不折行', () => {
    const block = rule('#app .cm-editor .cm-content .vsidian-math-block')
    expect(block).toMatch(/display:\s*block/)
    expect(block).toMatch(/text-align:\s*center/)
    expect(block).toMatch(/overflow-x:\s*auto/)
  })

  it('live 行内公式继承编辑器前景色（明暗主题跟随）', () => {
    expect(rule('#app .cm-editor .cm-content .vsidian-math'))
      .toMatch(/color:\s*var\(--vscode-editor-foreground/)
  })

  it('阅读块级公式容器带垂直 margin 与居中', () => {
    const reading = rule('#app .vsidian-view-reading .katex-block')
    expect(reading).toMatch(/margin:\s*0\.75em 0/)
    expect(reading).toMatch(/text-align:\s*center/)
    expect(reading).toMatch(/overflow-x:\s*auto/)
  })

  it('编辑态源码显形有着色与浅底（光标进入公式的可读源码）', () => {
    const source = rule('#app .cm-editor .cm-content .vsidian-math-source')
    expect(source).toMatch(/color:\s*var\(--vscode-textPreformat-foreground/)
    expect(source).toMatch(/background-color:\s*var\(--vsidian-math-source-background/)
  })

  it('降级态可读：错误色 + 浅红底 + 等宽字体（live 与阅读共用声明块）', () => {
    // main.css 中 live/阅读两个选择器共用一个声明块（块尾为阅读侧选择器）
    const fallback = rule('#app .vsidian-view-reading .vsidian-math-error')
    expect(fallback).toMatch(/color:\s*var\(--vscode-editorError-foreground/)
    expect(fallback).toMatch(/background-color:\s*var\(--vsidian-math-error-background/)
    expect(fallback).toMatch(/font-family:\s*var\(--vscode-editor-font-family/)
    // live 侧选择器在同一块内（共享规则）
    expect(fallback.split('{')[0]).toContain('#app .cm-editor .cm-content .vsidian-math-error')
  })
})
