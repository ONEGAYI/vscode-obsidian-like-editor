// 表格绘制 CSS 契约：真实宿主的 computed style 与命中测试验证实际呈现，
// 此处钉住对应源规则，防止样式表被误删或只剩 DOM 类名而集成探针失效。
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

describe('表格网格与选中轮廓 CSS 契约（#42/#43）', () => {
  it('单元格按等宽网格绘制且边框和内容不会被隐藏', () => {
    expect(rule('.vsidian-table-grid-row')).toMatch(/display:\s*grid/)
    expect(rule('.vsidian-table-grid-row')).toMatch(
      /grid-template-columns:\s*repeat\(var\(--vsidian-table-columns\),\s*minmax\(0,\s*1fr\)\)/,
    )
    const cell = rule('.vsidian-table-grid-row > .cm-widgetBuffer + .vsidian-table-grid-cell')
    expect(cell).toMatch(/border:\s*1px solid var\(--vscode-panel-border/)
    expect(cell).toMatch(/white-space:\s*pre-wrap/)
    expect(cell).not.toMatch(/display:\s*none/)
  })

  it('选中行外框及行列浅色高亮保留主题焦点色', () => {
    const row = rule('.vsidian-table-grid-row.vsidian-table-row-selected')
    expect(row).toMatch(/outline:\s*2px solid var\(--vscode-focusBorder/)
    expect(row).toMatch(/border-radius:\s*6px/)
    const fill = rule('.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-selected', /background:/)
    expect(fill).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--vscode-focusBorder/)
  })

  it('选中列两侧与首末端闭合为 2px 外轮廓', () => {
    const column = rule('.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-selected', /border-left:/)
    expect(column).toMatch(/border-left:\s*2px solid var\(--vscode-focusBorder/)
    expect(column).toMatch(/border-right:\s*2px solid var\(--vscode-focusBorder/)
    expect(rule('.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-first'))
      .toMatch(/border-top:\s*2px solid var\(--vscode-focusBorder/)
    expect(rule('.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-last'))
      .toMatch(/border-bottom:\s*2px solid var\(--vscode-focusBorder/)
  })

  it('抓手悬停时绘制出来', () => {
    expect(rule('.vsidian-table-controls button.vsidian-table-control-hover'))
      .toMatch(/opacity:\s*1/)
  })
})
