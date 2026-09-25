// Mermaid 绘制 CSS 契约（#60）：真实宿主的 computed style 与命中测试验证
// 实际呈现（集成 paint.mermaid 探针），此处钉住对应源规则，防止样式表被
// 误删或只剩 DOM 类名而集成探针失效。
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

describe('Mermaid 容器与降级态 CSS 契约（#60）', () => {
  it('渲染容器块级占位且水平可滚（宽图不遮挡周围文本）', () => {
    expect(rule('#app .vsidian-mermaid')).toMatch(/display:\s*block/)
    expect(rule('#app .vsidian-mermaid')).toMatch(/overflow-x:\s*auto/)
  })

  it('SVG 宽度受容器约束（max-width 100%、高度等比）', () => {
    expect(rule('#app .vsidian-mermaid svg')).toMatch(/max-width:\s*100%/)
    expect(rule('#app .vsidian-mermaid svg')).toMatch(/height:\s*auto/)
  })

  it('降级态错误标记走 VSCode 主题变量（明暗可读、左对齐不外溢）', () => {
    const error = rule('#app .vsidian-mermaid.vsidian-mermaid-error')
    expect(error).toMatch(/border-left:\s*2px solid var\(--vscode-editorError-foreground/)
    expect(error).toMatch(/text-align:\s*left/)
    expect(rule('#app .vsidian-mermaid .vsidian-mermaid-error-message'))
      .toMatch(/color:\s*var\(--vscode-editorError-foreground/)
    expect(rule('#app .vsidian-mermaid .vsidian-mermaid-error-source'))
      .toMatch(/font-family:\s*var\(--vscode-editor-font-family/)
    expect(rule('#app .vsidian-mermaid .vsidian-mermaid-error-source'))
      .toMatch(/white-space:\s*pre-wrap/)
  })
})
