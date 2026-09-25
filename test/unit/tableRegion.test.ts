import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { planTableRegionDelete, planTableRegionReplace, serializeTableRegion, type TableRegion } from '../../src/webview/tableRegion'
import type { TableRowInfo } from '../../src/webview/tableStructure'

const doc = '正文前\n\n| 名字 | 数量 | 备注 |\n| --- | :---: | ---: |\n| 苹果 | 3 | 甲 |\n| 香蕉 | 5 | 乙\\|丙 |\n| 樱桃 | 7 | `a|b` |\n\n正文后'
const starts = doc.split('\n').reduce<number[]>((out) => {
  out.push((out.at(-1) ?? -1) + (out.length ? doc.split('\n')[out.length - 1]!.length + 1 : 1))
  return out
}, [])
const rows: TableRowInfo[] = [2, 3, 4, 5, 6].map((line, index) => ({
  kind: index === 0 ? 'header' : index === 1 ? 'delimiter' : 'row',
  lineFrom: starts[line]!, lineTo: starts[line]! + doc.split('\n')[line]!.length,
}))
const apply = (changes: Array<{ from: number; to: number; insert: string }>) =>
  [...changes].sort((a, b) => b.from - a.from).reduce((text, change) =>
    text.slice(0, change.from) + change.insert + text.slice(change.to), doc)
const region = (r0: number, r1: number, c0: number, c1: number): TableRegion =>
  ({ tableFrom: rows[0]!.lineFrom, rowFrom: r0, rowTo: r1, columnFrom: c0, columnTo: c1 })

describe('矩形单元格区域', () => {
  it('复制任意 2×2 区域：首选行成为表头，转义和中文原样保留', () => {
    expect(serializeTableRegion(doc, rows, region(1, 2, 1, 2))).toBe(
      '| 3 | 甲 |\n| --- | --- |\n| 5 | 乙\\|丙 |',
    )
  })

  it('复制含代码片段裸管道的格区仍能被标准 Markdown 解析成表格', () => {
    const markdown = serializeTableRegion(doc, rows, region(2, 3, 1, 2))!
    const html = new MarkdownIt().render(markdown)
    expect(html).toContain('<table>')
    expect(html).toContain('a|b')
    expect(html).toContain('乙|丙')
  })

  it('局部矩形只清被选格，保留其余格和表格结构', () => {
    const plan = planTableRegionDelete(doc, rows, region(1, 2, 1, 2))!
    const after = apply(plan.changes)
    expect(after).toContain('| 苹果 |  |  |\n| 香蕉 |  |  |\n| 樱桃 | 7 | `a|b` |')
    expect(after).toMatch(/^正文前\n\n/)
    expect(after).toMatch(/\n\n正文后$/)
  })

  it('整行删除包含表头时，下一行晋升并保留原分隔行', () => {
    const after = apply(planTableRegionDelete(doc, rows, region(0, 0, 0, 2))!.changes)
    expect(after).toContain('| 苹果 | 3 | 甲 |\n| --- | :---: | ---: |\n| 香蕉 |')
    expect(after).not.toContain('| 名字 |')
  })

  it('满列删除同步删除对齐段，未选列原样保留', () => {
    const after = apply(planTableRegionDelete(doc, rows, region(0, 3, 1, 1))!.changes)
    expect(after).toContain('| 名字 | 备注 |\n| --- | ---: |\n| 苹果 | 甲 |')
    expect(after).toContain('| 香蕉 | 乙\\|丙 |')
  })

  it('整表与最后一列删除表格，保留前后正文', () => {
    const after = apply(planTableRegionDelete(doc, rows, region(0, 3, 0, 2))!.changes)
    expect(after).toBe('正文前\n\n\n\n正文后')
  })

  it('无 padding 的紧凑表格清首格仍保持两列可解析', () => {
    const compact = 'H1|H2\n---|---\nB1|B2'
    const compactRows: TableRowInfo[] = [
      { kind: 'header', lineFrom: 0, lineTo: 5 },
      { kind: 'delimiter', lineFrom: 6, lineTo: 13 },
      { kind: 'row', lineFrom: 14, lineTo: 19 },
    ]
    const change = planTableRegionDelete(compact, compactRows,
      { tableFrom: 0, rowFrom: 1, rowTo: 1, columnFrom: 0, columnTo: 0 })!.changes
    const after = [...change].sort((a, b) => b.from - a.from).reduce((text, item) =>
      text.slice(0, item.from) + item.insert + text.slice(item.to), compact)
    expect(after).toBe('H1|H2\n---|---\n| |B2|')
  })

  it('区域键入只在左上格插字，其余被选格清空，未选格保持且不删行列', () => {
    const plan = planTableRegionReplace(doc, rows, region(1, 2, 1, 2), 'X|换行\n后续')!
    const after = apply(plan.changes)
    expect(after).toContain('| 苹果 | X\\|换行<br>后续 |  |\n| 香蕉 |  |  |')
    expect(after).toContain('| 樱桃 | 7 | `a|b` |')
    expect(after.slice(plan.selection - 2, plan.selection)).toBe('后续')
  })
})
