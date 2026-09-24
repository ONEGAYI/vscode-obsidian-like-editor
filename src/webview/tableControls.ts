import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'
import type { TableEditOp } from '../shared/protocol'
import { liveDecorationsField } from './liveDecorations'
import { splitTableRowCells } from './tableCells'
import type { TableRowInfo } from './tableStructure'

interface TableControlActions {
  tableRowsAt(state: EditorState, pos: number, tree: Tree): TableRowInfo[] | null
  runTableEditAt(view: EditorView, pos: number, op: TableEditOp): boolean
  runTableRowMove(view: EditorView, sourcePos: number, slot: number): boolean
}

interface VisibleGridRow {
  element: HTMLElement
  lineFrom: number
  index: number
  tableFrom: number
  rows: TableRowInfo[]
  handle: HTMLButtonElement
}

/**
 * 控件是编辑器上的浮层，不进入 CM6 文本 DOM，也没有独立的单元格状态。
 * 每次只扫描已挂载的网格行；CM6 视口回收后同步重建控件。
 */
class TableControlsView {
  private readonly layer: HTMLDivElement
  private visible: VisibleGridRow[] = []
  private selected: { tableFrom: number; row?: number; column?: number } | null = null
  private dragging: { row: VisibleGridRow; x: number; y: number; slot: number | null; moved: boolean } | null = null
  private scheduled = false
  private destroyed = false
  private suppressNextClick = false
  private rowsCache: Array<{ first: number; last: number; rows: TableRowInfo[] }> = []
  private rowsCacheTree: Tree | null = null

  constructor(private readonly view: EditorView, private readonly actions: TableControlActions) {
    this.layer = document.createElement('div')
    this.layer.className = 'vsidian-table-controls'
    this.layer.setAttribute('aria-label', '表格操作控件')
    view.dom.appendChild(this.layer)
    view.scrollDOM.addEventListener('scroll', this.onScroll)
    view.contentDOM.addEventListener('pointermove', this.onHover)
    view.contentDOM.addEventListener('pointerleave', this.onLeave)
    this.scheduleRender()
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.selected = null
      this.endDrag()
      this.rowsCache = []
      this.rowsCacheTree = null
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
      this.scheduleRender()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.endDrag()
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.view.contentDOM.removeEventListener('pointermove', this.onHover)
    this.view.contentDOM.removeEventListener('pointerleave', this.onLeave)
    this.layer.remove()
  }

  private readonly onScroll = (): void => this.scheduleRender()

  private scheduleRender(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.destroyed) this.render()
    })
  }

  private readonly onHover = (event: PointerEvent): void => {
    if (this.dragging) {
      return
    }
    const row = (event.target as Element).closest?.('.vsidian-table-grid-row')
    const hovered = this.visible.find((item) => item.element === row)
    for (const item of this.visible) {
      item.handle.classList.toggle('vsidian-table-control-hover', item.element === row)
    }
    for (const button of this.layer.querySelectorAll<HTMLButtonElement>(
      '.vsidian-table-insert-row, .vsidian-table-insert-column, .vsidian-table-column-handle')) {
      button.classList.toggle('vsidian-table-control-hover',
        hovered !== undefined && button.dataset['tableFrom'] === String(hovered.tableFrom))
    }
  }

  private readonly onLeave = (): void => {
    this.layer.querySelectorAll('.vsidian-table-control-hover').forEach((button) =>
      button.classList.remove('vsidian-table-control-hover'))
  }

  private makeButton(cls: string, label: string, left: number, top: number, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = cls
    button.title = label
    button.setAttribute('aria-label', label)
    button.style.left = `${left}px`
    button.style.top = `${top}px`
    button.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation() })
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!this.destroyed && this.layer.contains(button)) onClick()
    })
    this.layer.appendChild(button)
    return button
  }

  private render(): void {
    for (const item of this.visible) {
      item.element.classList.remove('vsidian-table-row-selected', 'vsidian-table-dragging',
        'vsidian-table-drop-before', 'vsidian-table-drop-after')
      item.element.querySelectorAll('.vsidian-table-column-selected').forEach((cell) =>
        cell.classList.remove('vsidian-table-column-selected', 'vsidian-table-column-first',
          'vsidian-table-column-last'))
    }
    this.visible = []
    this.layer.replaceChildren()
    const field = this.view.state.field(liveDecorationsField, false)
    if (!field) {
      return
    }
    if (this.rowsCacheTree !== field.tree) {
      this.rowsCacheTree = field.tree
      this.rowsCache = []
    }
    const editorRect = this.view.dom.getBoundingClientRect()
    for (const element of this.view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')) {
      let pos: number
      try {
        pos = this.view.posAtDOM(element, 0)
      } catch {
        continue // CM6 正在回收行 DOM
      }
      const lineFrom = this.view.state.doc.lineAt(pos).from
      let rows = this.rowsCache.find((item) => item.first <= lineFrom && lineFrom <= item.last)?.rows
      if (!rows) {
        rows = this.actions.tableRowsAt(this.view.state, lineFrom, field.tree) ?? undefined
        if (rows) this.rowsCache.push({ first: rows[0]!.lineFrom, last: rows[rows.length - 1]!.lineTo, rows })
      }
      if (!rows) {
        continue
      }
      const content = [rows[0]!, ...rows.slice(2)]
      const index = content.findIndex((row) => row.lineFrom === lineFrom)
      if (index < 0) {
        continue // 分隔行没有抓手
      }
      const rect = element.getBoundingClientRect()
      const top = rect.top - editorRect.top
      const handle = this.makeButton('vsidian-table-row-handle', `选择或拖动第 ${index + 1} 行`,
        rect.left - editorRect.left - 24, top + rect.height / 2, () => {
          if (this.suppressNextClick) { this.suppressNextClick = false; return }
          this.selected = { tableFrom: rows[0]!.lineFrom, row: lineFrom }
          this.applySelection()
        })
      handle.textContent = '⠿'
      const item: VisibleGridRow = { element, lineFrom, index, tableFrom: rows[0]!.lineFrom, rows, handle }
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (this.destroyed || !this.layer.contains(handle) || this.view.compositionStarted) {
          return
        }
        this.dragging = { row: item, x: event.clientX, y: event.clientY, slot: null, moved: false }
        document.addEventListener('pointermove', this.onDragMove)
        document.addEventListener('pointerup', this.onDragEnd)
        document.addEventListener('pointercancel', this.onDragCancel)
      })
      this.visible.push(item)
    }
    const groups = new Map<number, VisibleGridRow[]>()
    for (const item of this.visible) {
      const group = groups.get(item.tableFrom) ?? []
      group.push(item)
      groups.set(item.tableFrom, group)
    }
    for (const group of groups.values()) {
      // 长表格滚动时表头可能已由 CM6 回收；列控件仍贴住首个可见内容行。
      const anchor = group.find((item) => item.index === 0) ?? group[0]
      if (anchor) {
        const rect = anchor.element.getBoundingClientRect()
        const cells = [...anchor.element.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')]
        cells.forEach((cell, column) => {
          const cellRect = cell.getBoundingClientRect()
          const button = this.makeButton('vsidian-table-column-handle', `选择第 ${column + 1} 列`,
            cellRect.left - editorRect.left + cellRect.width / 2, rect.top - editorRect.top - 10,
            () => { this.selected = { tableFrom: anchor.tableFrom, column }; this.applySelection() })
          button.textContent = '•'
          button.dataset['tableFrom'] = String(anchor.tableFrom)
        })
        const lastVisible = group[group.length - 1]!.element.getBoundingClientRect()
        const insertCol = this.makeButton('vsidian-table-insert-column', '在右侧新增列',
          rect.right - editorRect.left + 10, (rect.top + lastVisible.bottom) / 2 - editorRect.top, () => {
            // 可见锚点只负责几何定位；结构命令始终取真实表头末列。
            const line = this.view.state.doc.lineAt(anchor.rows[0]!.lineFrom)
            const last = splitTableRowCells(line.text, line.from).at(-1)
            if (last) this.actions.runTableEditAt(this.view, last.contentFrom, 'insertColumnRight')
          })
        insertCol.textContent = '+'
        insertCol.dataset['tableFrom'] = String(anchor.tableFrom)
      }
      const tableRows = group[0]!.rows
      const lastLineFrom = [tableRows[0]!, ...tableRows.slice(2)].at(-1)!.lineFrom
      const last = group.find((item) => item.lineFrom === lastLineFrom)
      if (last) {
        const rect = last.element.getBoundingClientRect()
        const addRow = this.makeButton('vsidian-table-insert-row', '在表格底部新增行',
          rect.left - editorRect.left + rect.width / 2, rect.bottom - editorRect.top + 10,
          () => { this.actions.runTableEditAt(this.view, last.lineFrom, 'insertRowBelow') })
        addRow.textContent = '+'
        addRow.dataset['tableFrom'] = String(last.tableFrom)
      }
    }
    this.applySelection()
  }

  private applySelection(): void {
    for (const item of this.visible) {
      const rowSelected = this.selected?.tableFrom === item.tableFrom && this.selected.row === item.lineFrom
      item.element.classList.toggle('vsidian-table-row-selected', rowSelected)
      const column = this.selected?.tableFrom === item.tableFrom ? this.selected.column : undefined
      item.element.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell').forEach((cell, index) => {
        const active = column === index
        cell.classList.toggle('vsidian-table-column-selected', active)
        cell.classList.toggle('vsidian-table-column-first', active && item.index === 0)
        cell.classList.toggle('vsidian-table-column-last', active && item.index === item.rows.length - 2)
      })
    }
  }

  private readonly onDragMove = (event: PointerEvent): void => {
    const drag = this.dragging
    if (!drag) return
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return
    drag.moved = true
    for (const item of this.visible) {
      item.element.classList.remove('vsidian-table-drop-before', 'vsidian-table-drop-after')
      item.element.classList.toggle('vsidian-table-dragging', item === drag.row)
    }
    const targetElement = (event.target as Element).closest?.('.vsidian-table-grid-row')
      ?? document.elementFromPoint?.(event.clientX, event.clientY)?.closest('.vsidian-table-grid-row')
    const target = this.visible.find((item) => item.element === targetElement &&
      item.tableFrom === drag.row.tableFrom)
    if (!target) {
      drag.slot = null
      return
    }
    const rect = target.element.getBoundingClientRect()
    const after = event.clientY >= rect.top + rect.height / 2
    drag.slot = target.index + (after ? 1 : 0)
    target.element.classList.add(after ? 'vsidian-table-drop-after' : 'vsidian-table-drop-before')
  }

  private readonly onDragEnd = (): void => {
    const drag = this.dragging
    this.endDrag()
    if (drag?.moved && drag.slot !== null) {
      this.suppressNextClick = true
      // 浏览器可能在 pointerup 后补发 click；只吞这一次，随后立即恢复抓手点击。
      setTimeout(() => { this.suppressNextClick = false }, 0)
      this.actions.runTableRowMove(this.view, drag.row.lineFrom, drag.slot)
    }
  }
  private readonly onDragCancel = (): void => this.endDrag()

  private endDrag(): void {
    document.removeEventListener('pointermove', this.onDragMove)
    document.removeEventListener('pointerup', this.onDragEnd)
    document.removeEventListener('pointercancel', this.onDragCancel)
    for (const item of this.visible) {
      item.element.classList.remove('vsidian-table-dragging', 'vsidian-table-drop-before', 'vsidian-table-drop-after')
    }
    this.dragging = null
  }
}

export function createTableControls(actions: TableControlActions) {
  return ViewPlugin.fromClass(class extends TableControlsView {
    constructor(view: EditorView) { super(view, actions) }
  })
}
