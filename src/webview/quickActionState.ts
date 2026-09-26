import type { SyntaxNode, Tree } from '@lezer/common'
import type { Text } from '@codemirror/state'
import type { FormatOperationId } from '../shared/formatOperations'
import type { FormatSelection } from './formatOperations'
import type { TableRegion } from './tableRegion'
import { parseTableDelimiter, tableRowCellsForColumns } from './tableCells'

export type QuickActionState = 'inactive' | 'active' | 'mixed' | 'disabled'

const INLINE_NODES: Partial<Record<FormatOperationId, string>> = {
  bold: 'StrongEmphasis', italic: 'Emphasis', strikethrough: 'Strikethrough', inlineCode: 'InlineCode',
}
const INLINE_NODE_NAMES = new Set(Object.values(INLINE_NODES))
const INLINE_OPS = new Set<FormatOperationId>([
  'bold', 'italic', 'strikethrough', 'inlineCode', 'link', 'clearInline', 'inlineMath',
])

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
    : doc.sliceString(range.from, range.to).replace(/[\s*~`]/gu, '').length
  const cells = region ? regionCells(doc, region) : null
  let lines: string[] | undefined
  return (op) => {
    if (!editable) return 'disabled'
    if (region && !INLINE_OPS.has(op)) return 'disabled'
    if (region && cells === null) return 'disabled'
    if (cells && INLINE_NODES[op]) {
      const mark = op === 'bold' ? '**' : op === 'italic' ? '*' : op === 'strikethrough' ? '~~' : '`'
      const hasMark = (cell: string): boolean => op === 'italic'
        ? /(?<!\*)\*(?!\*)[^*]+(?<!\*)\*(?!\*)/u.test(cell)
        : cell.includes(mark)
      const wrapped = cells.filter((cell) => cell.startsWith(mark) && cell.endsWith(mark) &&
        cell.length > mark.length * 2 &&
        (op !== 'italic' || !cell.startsWith('**') && !cell.endsWith('**'))).length
      const partial = cells.some(hasMark)
      return wrapped === cells.length ? 'active' : wrapped || partial ? 'mixed' : 'inactive'
    }
    if (cells && op === 'clearInline') {
      return cells.some((cell) => /\*\*|(?<!\*)\*(?!\*)|~~|`/u.test(cell))
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
