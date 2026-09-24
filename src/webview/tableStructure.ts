// 表格键盘导航与增删行列的纯函数层（工单 #13）。
//
// 职责分工：行身份（哪些行构成表格）由解析树判定（tableEditing 从
// liveDecorationsField 的树提取 TableRowInfo 后传入）；本模块只做字符串
// 与区间运算，不依赖 CM6/DOM，语义由 test/unit/tableStructure.test.ts 固定。
//
// 语义（首版，构建于 #12 的 tableCells 抽象上）：
// - 导航：Tab 落下一单元格内容首（行末环绕到下一表格行首格）；Shift+Tab
//   落上一单元格内容尾（行首回退到上一表格行末格）；表格首行首格回退与
//   末行末格前进返回 null——上层交默认行为（不吞输入）
// - 插入行：数据行前/后插入空数据行（格数 = 分隔行列数）；表头/分隔行上
//   的插入统一落到分隔行之后（表头上方或表头与分隔行之间插数据行会拆表）
// - 删除行：数据行直接删（光标落相邻行同列格）；删表头 = 首个数据行升格
//   为新表头、分隔行随移到升格行之后（对齐信息保留）；最小表格删表头与
//   单独删分隔行均拒绝（返回 null，零变更）
// - 插入/删除列：最小插入/删除法（不重建行）——既有单元格文本（含转义
//   管道与行内代码）逐字节保留；分隔行同步增删对应段（对齐信息随列走）；
//   缺该列的行不动；边界管道省略的行（a | b 形态）同样正确
// - 一切变更只落在表格行区间内，表格外文本逐字节不变
//
// 坐标契约：全文 UTF-16 code unit offset（与协议 SerChange、CM6 同构）；
// selection 为应用 changes 之后的新文档坐标。
import { barePipeAt, splitTableRowCells, type TableCellRange } from './tableCells'
import type { TableEditOp } from '../shared/protocol'

/** 表格行身份（解析树判定后传入；行区间不含换行） */
export interface TableRowInfo {
  kind: 'header' | 'delimiter' | 'row'
  /** 行首全文 offset */
  lineFrom: number
  /** 行尾（不含换行）全文 offset */
  lineTo: number
}

/** 一次结构操作的规划结果：changes 与操作后光标落点（新文档坐标） */
export interface PlannedTableEdit {
  changes: Array<{ from: number; to: number; insert: string }>
  selection: number
}

/** pos 所在行（区间含端点）；未命中返回 -1 */
function rowIndexOf(rows: TableRowInfo[], pos: number): number {
  for (let i = 0; i < rows.length; i++) {
    if (pos >= rows[i]!.lineFrom && pos <= rows[i]!.lineTo) {
      return i
    }
  }
  return -1
}

/** pos 所在列：最后一个 from <= pos 的单元格（管道上归右格；行首管道归首格） */
function columnOf(cells: TableCellRange[], pos: number): number {
  let col = 0
  for (let k = 0; k < cells.length; k++) {
    if (cells[k]!.from <= pos) {
      col = k
    } else {
      break
    }
  }
  return col
}

/**
 * 单元格导航目标。forward=true 为 Tab（下一格内容首），false 为 Shift+Tab
 * （上一格内容尾）。首行首格回退、末行末格前进、非表格行上下文均返回 null。
 */
export function tableCellNavTarget(
  doc: string,
  rows: TableRowInfo[],
  pos: number,
  forward: boolean,
): number | null {
  const i = rowIndexOf(rows, pos)
  if (i < 0) {
    return null
  }
  const row = rows[i]!
  const cells = splitTableRowCells(doc.slice(row.lineFrom, row.lineTo), row.lineFrom)
  if (cells.length === 0) {
    return null
  }
  const col = columnOf(cells, pos)
  if (forward) {
    if (col + 1 < cells.length) {
      return cells[col + 1]!.contentFrom
    }
    const next = rows[i + 1]
    if (!next) {
      return null
    }
    const nextCells = splitTableRowCells(doc.slice(next.lineFrom, next.lineTo), next.lineFrom)
    return nextCells.length > 0 ? nextCells[0]!.contentFrom : null
  }
  if (col - 1 >= 0) {
    return cells[col - 1]!.contentTo
  }
  const prev = rows[i - 1]
  if (!prev) {
    return null
  }
  const prevCells = splitTableRowCells(doc.slice(prev.lineFrom, prev.lineTo), prev.lineFrom)
  return prevCells.length > 0 ? prevCells[prevCells.length - 1]!.contentTo : null
}

/** 行尾边界裸管道的行内位置（其后仅空白才算；无则 -1） */
function trailingBarePipeRel(text: string): number {
  const end = text.trimEnd().length
  if (end === 0) {
    return -1
  }
  const i = end - 1
  return text[i] === '|' && barePipeAt(text, i) ? i : -1
}

/** 生成 n 个空单元格的新数据行（'| | |' 形态） */
function emptyRowText(n: number): string {
  return '|' + ' |'.repeat(Math.max(1, n))
}

/**
 * 规划一次表格结构操作。返回 null = 该上下文不可操作（零变更）：
 * 光标不在表格行上、删分隔行、最小表格删表头等。
 */
export function planTableEdit(
  doc: string,
  rows: TableRowInfo[],
  pos: number,
  op: TableEditOp,
): PlannedTableEdit | null {
  const i = rowIndexOf(rows, pos)
  if (i < 0) {
    return null
  }
  const delimIdx = rows.findIndex((r) => r.kind === 'delimiter')
  if (delimIdx < 0) {
    return null
  }
  const rowText = (r: TableRowInfo): string => doc.slice(r.lineFrom, r.lineTo)
  const rowCells = (r: TableRowInfo): TableCellRange[] =>
    splitTableRowCells(rowText(r), r.lineFrom)
  const cursorCells = rowCells(rows[i]!)
  if (cursorCells.length === 0) {
    return null
  }
  const col = columnOf(cursorCells, pos)
  /** 光标行同列（clamp）格内容首；无格时行首 */
  const focusOfCells = (cells: TableCellRange[], lineFrom: number, c: number): number =>
    cells.length > 0 ? cells[Math.min(c, cells.length - 1)]!.contentFrom : lineFrom

  switch (op) {
    case 'insertRowAbove':
    case 'insertRowBelow': {
      // 表头/分隔行上的插入统一落到分隔行后（数据区首）；数据行按上/下
      const insertAt = rows[i]!.kind === 'row' ? (op === 'insertRowAbove' ? i : i + 1) : delimIdx + 1
      const newRow = emptyRowText(rowCells(rows[delimIdx]!).length)
      if (insertAt < rows.length) {
        const from = rows[insertAt]!.lineFrom
        return { changes: [{ from, to: from, insert: `${newRow}\n` }], selection: from + 2 }
      }
      // 表格末尾追加（挂在末行换行之后；末行无换行则补）
      const at = rows[rows.length - 1]!.lineTo
      return { changes: [{ from: at, to: at, insert: `\n${newRow}` }], selection: at + 3 }
    }
    case 'deleteRow': {
      const row = rows[i]!
      if (row.kind === 'delimiter') {
        return null // 结构行：单独删除即拆表，拒绝
      }
      if (row.kind === 'header') {
        if (rows.length <= delimIdx + 1) {
          return null // 最小表格无数据行可升格，拒绝
        }
        // 删表头 = 首个数据行升为新表头：GFM 要求分隔行紧跟表头，升格须把
        // 分隔行移到升格行之后（对齐信息随分隔行文本原样保留）——单纯删除
        // 表头行会让分隔行成为表格首行，整表退化为普通段落
        const delim = rows[delimIdx]!
        const successor = rows[delimIdx + 1]!
        const successorHasNl = successor.lineTo < doc.length
        const promotedFrom = successorHasNl ? successor.lineTo + 1 : successor.lineTo
        const promotedInsert = successorHasNl
          ? `${rowText(delim)}\n`
          : `\n${rowText(delim)}`
        const changes: PlannedTableEdit['changes'] = [
          { from: row.lineFrom, to: row.lineTo + 1, insert: '' },
          { from: delim.lineFrom, to: delim.lineTo + 1, insert: '' },
          { from: promotedFrom, to: promotedFrom, insert: promotedInsert },
        ]
        const removed = row.lineTo + 1 - row.lineFrom + (delim.lineTo + 1 - delim.lineFrom)
        const newLineFrom = successor.lineFrom - removed
        const cells = splitTableRowCells(rowText(successor), newLineFrom)
        return { changes, selection: focusOfCells(cells, newLineFrom, col) }
      }
      // 数据行：优先与后继换行合并删除；文件尾无换行时回纳前行换行
      const hasNl = row.lineTo < doc.length
      const changes = hasNl
        ? [{ from: row.lineFrom, to: row.lineTo + 1, insert: '' }]
        : [{ from: row.lineFrom - 1, to: row.lineTo, insert: '' }]
      const len = hasNl ? row.lineTo + 1 - row.lineFrom : row.lineTo - row.lineFrom + 1
      const target = i + 1 < rows.length ? rows[i + 1]! : rows[i - 1]!
      const newLineFrom = i + 1 < rows.length ? target.lineFrom - len : target.lineFrom
      const cells = splitTableRowCells(rowText(target), newLineFrom)
      return { changes, selection: focusOfCells(cells, newLineFrom, col) }
    }
    case 'insertColumnLeft':
    case 'insertColumnRight': {
      const newCol = op === 'insertColumnLeft' ? col : col + 1
      const changes: PlannedTableEdit['changes'] = []
      let focus = -1
      let delta = 0 // 光标行之前各行的插入总长（行首右移量）
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!
        const text = rowText(row)
        const cells = rowCells(row)
        const c = Math.min(newCol, cells.length)
        let insertAtRel: number
        let piece: string
        if (c < cells.length) {
          // 目标列已有格：在其区间起点（前管道之后）插入「空格+管道」
          insertAtRel = cells[c]!.from - row.lineFrom
          piece = row.kind === 'delimiter' ? ' --- |' : ' |'
        } else {
          const lp = trailingBarePipeRel(text)
          if (lp >= 0) {
            // 行尾边界管道之后追加
            insertAtRel = lp + 1
            piece = row.kind === 'delimiter' ? ' --- |' : ' |'
          } else {
            // 无尾边界管道：行尾补「管道 + 空格 + 边界管道」形态
            insertAtRel = text.length
            piece = row.kind === 'delimiter' ? ' | ---' : ' | |'
          }
        }
        if (r === i) {
          const newText = text.slice(0, insertAtRel) + piece + text.slice(insertAtRel)
          const newCells = splitTableRowCells(newText, row.lineFrom + delta)
          focus = focusOfCells(newCells, row.lineFrom + delta, newCol)
        }
        if (r < i) {
          delta += piece.length
        }
        changes.push({ from: row.lineFrom + insertAtRel, to: row.lineFrom + insertAtRel, insert: piece })
      }
      return focus >= 0 ? { changes, selection: focus } : null
    }
    case 'deleteColumn': {
      // 唯一列保护（与最小表格删表头同口径）：删空唯一列会留下三行裸管道
      // （表格解体为残缺文本），拒绝（零变更）
      if (rowCells(rows[delimIdx]!).length <= 1) {
        return null
      }
      const changes: PlannedTableEdit['changes'] = []
      let focus = -1
      let delta = 0 // 光标行之前各行的删除总长（行首左移量）
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!
        const text = rowText(row)
        const cells = rowCells(row)
        if (col >= cells.length) {
          continue // 该行缺此列：不动
        }
        let delFromRel: number
        let delToRel: number
        if (col > 0 || cells[0]!.from - row.lineFrom > 0) {
          // 常态：删该格及其前管道（含内侧空白）
          delFromRel = cells[col]!.from - row.lineFrom - 1
          delToRel = cells[col]!.to - row.lineFrom
        } else {
          // 首格且行首无边界管道：删该格及其后管道
          delFromRel = 0
          delToRel = cells.length > 1 ? cells[1]!.from - row.lineFrom : text.length
        }
        if (r === i) {
          const newText = text.slice(0, delFromRel) + text.slice(delToRel)
          const newCells = splitTableRowCells(newText, row.lineFrom - delta)
          focus = focusOfCells(newCells, row.lineFrom - delta, col)
        }
        if (r < i) {
          delta += delToRel - delFromRel
        }
        changes.push({ from: row.lineFrom + delFromRel, to: row.lineFrom + delToRel, insert: '' })
      }
      return changes.length > 0 && focus >= 0 ? { changes, selection: focus } : null
    }
  }
}
