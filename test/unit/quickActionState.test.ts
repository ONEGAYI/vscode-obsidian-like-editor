import { describe, expect, it } from 'vitest'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { Text } from '@codemirror/state'
import { quickActionState } from '../../src/webview/quickActionState'

function state(text: string, op: Parameters<typeof quickActionState>[2], from: number, to = from) {
  return quickActionState(Text.of(text.split('\n')), markdownLanguage.parser.parse(text), op, { from, to }, null, true)
}

describe('快速操作可用状态', () => {
  it('同级标题保持已应用态，混合标题区间显示混合态', () => {
    expect(state('# 标题', 'heading1', 3)).toBe('active')
    expect(state('# 标题\n普通', 'heading1', 0, 7)).toBe('mixed')
    expect(state('标题\n===', 'heading1', 1)).toBe('active')
    expect(state('标题\n===', 'headingNone', 1)).toBe('inactive')
  })

  it('围栏内禁用行内格式；跨不同列表项显式围栏禁用', () => {
    const fenced = '```\ncode\n```'
    expect(state(fenced, 'bold', 5)).toBe('disabled')
    const list = '- 第一项\n- 第二项'
    expect(state(list, 'codeBlock', 2, list.length)).toBe('disabled')
  })

  it('已应用的粗体是可切换状态，阅读态禁用', () => {
    const text = '**中文**'
    const tree = markdownLanguage.parser.parse(text)
    const doc = Text.of([text])
    expect(quickActionState(doc, tree, 'bold', { from: 3, to: 3 }, null, true)).toBe('active')
    expect(quickActionState(doc, tree, 'bold', { from: 3, to: 3 }, null, false)).toBe('disabled')
  })

  it('矩形格区按各格汇总应用与混合状态，块级按钮禁用', () => {
    const text = '| **A** | B |\n| --- | --- |\n| **x** | y |'
    const doc = Text.of(text.split('\n'))
    const tree = markdownLanguage.parser.parse(text)
    const firstColumn = { tableFrom: 0, rowFrom: 0, rowTo: 1, columnFrom: 0, columnTo: 0 }
    const firstRow = { ...firstColumn, rowTo: 0, columnTo: 1 }
    expect(quickActionState(doc, tree, 'bold', { from: 0, to: 0 }, firstColumn, true)).toBe('active')
    expect(quickActionState(doc, tree, 'bold', { from: 0, to: 0 }, firstRow, true)).toBe('mixed')
    expect(quickActionState(doc, tree, 'italic', { from: 0, to: 0 }, firstColumn, true)).toBe('inactive')
    expect(quickActionState(doc, tree, 'clearInline', { from: 0, to: 0 }, firstColumn, true)).toBe('inactive')
    expect(quickActionState(doc, tree, 'codeBlock', { from: 0, to: 0 }, firstColumn, true)).toBe('disabled')
    expect(quickActionState(doc, tree, 'inlineMath', { from: 0, to: 0 }, firstColumn, true)).toBe('inactive')
    expect(quickActionState(doc, tree, 'blockMath', { from: 0, to: 0 }, firstColumn, true)).toBe('disabled')
  })

  it('表格单元格禁用块级公式，普通段落允许公式', () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |'
    expect(state(table, 'blockMath', table.indexOf('x'))).toBe('disabled')
    expect(state('公式', 'blockMath', 1)).toBe('inactive')
    expect(state('公式', 'inlineMath', 1)).toBe('inactive')
  })
})
