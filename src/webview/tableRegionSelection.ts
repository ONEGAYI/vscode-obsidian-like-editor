import { EditorSelection, StateEffect, StateField } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { normalizeTableRegion, type TableRegion } from './tableRegion'
import type { TableRowInfo } from './tableStructure'
import { liveDecorationsField } from './liveDecorations'
import { splitTableRowCells } from './tableCells'

export const setTableRegion = StateEffect.define<TableRegion | null>()

function caretInRegion(state: import('@codemirror/state').EditorState, region: TableRegion, pos: number): boolean {
  const header = state.doc.lineAt(region.tableFrom)
  const line = state.doc.lineAt(pos)
  const row = line.number - header.number - (line.number > header.number ? 1 : 0)
  if (row < region.rowFrom || row > region.rowTo) return false
  const cells = splitTableRowCells(line.text, line.from)
  return cells.some((cell, column) => column >= region.columnFrom && column <= region.columnTo &&
    pos >= cell.from && pos <= cell.to)
}

export const tableRegionField = StateField.define<TableRegion | null>({
  create: () => null,
  update(region, tr) {
    if (tr.docChanged || region && tr.selection !== undefined && !tr.isUserEvent('select.pointer') &&
        (tr.isUserEvent('select') || !caretInRegion(tr.startState, region, tr.selection.main.head) ||
          !caretInRegion(tr.startState, region, tr.selection.main.anchor))) region = null
    for (const effect of tr.effects) if (effect.is(setTableRegion)) region = effect.value
    return region
  },
})

export function selectTableRegion(view: EditorView, region: TableRegion | null): void {
  const normalized = region ? normalizeTableRegion(region) : null
  if (!normalized && !view.state.field(tableRegionField, false)) return
  if (normalized) {
    const header = view.state.doc.lineAt(normalized.tableFrom)
    const lineNumber = header.number + normalized.rowFrom + (normalized.rowFrom > 0 ? 1 : 0)
    const line = lineNumber <= view.state.doc.lines ? view.state.doc.line(lineNumber) : null
    const cell = line && splitTableRowCells(line.text, line.from)[normalized.columnFrom]
    view.dispatch({ selection: EditorSelection.create([
      EditorSelection.cursor(cell?.contentFrom ?? normalized.tableFrom, -1)]),
      effects: setTableRegion.of(normalized) })
  } else {
    view.dispatch({ effects: setTableRegion.of(null) })
  }
}

const CLASSES = ['vsidian-table-region-cell', 'vsidian-table-region-top', 'vsidian-table-region-bottom',
  'vsidian-table-region-left', 'vsidian-table-region-right']

function contentIndex(rows: TableRowInfo[], lineFrom: number): number {
  return [rows[0], ...rows.slice(2)].findIndex((row) => row?.lineFrom === lineFrom)
}

/** 鼠标原生事件只负责确定格坐标；选择、复制与删除读取同一 StateField。 */
export function createTableRegionPointer(tableRowsAt: (view: EditorView, pos: number, tree: Tree) => TableRowInfo[] | null) {
  return ViewPlugin.fromClass(class {
    private anchor: { tableFrom: number; row: number; column: number } | null = null
    private painted = new Set<HTMLElement>()

    constructor(private readonly view: EditorView) {
      view.contentDOM.addEventListener('pointerdown', this.onDown)
      document.addEventListener('pointermove', this.onMove)
      document.addEventListener('pointerup', this.onUp)
      document.addEventListener('pointercancel', this.onUp)
      view.dom.addEventListener('focusout', this.onBlur)
      this.paint()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setTableRegion)))) this.paint()
    }

    destroy(): void {
      this.view.contentDOM.removeEventListener('pointerdown', this.onDown)
      document.removeEventListener('pointermove', this.onMove)
      document.removeEventListener('pointerup', this.onUp)
      document.removeEventListener('pointercancel', this.onUp)
      this.view.dom.removeEventListener('focusout', this.onBlur)
      this.clearPaint()
    }

    private readonly onBlur = (event: FocusEvent): void => {
      if (event.relatedTarget instanceof Node && this.view.dom.contains(event.relatedTarget)) return
      queueMicrotask(() => {
        if (this.view.dom.contains(document.activeElement)) return
        this.anchor = null
        if (this.view.state.field(tableRegionField)) selectTableRegion(this.view, null)
      })
    }
    private readonly onUp = (): void => {
      this.anchor = null
      // CM6 的 pointerup 监听可能在本监听之后结算原生线性选区。
      queueMicrotask(() => {
        const region = this.view.state.field(tableRegionField)
        if (region) this.selectWithoutNativeText(region)
      })
    }

    private selectWithoutNativeText(region: TableRegion): void {
      const live = this.view.state.field(this.liveField, false)
      const rows = live && tableRowsAt(this.view, region.tableFrom, live.tree)
      const row = rows && [rows[0], ...rows.slice(2)][region.rowFrom]
      if (!row) return
      const line = this.view.state.doc.lineAt(row.lineFrom)
      const cell = splitTableRowCells(line.text, line.from)[region.columnFrom]
      if (!cell) return
      this.view.dispatch({ selection: EditorSelection.single(cell.contentFrom), effects: setTableRegion.of(region) })
    }

    private hit(event: PointerEvent) {
      const target = document.elementFromPoint(event.clientX, event.clientY) ?? event.target as Element
      const cell = target instanceof Element ? target.closest<HTMLElement>('.vsidian-table-grid-cell') : null
      const row = cell?.closest<HTMLElement>('.vsidian-table-grid-row')
      if (!cell || !row || !this.view.contentDOM.contains(row)) return null
      let pos: number
      try { pos = this.view.posAtDOM(row, 0) } catch { return null }
      const field = this.view.state.field(tableRegionField, false)
      if (field === undefined) return null
      // 表格行身份仍由 live 解析树提供，DOM 只提供实际命中的可见坐标。
      const live = this.view.state.field(this.liveField, false)
      if (!live) return null
      const lineFrom = this.view.state.doc.lineAt(pos).from
      const rows = tableRowsAt(this.view, lineFrom, live.tree)
      if (!rows) return null
      const rowIndex = contentIndex(rows, lineFrom)
      const column = [...row.querySelectorAll(':scope > .vsidian-table-grid-cell')].indexOf(cell)
      return rowIndex < 0 || column < 0 ? null : { tableFrom: rows[0]!.lineFrom, row: rowIndex, column }
    }

    // 通过构造器闭包间接取得 live 字段，避免本模块再定义另一套表格解析。
    private readonly liveField = liveDecorationsField

    private readonly onDown = (event: PointerEvent): void => {
      if (event.button !== 0 || this.view.compositionStarted) return
      this.anchor = this.hit(event)
      if (this.view.state.field(tableRegionField)) selectTableRegion(this.view, null)
    }

    private readonly onMove = (event: PointerEvent): void => {
      if (!this.anchor || !(event.buttons & 1)) return
      const target = this.hit(event)
      if (!target || target.tableFrom !== this.anchor.tableFrom) {
        // 手势离开该表格后交回 CM6 原生文本拖选，不能保留过期矩形。
        if (this.view.state.field(tableRegionField)) selectTableRegion(this.view, null)
        this.anchor = null
        return
      }
      if (target.row === this.anchor.row && target.column === this.anchor.column) {
        if (this.view.state.field(tableRegionField)) selectTableRegion(this.view, null)
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      const region = normalizeTableRegion({ tableFrom: target.tableFrom,
        rowFrom: this.anchor.row, rowTo: target.row,
        columnFrom: this.anchor.column, columnTo: target.column })
      const current = this.view.state.field(tableRegionField)
      if (!current || current.rowFrom !== region.rowFrom || current.rowTo !== region.rowTo ||
          current.columnFrom !== region.columnFrom || current.columnTo !== region.columnTo) {
        this.selectWithoutNativeText(region)
      } else if (!this.view.state.selection.main.empty) {
        this.selectWithoutNativeText(region)
      }
    }

    private clearPaint(): void {
      for (const cell of this.painted) cell.classList.remove(...CLASSES)
      this.painted.clear()
    }

    private paint(): void {
      this.clearPaint()
      const selected = this.view.state.field(tableRegionField)
      if (!selected) return
      const live = this.view.state.field(this.liveField, false)
      if (!live) return
      for (const element of this.view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')) {
        let pos: number
        try { pos = this.view.posAtDOM(element, 0) } catch { continue }
        const lineFrom = this.view.state.doc.lineAt(pos).from
        const rows = tableRowsAt(this.view, lineFrom, live.tree)
        if (rows?.[0]?.lineFrom !== selected.tableFrom) continue
        const index = contentIndex(rows, lineFrom)
        if (index < selected.rowFrom || index > selected.rowTo) continue
        const cells = element.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')
        for (let col = selected.columnFrom; col <= selected.columnTo; col++) {
          const cell = cells[col]
          if (!cell) continue
          cell.classList.add(CLASSES[0]!)
          if (index === selected.rowFrom) cell.classList.add(CLASSES[1]!)
          if (index === selected.rowTo) cell.classList.add(CLASSES[2]!)
          if (col === selected.columnFrom) cell.classList.add(CLASSES[3]!)
          if (col === selected.columnTo) cell.classList.add(CLASSES[4]!)
          this.painted.add(cell)
        }
      }
    }
  })
}
