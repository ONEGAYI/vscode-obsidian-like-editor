import type { SyntaxNode, Tree } from '@lezer/common'
import type { Text } from '@codemirror/state'
import type { FormatOperationId } from '../shared/formatOperations'
import type { FormatSelection } from './formatOperations'
import { INLINE } from './formatOperations'
import type { TableRegion } from './tableRegion'
import { parseTableDelimiter, tableRowCellsForColumns } from './tableCells'

export type QuickActionState = 'inactive' | 'active' | 'mixed' | 'disabled'

// ---- 行内围栏全部从 formatOperations 的 INLINE 表派生（#103 两处登记
// 约定闭环）：节点名、操作集、mark 字符集与包裹判定零围栏枚举。前缀
// 冲突（italic `*` ⊂ bold `**`）的环视例外按表内前缀关系自动推导，
// 新增围栏两处登记即自动生效，本文件不需要跟着改 ----
const INLINE_NODES = Object.fromEntries(
  Object.entries(INLINE).map(([op, config]) => [op, config!.node]),
) as Partial<Record<FormatOperationId, string>>
const INLINE_NODE_NAMES = new Set(Object.values(INLINE_NODES))
const INLINE_OPS = new Set<FormatOperationId>([
  ...(Object.keys(INLINE) as FormatOperationId[]), 'link', 'clearInline', 'inlineMath',
])

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

/** 更长且共前缀的 mark（italic `*` → [`**`]）：此类围栏的裸字面量判定
 *  会误吞更长 mark，检测须以环视排除、包裹判定须排除更长 mark 前后缀 */
function conflictingMarks(op: FormatOperationId): string[] {
  const mark = INLINE[op]!.mark
  return Object.entries(INLINE)
    .filter(([other, config]) => other !== op && config!.mark.length > mark.length &&
      config!.mark.startsWith(mark))
    .map(([, config]) => config!.mark)
}

/** 选区内容长度按 mark 字符集合剥离（包裹定界符不算内容） */
const INLINE_MARK_STRIP = new RegExp(`[\\s${
  [...new Set(Object.values(INLINE).flatMap((config) => [...config!.mark]))]
    .map((ch) => ch.replace(/[\\\]^-]/gu, '\\$&')).join('')}]`, 'gu')

/** 格区单元格的行内格式探测正则：各围栏 mark 字面量交替；前缀冲突
 *  围栏（italic）以单字符环视排除更长 mark 的误吞 */
const CELL_INLINE_PATTERN = new RegExp(Object.entries(INLINE)
  .map(([op, config]) => conflictingMarks(op as FormatOperationId).length
    ? `(?<!${escapeRegExp(config!.mark)})${escapeRegExp(config!.mark)}(?!${escapeRegExp(config!.mark)})`
    : escapeRegExp(config!.mark))
  .join('|'), 'u')

/** 格区单元格「含 mark 对」判定：非冲突围栏退化为字面量 includes */
function cellHasMarkPair(op: FormatOperationId, cell: string): boolean {
  const mark = INLINE[op]!.mark
  if (!conflictingMarks(op).length) return cell.includes(mark)
  const m = escapeRegExp(mark)
  // `(?<!m)m(?!m)((?!m).)+(?<!m)m(?!m)`：环视排除更长 mark，内容不含
  // mark 字符——italic 下与「成对单星、两侧不贴星」的既有语义逐字等价
  return new RegExp(`(?<!${m})${m}(?!${m})((?!${m}).)+(?<!${m})${m}(?!${m})`, 'u').test(cell)
}

function ancestors(tree: Tree, pos: number): SyntaxNode[] {
  const found: SyntaxNode[] = []
  for (let node: SyntaxNode | null = tree.resolveInner(Math.min(pos, tree.length), 1);
    node; node = node.parent) found.push(node)
  return found
}

function lineRange(doc: Text, range: FormatSelection): string[] {
  const first = doc.lineAt(range.from).number
  const last = doc.lineAt(range.from === range.to ? range.to : range.to - 1).number
  const lines: string[] = []
  for (let number = first; number <= last; number++) {
    const line = doc.line(number).text
    if (line.trim()) lines.push(line)
  }
  return lines
}

function regionCells(doc: Text, region: TableRegion): string[] | null {
  if (region.tableFrom < 0 || region.tableFrom > doc.length ||
      region.rowFrom < 0 || region.columnFrom < 0) return null
  const header = doc.lineAt(region.tableFrom).number
  if (header >= doc.lines) return null
  const columns = parseTableDelimiter(doc.line(header + 1).text)?.length
  if (!columns || region.columnTo >= columns) return null
  const values: string[] = []
  for (let row = region.rowFrom; row <= region.rowTo; row++) {
    const lineNumber = header + (row === 0 ? 0 : row + 1)
    if (lineNumber > doc.lines) return null
    const line = doc.line(lineNumber)
    const cells = tableRowCellsForColumns(line.text, line.from, columns)
    if (!cells) return null
    for (let column = region.columnFrom; column <= region.columnTo; column++) {
      const cell = cells[column]
      if (!cell) return null
      values.push(doc.sliceString(cell.contentFrom, cell.contentTo))
    }
  }
  return values
}

/** 一次选区刷新构建一个读取器：共享语法范围、行片段和行内节点扫描。 */
export function createQuickActionStateReader(doc: Text, tree: Tree, range: FormatSelection,
  region: TableRegion | null, editable: boolean): (op: FormatOperationId) => QuickActionState {
  const atStart = ancestors(tree, range.from)
  const atEnd = ancestors(tree, Math.max(range.from, range.to - 1))
  const edges = [...atStart, ...atEnd]
  const blocked = edges.some((node) =>
    node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'HTMLBlock')
  const inInlineCode = edges.some((node) => node.name === 'InlineCode')
  const inTable = edges.some((node) => node.name === 'Table' || node.name === 'TableCell')
  const inLink = edges.some((node) => node.name === 'Link' || node.name === 'Autolink')
  let crossContainer = false
  if (range.from !== range.to) {
    for (const name of ['ListItem', 'Blockquote']) {
      const a = atStart.find((node) => node.name === name)
      const b = atEnd.find((node) => node.name === name)
      if ((a || b) && (!a || !b || a.from !== b.from || a.to !== b.to)) crossContainer = true
    }
  }
  const spans = new Map<string, Array<{ from: number; to: number }>>()
  if (range.from !== range.to) {
    tree.iterate({ from: range.from, to: range.to, enter(node) {
      if (INLINE_NODE_NAMES.has(node.name) && node.node.firstChild && node.node.lastChild) {
        spans.set(node.name, [...(spans.get(node.name) ?? []),
          { from: node.node.firstChild.to, to: node.node.lastChild.from }])
      }
    } })
  }
  const contentLength = range.from === range.to ? 0
    : doc.sliceString(range.from, range.to).replace(INLINE_MARK_STRIP, '').length
  const cells = region ? regionCells(doc, region) : null
  let lines: string[] | undefined
  return (op) => {
    if (!editable) return 'disabled'
    if (region && !INLINE_OPS.has(op)) return 'disabled'
    if (region && cells === null) return 'disabled'
    if (cells && INLINE_NODES[op]) {
      const mark = INLINE[op]!.mark
      const longer = conflictingMarks(op)
      const wrapped = cells.filter((cell) => cell.startsWith(mark) && cell.endsWith(mark) &&
        cell.length > mark.length * 2 &&
        longer.every((m) => !cell.startsWith(m) && !cell.endsWith(m))).length
      const partial = cells.some((cell) => cellHasMarkPair(op, cell))
      return wrapped === cells.length ? 'active' : wrapped || partial ? 'mixed' : 'inactive'
    }
    if (cells && op === 'clearInline') {
      return cells.some((cell) => CELL_INLINE_PATTERN.test(cell))
        ? 'inactive' : 'disabled'
    }
    if (cells && op === 'link') {
      return cells.some((cell) => /\[[^\]]+\]\([^)]*\)/u.test(cell))
        ? 'disabled' : 'inactive'
    }
    if (blocked && op !== 'codeBlock') return 'disabled'
    if (op !== 'inlineCode' && inInlineCode) return 'disabled'
    if (op === 'codeBlock' || op === 'blockMath') {
      if (inTable || crossContainer) return 'disabled'
      if (blocked && range.from !== range.to) {
        const fence = atStart.find((node) => node.name === 'FencedCode')
        if (!fence || range.from !== fence.from || range.to !== fence.to) return 'disabled'
      }
      return op === 'codeBlock' && blocked ? 'active' : 'inactive'
    }
    const inlineNode = INLINE_NODES[op]
    if (inlineNode) {
      if (range.from === range.to) {
        return atStart.some((node) => node.name === inlineNode && node.from < range.from && node.to > range.to)
          ? 'active' : 'inactive'
      }
      let covered = 0
      for (const span of spans.get(inlineNode) ?? []) {
        covered += Math.max(0, Math.min(span.to, range.to) - Math.max(span.from, range.from))
      }
      return covered === 0 ? 'inactive' : covered >= contentLength ? 'active' : 'mixed'
    }
    if (op === 'link') return inLink ? 'disabled' : 'inactive'
    if (op === 'clearInline') {
      const hasInline = range.from === range.to
        ? atStart.some((node) => INLINE_NODE_NAMES.has(node.name))
        : [...spans.values()].some((items) => items.length > 0)
      return hasInline ? 'inactive' : 'disabled'
    }
    if (op.startsWith('heading')) {
      const setext = atStart.find((node) => /^SetextHeading[12]$/u.test(node.name))
      if (setext && (range.from === range.to || range.to <= setext.to)) {
        return Number(setext.name.at(-1)) === Number(op.slice(7)) ? 'active' : 'inactive'
      }
    }
    lines ??= lineRange(doc, range)
    if (!lines.length) return 'inactive'
    const count = lines.filter((line) => {
      const body = line.trimStart()
      if (op.startsWith('heading')) {
        const found = /^(#{1,6})\s+/u.exec(body)
        return op === 'headingNone' ? !found : found?.[1]?.length === Number(op.slice(7))
      }
      if (op === 'bulletList') return /^[-+*]\s+(?!\[[ xX]\]\s)/u.test(body)
      if (op === 'orderedList') return /^\d+[.)]\s+/u.test(body)
      if (op === 'taskList') return /^[-+*]\s+\[[ xX]\]\s+/u.test(body)
      if (op === 'quote') return /^>\s?/u.test(body)
      return false
    }).length
    return count === 0 ? 'inactive' : count === lines.length ? 'active' : 'mixed'
  }
}

export function quickActionState(doc: Text, tree: Tree, op: FormatOperationId,
  range: FormatSelection, region: TableRegion | null, editable: boolean): QuickActionState {
  return createQuickActionStateReader(doc, tree, range, region, editable)(op)
}
