// 表格单元格边界与写回转义（工单 #12）：live 侧表格编辑语义的单一来源。
//
// 设计取舍（首版语义，测试固定；详见 test/unit/tableCells.test.ts 头注释）：
// - 单元格分隔符 = 未转义（非 \|）且不在行内代码 span 内的 |
//   （GFM 规范语义，即 GitHub 实际渲染行为）。@lezer/markdown 与
//   markdown-it 的表格 cell 切分均不识别行内代码内的 |（实测探针确认），
//   因此 live 装饰与编辑钩子不用它们的 TableCell 节点定位单元格，
//   仅用其 TableRow/TableHeader/TableDelimiter 判定「哪些行是表格行」
// - 写回不做重排对齐：单元格编辑直接落在源文本上（CM6 事务），
//   行内其余部分（其他单元格、管道符、缩进）保持不动
// - 键入 | 自动转义为 \|（单元格内容处）；\ 之后（用户手动转义）与
//   行内代码 span 内不转义
// - 行内代码判定为 CommonMark code span 的行内简化扫描：等长反引号串
//   配对；转义反斜杠 \` 不参与配对扫描（罕见形态，已知限制——如实记录
//   于 docs/perf/2026-09-table-cell-editing.md）
//
// 坐标契约：区间一律 LF 全文 UTF-16 code unit offset（与协议 SerChange、
// CodeMirror 文档定位同构）；lineStart 为该行行首 offset。
//
// #13 扩展点：TableCellRange 已携带列结构与对齐上下文（alignAt 调用方从
// 分隔行解析），键盘导航/增删行列在此抽象上扩展，不需要重解析行文本。

/** 单元格区间：from/to 覆盖两管道符之间（含内侧空白），content* 为 trim 后内容 */
export interface TableCellRange {
  from: number
  to: number
  contentFrom: number
  contentTo: number
}

/** 表格格内换行的持久化形式，仅允许无属性的 br。
 * 宽松接受大小写、空格和自闭合写法，以便重新打开已有 Markdown 时同样换行；
 * 带属性标签不在此白名单内，也不应因此打开通用 HTML 渲染。 */
export function tableCellBreakLength(text: string, at: number): number {
  return /^<br[\t ]*\/?>/i.exec(text.slice(at))?.[0].length ?? 0
}

/** 行内代码与转义文本中的 br 仍为字面内容。 */
export function tableCellBreaks(text: string): Array<{ from: number; to: number }> {
  const code = scanCodeSpans(text)
  const breaks: Array<{ from: number; to: number }> = []
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '<' || code[at] || isEscapedAt(text, at)) continue
    const length = tableCellBreakLength(text, at)
    if (length) {
      breaks.push({ from: at, to: at + length })
      at += length - 1
    }
  }
  return breaks
}

/** 列对齐语义（GFM 分隔行声明） */
export type TableAlign = 'left' | 'center' | 'right'

/** 行内代码 span 覆盖表（含定界反引号本身；未配对反引号不构成 span） */
function scanCodeSpans(line: string): boolean[] {
  const inSpan = new Array<boolean>(line.length).fill(false)
  let i = 0
  while (i < line.length) {
    if (line[i] === '`') {
      const runStart = i
      while (i < line.length && line[i] === '`') {
        i += 1
      }
      const runLen = i - runStart
      // 向后找等长反引号串（CommonMark：跨长度不配对）
      let j = i
      let closeAt = -1
      while (j < line.length) {
        if (line[j] === '`') {
          let k = j
          while (k < line.length && line[k] === '`') {
            k += 1
          }
          if (k - j === runLen) {
            closeAt = j
            i = k
            break
          }
          j = k
        } else {
          j += 1
        }
      }
      if (closeAt >= 0) {
        for (let p = runStart; p < i; p++) {
          inSpan[p] = true
        }
      }
    } else {
      i += 1
    }
  }
  return inSpan
}

/** 保持行长度不变地遮蔽 code span 内的管道符，供阅读表格解析使用。
 * markdown-it 的表格规则先于 inline code 切格，遮蔽后再从 token 还原原字。
 */
export function maskCodeSpanPipes(line: string, marker: string): string {
  if (!line.includes('|') || !line.includes('`')) {
    return line
  }
  const inSpan = scanCodeSpans(line)
  let changed = false
  const chars = line.split('')
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && inSpan[i]) {
      chars[i] = marker
      changed = true
    }
  }
  return changed ? chars.join('') : line
}

/** 位置 i 的管道符是否被反斜杠转义（前导奇数个连续 \） */
function isEscapedAt(line: string, i: number): boolean {
  let n = 0
  for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) {
    n += 1
  }
  return n % 2 === 1
}

/** 行内位置 i 的 | 是否为未转义、行内代码 span 外的裸管道（单元格分隔口径；
 *  live 装饰的管道符样式与单元格切分共用同一判定，见 liveDecorations） */
export function barePipeAt(lineText: string, i: number): boolean {
  if (lineText[i] !== '|') {
    return false
  }
  if (isEscapedAt(lineText, i)) {
    return false
  }
  return !scanCodeSpans(lineText)[i]
}

/** 非代码 span 中被反斜杠转义的管道符，其紧邻的反斜杠位置。网格显示
 * 隐藏这一枚转义标记，源文本及编辑行为保持不变。 */
export function escapedPipeBackslashes(lineText: string): number[] {
  if (!lineText.includes('\\|')) return []
  const inSpan = scanCodeSpans(lineText)
  const out: number[] = []
  for (let i = 1; i < lineText.length; i++) {
    if (lineText[i] === '|' && !inSpan[i] && isEscapedAt(lineText, i)) {
      out.push(i - 1)
    }
  }
  return out
}

/**
 * GFM 语义切分一行表格行为单元格。
 * 调用方负责判定该行确为表格行（表头/数据行）；非表格行（无裸管道）返回 []。
 * 行首/行尾边界管道符不产生空单元格；中间空段是空单元格（零宽内容）。
 */
export function splitTableRowCells(lineText: string, lineStart: number): TableCellRange[] {
  if (!lineText.includes('|')) {
    return []
  }
  const inSpan = scanCodeSpans(lineText)
  const segs: Array<{ from: number; to: number }> = []
  let segStart = 0
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === '|' && !inSpan[i] && !isEscapedAt(lineText, i)) {
      segs.push({ from: segStart, to: i })
      segStart = i + 1
    }
  }
  segs.push({ from: segStart, to: lineText.length })
  // 纯空白行且首尾没有实际边界管道时，每段空白都是一个单元格：
  // ` | ` 为两格，` | | ` 为三格。若行首/行尾有管道，或行内有内容，
  // 则首尾空白段是边界外的缩进/尾随空白，不计入单元格。
  const hasContent = segs.some((seg) => lineText.slice(seg.from, seg.to).trim() !== '')
  const hasEdgePipe = segs[0]!.from === segs[0]!.to ||
    segs[segs.length - 1]!.from === segs[segs.length - 1]!.to
  if (hasContent || hasEdgePipe) {
    if (segs.length > 0 && lineText.slice(segs[0]!.from, segs[0]!.to).trim() === '') {
      segs.shift()
    }
    if (segs.length > 0 && lineText.slice(segs[segs.length - 1]!.from, segs[segs.length - 1]!.to).trim() === '') {
      segs.pop()
    }
  }
  return segs.map((seg) => {
    const raw = lineText.slice(seg.from, seg.to)
    const lead = raw.length - raw.trimStart().length
    const trail = raw.length - raw.trimEnd().length
    const contentFrom = lineStart + seg.from + lead
    const contentTo = Math.max(contentFrom, lineStart + seg.to - trail)
    return {
      from: lineStart + seg.from,
      to: lineStart + seg.to,
      contentFrom,
      contentTo,
    }
  })
}

/**
 * 表格网格需要每个显示格有独立源区间。仅在纯空白且省略边界管道的行上，
 * 允许按表头列数舍弃多余的尾部空白段；含内容的多列行仍拒绝映射。
 */
export function tableRowCellsForColumns(
  lineText: string,
  lineStart: number,
  columns: number,
): TableCellRange[] | null {
  const cells = splitTableRowCells(lineText, lineStart)
  if (cells.length === columns) return cells
  if (columns > 0 && cells.length === columns + 1 && /^[\s|]+$/.test(lineText) &&
      lineText[0] !== '|' && lineText[lineText.length - 1] !== '|') {
    return cells.slice(0, columns)
  }
  return null
}

/** 首次写入无边界纯空白行时，在同一事务中规范化为显式边界并填目标格。 */
export function planBlankRowCellInput(
  lineText: string,
  lineStart: number,
  columns: number,
  from: number,
  to: number,
  insert: string,
): { from: number; to: number; insert: string; selection: number } | null {
  if (from !== to || !insert || insert.includes('\n') || !/^[\s|]+$/.test(lineText) ||
      lineText[0] === '|' || lineText[lineText.length - 1] === '|') return null
  const cells = tableRowCellsForColumns(lineText, lineStart, columns)
  if (!cells) return null
  const column = cells.findIndex((cell) => cell.contentFrom === from)
  if (column < 0) return null
  const canonical = '|' + ' |'.repeat(columns)
  const target = splitTableRowCells(canonical, lineStart)[column]!.contentFrom
  const relative = target - lineStart
  const escaped = escapeCellText(insert)
  return {
    from: lineStart,
    to: lineStart + lineText.length,
    insert: canonical.slice(0, relative) + escaped + canonical.slice(relative),
    selection: target + escaped.length,
  }
}

/**
 * 分隔行判定与列对齐：`---`/`:---`/`---:`/`:---:` 序列。
 * 非分隔行返回 null。允许省略首尾边界管道与段内空格。
 */
export function parseTableDelimiter(lineText: string): Array<TableAlign | null> | null {
  const cells = splitTableRowCells(lineText, 0)
  if (cells.length === 0) {
    return null
  }
  const aligns: Array<TableAlign | null> = []
  for (const cell of cells) {
    const t = lineText.slice(cell.contentFrom, cell.contentTo)
    if (!/^:?-+:?$/.test(t)) {
      return null
    }
    const left = t.startsWith(':')
    const right = t.endsWith(':')
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return aligns
}

/**
 * 键入 | 的转义判定：在表格行 lineText 的插入点 pos 处（相对行首）键入 |
 * 是否须写为 \|。
 * - 行首/行尾：边界管道语义，不转义
 * - 前一字符是 \：用户手动转义已就位，不重复
 * - 行内代码 span 内（GFM 语义内管道不切分）：不转义
 * - 其余：转义
 */
export function needsPipeEscapeAt(lineText: string, pos: number): boolean {
  if (pos <= 0 || pos >= lineText.length) {
    return false
  }
  if (lineText[pos - 1] === '\\') {
    return false
  }
  const inSpan = scanCodeSpans(lineText)
  return !inSpan[pos]
}

/**
 * 写回内容持久化形式（单一事实源，键入/粘贴/跨格替换共用）：换行写为
 * `<br>`（一格一源行），文本中的裸 |（行内代码 span 外、未被 \ 转义）
 * 转义为 \|——span 内与已转义的管道保持原样，与键入路径
 * tablePipeKeyHandler 的逐位置判定同口径。
 * 单元格内容经此函数写回后，保存回读与再渲染保持单格语义。
 */
export function escapeCellText(text: string): string {
  const bridged = text.replace(/\r?\n/g, '<br>')
  if (!bridged.includes('|')) {
    return bridged
  }
  const text$ = bridged
  const inSpan = scanCodeSpans(text$)
  let out = ''
  for (let i = 0; i < text$.length; i++) {
    if (text$[i] === '|' && !inSpan[i] && !isEscapedAt(text$, i)) {
      out += '\\|'
    } else {
      out += text$[i]
    }
  }
  return out
}
