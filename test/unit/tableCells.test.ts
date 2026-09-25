// 表格单元格边界契约（工单 #12）：GFM 表格行拆分与写回转义的纯函数语义。
//
// 语义固定（首版，写回不做重排对齐——所见即所键）：
// - 单元格分隔符 = 未转义（非 \|）且不在行内代码 span 内的 |
// - 行首/行尾的边界管道符不产生空单元格；中间空段是空单元格
// - 分隔行（---/:---/---:/:---:）解析出列对齐；非分隔行返回 null
// - 键入转义：单元格内键入 | 自动写为 \|；\ 之后或代码 span 内不转义
// - 写回转义：内容文本中的裸 |（代码 span 外）转义为 \|
//
// 已知差异（如实记录）：@lezer/markdown 与 markdown-it 的表格 cell 切分
// 均不识别行内代码内的 |（GitHub cmark-gfm 识别）；本模块按 GFM 规范语义
// 自研拆分，供 live 装饰与编辑链路使用——阅读视图渲染侧的对应偏差见
// docs/perf/2026-09-table-cell-editing.md「已知限制」。
import { describe, it, expect } from 'vitest'
import {
  splitTableRowCells,
  tableRowCellsForColumns,
  planBlankRowCellInput,
  parseTableDelimiter,
  needsPipeEscapeAt,
  escapeCellText,
} from '../../src/webview/tableCells'

describe('splitTableRowCells：GFM 单元格切分', () => {
  it('标准行：| a | b | 切出两个单元格，区间含内侧空格、内容为 trim 后区间', () => {
    // "| a | b |"：0='|',1=' ',2='a',3=' ',4='|',5=' ',6='b',7=' ',8='|'
    const cells = splitTableRowCells('| a | b |', 0)
    expect(cells).toHaveLength(2)
    expect(cells[0]).toMatchObject({ from: 1, to: 4, contentFrom: 2, contentTo: 3 })
    expect(cells[1]).toMatchObject({ from: 5, to: 8, contentFrom: 6, contentTo: 7 })
  })

  it('lineStart 偏移换算为全文 UTF-16 坐标', () => {
    const cells = splitTableRowCells('| 甲 |', 100)
    expect(cells[0]).toMatchObject({ from: 101, to: 104, contentFrom: 102, contentTo: 103 })
  })

  it('转义管道 \\| 不切分，且属于单元格内容', () => {
    const cells = splitTableRowCells('| a\\|b | c |', 0)
    expect(cells).toHaveLength(2)
    expect(cells[0]!.contentFrom).toBe(2)
    expect(cells[0]!.contentTo).toBe(6) // "a\|b"
  })

  it('行内代码内的 | 不切分（GFM 语义）', () => {
    const cells = splitTableRowCells('| `x|y` | c |', 0)
    expect(cells).toHaveLength(2)
    expect(cells[0]!.contentTo - cells[0]!.contentFrom).toBe(5) // "`x|y`"
  })

  it('行内代码内的管道与转义管道并存', () => {
    const cells = splitTableRowCells('| `a|b` | c\\|d |', 0)
    expect(cells).toHaveLength(2)
  })

  it('首尾边界管道符省略：a | b 等价两格', () => {
    const cells = splitTableRowCells('a | b', 0)
    expect(cells).toHaveLength(2)
  })

  it('尾管道后有空白仍是边界，不凭空多出第三格', () => {
    const cells = splitTableRowCells('| c | d |  ', 40)
    expect(cells).toHaveLength(2)
    expect(cells.map((cell) => '| c | d |  '.slice(cell.contentFrom - 40, cell.contentTo - 40)))
      .toEqual(['c', 'd'])
    expect(splitTableRowCells('  | c | d |\t', 0)).toHaveLength(2)
  })

  it.each([
    [' | ', 2],
    [' | | ', 3],
    [' | | | ', 4],
    ['| | |', 2],
    ['| | | |', 3],
    ['| | | | |', 4],
    ['| | | ', 2],
    [' | | |', 2],
  ])('纯空白行 %j 按实际边界切为 %i 格', (row, count) => {
    const cells = splitTableRowCells(row, 20)
    expect(cells).toHaveLength(count)
    expect(cells.every((cell) => cell.contentFrom === cell.contentTo)).toBe(true)
    expect(cells.every((cell) => cell.from >= 20 && cell.to <= 20 + row.length)).toBe(true)
  })

  it('无边界的两格空白行保留原始区间', () => {
    const cells = splitTableRowCells(' | ', 20)
    expect(cells[0]).toMatchObject({ from: 20, to: 21, contentFrom: 21, contentTo: 21 })
    expect(cells[1]).toMatchObject({ from: 22, to: 23, contentFrom: 23, contentTo: 23 })
  })

  it('同一纯空白行按表头列数安全截取可编辑源格，格位仍保持原始坐标', () => {
    expect(tableRowCellsForColumns(' | | ', 20, 2)?.map((cell) => cell.contentFrom)).toEqual([21, 23])
    expect(tableRowCellsForColumns(' | | ', 20, 3)?.map((cell) => cell.contentFrom)).toEqual([21, 23, 25])
    expect(tableRowCellsForColumns('x|y|z', 20, 2)).toBeNull()
    expect(tableRowCellsForColumns(' | | | ', 20, 2)).toBeNull()
  })

  it('纯空白格首次粘贴含裸管道的文本时先转义，仍保持单格', () => {
    const edit = planBlankRowCellInput(' | | ', 20, 3, 23, 23, 'x|y')!
    expect(edit.insert).toBe('| | x\\|y| |')
    expect(edit.selection).toBe(28)
  })

  it.each([2, 3])('无边界纯空白行的第 %i 列数首次输入补全源管道和目标格', (columns) => {
    for (let col = 0; col < columns; col++) {
      const original = ' | | '
      const pos = tableRowCellsForColumns(original, 20, columns)![col]!.contentFrom
      const edit = planBlankRowCellInput(original, 20, columns, pos, pos, 'X')
      const expected = '|' + Array.from({ length: columns }, (_, index) => ` ${index === col ? 'X' : ''}|`).join('')
      expect(edit).toEqual({ from: 20, to: 25, insert: expected, selection: 20 + expected.indexOf('X') + 1 })
    }
  })

  it('空单元格：| a || b | 的中间空段是空格零内容单元格', () => {
    const cells = splitTableRowCells('| a || b |', 0)
    expect(cells).toHaveLength(3)
    expect(cells[1]!.contentFrom).toBe(cells[1]!.contentTo)
  })

  it('行首管道后无内容（| |）产生一个空单元格；纯管道行不抛错', () => {
    expect(splitTableRowCells('| |', 0)).toHaveLength(1)
    expect(splitTableRowCells('|', 0)).toHaveLength(0)
  })

  it('无管道的行返回空数组（调用方负责表格行判定）', () => {
    expect(splitTableRowCells('普通文本行', 0)).toEqual([])
  })

  it('代码 span 判定按 CommonMark：等长反引号串配对，未配对反引号不是代码', () => {
    // 配对反引号内的 | 不切分
    const paired = splitTableRowCells('| `a | b` |', 0)
    expect(paired).toHaveLength(1)
    expect(paired[0]!.contentTo - paired[0]!.contentFrom).toBe(7) // "`a | b`"
    // 单个反引号无配对 → 其后的 | 仍切分
    const unpaired = splitTableRowCells('| `a | b |', 0)
    expect(unpaired).toHaveLength(2) // "`a"、"b"
  })
})

describe('parseTableDelimiter：分隔行判定与列对齐', () => {
  it('标准分隔行解析出对齐数组（null=默认左）', () => {
    expect(parseTableDelimiter('| --- | :---: | ---: | :--- |')).toEqual([
      null,
      'center',
      'right',
      'left',
    ])
  })

  it('无边界管道的分隔行同样识别', () => {
    expect(parseTableDelimiter('--- | ---')).toEqual([null, null])
    expect(parseTableDelimiter('| --- | --- |  ')).toEqual([null, null])
  })

  it('非分隔行返回 null', () => {
    expect(parseTableDelimiter('| a | b |')).toBeNull()
    expect(parseTableDelimiter('| --x | --- |')).toBeNull()
    expect(parseTableDelimiter('普通行')).toBeNull()
  })

  it('至少一格、允许空格与单横线', () => {
    expect(parseTableDelimiter('| - |')).toEqual([null])
    expect(parseTableDelimiter('|  :---:  |')).toEqual(['center'])
  })
})

describe('needsPipeEscapeAt：键入 | 的转义判定', () => {
  it('单元格内容中键入需要转义', () => {
    // "| a | b |"，在 'a' 前（rel=2）键入 |
    expect(needsPipeEscapeAt('| a | b |', 2)).toBe(true)
  })

  it('前一个字符是 \\（用户手动转义）不重复转义', () => {
    // "| a\| |"：0='|',1=' ',2='a',3='\',4='|'…
    // rel=4 前一字符是 '\'：这次 | 自然构成 \|，钩子不介入
    expect(needsPipeEscapeAt('| a\\| |', 4)).toBe(false)
    // rel=3 前是 'a'：键入的是裸 |，仍需转义
    expect(needsPipeEscapeAt('| a\\| |', 3)).toBe(true)
  })

  it('行内代码 span 内不转义（GFM 语义内管道不切分）', () => {
    // "| `x` |"：rel=3 位于 code span 内
    expect(needsPipeEscapeAt('| `x` |', 3)).toBe(false)
    // "| `x|y` |"：span 内的管道位置（rel=4）同样不转义
    expect(needsPipeEscapeAt('| `x|y` |', 4)).toBe(false)
  })

  it('代码 span 边界外仍转义', () => {
    // "| `x` | y |"：rel=6 已出 code span
    expect(needsPipeEscapeAt('| `x` | y |', 6)).toBe(true)
  })
})

describe('escapeCellText：写回内容持久化（换行 + 转义，单一事实源）', () => {
  it('裸管道转义为 \\|', () => {
    expect(escapeCellText('a|b')).toBe('a\\|b')
  })

  it('已转义管道不重复转义', () => {
    expect(escapeCellText('a\\|b')).toBe('a\\|b')
  })

  it('反斜杠奇偶判定：双反斜杠后的管道仍是裸管道需转义，三反斜杠后不转义', () => {
    expect(escapeCellText('a\\\\|b')).toBe('a\\\\\\|b')
    expect(escapeCellText('a\\\\\\|b')).toBe('a\\\\\\|b')
  })

  it('行内代码内的管道不转义（GFM 渲染为代码内容）', () => {
    expect(escapeCellText('`x|y`')).toBe('`x|y`')
    expect(escapeCellText('前缀 `x|y` 后缀 | 尾')).toBe('前缀 `x|y` 后缀 \\| 尾')
  })

  it('换行持久化为 <br>（一格一源行；评审 N-1 统一后键入/粘贴/跨格替换同口径）', () => {
    expect(escapeCellText('x\ny')).toBe('x<br>y')
    expect(escapeCellText('x\r\ny')).toBe('x<br>y')
  })

  it('换行转换先于转义判定：含 <br> 后的文本仍按 span 口径转义', () => {
    expect(escapeCellText('x|y\n`z|w`')).toBe('x\\|y<br>`z|w`')
  })

  it('无管道文本换行仍转换、纯文本原样返回', () => {
    expect(escapeCellText('普通内容 **加粗**')).toBe('普通内容 **加粗**')
  })
})
