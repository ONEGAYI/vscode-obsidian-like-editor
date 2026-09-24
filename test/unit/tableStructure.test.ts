// 表格键盘导航与增删行列契约（工单 #13）：纯函数层语义固定。
//
// 语义决策（首版，本文件锁定；上层 tableEditing/keymap 只做装配）：
// - Tab/Shift+Tab 单元格导航：Tab 定位下一单元格内容首，行末环绕到下一
//   表格行的首格；Shift+Tab 定位上一单元格内容尾，行首回退到上一表格行
//   的末格。分隔行参与导航序列（编辑面即源文本行）。表格首行首格的
//   Shift+Tab 与末行末格的 Tab 返回 null——上层交默认行为（不吞输入）。
// - 插入行：数据行上方/下方插入空数据行（单元格数 = 分隔行声明的列数）；
//   表头/分隔行上的上方/下方插入统一落到分隔行之后（表头与分隔行之间
//   或表头上方无法插入普通数据行——GFM 结构会退化）。
// - 删除行：数据行直接删（光标落相邻行同列格）；删表头 = 删除表头行文本，
//   首个数据行自然升为新表头、分隔行与对齐保留；最小表格（无数据行）删
//   表头拒绝；单独删分隔行拒绝（结构行——删除即拆表，超出本票）。
// - 插入列：在每行（含表头/分隔/数据行）的目标列位置以最小插入法插入空
//   单元格（分隔行插入 --- 段，对齐默认）；不重建行、既有单元格文本（含
//   转义管道与行内代码）逐字节保留。
// - 删除列：每行删除该列单元格及其前管道（无首边界管道时删其后管道）；
//   分隔行的对齐段同步删除；缺该列的行不动。
// - 一切操作的变更只落在表格行区间内：表格外的文本逐字节不变。
import { describe, it, expect } from 'vitest'
import {
  planTableEdit,
  planTableRowMove,
  tableCellNavTarget,
  type TableRowInfo,
} from '../../src/webview/tableStructure'

// 主样例：表格前后有普通段落（区域不变断言），表格含对齐全样例、空格
// 单元格外的常规形态。行内代码/转义管道的行在 col 语义上与常规行一致。
const DOC = [
  '前导段落。',
  '',
  '| 名字 | 数量 | 备注 |',
  '| --- | :---: | ---: |',
  '| 苹果 | 3 | 甲 |',
  '| `x|y` | 4 | 乙\\|丙 |',
  '',
  '结尾段落。',
].join('\n')

const KINDS: Array<'header' | 'delimiter' | 'row'> = ['header', 'delimiter', 'row', 'row']

/** 按行号（0 基）构造行结构（与解析树提取的行信息同构） */
function rowsOf(doc: string, lineNos: number[], kinds: Array<'header' | 'delimiter' | 'row'>): TableRowInfo[] {
  const texts = doc.split('\n')
  const starts: number[] = []
  let acc = 0
  for (const t of texts) {
    starts.push(acc)
    acc += t.length + 1
  }
  return lineNos.map((n, i) => ({
    kind: kinds[i]!,
    lineFrom: starts[n]!,
    lineTo: starts[n]! + texts[n]!.length,
  }))
}

const ROWS = rowsOf(DOC, [2, 3, 4, 5], KINDS)

/** 应用变更得到新文档（与 CM6 事务同语义） */
function apply(doc: string, changes: Array<{ from: number; to: number; insert: string }>): string {
  const sorted = [...changes].sort((a, b) => a.from - b.from)
  let out = ''
  let last = 0
  for (const c of sorted) {
    out += doc.slice(last, c.from) + c.insert
    last = c.to
  }
  return out + doc.slice(last)
}

const at = (needle: string, from = 0): number => DOC.indexOf(needle, from)

// ---- Tab / Shift+Tab 导航目标 ----

describe('tableCellNavTarget：单元格导航目标', () => {
  it('Tab：单元格内光标 → 下一单元格内容首', () => {
    // '| 苹果 | 3 | 甲 |' 中「苹果」首字符后
    const p = at('苹果') + 1
    expect(tableCellNavTarget(DOC, ROWS, p, true)).toBe(at('| 3 |') + 2)
  })

  it('Tab：行末单元格 → 下一表格行首格内容首（数据行间环绕）', () => {
    const p = at('甲') + 1
    expect(tableCellNavTarget(DOC, ROWS, p, true)).toBe(at('| `x|y` |') + 2)
  })

  it('Tab：表头行末格 → 分隔行首格（分隔行参与导航序列）', () => {
    const p = at('备注') + 1
    expect(tableCellNavTarget(DOC, ROWS, p, true)).toBe(at('| --- |') + 2)
  })

  it('Tab：表格末行末格 → null（边界交默认行为，不吞输入）', () => {
    const p = at('丙') + 1
    expect(tableCellNavTarget(DOC, ROWS, p, true)).toBeNull()
  })

  it('Shift+Tab：单元格内光标 → 上一单元格内容尾', () => {
    const p = at('3') + 1
    expect(tableCellNavTarget(DOC, ROWS, p, false)).toBe(at('苹果') + 2)
  })

  it('Shift+Tab：行首单元格 → 上一表格行末格内容尾', () => {
    const p = at('`x|y`') + 1
    expect(tableCellNavTarget(DOC, ROWS, p, false)).toBe(at('甲') + 1)
  })

  it('Shift+Tab：表格首行（表头）首格 → null', () => {
    expect(tableCellNavTarget(DOC, ROWS, at('名字') + 1, false)).toBeNull()
    // 行首管道上同理（首格定位）
    expect(tableCellNavTarget(DOC, ROWS, at('| 名字'), false)).toBeNull()
  })

  it('空单元格（| |）也是导航落点：光标落其内容区（闭合管道前）', () => {
    const doc = '| a | | b |\n| --- | --- | --- |\n| 1 | | 3 |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    // 'a' 后 Tab → 中间空单元格：contentFrom 位于空格与闭合管道之间
    const t = tableCellNavTarget(doc, rows, doc.indexOf('a') + 1, true)
    expect(t).toBe(doc.indexOf('| b |')) // 空单元格的闭合管道位置
  })

  it('转义管道不切分单元格：导航在含 \\| 的行上按单格移动', () => {
    // '| `x|y` | 4 | 乙\|丙 |'：首格「`x|y`」→ 次格「4」
    const p = at('`x|y`') + 2
    expect(tableCellNavTarget(DOC, ROWS, p, true)).toBe(at('| 4 |') + 2)
  })

  it('光标不在任何表格行上 → null', () => {
    expect(tableCellNavTarget(DOC, ROWS, at('前导段落'), true)).toBeNull()
    expect(tableCellNavTarget(DOC, ROWS, at('结尾段落'), false)).toBeNull()
  })
})

describe('planTableRowMove：点阵拖排行', () => {
  it('表头拖到末尾：首个数据行升为表头，分隔行与对齐声明原位不动', () => {
    const plan = planTableRowMove(DOC, ROWS, 0, 3)!
    expect(apply(DOC, plan.changes)).toBe([
      '前导段落。', '',
      '| 苹果 | 3 | 甲 |',
      '| --- | :---: | ---: |',
      '| `x|y` | 4 | 乙\\|丙 |',
      '| 名字 | 数量 | 备注 |',
      '', '结尾段落。',
    ].join('\n'))
    expect(plan.changes.every((c) => DOC.slice(c.from, c.to).indexOf('\n') < 0)).toBe(true)
  })

  it('末数据行拖到表头：空格、转义与代码内管道符逐字保留', () => {
    const plan = planTableRowMove(DOC, ROWS, 2, 0)!
    const after = apply(DOC, plan.changes)
    expect(after).toContain('| `x|y` | 4 | 乙\\|丙 |\n| --- | :---: | ---: |\n| 名字 | 数量 | 备注 |')
    expect(after.startsWith('前导段落。\n\n')).toBe(true)
    expect(after.endsWith('\n\n结尾段落。')).toBe(true)
  })

  it('首末边界与原位置落点：相邻不动，末数据行可移到第一数据行', () => {
    expect(planTableRowMove(DOC, ROWS, 0, 0)).toBeNull()
    expect(planTableRowMove(DOC, ROWS, 0, 1)).toBeNull()
    expect(planTableRowMove(DOC, ROWS, 2, 3)).toBeNull()
    expect(planTableRowMove(DOC, ROWS, 3, 0)).toBeNull()
    const plan = planTableRowMove(DOC, ROWS, 2, 1)!
    expect(apply(DOC, plan.changes)).toContain(
      '| 名字 | 数量 | 备注 |\n| --- | :---: | ---: |\n| `x|y` | 4 | 乙\\|丙 |\n| 苹果 | 3 | 甲 |',
    )
  })

  it('只替换行内容，CRLF 和结尾换行字节保持原状', () => {
    const doc = '前\r\n| a | b |\r\n| :--- | ---: |\r\n| 1 | |\r\n| 2 | x |\r\n尾\r\n'
    const lines = doc.split('\r\n')
    let offset = 0
    const rows: TableRowInfo[] = []
    for (let i = 0; i < lines.length; i++) {
      if (i >= 1 && i <= 4) {
        rows.push({
          kind: i === 1 ? 'header' : i === 2 ? 'delimiter' : 'row',
          lineFrom: offset,
          lineTo: offset + lines[i]!.length,
        })
      }
      offset += lines[i]!.length + 2
    }
    const plan = planTableRowMove(doc, rows, 2, 0)!
    expect(apply(doc, plan.changes)).toBe('前\r\n| 2 | x |\r\n| :--- | ---: |\r\n| a | b |\r\n| 1 | |\r\n尾\r\n')
    expect(plan.changes.every((c) => !/[\r\n]/.test(doc.slice(c.from, c.to)))).toBe(true)
  })
})

// ---- 插入行 ----

describe('planTableEdit：插入行', () => {
  it('数据行下方插入：空单元格数与分隔行列数一致，焦点落新行首格', () => {
    const plan = planTableEdit(DOC, ROWS, at('苹果') + 1, 'insertRowBelow')
    expect(plan).not.toBeNull()
    const after = apply(DOC, plan!.changes)
    // 表格外区域逐字节不变
    expect(after.startsWith('前导段落。\n\n| 名字 | 数量 | 备注 |\n| --- | :---: | ---: |\n| 苹果 | 3 | 甲 |\n')).toBe(true)
    expect(after.endsWith('\n| `x|y` | 4 | 乙\\|丙 |\n\n结尾段落。')).toBe(true)
    expect(after).toContain('| 苹果 | 3 | 甲 |\n| | | |')
    // 焦点：新行首格内容首（'| ' 之后）
    const newRowAt = after.indexOf('| | | |')
    expect(plan!.selection).toBe(newRowAt + 2)
  })

  it('数据行上方插入：落在该行之前', () => {
    const plan = planTableEdit(DOC, ROWS, at('`x|y`') + 1, 'insertRowAbove')
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| 苹果 | 3 | 甲 |\n| | | |\n| `x|y` | 4 | 乙\\|丙 |')
  })

  it('表头行上的上方/下方插入统一落到分隔行之后（表头上方/之间插数据行会拆表）', () => {
    const above = planTableEdit(DOC, ROWS, at('名字') + 1, 'insertRowAbove')!
    const below = planTableEdit(DOC, ROWS, at('名字') + 1, 'insertRowBelow')!
    const delim = planTableEdit(DOC, ROWS, at(':---:'), 'insertRowAbove')!
    for (const plan of [above, below, delim]) {
      const after = apply(DOC, plan.changes)
      expect(after).toContain('| --- | :---: | ---: |\n| | | |\n| 苹果 | 3 | 甲 |')
      expect(after).toContain('| 名字 | 数量 | 备注 |\n| --- | :---: | ---: |')
    }
  })

  it('末数据行下方插入：表格末尾追加（含换行处理），后续段落不变', () => {
    const plan = planTableEdit(DOC, ROWS, at('丙') + 1, 'insertRowBelow')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| `x|y` | 4 | 乙\\|丙 |\n| | | |\n\n结尾段落。')
  })

  it('最小表格（表头+分隔行，无数据行）：插入落到分隔行后', () => {
    const doc = '# 题\n\n| a | b |\n| --- | --- |\n\n尾段。\n'
    const rows = rowsOf(doc, [2, 3], ['header', 'delimiter'])
    const plan = planTableEdit(doc, rows, doc.indexOf('a') + 1, 'insertRowBelow')!
    const after = apply(doc, plan.changes)
    expect(after).toContain('| a | b |\n| --- | --- |\n| | |\n\n尾段。')
  })

  it('单列表格：新行单元格数同样跟随分隔行', () => {
    const doc = '| a |\n| --- |\n| 1 |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    const plan = planTableEdit(doc, rows, doc.indexOf('1') + 1, 'insertRowAbove')!
    const after = apply(doc, plan.changes)
    expect(after).toBe('| a |\n| --- |\n| |\n| 1 |\n')
  })
})

// ---- 删除行 ----

describe('planTableEdit：删除行', () => {
  it('删除数据行：该行移除，焦点落相邻行同列格内容首', () => {
    const plan = planTableEdit(DOC, ROWS, at('苹果') + 1, 'deleteRow')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| --- | :---: | ---: |\n| `x|y` | 4 | 乙\\|丙 |')
    expect(after).not.toContain('苹果')
    // 相邻行（被删行的下一行）同列（首列）内容首
    expect(plan.selection).toBe(after.indexOf('`x|y`'))
  })

  it('删除末数据行：焦点落上一行同列格', () => {
    const plan = planTableEdit(DOC, ROWS, at('乙') + 1, 'deleteRow')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| 苹果 | 3 | 甲 |\n\n结尾段落。')
    // 光标原在末行列 2（乙），删除后落在上一行列 2（甲）内容首
    expect(plan.selection).toBe(after.indexOf('甲'))
  })

  it('删除表头行：首个数据行升为新表头，分隔行随移到升格行之后、对齐保留', () => {
    const plan = planTableEdit(DOC, ROWS, at('名字') + 1, 'deleteRow')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| 苹果 | 3 | 甲 |\n| --- | :---: | ---: |\n| `x|y` | 4 | 乙\\|丙 |')
    expect(after).not.toContain('名字')
    // 焦点：新表头行同列（首列）内容首
    expect(plan!.selection).toBe(after.indexOf('苹果'))
  })

  it('最小表格删表头：拒绝（无数据行可升格，零变更）', () => {
    const doc = '| a | b |\n| --- | --- |\n'
    const rows = rowsOf(doc, [0, 1], ['header', 'delimiter'])
    expect(planTableEdit(doc, rows, doc.indexOf('a'), 'deleteRow')).toBeNull()
  })

  it('单独删分隔行：拒绝（结构行，删除即拆表）', () => {
    expect(planTableEdit(DOC, ROWS, at(':---:'), 'deleteRow')).toBeNull()
  })

  it('删除表格唯一数据行后保留最小表格（表头+分隔行）', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    const plan = planTableEdit(doc, rows, doc.indexOf('1'), 'deleteRow')!
    expect(apply(doc, plan.changes)).toBe('| a | b |\n| --- | --- |\n')
  })
})

// ---- 插入/删除列 ----

describe('planTableEdit：插入列', () => {
  it('在列右侧插入：全部行（表头/分隔/数据）同步插入空单元格，分隔行补 --- 段', () => {
    const plan = planTableEdit(DOC, ROWS, at('苹果') + 1, 'insertColumnRight')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| 名字 | | 数量 | 备注 |')
    expect(after).toContain('| --- | --- | :---: | ---: |')
    expect(after).toContain('| 苹果 | | 3 | 甲 |')
    expect(after).toContain('| `x|y` | | 4 | 乙\\|丙 |')
    // 焦点：光标行（苹果行）的新列空单元格内
    const rowAt = after.indexOf('| 苹果 | |')
    expect(plan.selection).toBe(rowAt + after.slice(rowAt).indexOf('| |') + 2)
    // 表格外不变
    expect(after.startsWith('前导段落。')).toBe(true)
    expect(after.endsWith('结尾段落。')).toBe(true)
  })

  it('在列左侧插入：新列成为首列', () => {
    const plan = planTableEdit(DOC, ROWS, at('名字') + 1, 'insertColumnLeft')!
    const after = apply(DOC, plan.changes)
    expect(after).toContain('| | 名字 | 数量 | 备注 |')
    expect(after).toContain('| --- | --- | :---: | ---: |')
  })

  it('末列右侧插入：追加到行尾；转义管道与行内代码单元格逐字节保留', () => {
    const plan = planTableEdit(DOC, ROWS, at('丙') + 1, 'insertColumnRight')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| `x|y` | 4 | 乙\\|丙 | |')
    expect(after).toContain('| --- | :---: | ---: | --- |')
  })

  it('缺列的行（单元格数少于分隔行）：新列追加到该行行尾', () => {
    const doc = '| a | b | c |\n| --- | --- | --- |\n| 1 |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    const plan = planTableEdit(doc, rows, doc.indexOf('b') + 1, 'insertColumnRight')!
    const after = apply(doc, plan.changes)
    expect(after).toBe('| a | b | | c |\n| --- | --- | --- | --- |\n| 1 | |\n')
  })

  it('省略边界管道的行：插入位置语义正确（不依赖首尾管道）', () => {
    const doc = 'a | b\n--- | ---\n1 | 2\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    const plan = planTableEdit(doc, rows, doc.indexOf('a') + 1, 'insertColumnRight')!
    const after = apply(doc, plan.changes)
    // 各行均为 3 格（GFM 拆分口径验证）
    const lines = after.split('\n')
    expect(lines[0]!.split('|')).toHaveLength(3)
    expect(lines[1]!.split('|')).toHaveLength(3)
    expect(lines[2]!.split('|')).toHaveLength(3)
  })
})

describe('planTableEdit：删除列', () => {
  it('删除中间列：每行移除该单元格及其前管道，分隔行对齐段同步删除', () => {
    const plan = planTableEdit(DOC, ROWS, at('数量') + 1, 'deleteColumn')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| 名字 | 备注 |')
    expect(after).toContain('| --- | ---: |')
    expect(after).toContain('| 苹果 | 甲 |')
    expect(after).toContain('| `x|y` | 乙\\|丙 |')
    // 焦点：光标行删除后同位置列（原列 1 删除 → 「备注」列上移为列 1）
    expect(plan.selection).toBe(after.indexOf('备注'))
  })

  it('删除首列：保留各行其余单元格', () => {
    const plan = planTableEdit(DOC, ROWS, at('苹果') + 1, 'deleteColumn')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| 数量 | 备注 |')
    expect(after).toContain('| :---: | ---: |')
    expect(after).toContain('| 3 | 甲 |')
    expect(after).toContain('| 4 | 乙\\|丙 |')
  })

  it('删除末列：含转义管道的内容行保真', () => {
    const plan = planTableEdit(DOC, ROWS, at('丙') + 1, 'deleteColumn')!
    const after = apply(DOC, plan!.changes)
    expect(after).toContain('| `x|y` | 4 |')
    expect(after).toContain('| --- | :---: |')
  })

  it('省略边界管道的行：首列删除不越界', () => {
    const doc = 'a | b\n--- | ---\n1 | 2\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    const plan = planTableEdit(doc, rows, doc.indexOf('a') + 1, 'deleteColumn')!
    const after = apply(doc, plan.changes)
    const lines = after.split('\n')
    expect(lines[0]!.trim()).toBe('b')
    expect(lines[1]!.trim()).toBe('---')
    expect(lines[2]!.trim()).toBe('2')
  })

  it('缺该列的行不动', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    const plan = planTableEdit(doc, rows, doc.indexOf('b') + 1, 'deleteColumn')!
    const after = apply(doc, plan.changes)
    expect(after.split('\n')[2]).toBe('| 1 |')
  })

  it('单列表删除唯一列：拒绝（返回 null，与最小表格删表头同口径）', () => {
    // 删空唯一列会留下三行裸管道（表格解体为残缺文本），拒绝更符合
    // 「结构行保护」的既有口径（探针实证：放行结果是 "|\n|\n|\n"）
    const doc = '| a |\n| --- |\n| b |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    expect(planTableEdit(doc, rows, doc.indexOf('a') + 1, 'deleteColumn')).toBeNull()
    expect(planTableEdit(doc, rows, doc.indexOf('---') + 1, 'deleteColumn')).toBeNull()
    expect(planTableEdit(doc, rows, doc.indexOf('b') + 1, 'deleteColumn')).toBeNull()
  })
})

// ---- 边界与拒绝 ----

describe('planTableEdit：上下文与边界', () => {
  it('光标不在表格行上 → null（零变更）', () => {
    expect(planTableEdit(DOC, ROWS, at('前导段落'), 'insertRowBelow')).toBeNull()
    expect(planTableEdit(DOC, ROWS, at('结尾段落'), 'deleteColumn')).toBeNull()
  })

  it('空单元格（| |）所在行列定位正确：增删列不误伤相邻格', () => {
    const doc = '| a | | b |\n| --- | --- | --- |\n| 1 | | 3 |\n'
    const rows = rowsOf(doc, [0, 1, 2], ['header', 'delimiter', 'row'])
    // 光标在空单元格（列 1）：右侧插列
    const plan = planTableEdit(doc, rows, doc.indexOf('a') + 4, 'insertColumnRight')!
    const after = apply(doc, plan.changes)
    expect(after.split('\n')[0]).toBe('| a | | | b |')
    expect(after.split('\n')[2]).toBe('| 1 | | | 3 |')
  })

  it('全部操作的变更区间都落在表格行范围内（表格外逐字节不变）', () => {
    const ops = [
      'insertRowAbove',
      'insertRowBelow',
      'insertColumnLeft',
      'insertColumnRight',
      'deleteColumn',
    ] as const
    const tableFrom = ROWS[0]!.lineFrom
    const tableTo = ROWS[ROWS.length - 1]!.lineTo
    for (const op of ops) {
      const plan = planTableEdit(DOC, ROWS, at('苹果') + 1, op)!
      for (const c of plan.changes) {
        expect(c.from).toBeGreaterThanOrEqual(tableFrom)
        expect(c.from).toBeLessThanOrEqual(tableTo)
      }
    }
  })
})
