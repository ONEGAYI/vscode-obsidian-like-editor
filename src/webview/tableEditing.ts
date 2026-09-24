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
import { EditorView, ViewPlugin, keymap } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { TableEditOp } from '../shared/protocol'
import { liveDecorationsField, LIVE_CLASS_NAMES, tableCompositionPreview } from './liveDecorations'
import { chainAt } from './markdownDoc'
import { needsPipeEscapeAt, parseTableDelimiter, planBlankRowCellInput } from './tableCells'
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
  view.dispatch({ changes })
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
function navTargetsOf(view: EditorView, forward: boolean): number[] | null {
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
    const target = tableCellNavTarget(state.doc.toString(), rows, range.from, forward)
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
    compositionstart: (_event, view) => {
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
  keymap.of([{ key: '|', run: tablePipeKeyHandler }]),
  keymap.of([{ key: 'Tab', run: tableTabForward, shift: tableTabBackward }]),
  tableControls,
]
