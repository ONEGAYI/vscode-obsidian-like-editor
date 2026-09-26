// 列表/引用行前缀形态学契约（工单 #119/#120）：Enter 延续与退格清层、
// Tab/Shift+Tab 行缩进共用的纯函数单一事实源。断言口径为「前缀如何
// 解析、延续成什么、剥哪一层、缩进单位多宽」——三族键位变换对同一
// 形态必须得到同一判定，否则延续与清层会互相打架。
import { describe, it, expect } from 'vitest'
import {
  parseLinePrefix,
  continuePrefix,
  stripLayer,
  blankExitCut,
  indentUnitOf,
  dedentCutOf,
} from '../../src/shared/listPrefix'

describe('parseLinePrefix 行前缀解析', () => {
  it('无序三族：标记与标记后空白构成 mark，quote/indent 为空', () => {
    expect(parseLinePrefix('- a')).toMatchObject({
      quote: '', indent: '', mark: '- ', list: { bullet: '-' },
    })
    expect(parseLinePrefix('* a')!.mark).toBe('* ')
    expect(parseLinePrefix('+ a')!.mark).toBe('+ ')
  })

  it('有序：编号原文与分隔符保留，前导零不丢', () => {
    const p = parseLinePrefix('01. a')!
    expect(p.mark).toBe('01. ')
    expect(p.list).toMatchObject({ digits: '01', delim: '.' })
    expect(parseLinePrefix('9) a')!.list).toMatchObject({ digits: '9', delim: ')' })
  })

  it('任务：勾选态与任务标记后空白入 mark', () => {
    const p = parseLinePrefix('- [x] a')!
    expect(p.mark).toBe('- [x] ')
    expect(p.list!.task).toEqual({ checked: true, gap2: ' ' })
    const unchecked = parseLinePrefix('- [ ] a')!
    expect(unchecked.mark).toBe('- [ ] ')
    expect(unchecked.list!.task).toEqual({ checked: false, gap2: ' ' })
  })

  it('引用：单层、无空格紧贴、嵌套', () => {
    expect(parseLinePrefix('> a')).toMatchObject({ quote: '> ', mark: '', list: null })
    expect(parseLinePrefix('>>a')!.quote).toBe('>>')
    expect(parseLinePrefix('> > a')!.quote).toBe('> > ')
  })

  it('引用内列表：quote 与 mark 同时存在；引用层后缩进归 indent', () => {
    expect(parseLinePrefix('> - a')).toMatchObject({ quote: '> ', mark: '- ' })
    expect(parseLinePrefix('>   - a')).toMatchObject({ quote: '> ', indent: '  ', mark: '- ' })
    expect(parseLinePrefix('> 1. a')).toMatchObject({ quote: '> ', mark: '1. ' })
  })

  it('列表缩进归 indent（含行首缩进的引用）', () => {
    expect(parseLinePrefix('  - a')).toMatchObject({ quote: '', indent: '  ', mark: '- ' })
    expect(parseLinePrefix('    - a')!.indent).toBe('    ')
    expect(parseLinePrefix('  > a')!.quote).toBe('  > ')
  })

  it('普通行与伪前缀返回 null（无空格标记、无标记行）', () => {
    expect(parseLinePrefix('plain')).toBeNull()
    expect(parseLinePrefix('')).toBeNull()
    expect(parseLinePrefix('-item')).toBeNull()
    expect(parseLinePrefix('1.item')).toBeNull()
    expect(parseLinePrefix('1 . item')).toBeNull()
  })

  it('标记后空白不止一个全部入 mark', () => {
    expect(parseLinePrefix('-  a')!.mark).toBe('-  ')
    expect(parseLinePrefix('1.  a')!.mark).toBe('1.  ')
  })

  it('任务标记无尾随空白时须行尾才算任务；否则归正文', () => {
    expect(parseLinePrefix('- [x]')!.mark).toBe('- [x]')
    expect(parseLinePrefix('- [x]')!.list!.task).toEqual({ checked: true, gap2: '' })
    const inline = parseLinePrefix('- [x]a')!
    expect(inline.mark).toBe('- ')
    expect(inline.list!.task).toBeNull()
  })

  it('独行裸标记是合法空项形态', () => {
    expect(parseLinePrefix('-')!.mark).toBe('-')
    expect(parseLinePrefix('1.')!.mark).toBe('1.')
    expect(parseLinePrefix('>')!.quote).toBe('>')
  })
})

describe('continuePrefix 延续前缀重建', () => {
  it('无序原样延续（含多空格与缩进）', () => {
    expect(continuePrefix(parseLinePrefix('- a')!)).toBe('- ')
    expect(continuePrefix(parseLinePrefix('* a')!)).toBe('* ')
    expect(continuePrefix(parseLinePrefix('+ a')!)).toBe('+ ')
    expect(continuePrefix(parseLinePrefix('-  a')!)).toBe('-  ')
    expect(continuePrefix(parseLinePrefix('  - a')!)).toBe('  - ')
  })

  it('有序编号 +1 并保留宽度；超宽自然增长', () => {
    expect(continuePrefix(parseLinePrefix('1. a')!)).toBe('2. ')
    expect(continuePrefix(parseLinePrefix('9. a')!)).toBe('10. ')
    expect(continuePrefix(parseLinePrefix('01. a')!)).toBe('02. ')
    expect(continuePrefix(parseLinePrefix('099. a')!)).toBe('100. ')
    expect(continuePrefix(parseLinePrefix('1) a')!)).toBe('2) ')
  })

  it('任务新项固定未勾选', () => {
    expect(continuePrefix(parseLinePrefix('- [x] a')!)).toBe('- [ ] ')
    expect(continuePrefix(parseLinePrefix('- [ ] a')!)).toBe('- [ ] ')
  })

  it('有序任务组合：编号 +1 且任务重置', () => {
    expect(continuePrefix(parseLinePrefix('1. [x] a')!)).toBe('2. [ ] ')
  })

  it('纯引用行延续引用前缀（原样含嵌套）', () => {
    expect(continuePrefix(parseLinePrefix('> a')!)).toBe('> ')
    expect(continuePrefix(parseLinePrefix('>>a')!)).toBe('>>')
    expect(continuePrefix(parseLinePrefix('> > a')!)).toBe('> > ')
  })

  it('引用内列表延续完整结构前缀', () => {
    expect(continuePrefix(parseLinePrefix('> - a')!)).toBe('> - ')
    expect(continuePrefix(parseLinePrefix('> 1. a')!)).toBe('> 2. ')
    expect(continuePrefix(parseLinePrefix('>   - a')!)).toBe('>   - ')
  })
})

describe('stripLayer 退格分层', () => {
  it('顶级列表项一次清除整段标记（含缩进）', () => {
    expect(stripLayer(parseLinePrefix('- a')!, null)).toEqual({ kind: 'clear' })
    expect(stripLayer(parseLinePrefix('  - a')!, null)).toEqual({ kind: 'clear' })
    expect(stripLayer(parseLinePrefix('1. a')!, null)).toEqual({ kind: 'clear' })
  })

  it('嵌套项升一级：缩进对齐父项标记列', () => {
    expect(stripLayer(parseLinePrefix('  - b')!, 0)).toEqual({ kind: 'dedent', insert: '- ' })
    expect(stripLayer(parseLinePrefix('    - c')!, 2)).toEqual({ kind: 'dedent', insert: '  - ' })
    expect(stripLayer(parseLinePrefix('   - b')!, 0)).toEqual({ kind: 'dedent', insert: '- ' })
  })

  it('父项标记列不比当前缩进浅时不减缩进，走清整段', () => {
    expect(stripLayer(parseLinePrefix('  - b')!, 2)).toEqual({ kind: 'clear' })
    expect(stripLayer(parseLinePrefix('  - b')!, 3)).toEqual({ kind: 'clear' })
  })

  it('引用内顶级列表清标记保留引用前缀', () => {
    expect(stripLayer(parseLinePrefix('> - a')!, null)).toEqual({ kind: 'clear' })
  })

  it('引用内嵌套项升级保留引用前缀', () => {
    expect(stripLayer(parseLinePrefix('>   - b')!, 0)).toEqual({ kind: 'dedent', insert: '> - ' })
  })

  it('纯引用行剥一层（无空格紧贴只剥一个字符）', () => {
    expect(stripLayer(parseLinePrefix('> a')!, null)).toEqual({ kind: 'unquote', width: 2 })
    expect(stripLayer(parseLinePrefix('> > a')!, null)).toEqual({ kind: 'unquote', width: 2 })
    expect(stripLayer(parseLinePrefix('>>a')!, null)).toEqual({ kind: 'unquote', width: 1 })
  })
})

describe('blankExitCut 空项退出的删除区间（相对行首）', () => {
  it('空列表项删缩进与标记，保留引用前缀', () => {
    expect(blankExitCut(parseLinePrefix('- ')!)).toEqual({ from: 0, to: 2, cursor: 0 })
    expect(blankExitCut(parseLinePrefix('  - ')!)).toEqual({ from: 0, to: 4, cursor: 0 })
    expect(blankExitCut(parseLinePrefix('> - ')!)).toEqual({ from: 2, to: 4, cursor: 2 })
  })

  it('空引用行剥一层引用并清层后缩进', () => {
    expect(blankExitCut(parseLinePrefix('> ')!)).toEqual({ from: 0, to: 2, cursor: 0 })
    expect(blankExitCut(parseLinePrefix('> > ')!)).toEqual({ from: 0, to: 2, cursor: 2 })
    expect(blankExitCut(parseLinePrefix('>   ')!)).toEqual({ from: 0, to: 4, cursor: 0 })
    expect(blankExitCut(parseLinePrefix('>')!)).toEqual({ from: 0, to: 1, cursor: 0 })
  })
})

describe('indentUnitOf 行缩进单位（#120 Tab 一级缩进的落点与宽度）', () => {
  it('列表行：宽度取标记总宽（对齐父项内容起点），落点在引用前缀右端', () => {
    expect(indentUnitOf(parseLinePrefix('- a'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix('* a'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix('1. a'))).toEqual({ offset: 0, width: 3 })
    expect(indentUnitOf(parseLinePrefix('10. a'))).toEqual({ offset: 0, width: 4 })
    expect(indentUnitOf(parseLinePrefix('01. a'))).toEqual({ offset: 0, width: 4 })
    expect(indentUnitOf(parseLinePrefix('1) a'))).toEqual({ offset: 0, width: 3 })
    expect(indentUnitOf(parseLinePrefix('- [ ] a'))).toEqual({ offset: 0, width: 6 })
    expect(indentUnitOf(parseLinePrefix('- [x] a'))).toEqual({ offset: 0, width: 6 })
    expect(indentUnitOf(parseLinePrefix('-  a'))).toEqual({ offset: 0, width: 3 })
  })

  it('引用内列表：落点在引用前缀之后（缩进作用于列表层级）', () => {
    expect(indentUnitOf(parseLinePrefix('> - a'))).toEqual({ offset: 2, width: 2 })
    expect(indentUnitOf(parseLinePrefix('> > 1. a'))).toEqual({ offset: 4, width: 3 })
    expect(indentUnitOf(parseLinePrefix('>   - a'))).toEqual({ offset: 2, width: 2 })
  })

  it('普通行与纯引用行：行首固定 2 空格（对齐 CM6 indentUnit 默认）', () => {
    expect(indentUnitOf(parseLinePrefix('plain'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix(''))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix('-item'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix('> a'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix('> > a'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(parseLinePrefix('>>a'))).toEqual({ offset: 0, width: 2 })
    expect(indentUnitOf(null)).toEqual({ offset: 0, width: 2 })
  })
})

describe('dedentCutOf Shift+Tab 删除区间（相对行首，至多一级宽度）', () => {
  it('列表行删引用前缀右端的缩进', () => {
    const listUnit = (line: string) => indentUnitOf(parseLinePrefix(line))!
    expect(dedentCutOf('  - a', listUnit('  - a'))).toEqual({ from: 0, to: 2 })
    expect(dedentCutOf('    1. a', listUnit('    1. a'))).toEqual({ from: 0, to: 3 })
    expect(dedentCutOf('>   - a', listUnit('>   - a'))).toEqual({ from: 2, to: 4 })
    expect(dedentCutOf('>     10. a', listUnit('>     10. a'))).toEqual({ from: 2, to: 6 })
  })

  it('缩进不足一级宽度时全删（对齐 CM6 indentLess 至多删单位）', () => {
    const listUnit = (line: string) => indentUnitOf(parseLinePrefix(line))!
    expect(dedentCutOf(' - a', listUnit(' - a'))).toEqual({ from: 0, to: 1 })
    expect(dedentCutOf('  plain', indentUnitOf(null))).toEqual({ from: 0, to: 2 })
    expect(dedentCutOf(' plain', indentUnitOf(null))).toEqual({ from: 0, to: 1 })
    expect(dedentCutOf('    plain', indentUnitOf(null))).toEqual({ from: 0, to: 2 })
  })

  it('无缩进可删返回 null（该行不变）', () => {
    const listUnit = (line: string) => indentUnitOf(parseLinePrefix(line))!
    expect(dedentCutOf('- a', listUnit('- a'))).toBeNull()
    expect(dedentCutOf('> - a', listUnit('> - a'))).toBeNull()
    expect(dedentCutOf('plain', indentUnitOf(null))).toBeNull()
    expect(dedentCutOf('> a', indentUnitOf(parseLinePrefix('> a')))).toBeNull()
  })

  it('删除只吃空白字符，不越过正文首字符', () => {
    expect(dedentCutOf('  plain', indentUnitOf(null))).toEqual({ from: 0, to: 2 })
    expect(dedentCutOf('\tplain', indentUnitOf(null))).toEqual({ from: 0, to: 1 })
    expect(dedentCutOf(' \t- a', indentUnitOf(parseLinePrefix(' \t- a'))!)).toEqual({ from: 0, to: 2 })
  })
})
