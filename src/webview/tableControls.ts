import { EditorView, ViewPlugin } from '@codemirror/view'
import type { ViewUpdate } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'
import type { TableEditOp } from '../shared/protocol'
import { liveDecorationsField } from './liveDecorations'
import { splitTableRowCells } from './tableCells'
import type { TableRowInfo } from './tableStructure'
import { selectTableRegion, setTableRegion, tableRegionField } from './tableRegionSelection'
import { t } from '../shared/i18n'

interface TableControlActions {
  tableRowsAt(state: EditorState, pos: number, tree: Tree): TableRowInfo[] | null
  runTableEditAt(view: EditorView, pos: number, op: TableEditOp): boolean
  runTableRowMove(view: EditorView, sourcePos: number, slot: number): boolean
  runTableColumnMove(view: EditorView, tableFrom: number, source: number, slot: number): boolean
}

interface VisibleGridRow {
  element: HTMLElement
  lineFrom: number
  index: number
  tableFrom: number
  rows: TableRowInfo[]
  handle: HTMLButtonElement
}

/** 表格行按源位置升序：二分定位可见内容行，索引跳过固定分隔行。 */
function contentRowIndex(rows: TableRowInfo[], lineFrom: number): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (rows[mid]!.lineFrom < lineFrom) lo = mid + 1
    else hi = mid
  }
  if (lo >= rows.length || rows[lo]!.lineFrom !== lineFrom || lo === 1) return -1
  return lo === 0 ? 0 : lo - 1
}

/**
 * 控件是编辑器上的浮层，不进入 CM6 文本 DOM，也没有独立的单元格状态。
 * 每次只扫描已挂载的网格行；CM6 视口回收后同步重建控件。
 */
class TableControlsView {
  private readonly layer: HTMLDivElement
  private visible: VisibleGridRow[] = []
  private dragging: { axis: 'row' | 'column'; tableFrom: number; source: number; sourcePos: number;
    x: number; y: number; slot: number | null; moved: boolean; lastX: number; lastY: number } | null = null
  private scheduled = false
  private destroyed = false
  private suppressNextClick = false
  private rowsCache: Array<{ first: number; last: number; rows: TableRowInfo[] }> = []
  private rowsCacheTree: Tree | null = null

  constructor(private readonly view: EditorView, private readonly actions: TableControlActions) {
    this.layer = document.createElement('div')
    this.layer.className = 'vsidian-table-controls'
    this.layer.setAttribute('aria-label', t('table.controls'))
    view.dom.appendChild(this.layer)
    view.scrollDOM.addEventListener('scroll', this.onScroll)
    view.contentDOM.addEventListener('pointermove', this.onHover)
    view.contentDOM.addEventListener('pointerleave', this.onLeave)
    this.layer.addEventListener('pointermove', this.onLayerHover)
    this.layer.addEventListener('pointerleave', this.onLeave)
    view.dom.addEventListener('focusout', this.onFocusOut)
    document.addEventListener('keydown', this.onKeyDown)
    this.scheduleRender()
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.endDrag()
      this.rowsCache = []
      this.rowsCacheTree = null
    }
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
      this.scheduleRender()
    } else if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setTableRegion)))) {
      this.applySelection()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.endDrag()
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.view.contentDOM.removeEventListener('pointermove', this.onHover)
    this.view.contentDOM.removeEventListener('pointerleave', this.onLeave)
    this.layer.removeEventListener('pointermove', this.onLayerHover)
    this.layer.removeEventListener('pointerleave', this.onLeave)
    this.view.dom.removeEventListener('focusout', this.onFocusOut)
    document.removeEventListener('keydown', this.onKeyDown)
    this.layer.remove()
  }

  private readonly onScroll = (): void => this.scheduleRender()
  private readonly onFocusOut = (): void => this.endDrag()
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.endDrag()
  }

  private scheduleRender(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.destroyed) this.render()
    })
  }

  private readonly onHover = (event: PointerEvent): void => {
    if (this.dragging) return
    const row = (event.target as Element).closest?.('.vsidian-table-grid-row')
    const hovered = this.visible.find((item) => item.element === row)
    const cell = (event.target as Element).closest?.('.vsidian-table-grid-cell')
    const column = hovered && cell
      ? [...hovered.element.querySelectorAll(':scope > .vsidian-table-grid-cell')].indexOf(cell) : -1
    for (const item of this.visible) {
      item.handle.classList.toggle('vsidian-table-control-hover', item.element === row)
    }
    for (const button of this.layer.querySelectorAll<HTMLButtonElement>('.vsidian-table-column-handle')) {
      button.classList.toggle('vsidian-table-control-hover', hovered !== undefined &&
        button.dataset['tableFrom'] === String(hovered.tableFrom) && button.dataset['column'] === String(column))
    }
    for (const button of this.layer.querySelectorAll<HTMLButtonElement>('.vsidian-table-insert-row, .vsidian-table-insert-column')) {
      const tableFrom = Number(button.dataset['tableFrom'])
      const group = this.visible.filter((item) => item.tableFrom === tableFrom)
      if (!group.length) continue
      const first = group[0]!.element.getBoundingClientRect()
      const last = group[group.length - 1]!.element.getBoundingClientRect()
      const near = button.classList.contains('vsidian-table-insert-row')
        ? event.clientX >= first.left && event.clientX <= first.right &&
          Math.abs(event.clientY - last.bottom) <= 12
        : event.clientY >= first.top && event.clientY <= last.bottom &&
          Math.abs(event.clientX - first.right) <= 12
      button.classList.toggle('vsidian-table-control-hover', near)
    }
  }

  private readonly onLayerHover = (event: PointerEvent): void => {
    const button = (event.target as Element).closest?.('button')
    if (button?.classList.contains('vsidian-table-insert-row') ||
        button?.classList.contains('vsidian-table-insert-column')) {
      button.classList.add('vsidian-table-control-hover')
    }
  }

  private readonly onLeave = (event: PointerEvent): void => {
    if ((event.relatedTarget as Element | null)?.closest?.('.vsidian-table-insert-row, .vsidian-table-insert-column')) return
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
    // 语言切换后控件按钮随本渲染自然取新词；层可访问名称常驻，就地重刷
    this.layer.setAttribute('aria-label', t('table.controls'))
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
      const index = contentRowIndex(rows, lineFrom)
      if (index < 0) {
        continue // 分隔行没有抓手
      }
      const rect = element.getBoundingClientRect()
      const top = rect.top - editorRect.top
      const handleLeft = rect.left - editorRect.left - 9
        const handle = this.makeButton('vsidian-table-row-handle', t('table.selectRow', { n: index + 1 }),
        handleLeft, top + rect.height / 2, () => {
          if (this.suppressNextClick) { this.suppressNextClick = false; return }
          const columns = splitTableRowCells(this.view.state.doc.lineAt(rows[0]!.lineFrom).text,
            rows[0]!.lineFrom).length
          this.view.focus()
          selectTableRegion(this.view, { tableFrom: rows[0]!.lineFrom, rowFrom: index,
            rowTo: index, columnFrom: 0, columnTo: columns - 1 })
          this.applySelection()
        })
      handle.textContent = '⠿'
      handle.dataset['tableFrom'] = String(rows[0]!.lineFrom)
      const item: VisibleGridRow = { element, lineFrom, index, tableFrom: rows[0]!.lineFrom, rows, handle }
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (this.destroyed || !this.layer.contains(handle) || this.view.compositionStarted) return
        this.startDrag('row', item.tableFrom, item.index, item.lineFrom, event)
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
          const button = this.makeButton('vsidian-table-column-handle', t('table.selectColumn', { n: column + 1 }),
            cellRect.left - editorRect.left + cellRect.width / 2, rect.top - editorRect.top - 9,
            () => {
              if (this.suppressNextClick) { this.suppressNextClick = false; return }
              this.view.focus()
              selectTableRegion(this.view, { tableFrom: anchor.tableFrom, rowFrom: 0,
                rowTo: anchor.rows.length - 2, columnFrom: column, columnTo: column })
              this.applySelection()
            })
          button.textContent = '⠿'
          button.dataset['tableFrom'] = String(anchor.tableFrom)
          button.dataset['column'] = String(column)
          button.addEventListener('pointerdown', (event) => {
            event.preventDefault()
            event.stopPropagation()
            if (this.destroyed || !this.layer.contains(button) || this.view.compositionStarted) return
            this.startDrag('column', anchor.tableFrom, column, anchor.lineFrom, event)
          })
        })
        const lastVisible = group[group.length - 1]!.element.getBoundingClientRect()
        const insertCol = this.makeButton('vsidian-table-insert-column', t('table.insertColumnRight'),
          rect.right - editorRect.left + 6, (rect.top + lastVisible.bottom) / 2 - editorRect.top, () => {
            // 可见锚点只负责几何定位；结构命令始终取真实表头末列。
            const line = this.view.state.doc.lineAt(anchor.rows[0]!.lineFrom)
            const last = splitTableRowCells(line.text, line.from).at(-1)
            if (last) this.actions.runTableEditAt(this.view, last.contentFrom, 'insertColumnRight')
          })
        insertCol.textContent = '+'
        insertCol.dataset['tableFrom'] = String(anchor.tableFrom)
        insertCol.style.height = `${lastVisible.bottom - rect.top}px`
      }
      const tableRows = group[0]!.rows
      const lastLineFrom = tableRows[tableRows.length > 2 ? tableRows.length - 1 : 0]!.lineFrom
      const last = group.find((item) => item.lineFrom === lastLineFrom)
      if (last) {
        const rect = last.element.getBoundingClientRect()
        const addRow = this.makeButton('vsidian-table-insert-row', t('table.insertRowBelow'),
          rect.left - editorRect.left + rect.width / 2, rect.bottom - editorRect.top + 6,
          () => { this.actions.runTableEditAt(this.view, last.lineFrom, 'insertRowBelow') })
        addRow.textContent = '+'
        addRow.dataset['tableFrom'] = String(last.tableFrom)
        addRow.style.width = `${rect.width}px`
      }
    }
    this.applySelection()
    if (this.dragging?.moved) this.paintDrag(this.dragging.lastX, this.dragging.lastY)
  }

  private applySelection(): void {
    const selected = this.view.state.field(tableRegionField, false)
    for (const item of this.visible) {
      const columns = item.element.querySelectorAll(':scope > .vsidian-table-grid-cell').length
      const rowSelected = selected?.tableFrom === item.tableFrom && selected.rowFrom === item.index &&
        selected.rowTo === item.index && selected.columnFrom === 0 && selected.columnTo === columns - 1
      item.element.classList.toggle('vsidian-table-row-selected', rowSelected)
      const column = selected?.tableFrom === item.tableFrom && selected.rowFrom === 0 &&
        selected.rowTo === item.rows.length - 2 && selected.columnFrom === selected.columnTo
        ? selected.columnFrom : undefined
      item.element.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell').forEach((cell, index) => {
        const active = column === index
        cell.classList.toggle('vsidian-table-column-selected', active)
        cell.classList.toggle('vsidian-table-column-first', active && item.index === 0)
        cell.classList.toggle('vsidian-table-column-last', active && item.index === item.rows.length - 2)
      })
    }
  }

  private startDrag(axis: 'row' | 'column', tableFrom: number, source: number,
    sourcePos: number, event: PointerEvent): void {
    this.endDrag()
    this.dragging = { axis, tableFrom, source, sourcePos, x: event.clientX, y: event.clientY,
      lastX: event.clientX, lastY: event.clientY, slot: null, moved: false }
    document.addEventListener('pointermove', this.onDragMove)
    document.addEventListener('pointerup', this.onDragEnd)
    document.addEventListener('pointercancel', this.onDragCancel)
  }

  private clearDragPaint(): void {
    for (const item of this.visible) {
      item.element.classList.remove('vsidian-table-dragging', 'vsidian-table-drop-before', 'vsidian-table-drop-after')
      item.element.querySelectorAll('.vsidian-table-column-drop-before, .vsidian-table-column-drop-after')
        .forEach((cell) => cell.classList.remove('vsidian-table-column-drop-before', 'vsidian-table-column-drop-after'))
    }
  }

  private paintDrag(x: number, y: number): void {
    const drag = this.dragging
    if (!drag) return
    this.clearDragPaint()
    const group = this.visible.filter((item) => item.tableFrom === drag.tableFrom)
    if (!group.length) { drag.slot = null; return }
    const first = group[0]!.element.getBoundingClientRect()
    const last = group[group.length - 1]!.element.getBoundingClientRect()
    if (drag.axis === 'row' ? y < first.top - 12 || y > last.bottom + 12
      : x < first.left - 12 || x > first.right + 12 || y < first.top - 16 || y > last.bottom + 12) {
      drag.slot = null
      return
    }
    const hit = document.elementFromPoint(x, y)
    const control = hit?.closest<HTMLElement>('[data-table-from]')
    if (control?.dataset['tableFrom'] && Number(control.dataset['tableFrom']) !== drag.tableFrom) {
      drag.slot = null
      return
    }
    const hitRow = hit?.closest<HTMLElement>('.vsidian-table-grid-row')
    if (hitRow && this.visible.some((item) => item.element === hitRow && item.tableFrom !== drag.tableFrom)) {
      drag.slot = null
      return
    }
    if (drag.axis === 'row') {
      const target = group.find((item) => {
        const rect = item.element.getBoundingClientRect()
        return y < rect.top + rect.height / 2
      }) ?? group[group.length - 1]!
      const rect = target.element.getBoundingClientRect()
      const after = y >= rect.top + rect.height / 2
      drag.slot = target.index + (after ? 1 : 0)
      target.element.classList.add(after ? 'vsidian-table-drop-after' : 'vsidian-table-drop-before')
      group.find((item) => item.index === drag.source)?.element.classList.add('vsidian-table-dragging')
    } else {
      const anchor = group.find((item) => item.index === 0) ?? group[0]!
      const cells = [...anchor.element.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')]
      const target = cells.findIndex((cell) => {
        const rect = cell.getBoundingClientRect()
        return x < rect.left + rect.width / 2
      })
      const col = target < 0 ? cells.length - 1 : target
      if (col < 0) { drag.slot = null; return }
      const rect = cells[col]!.getBoundingClientRect()
      const after = x >= rect.left + rect.width / 2
      drag.slot = col + (after ? 1 : 0)
      for (const item of group) {
        item.element.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')[col]
          ?.classList.add(after ? 'vsidian-table-column-drop-after' : 'vsidian-table-column-drop-before')
      }
    }
  }

  private readonly onDragMove = (event: PointerEvent): void => {
    const drag = this.dragging
    if (!drag) return
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return
    drag.moved = true
    this.paintDrag(event.clientX, event.clientY)
  }

  private readonly onDragEnd = (): void => {
    const drag = this.dragging
    this.endDrag()
    if (drag?.moved && drag.slot !== null) {
      this.suppressNextClick = true
      // 浏览器可能在 pointerup 后补发 click；只吞这一次，随后立即恢复抓手点击。
      setTimeout(() => { this.suppressNextClick = false }, 0)
      if (drag.axis === 'row') this.actions.runTableRowMove(this.view, drag.sourcePos, drag.slot)
      else this.actions.runTableColumnMove(this.view, drag.tableFrom, drag.source, drag.slot)
    }
  }
  private readonly onDragCancel = (): void => this.endDrag()

  private endDrag(): void {
    document.removeEventListener('pointermove', this.onDragMove)
    document.removeEventListener('pointerup', this.onDragEnd)
    document.removeEventListener('pointercancel', this.onDragCancel)
    this.clearDragPaint()
    this.dragging = null
  }
}

export function createTableControls(actions: TableControlActions) {
  return ViewPlugin.fromClass(class extends TableControlsView {
    constructor(view: EditorView) { super(view, actions) }
  })
}
