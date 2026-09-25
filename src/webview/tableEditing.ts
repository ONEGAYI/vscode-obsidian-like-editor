// 表格单元格输入钩子与键盘导航/结构命令（工单 #12 + #13 + #43）：live 视图中
// 表格编辑面的 CM6 扩展。
//
// 形态（架构约定：单元格编辑完全跑在既有出站同步链路上）：
// - 表格编辑面即 CM6 源文本行：安全表格保持网格（#42），进入格子后
//   仍在对应源区间编辑，不建独立输入状态。IME 组合、出站暂缓、
//   冲突暂停全部复用既有链路
//   （syncController），无旁路直改文档
// - #12 输入语义：在表格行内（非行内代码、非已转义后）键入 | 时自动写为
//   \|——保证「单元格输入含管道符 → 保存回读 → 再渲染」仍是单格语义；
//   其余位置返回 false 走默认插入
// - #13 键盘导航：Tab/Shift+Tab 在表格行内定位相邻单元格（语义见
//   tableStructure.ts 头注释；纯选区事务——零写回、零编辑历史）；IME
//   组合中不劫持（view.compositionStarted）；非表格上下文返回 false 交默认行为
// - #13 结构命令（宿主 table.command → syncController 调 runTableEdit）：
//   增删行列以单笔 CM6 事务派发 = 单笔 edit.request = 宿主撤销一次
// - #43 悬停控件由 tableControls.ts 只按可见 DOM 行构建；拖排行的纯规划
//   在 tableStructure.ts，松手时仍经本模块单笔 CM6 事务写回
import { EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state'
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import { deleteCharBackward } from '@codemirror/commands'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { TableEditOp } from '../shared/protocol'
import { liveDecorationsField, LIVE_CLASS_NAMES, tableCompositionPreview } from './liveDecorations'
import { chainAt } from './markdownDoc'
import { needsPipeEscapeAt, parseTableDelimiter, planBlankRowCellInput, tableRowCellsForColumns } from './tableCells'
import { planTableEdit, planTableRowMove, tableCellNavTarget, type TableRowInfo } from './tableStructure'
import { createTableControls } from './tableControls'
import { planCreateTable } from './tableCreate'

/** 表格行身份的解析树节点名（分隔行整体是一个 TableDelimiter 节点） */
const TABLE_LINE_NODE_NAMES = new Set(['TableHeader', 'TableRow', 'TableDelimiter'])

/** 判定 pos 所在行是否为表格行（表头/数据/分隔行；依据解析树，前序下降） */
function isTableRowLine(state: EditorState, pos: number, tree: Tree): boolean {
  const line = state.doc.lineAt(pos)
  const walk = (node: SyntaxNode): boolean => {
    if (node.from > line.to || node.to < line.from) {
      return false
    }
    if (TABLE_LINE_NODE_NAMES.has(node.name)) {
      // Lezer 块节点区间含尾换行：按去掉尾换行后的行界判定相交
      let end = node.to
      if (end > node.from && state.doc.sliceString(end - 1, end) === '\n') {
        end -= 1
      }
      if (node.from <= line.to && end >= line.from) {
        return true
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (walk(c)) {
        return true
      }
    }
    return false
  }
  return walk(tree.topNode)
}

/**
 * | 键处理：光标各 range 所在位置若需转义，则以一个事务插入 \|；
 * 任一 range 无需转义即整体返回 false（交默认行为，避免多光标语义分裂）。
 */
export const tablePipeKeyHandler: Command = (view: EditorView): boolean => {
  if (view.compositionStarted) return false
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return false
  }
  if (state.selection.ranges.length === 1) {
    const range = state.selection.main
    const plan = blankRowInputPlan(state, range.from, range.to, '\\|')
    if (plan) {
      view.dispatch({ changes: plan, selection: { anchor: plan.selection } })
      return true
    }
  }
  const changes: Array<{ from: number; to?: number; insert: string }> = []
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from)
    if (!isTableRowLine(state, range.from, field.tree)) {
      return false
    }
    if (needsPipeEscapeAt(line.text, range.from - line.from)) {
      changes.push(
        range.empty
          ? { from: range.from, insert: '\\|' }
          : { from: range.from, to: range.to, insert: '\\|' },
      )
    } else {
      return false
    }
  }
  if (changes.length === 0) {
    return false
  }
  view.dispatch({ changes, userEvent: 'input.type' })
  return true
}

// ---- 键盘导航与结构命令（工单 #13） ----

/** Table 直接子行节点名 → 行身份（表头/数据行内的单字符管道节点不是直接子节点） */
const ROW_KIND_BY_NODE: Partial<Record<string, TableRowInfo['kind']>> = {
  TableHeader: 'header',
  TableDelimiter: 'delimiter',
  TableRow: 'row',
}

/**
 * 提取包含 pos 的 Table 的行结构（Table 不可嵌套，前序下降命中即唯一）。
 * 行身份依据解析树；返回 null = pos 不在表格行上。
 */
export function tableRowsAt(state: EditorState, pos: number, tree: Tree): TableRowInfo[] | null {
  const line = state.doc.lineAt(pos)
  const findTable = (node: SyntaxNode): SyntaxNode | null => {
    if (node.from > line.to || node.to < line.from) {
      return null
    }
    if (node.name === 'Table') {
      // Lezer 块节点区间含尾换行：按去掉尾换行后的行界判定相交
      let end = node.to
      if (end > node.from && state.doc.sliceString(end - 1, end) === '\n') {
        end -= 1
      }
      if (node.from <= line.to && end >= line.from) {
        return node
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      const hit = findTable(c)
      if (hit) {
        return hit
      }
    }
    return null
  }
  const table = findTable(tree.topNode)
  if (!table) {
    return null
  }
  const rows: TableRowInfo[] = []
  for (let c = table.firstChild; c; c = c.nextSibling) {
    const kind = ROW_KIND_BY_NODE[c.name]
    if (!kind) {
      continue
    }
    const l = state.doc.lineAt(c.from)
    rows.push({ kind, lineFrom: l.from, lineTo: l.to })
  }
  return rows.length >= 2 ? rows.sort((a, b) => a.lineFrom - b.lineFrom) : null
}

export function blankRowInputPlan(state: EditorState, from: number, to: number, text: string) {
  const line = state.doc.lineAt(from)
  if (!line.text.includes('|') || !/^[\s|]+$/.test(line.text)) return null
  const field = state.field(liveDecorationsField, false)
  if (!field) return null
  const path = chainAt(field.tree, line.from + line.text.indexOf('|') + 1)
  const table = path.find((node) => node.name === 'Table')
  if (!table || !path.some((node) => node.name === 'TableRow')) return null
  let inGrid = false
  field.decos.between(line.from, line.from + 1, (start, end, value) => {
    const cls = (value.spec as { class?: string }).class
    if (start === line.from && end === line.from && cls?.split(' ').includes(LIVE_CLASS_NAMES.tableGridRow)) {
      inGrid = true
    }
  })
  if (!inGrid) return null
  const cached = field.gridPlans.get(table.from)
  let columns = cached?.columns
  if (!columns) {
    const delimiter = table.firstChild?.nextSibling
    if (delimiter?.name !== 'TableDelimiter') return null
    const declaration = state.doc.lineAt(delimiter.from)
    columns = parseTableDelimiter(declaration.text)?.length
  }
  if (!columns) return null
  return planBlankRowCellInput(line.text, line.from, columns, from, to, text)
}

const setTableComposition = StateEffect.define<boolean>()
const tableComposition = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setTableComposition)) value = effect.value
    return value
  },
})
const tableCompositionTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()
const tableCompositionCleanup = ViewPlugin.fromClass(class {
  constructor(private readonly view: EditorView) {}
  destroy() {
    const timer = tableCompositionTimers.get(this.view)
    if (timer !== undefined) clearTimeout(timer)
    tableCompositionTimers.delete(this.view)
  }
})

const markTableCompositionInput = EditorState.transactionExtender.of((tr) =>
  tr.docChanged && tr.startState.field(tableComposition) && tr.isUserEvent('input')
    ? { annotations: tableCompositionPreview.of(true) }
    : null)

/** 仅渲染为网格的行才限制编辑范围；源码降级行保留原生编辑能力。 */
function editableGridCellAt(state: EditorState, pos: number) {
  const field = state.field(liveDecorationsField, false)
  if (!field) return null
  const line = state.doc.lineAt(pos)
  let inGrid = false
  field.decos.between(line.from, line.from + 1, (from, to, deco) => {
    if (from === line.from && to === from &&
        deco.spec.class?.split(' ').includes(LIVE_CLASS_NAMES.tableGridRow)) inGrid = true
  })
  if (!inGrid) return null
  const table = chainAt(field.tree, line.from + line.text.indexOf('|') + 1)
    .find((node) => node.name === 'Table')
  const delimiter = table?.firstChild?.nextSibling
  if (!table || delimiter?.name !== 'TableDelimiter') return null
  const columns = field.gridPlans.get(table.from)?.columns ??
    parseTableDelimiter(state.doc.lineAt(delimiter.from).text)?.length
  if (!columns) return null
  const cells = tableRowCellsForColumns(line.text, line.from, columns)
  if (!cells?.length) return null
  const cell = cells.find((cell) => pos >= cell.from && pos <= cell.to) ??
    (pos < cells[0]!.from ? cells[0]! : cells[cells.length - 1]!)
  return { ...cell, cells, line }
}

/** 从当前网格装饰识别选区最先碰到的安全表格，避免局部缓存遗漏未改表。
 *  反向拖选从锚点附近分段回查，长表格中不遍历整张表的每一行。 */
function gridTableAcross(state: EditorState, from: number, to: number, reverse = false) {
  const field = state.field(liveDecorationsField, false)
  if (!field || from >= to) return null
  const scan = (start: number, end: number): { from: number; to: number } | null => {
    let found: { from: number; to: number } | null = null
    let lastTableEnd = -1
    field.decos.between(start, end, (at, next, deco) => {
      if (at < lastTableEnd || at !== next ||
          !deco.spec.class?.split(' ').includes(LIVE_CLASS_NAMES.tableGridRow)) return
      const table = chainAt(field.tree, Math.min(at + 1, state.doc.length))
        .find((node) => node.name === 'Table')
      if (table) {
        found = { from: table.from, to: table.to }
        lastTableEnd = table.to
        if (!reverse) return false
      }
    })
    return found
  }
  if (!reverse) return scan(from, to)
  for (let end = to; end > from;) {
    const start = Math.max(from, end - 4096)
    const found = scan(start, end)
    if (found) return found
    end = start
  }
  return null
}

/** 鼠标从表格外跨行拖选时停在网格边界，不把隐藏管道/分隔行纳入选区。 */
const protectGridPointerSelection = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || tr.selection === undefined || !tr.isUserEvent('select.pointer') ||
      tr.newSelection.ranges.length !== 1) return tr
  const range = tr.newSelection.main
  if (range.empty) return tr
  const forward = range.anchor < range.head
  const table = gridTableAcross(tr.startState, range.from, range.to, !forward)
  const boundary = table && (forward
    ? range.anchor < table.from && range.head > table.from ? table.from : null
    : range.anchor > table.to && range.head < table.to ? table.to : null)
  if (boundary === null) return tr
  return {
    selection: EditorSelection.single(range.anchor, boundary),
    annotations: Transaction.userEvent.of('select.pointer'),
    scrollIntoView: tr.scrollIntoView,
  }
})

/** 原生删除命令可跨过隐藏源码。格内开始的编辑只修改这一格的可见内容。 */
const protectGridCellContent = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || (!tr.isUserEvent('delete') && !tr.isUserEvent('input'))) return tr
  const ranges = tr.startState.selection.ranges
  if (ranges.length !== 1) return tr
  const cell = editableGridCellAt(tr.startState, ranges[0]!.anchor)
  if (!cell) {
    const range = ranges[0]!
    if (!range.empty && !(range.from === 0 && range.to === tr.startState.doc.length) &&
        gridTableAcross(tr.startState, range.from, range.to)) {
      return [] // 键盘扩选等非鼠标路径也不能删除隐藏的安全表格源码。
    }
    return tr
  }
  // 边界取管道内侧；普通空白可删除，但删到零长度时保留一个 Markdown
  // 填充空格作为原生输入节点，避免 CM6 将当前格换成不可编辑的 widget。
  const lower = cell.from
  const upper = cell.to
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let clipped = false
  tr.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    // 空白行首笔规范化属于结构补全，不应被本过滤器截断。
    if (from === to) {
      const at = Math.max(lower, Math.min(upper, from))
      if (at !== from) clipped = true
      changes.push({ from: at, to: at, insert: insert.toString() })
      return
    }
    const start = from < lower ? cell.contentFrom : from
    const end = to > upper ? cell.contentTo : to
    if (start !== from || end !== to) clipped = true
    if (end >= start && (end > start || insert.length)) {
      changes.push({ from: start, to: end, insert: insert.toString() })
    }
  })
  let clearedCell = false
  // Chromium 原生 Backspace 经 DOM observer 回来时标为 input.type，
  // 不能仅按 delete 事件判断；组合中间态不改写，避免打断候选区间。
  if (!tr.isUserEvent('input.type.compose') && changes.length) {
    let remaining = tr.startState.sliceDoc(lower, upper)
    for (const change of [...changes].reverse()) {
      remaining = remaining.slice(0, change.from - lower) + change.insert +
        remaining.slice(change.to - lower)
    }
    if (remaining.length === 0) {
      changes.splice(0, changes.length, { from: lower, to: upper, insert: ' ' })
      clipped = clearedCell = true
    }
  }
  // 省略首尾管道的行在边缘格清空后可能丢列（a|b → |b）。只有此时
  // 才补显式边界，在同一笔事务中保留原列数及其余格内容。
  if ((clearedCell || tr.isUserEvent('delete')) && changes.length) {
    let editedLine = cell.line.text
    for (const change of [...changes].reverse()) {
      editedLine = editedLine.slice(0, change.from - cell.line.from) + change.insert +
        editedLine.slice(change.to - cell.line.from)
    }
    if (!tableRowCellsForColumns(editedLine, cell.line.from, cell.cells.length)) {
      const column = cell.cells.findIndex((item) => item.from === cell.from)
      const parts = cell.cells.map((item) => tr.startState.sliceDoc(item.from, item.to))
      for (const change of [...changes].reverse()) {
        parts[column] = parts[column]!.slice(0, change.from - cell.from) + change.insert +
          parts[column]!.slice(change.to - cell.from)
      }
      const canonical = '|' + parts.join('|') + '|'
      // 删除转义符或代码定界符可能暴露格内管道。补边界仍不能保持列数时
      // 拒绝这笔删除，避免把当前格拆成额外列。
      if (!tableRowCellsForColumns(canonical, cell.line.from, cell.cells.length)) return []
      const caret = clearedCell ? 0
        : Math.min(parts[column]!.length, changes[0]!.from - cell.from + changes[0]!.insert.length)
      return {
        changes: { from: cell.line.from, to: cell.line.to, insert: canonical },
        selection: { anchor: cell.line.from + 1 + parts.slice(0, column).reduce((n, part) => n + part.length + 1, 0) + caret },
        annotations: Transaction.userEvent.of(tr.annotation(Transaction.userEvent)!),
        scrollIntoView: tr.scrollIntoView,
      }
    }
  }
  if (!clipped) return tr
  if (!changes.length) return []
  const event = tr.annotation(Transaction.userEvent)
  return {
    changes,
    selection: { anchor: changes[0]!.from + (clearedCell ? 0 : changes[0]!.insert.length) },
    annotations: event ? Transaction.userEvent.of(event) : undefined,
    scrollIntoView: tr.scrollIntoView,
  }
})

/** 浏览器输入默认生成 assoc=0 的光标。格尾紧邻隐藏管道时，这会把原生
 * caret 锚在网格行边界，视觉上落到下一列；向当前格关联以保持可继续退格。 */
const keepGridInputCaretInsideCell = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input') || tr.newSelection.ranges.length !== 1 ||
      !tr.newSelection.main.empty) return tr
  const cell = editableGridCellAt(tr.startState, tr.startState.selection.main.anchor)
  if (!cell) return tr
  const head = tr.newSelection.main.head
  const line = tr.newDoc.lineAt(head)
  if (line.number !== cell.line.number) return tr
  const cells = tableRowCellsForColumns(line.text, line.from, cell.cells.length)
  const column = cell.cells.findIndex((candidate) => candidate.from === cell.from)
  const target = cells?.[column]
  if (!target || head < target.from || head > target.to ||
      tr.newSelection.main.assoc === -1) return tr
  return [tr, {
    selection: EditorSelection.create([EditorSelection.cursor(head, -1)]),
    sequential: true,
  }]
})

/** 原生 DOM 输入会在 CM6 事务后再次同步浏览器选区，并把格尾 assoc
 * 复位为 0。待本轮 DOM 更新结束后重新关联当前格，避免原生 caret 跑到右列。 */
const stabilizeGridCaretAfterInput = ViewPlugin.fromClass(class {
  update(update: ViewUpdate): void {
    if (!update.docChanged || update.view.compositionStarted) return
    const view = update.view
    queueMicrotask(() => {
      if (view.compositionStarted) return
      const selection = view.state.selection
      if (selection.ranges.length !== 1 || !selection.main.empty) return
      const head = selection.main.head
      const cell = editableGridCellAt(view.state, head)
      if (!cell) return
      const atEmptyStart = cell.contentFrom === cell.contentTo && head === cell.from
      if (!atEmptyStart && head !== cell.contentTo) return
      const assoc = atEmptyStart ? 1 : -1
      if (selection.main.assoc !== assoc) {
        view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(head, assoc)]) })
      }
      const column = cell.cells.findIndex((candidate) => candidate.from === cell.from)
      const row = [...view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')]
        .find((candidate) => view.posAtDOM(candidate, 0) === cell.line.from)
      const target = row?.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')[column]
      if (!target || document.activeElement !== view.contentDOM) return
      const nativeSelection = window.getSelection()
      const nativeNode = nativeSelection?.focusNode
      const nativeRect = nativeSelection?.rangeCount
        ? nativeSelection.getRangeAt(0).getBoundingClientRect() : null
      if (nativeNode && target.contains(nativeNode) && (nativeRect?.height ?? 0) > 0) return
      const mapped = view.domAtPos(head, assoc)
      let textNode = mapped.node.nodeType === Node.TEXT_NODE && target.contains(mapped.node)
        ? mapped.node as globalThis.Text : null
      let offset = mapped.offset
      if (!textNode) {
        const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const candidate = walker.currentNode as globalThis.Text
          if (candidate.data.length > 0) textNode = candidate
        }
        offset = atEmptyStart ? 0 : textNode?.data.length ?? 0
      }
      if (textNode) {
        const at = Math.max(0, Math.min(offset, textNode.data.length))
        nativeSelection?.setBaseAndExtent(textNode, at, textNode, at)
      }
    })
  }
})

const selectGridCell: Command = (view) => {
  if (view.compositionStarted || view.state.selection.ranges.length !== 1) return false
  const cell = editableGridCellAt(view.state, view.state.selection.main.anchor)
  if (!cell) return false
  view.dispatch({ selection: EditorSelection.single(cell.contentFrom, cell.contentTo),
    userEvent: 'select', scrollIntoView: true })
  return true
}

/** 在可编辑边界直接导航到相邻格，跳过透明填充和隐藏管道。 */
function moveAcrossGridCell(view: EditorView, forward: boolean): boolean {
  if (view.compositionStarted || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false
  const head = view.state.selection.main.head
  const cell = editableGridCellAt(view.state, head)
  if (!cell) return false
  const end = cell.to > cell.from && view.state.sliceDoc(cell.to - 1, cell.to) === ' ' ? cell.to - 1 : cell.to
  if (forward ? head < end : head > cell.contentFrom) return false
  const target = navTargetsOf(view, forward, true)?.[0]
  if (target === undefined) return true
  const next = editableGridCellAt(view.state, target)
  if (!next) return false
  const empty = next.contentFrom === next.contentTo
  const at = empty ? next.from : forward ? next.contentFrom
    : next.to > next.from && view.state.sliceDoc(next.to - 1, next.to) === ' ' ? next.to - 1 : next.to
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(at, empty || forward ? 1 : -1)]),
    scrollIntoView: true, userEvent: 'select' })
  return true
}

/** 网格视觉行不等于 CM6 源行：上下导航按内容行定位，绕过隐藏分隔行。 */
function moveVerticallyAcrossGrid(view: EditorView, forward: boolean): boolean {
  const state = view.state
  const range = state.selection.main
  if (view.compositionStarted || state.selection.ranges.length !== 1 || !range.empty) return false
  const field = state.field(liveDecorationsField, false)
  if (!field) return false
  const cell = editableGridCellAt(state, range.head)
  const direction = forward ? 1 : -1
  const line = state.doc.lineAt(range.head)
  const nativeSelection = view.contentDOM.ownerDocument.getSelection()
  const nativeRect = nativeSelection?.rangeCount && nativeSelection.focusNode &&
    view.contentDOM.contains(nativeSelection.focusNode) &&
    view.posAtDOM(nativeSelection.focusNode, nativeSelection.focusOffset) === range.head
    ? nativeSelection.getRangeAt(0).getBoundingClientRect() : null
  const origin = nativeRect && nativeRect.height > 0 ? nativeRect : view.coordsAtPos(range.head, range.assoc || 1)
  const contentLeft = view.contentDOM.getBoundingClientRect().left
  const goal = range.goalColumn ?? ((origin?.left ?? contentLeft) - contentLeft)
  const select = (at: number, assoc: number) => {
    view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(at, assoc, undefined, goal)]),
      scrollIntoView: true, userEvent: 'select' })
    return true
  }
  if (cell) {
    // CM6 的源行测量会将 CSS grid 看成一个块；格内软换行用浏览器文字
    // 命中定位，但仅接受仍落在当前格、且确实前进一个视觉行的结果。
    const visual = origin ? view.contentDOM.ownerDocument.caretRangeFromPoint?.(
      contentLeft + goal, (origin.top + origin.bottom) / 2 + direction * view.defaultLineHeight) : null
    if (visual && view.contentDOM.contains(visual.startContainer)) {
      const at = view.posAtDOM(visual.startContainer, visual.startOffset)
      const rect = view.coordsAtPos(at, forward ? 1 : -1) ?? visual.getBoundingClientRect()
      if (at !== range.head && at >= cell.contentFrom && at <= cell.contentTo && origin && rect.bottom > rect.top &&
          (forward ? rect.top > origin.top + 1 : rect.top < origin.top - 1)) {
        return select(at, forward ? 1 : -1)
      }
    }
    const rows = tableRowsAt(state, range.head, field.tree)
    if (!rows) return false
    const visible = rows.filter((row) => row.kind !== 'delimiter')
    const index = visible.findIndex((row) => row.lineFrom === line.from)
    const nextRow = visible[index + direction]
    if (!nextRow) {
      const boundary = forward ? rows[rows.length - 1]!.lineFrom : rows[0]!.lineFrom
      const outsideNumber = state.doc.lineAt(boundary).number + direction
      if (outsideNumber < 1 || outsideNumber > state.doc.lines) return true
      const outside = state.doc.line(outsideNumber)
      return select(outside.from + Math.min(Math.max(0, range.head - cell.contentFrom), outside.length), 1)
    }
    const cells = tableRowCellsForColumns(state.sliceDoc(nextRow.lineFrom, nextRow.lineTo), nextRow.lineFrom, cell.cells.length)
    const column = cell.cells.findIndex((entry) => entry.from === cell.from)
    const next = cells?.[column]
    if (!next || !editableGridCellAt(state, next.from)) return false
    const empty = next.contentFrom === next.contentTo
    const at = empty ? next.from : Math.min(next.contentTo, next.contentFrom + Math.max(0, range.head - cell.contentFrom))
    return select(at, empty || at === next.contentFrom ? 1 : -1)
  }
  // 表格外仅接管紧邻可见网格的那一步；普通段落导航保持原有行为。
  const nextNumber = line.number + direction
  if (nextNumber < 1 || nextNumber > state.doc.lines) return false
  const nextLine = state.doc.line(nextNumber)
  const first = editableGridCellAt(state, nextLine.from)
  if (!first) return false
  const rowDOM = [...view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')]
    .find((row) => view.posAtDOM(row, 0) === nextLine.from)
  const domCells = rowDOM?.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')
  const x = contentLeft + goal
  let column = 0
  if (domCells) {
    while (column + 1 < domCells.length && x >= domCells[column]!.getBoundingClientRect().right) column++
  }
  const next = first.cells[column]!
  const empty = next.contentFrom === next.contentTo
  const rect = domCells?.[column]?.getBoundingClientRect()
  const hit = rect ? view.posAtCoords({ x, y: forward ? rect.top + 5 : rect.bottom - 5 }) : null
  const at = empty ? next.from : Math.max(next.contentFrom, Math.min(next.contentTo, hit ?? next.contentFrom))
  return select(at, empty || at === next.contentFrom ? 1 : -1)
}
/** 退格直接删除可见内容，不先消耗透明填充。 */
const deleteBeforeGridPadding: Command = (view) => {
  if (view.compositionStarted || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return false
  const head = view.state.selection.main.head
  const cell = editableGridCellAt(view.state, head)
  if (!cell || head !== cell.to || head <= cell.from || view.state.sliceDoc(head - 1, head) !== ' ') return false
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(head - 1, 1)]) })
  return deleteCharBackward(view)
}

/** 无尾填充的既有格在原生输入开始前补齐承载。这样用户新键入的空格
 * 位于透明填充之前，仍按普通字符显示与删除。点击本身不改写文档。 */
function prepareGridInputPadding(view: EditorView): void {
  const caret = view.state.selection.main
  if (!caret.empty) return
  const cell = editableGridCellAt(view.state, caret.head)
  if (!cell || caret.head !== cell.to || (cell.to > cell.from && view.state.sliceDoc(cell.to - 1, cell.to) === ' ')) return
  view.dispatch({ changes: { from: cell.to, insert: ' ' },
    selection: EditorSelection.create([EditorSelection.cursor(caret.head, cell.from === cell.to ? 1 : -1)]) })
}

/** 普通键入、粘贴在空白行首笔规范化；IME 的中间事务交宿主组合缓冲处理。 */
const normalizeBlankRowInput = EditorState.transactionFilter.of((tr) => {
  if (!tr.isUserEvent('input') || tr.changes.empty || tr.startState.field(tableComposition)) return tr
  let change: { from: number; to: number; text: string } | null = null
  let multiple = false
  tr.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    if (change) multiple = true
    change = { from, to, text: insert.toString() }
  })
  if (multiple || !change) return tr
  const { from, to, text } = change
  const plan = blankRowInputPlan(tr.startState, from, to, text)
  if (!plan) return tr
  const event = tr.annotation(Transaction.userEvent)
  return {
    changes: plan,
    selection: { anchor: plan.selection },
    annotations: event ? Transaction.userEvent.of(event) : undefined,
  }
})

/** 导航前置解析：全部 range（须为空光标）都在表格单元格序列上时返回目标数组 */
function navTargetsOf(view: EditorView, forward: boolean, visibleOnly = false): number[] | null {
  if (view.compositionStarted) {
    return null // IME 组合中不劫持 Tab（组合文本由既有链路上屏）
  }
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return null
  }
  const targets: number[] = []
  for (const range of state.selection.ranges) {
    if (!range.empty) {
      return null // 选区不作单元格导航（交默认行为）
    }
    const rows = tableRowsAt(state, range.from, field.tree)
    if (!rows) {
      return null
    }
    const source = state.doc.toString()
    let target = tableCellNavTarget(source, rows, range.from, forward)
    if (visibleOnly && target !== null) {
      const delimiter = rows.find((row) => row.kind === 'delimiter' && target! >= row.lineFrom && target! <= row.lineTo)
      if (delimiter) {
        // 保留声明行的列数信息供纯空白行解析，但不让光标停在声明行内。
        target = tableCellNavTarget(source, rows, forward ? delimiter.lineTo : delimiter.lineFrom, forward)
      }
    }
    if (target === null) {
      return null // 边界（首行首格回退/末行末格前进）与非表格上下文：交默认
    }
    targets.push(target)
  }
  return targets.length > 0 ? targets : null
}

/** Tab：定位下一单元格内容首（行末环绕到下一表格行首格） */
export const tableTabForward: Command = (view: EditorView): boolean => {
  const targets = navTargetsOf(view, true)
  if (!targets) {
    return false
  }
  view.dispatch({
    selection: EditorSelection.create(
      targets.map((t) => EditorSelection.range(t, t)),
      view.state.selection.ranges.length - 1,
    ),
  })
  return true
}

/** Shift+Tab：定位上一单元格内容尾（行首回退到上一表格行末格） */
export const tableTabBackward: Command = (view: EditorView): boolean => {
  const targets = navTargetsOf(view, false)
  if (!targets) {
    return false
  }
  view.dispatch({
    selection: EditorSelection.create(
      targets.map((t) => EditorSelection.range(t, t)),
      view.state.selection.ranges.length - 1,
    ),
  })
  return true
}

/** 建表命令只派发一笔 CM6 事务；宿主负责 LF/CRLF 转换与撤销历史。 */
export function runCreateTable(view: EditorView): boolean {
  if (view.compositionStarted) return false
  const selection = view.state.selection.main
  const plan = planCreateTable(view.state.doc.toString(), selection.from, selection.to)
  view.dispatch({ changes: plan.changes, selection: { anchor: plan.selection }, scrollIntoView: true })
  return true
}

/**
 * 执行一次表格结构操作（增删行列；宿主 table.command 命令与测试共用）。
 * 单笔 CM6 事务（多行变更合一）→ 单笔 edit.request → 宿主撤销一次；
 * 光标落点由 planTableEdit 给出（新行首格 / 相邻行同列格）。
 * 上下文不符（表格外、删分隔行、最小表格删表头、选区中）返回 false 零变更。
 */
export function runTableEdit(view: EditorView, op: TableEditOp): boolean {
  const sel = view.state.selection.main
  return sel.empty && runTableEditAt(view, sel.from, op)
}

/** 悬停控件的定位入口：不先移动 CM6 光标，结构变更仍只派发一次事务。 */
export function runTableEditAt(view: EditorView, pos: number, op: TableEditOp): boolean {
  if (view.compositionStarted) {
    return false
  }
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return false
  }
  const rows = tableRowsAt(state, pos, field.tree)
  if (!rows) {
    return false
  }
  const plan = planTableEdit(state.doc.toString(), rows, pos, op)
  if (!plan) {
    return false
  }
  view.dispatch({
    changes: plan.changes,
    selection: { anchor: plan.selection },
    scrollIntoView: true,
  })
  return true
}

/** 行位置属于表头或数据行；目标 slot 不计分隔行。 */
export function runTableRowMove(view: EditorView, sourcePos: number, slot: number): boolean {
  if (view.compositionStarted) {
    return false
  }
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field || sourcePos < 0 || sourcePos > state.doc.length) {
    return false
  }
  const rows = tableRowsAt(state, sourcePos, field.tree)
  if (!rows) {
    return false
  }
  const sourceLine = state.doc.lineAt(sourcePos).from
  const source = [rows[0]!, ...rows.slice(2)].findIndex((r) => r.lineFrom === sourceLine)
  const plan = planTableRowMove(state.doc.toString(), rows, source, slot)
  if (!plan) {
    return false
  }
  view.dispatch({ changes: plan.changes })
  return true
}

const tableControls = createTableControls({ tableRowsAt, runTableEditAt, runTableRowMove })

/** 装配扩展：键盘编辑、导航及可见表格控件共用 CM6 文本事务 */
export const tableEditing = [
  tableComposition,
  tableCompositionCleanup,
  EditorView.domEventHandlers({
    beforeinput: (event, view) => {
      if (event.inputType === 'insertText' && !event.isComposing && !view.compositionStarted) prepareGridInputPadding(view)
    },
    compositionstart: (_event, view) => {
      // 既有文件可能含 || 零宽格。候选开始前提供文字节点，避免浏览器
      // 把组合区间附着在不可编辑 widget 外；普通点击仍不修改源文。
      prepareGridInputPadding(view)
      const timer = tableCompositionTimers.get(view)
      if (timer !== undefined) clearTimeout(timer)
      tableCompositionTimers.delete(view)
      const selection = view.state.selection.main
      if (!view.state.field(tableComposition) && selection.empty &&
          blankRowInputPlan(view.state, selection.from, selection.to, 'x')) {
        view.dispatch({ effects: setTableComposition.of(true) })
      }
    },
    compositionupdate: (_event, view) => {
      const selection = view.state.selection.main
      if (!view.state.field(tableComposition) && selection.empty &&
          blankRowInputPlan(view.state, selection.from, selection.to, 'x')) {
        view.dispatch({ effects: setTableComposition.of(true) })
      }
    },
    compositionend: (_event, view) => {
      if (view.state.field(tableComposition)) {
        tableCompositionTimers.set(view, setTimeout(() => {
          tableCompositionTimers.delete(view)
          if (view.state.field(tableComposition)) view.dispatch({ effects: setTableComposition.of(false) })
        }, 0))
      }
    },
  }),
  markTableCompositionInput,
  normalizeBlankRowInput,
  protectGridPointerSelection,
  protectGridCellContent,
  keepGridInputCaretInsideCell,
  stabilizeGridCaretAfterInput,
  keymap.of([
    { key: 'ArrowLeft', run: (view) => moveAcrossGridCell(view, false) },
    { key: 'ArrowRight', run: (view) => moveAcrossGridCell(view, true) },
    { key: 'ArrowUp', run: (view) => moveVerticallyAcrossGrid(view, false) },
    { key: 'ArrowDown', run: (view) => moveVerticallyAcrossGrid(view, true) },
    { key: 'Backspace', run: deleteBeforeGridPadding },
  ]),
  keymap.of([{ key: 'Mod-a', run: selectGridCell }]),
  keymap.of([{ key: '|', run: tablePipeKeyHandler }]),
  keymap.of([{ key: 'Tab', run: tableTabForward, shift: tableTabBackward }]),
  tableControls,
]
