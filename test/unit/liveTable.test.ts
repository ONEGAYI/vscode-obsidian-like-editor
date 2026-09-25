// @vitest-environment jsdom
// 表格单元格编辑契约（工单 #12/#42）：live 网格装饰 + 编辑链路 + 权威回读。
//
// 核心断言（用户可观察行为，非实现复述）：
// - 装饰：表格行/单元格/管道符/对齐的稳定类名；安全表格的活动格也保留网格，
//   原文零长度格用定位 widget；编辑清空后保留填充空格承载原生输入
// - 编辑链路：视图单元格输入（CM6 事务）→ edit.request → 宿主权威文档
//   → 保存回读（getText）→ 以权威文本重建装饰与编辑后呈现一致
// - 键入 | 自动转义 \|；代码 span 内不转义；\ 之后不重复转义
// - 撤销一次 = 撤销一次单元格提交（宿主权威栈经 history.request 回流）
// - 外部变更（另一面板改同一表格）经统一 doc.changed 链路应用
// - IME 组合期间外部增量缓冲、组合上屏后对账不丢输入（复用 #3 链路）
// - 真冲突进入暂停并保留输入（conflict.report），不静默丢字
// - 增量装饰与全量重建对拍一致（RangeSet.eq）
// - 千行单表：装饰构建/单格编辑增量在宽松时限内完成且写回正确
import { describe, it, expect, vi } from 'vitest'
import { EditorSelection, EditorState, RangeSet, Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, deleteCharBackward, deleteCharForward } from '@codemirror/commands'
import type { DecorationSet } from '@codemirror/view'
import {
  LIVE_CLASS_NAMES,
  buildLivePreviewDecorations,
  getTableGridStats,
  liveDecorationsField,
  livePreviewDecorations,
} from '../../src/webview/liveDecorations'
import { blankRowInputPlan, tableEditing, tablePipeKeyHandler } from '../../src/webview/tableEditing'
import { splitTableRowCells, tableRowCellsForColumns } from '../../src/webview/tableCells'
import { splitReadingBlocks } from '../../src/webview/readingBlocks'
import { createReadingBlockElement } from '../../src/webview/readingView'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { DocumentSession, type HostDocumentPort, type SessionNotice } from '../../src/host/documentSession'
import type { HostToWebview, SerChange, WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/table.md'

const TABLE_DOC = [
  '# 表格样例',
  '',
  '| 名字 | 数量 |',
  '| --- | :---: |',
  '| 苹果 | 3 |',
  '| `x|y` | 4 |',
  '',
  '普通段落。',
  '',
].join('\n')

// ---- 断言辅助（集合级读取，同 liveDecorations.test.ts 方向） ----

interface DecoItem {
  from: number
  to: number
  cls?: string
}

function collect(set: DecorationSet): DecoItem[] {
  const out: DecoItem[] = []
  set.between(0, Infinity, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: unknown }
    if (spec['class'] !== undefined) {
      out.push({ from, to, cls: spec['class'] })
    } else if (spec.widget !== undefined) {
      out.push({ from, to, cls: '__widget__' })
    } else {
      out.push({ from, to })
    }
  })
  return out
}

function textsFor(set: DecorationSet, cls: string, doc: string): string[] {
  return collect(set)
    .filter((i) => i.cls?.split(' ').includes(cls))
    .map((i) => (i.to > i.from ? doc.slice(i.from, i.to) : `@${i.from}`))
}

function build(doc: string, selection = { anchor: 0 }): DecorationSet {
  return buildLivePreviewDecorations(Text.of(doc.split('\n')), EditorSelection.single(selection.anchor))
}

// ---- 装饰契约 ----

describe('live 表格装饰', () => {
  it('跨过安全表格的非空选区不露出分隔行源码标记', () => {
    const doc = '前文\n\n| A | B | C |\n| --- | --- | --- |\n| 带 | s是 | 送 |\n\n后文'
    const selection = EditorSelection.single(1, doc.indexOf('后文') + 1)
    const set = buildLivePreviewDecorations(Text.of(doc.split('\n')), selection)
    expect(textsFor(set, LIVE_CLASS_NAMES.tableGridRow, doc)).toHaveLength(2)
    const delimiterAt = doc.indexOf('| --- | --- | --- |')
    expect(collect(set).some((item) => item.from === delimiterAt &&
      item.cls?.split(' ').includes(LIVE_CLASS_NAMES.tableGridDelimiter))).toBe(true)
  })

  it('鼠标从段落跨行拖选到表格后方时停在表格边界，不把结构标记纳入选区', () => {
    const doc = '前文\n\n| A | B | C |\n| --- | --- | --- |\n| 带 | s是 | 送 |\n\n后文'
    const view = makeEditView(doc, 1)
    view.dispatch({ selection: EditorSelection.single(1, doc.indexOf('后文') + 1),
      userEvent: 'select.pointer' })
    expect(view.state.selection.main.anchor).toBe(1)
    expect(view.state.selection.main.head).toBe(doc.indexOf('| A | B | C |'))
    expect(view.state.doc.toString()).toBe(doc)
    const after = doc.indexOf('后文') + 1
    view.dispatch({ selection: EditorSelection.single(after, 0), userEvent: 'select.pointer' })
    expect(view.state.selection.main.head).toBe(doc.indexOf('| 带 | s是 | 送 |') + '| 带 | s是 | 送 |'.length)
    view.destroy()
  })

  it('键盘跨过安全表格的非空选区删除不破坏隐藏结构', () => {
    const doc = '前文\n\n| A | B | C |\n| --- | --- | --- |\n| 带 | s是 | 送 |\n\n后文'
    const view = makeEditView(doc, 1)
    view.dispatch({ selection: EditorSelection.single(1, doc.indexOf('后文') + 1), userEvent: 'select' })
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(doc)
    view.destroy()
  })

  it('中间空格连续退格后再输入仍包在中列网格标记中', () => {
    const doc = '| 带 |  | 送 |\n| --- | --- | --- |\n| 左 | 右 | 末 |'
    const line = doc.split('\n')[0]!
    const middle = splitTableRowCells(line, 0)[1]!
    const view = makeEditView(doc, middle.contentFrom)
    deleteCharBackward(view)
    deleteCharBackward(view)
    expect(view.state.doc.line(1).text).toBe('| 带 | | 送 |')
    const at = view.state.selection.main.head
    view.dispatch({ changes: { from: at, insert: '是' },
      selection: { anchor: at + 1 }, userEvent: 'input.type' })
    expect(view.state.doc.line(1).text).toBe('| 带 |是 | 送 |')
    expect(view.state.selection.main.assoc).toBe(-1)
    const rendered = view.state.field(liveDecorationsField).decos
    const rebuilt = buildLivePreviewDecorations(view.state.doc, view.state.selection)
    expect(RangeSet.eq([rendered], [rebuilt])).toBe(true)
    const cells = view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[0]!
      .querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')
    expect(cells).toHaveLength(3)
    expect(cells[1]!.textContent).toContain('是')
    for (let i = 0; i < 8; i++) {
      const at = view.state.selection.main.head
      view.dispatch({ changes: { from: at, insert: 's' },
        selection: { anchor: at + 1 }, userEvent: 'input.type' })
      const current = view.state.doc.line(1)
      const columns = splitTableRowCells(current.text, current.from)
      expect(view.state.selection.main.head).toBeLessThanOrEqual(columns[1]!.contentTo)
      expect(current.text.slice(columns[2]!.contentFrom - current.from,
        columns[2]!.contentTo - current.from)).toBe('送')
    }
    expect(view.state.doc.line(1).text).toBe('| 带 |是ssssssss | 送 |')
    expect(view.state.selection.main.assoc).toBe(-1)
    view.destroy()
  })

  it('表格各行带稳定行级类：表头/分隔/数据行区分', () => {
    const set = build(TABLE_DOC)
    // 4 行表格（header、delimiter、2 数据行）；行级装饰零宽 → @行首
    expect(textsFor(set, LIVE_CLASS_NAMES.tableLine, TABLE_DOC)).toHaveLength(4)
    expect(textsFor(set, LIVE_CLASS_NAMES.tableHeaderLine, TABLE_DOC)).toHaveLength(1)
    expect(textsFor(set, LIVE_CLASS_NAMES.tableDelimiterLine, TABLE_DOC)).toHaveLength(1)
    // 表格外（标题/段落行首 0 与'普通段落'处）无表格行类
    const tableLineAt = new Set(
      collect(set)
        .filter((i) => i.cls?.split(' ').includes(LIVE_CLASS_NAMES.tableLine))
        .map((i) => i.from),
    )
    expect(tableLineAt.has(0)).toBe(false)
    expect(tableLineAt.has(TABLE_DOC.indexOf('普通段落'))).toBe(false)
  })

  it('单元格内容 mark 覆盖 trim 后内容；GFM 拆分：代码内管道不切分', () => {
    const set = build(TABLE_DOC)
    expect(textsFor(set, LIVE_CLASS_NAMES.tableCell, TABLE_DOC)).toEqual([
      '名字',
      '数量',
      '苹果',
      '3',
      '`x|y`',
      '4',
    ])
    expect(textsFor(set, LIVE_CLASS_NAMES.tableCellHeader, TABLE_DOC)).toEqual(['名字', '数量'])
  })

  it('列对齐：分隔行声明的对齐以稳定类落到各单元格', () => {
    const set = build(TABLE_DOC)
    expect(textsFor(set, LIVE_CLASS_NAMES.tableAlign('center'), TABLE_DOC)).toEqual([
      '数量',
      '3',
      '4',
    ])
    expect(textsFor(set, LIVE_CLASS_NAMES.tableAlign('left'), TABLE_DOC)).toEqual([])
    expect(textsFor(set, LIVE_CLASS_NAMES.tableAlign('right'), TABLE_DOC)).toEqual([])
  })

  it('管道符带分隔样式类：数据行的全部裸管道符（含首尾边界）', () => {
    const set = build(TABLE_DOC)
    const rowFrom = TABLE_DOC.indexOf('| 苹果 | 3 |')
    const pipes = collect(set)
      .filter(
        (i) =>
          i.cls?.split(' ').includes(LIVE_CLASS_NAMES.tablePipe) &&
          i.from >= rowFrom &&
          i.from < rowFrom + 10,
      )
      .sort((a, b) => a.from - b.from)
    expect(pipes.map((p) => TABLE_DOC[p.from])).toEqual(['|', '|', '|'])
  })

  it('非空表格行没有独立输入 widget 或源区间替换', () => {
    const set = build(TABLE_DOC)
    expect(collect(set).some((i) => i.cls === '__widget__' || i.cls === undefined)).toBe(false)
  })

  it('单元格内行内格式装饰照常发射（粗体等）', () => {
    const doc = '| a | b |\n| --- | --- |\n| **粗** | c |\n'
    const set = build(doc)
    expect(textsFor(set, LIVE_CLASS_NAMES.strong, doc)).toEqual(['粗'])
  })

  it('frontmatter 内的管道行不作表格装饰（两视图共用头块边界）', () => {
    const doc = '---\n| a | b |\n| --- | --- |\n---\n\n正文\n'
    const set = build(doc)
    expect(textsFor(set, LIVE_CLASS_NAMES.tableLine, doc)).toHaveLength(0)
  })

  it('活动单元格仍留在完整网格内，原文编辑和选区切换不改其他格', () => {
    const at = TABLE_DOC.indexOf('苹果')
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: TABLE_DOC, extensions: [livePreviewDecorations] }),
    })
    const rows = [...view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')]
    expect(rows).toHaveLength(3)
    expect(rows[0]?.dataset['vsidianTableRow']).toBe('header')
    expect(rows[1]?.dataset['vsidianTableRow']).toBe('row')
    expect(rows[0]?.style.getPropertyValue('--vsidian-table-columns')).toBe('2')
    expect(rows[0]?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
    expect(rows[2]?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
    expect(rows[1]?.querySelector('.vsidian-table-grid-align-center')).not.toBeNull()
    expect(view.contentDOM.querySelector('.vsidian-table-grid-delimiter')).not.toBeNull()
    expect(view.state.doc.toString()).toBe(TABLE_DOC)

    view.dispatch({ selection: EditorSelection.single(at) })
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
    const activeRow = view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[1]!
    expect(activeRow.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.dispatch({ changes: { from: at, to: at + 2, insert: '香蕉' } })
    expect(view.state.doc.toString()).toContain('| 香蕉 | 3 |')
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
    view.destroy()
  })

  it('空格、转义管道与代码管道保留单格；不安全的列数不一致表格退回源码', () => {
    const safe = '| A | B |\n| --- | :---: |\n| | x\\|y |\n| `a|b` | z |\n'
    const safeSet = build(safe, { anchor: safe.length })
    expect(textsFor(safeSet, LIVE_CLASS_NAMES.tableGridRow, safe)).toHaveLength(3)
    expect(textsFor(safeSet, LIVE_CLASS_NAMES.tableGridCell, safe)).toHaveLength(6)
    expect(textsFor(safeSet, LIVE_CLASS_NAMES.tableEscapedPipe, safe)).toEqual(['\\'])
    const safeView = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: safe, extensions: [livePreviewDecorations], selection: EditorSelection.single(safe.length) }),
    })
    expect(safeView.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
    expect(safeView.contentDOM.querySelectorAll('.vsidian-table-grid-row')[2]?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
    safeView.destroy()
    const empty = '| A | B |\n| --- | --- |\n|| x |\n'
    const emptySet = build(empty, { anchor: empty.length })
    expect(textsFor(emptySet, LIVE_CLASS_NAMES.tableGridRow, empty)).toHaveLength(2)
    expect(collect(emptySet).some((item) => item.cls === '__widget__')).toBe(true)
    const emptyView = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: empty, extensions: [livePreviewDecorations], selection: EditorSelection.single(empty.length) }),
    })
    const slot = emptyView.contentDOM.querySelector<HTMLElement>('[aria-label="空单元格"]')
    expect(slot).not.toBeNull()
    expect(slot!.parentElement?.classList.contains(LIVE_CLASS_NAMES.tableGridRow)).toBe(true)
    expect(slot!.parentElement?.querySelectorAll(':scope > .cm-widgetBuffer')).toHaveLength(1)
    slot!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(emptyView.state.selection.main.from).toBe(empty.indexOf('|| x |') + 1)
    expect(emptyView.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(2)
    emptyView.destroy()
    const unsafe = '| A | B |\n| --- | --- |\n| only one |\n'
    const unsafeSet = build(unsafe)
    expect(textsFor(unsafeSet, LIVE_CLASS_NAMES.tableGridRow, unsafe)).toHaveLength(0)
    expect(textsFor(unsafeSet, LIVE_CLASS_NAMES.tableLine, unsafe)).toHaveLength(3)
    const trailing = '| A | B |\n| --- | --- |\n| c | d |  \n'
    expect(textsFor(build(trailing, { anchor: trailing.length }), LIVE_CLASS_NAMES.tableGridRow, trailing))
      .toHaveLength(2)
  })

  it.each([
    ['a|b', '---|---', ' | ', 2],
    ['a|b|c', '---|---|---', ' | | ', 3],
    ['a|b|c|d', '---|---|---|---', ' | | | ', 4],
    ['| a | b | c |', '| --- | --- | --- |', '| | | |', 3],
  ])('合法表格 %s / %s / %s 保持 %i 格网格', (header, delimiter, row, count) => {
    const doc = `${header}\n${delimiter}\n${row}\n`
    const set = build(doc, { anchor: doc.length })
    expect(textsFor(set, LIVE_CLASS_NAMES.tableGridRow, doc)).toHaveLength(2)
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [livePreviewDecorations], selection: EditorSelection.single(doc.length) }),
    })
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(count)
    view.destroy()
  })

  it.each([2, 3])('同一无边界空白行在 %i 列表格按列数绘制，点击不写回且首次输入维持网格', (columns) => {
    const header = Array.from({ length: columns }, (_, i) => String.fromCharCode(97 + i)).join('|')
    const delimiter = Array(columns).fill('---').join('|')
    const doc = `${header}\n${delimiter}\n | | \n`
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [livePreviewDecorations, tableEditing] }),
    })
    const table = splitReadingBlocks(doc).find((block) => block.kind === 'table')!
    expect(createReadingBlockElement(table, doc).querySelectorAll('tbody td')).toHaveLength(columns)
    for (let col = 0; col < columns; col++) {
      const cells = view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[1]
        ?.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')
      expect(cells).toHaveLength(columns)
      cells![col]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
      expect(view.state.doc.toString()).toBe(doc)
      const pos = splitTableRowCells(' | | ', doc.indexOf(' | | '))[col]!.contentFrom
      view.dispatch({ selection: EditorSelection.single(pos) })
      view.dispatch({ changes: { from: pos, insert: 'X' }, userEvent: 'input.type' })
      expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
        ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(columns)
      expect(view.state.doc.line(3).text).toContain('X')
      view.dispatch({ changes: { from: view.state.doc.line(3).from, to: view.state.doc.line(3).to, insert: ' | | ' } })
    }
    view.destroy()
  })

  it('增量维护：单元格编辑后装饰与全量重建对拍一致', () => {
    const state0 = EditorState.create({
      doc: TABLE_DOC,
      extensions: [liveDecorationsField],
      selection: EditorSelection.single(0),
    })
    const at = TABLE_DOC.indexOf('苹果')
    const tr = state0.update({
      changes: { from: at, to: at + 2, insert: '香蕉芒果' },
      selection: EditorSelection.single(at),
    })
    const after = tr.state.doc.toString()
    const incremental = tr.state.field(liveDecorationsField).decos
    const full = buildLivePreviewDecorations(tr.state.doc, tr.state.selection)
    expect(RangeSet.eq([incremental], [full])).toBe(true)
    expect(textsFor(incremental, LIVE_CLASS_NAMES.tableCell, after)).toContain('香蕉芒果')
  })

  it('结构变化（分隔行破坏 → 表格退化为普通行）重建正确', () => {
    const state0 = EditorState.create({
      doc: TABLE_DOC,
      extensions: [liveDecorationsField],
      selection: EditorSelection.single(0),
    })
    const delimAt = TABLE_DOC.indexOf('| --- | :---: |')
    const tr = state0.update({
      changes: { from: delimAt, to: delimAt + '| --- | :---: |'.length, insert: '不再是分隔行' },
      selection: EditorSelection.single(delimAt),
    })
    const full = buildLivePreviewDecorations(tr.state.doc, tr.state.selection)
    expect(RangeSet.eq([tr.state.field(liveDecorationsField).decos], [full])).toBe(true)
    expect(
      textsFor(full, LIVE_CLASS_NAMES.tableLine, tr.state.doc.toString()),
    ).toHaveLength(0)
  })
})

// ---- 输入钩子（| 键转义） ----

function makeEditView(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [liveDecorationsField, tableEditing],
      selection: EditorSelection.single(anchor),
    }),
  })
}

describe('表格单元格 | 键转义钩子', () => {
  it('省略边界的纯空白行首次键入管道：一笔规范化并转义，网格仍在', () => {
    const doc = 'a|b|c\n---|---|---\n | | '
    const pos = doc.length
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [livePreviewDecorations, tableEditing], selection: EditorSelection.single(pos) }),
    })
    expect(tablePipeKeyHandler(view)).toBe(true)
    expect(view.state.doc.line(3).text).toBe('| | | \\||')
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(3)
    view.destroy()
  })
  it('单元格内容中键入 | 写为 \\|（一次 CM6 事务）', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('果') + 1)
    expect(tablePipeKeyHandler(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('| 苹果\\| | 3 |')
    view.destroy()
  })

  it('行内代码内键入 | 不转义（返回 false 交默认插入）', () => {
    // 光标放在 `x|y` 内（x 之后）
    const spanAt = TABLE_DOC.indexOf('`x') + 2
    const view = makeEditView(TABLE_DOC, spanAt)
    expect(tablePipeKeyHandler(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.destroy()
  })

  it('表格外键入 | 不转义', () => {
    const paraAt = TABLE_DOC.indexOf('普通段落')
    const view = makeEditView(TABLE_DOC, paraAt)
    expect(tablePipeKeyHandler(view)).toBe(false)
    view.destroy()
  })

  it('选区替换：选中单元格部分内容键入 | 整体替换为 \\|', () => {
    const at = TABLE_DOC.indexOf('苹')
    const view = makeEditView(TABLE_DOC, at)
    view.dispatch({ selection: EditorSelection.range(at, at + 2) })
    expect(tablePipeKeyHandler(view)).toBe(true)
    expect(view.state.doc.toString()).toContain('| \\| | 3 |')
    view.destroy()
  })

  it('keydown 事件路径：真实按键触发转义', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('果') + 1)
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: '|', bubbles: true, cancelable: true }),
    )
    expect(view.state.doc.toString()).toContain('苹果\\|')
    view.destroy()
  })
})

// ---- 权威链路（视图 → TextDocument → 保存回读 → 再渲染一致） ----

class FakeDoc implements HostDocumentPort {
  content: string
  ver: number
  applyCalls: SerChange[][] = []
  holdApply = false
  private undoStack: { changes: SerChange[]; before: string }[] = []
  private listener: ((changes: SerChange[], version: number) => void) | undefined

  constructor(text: string) {
    this.content = text
    this.ver = 1
  }

  get version(): number {
    return this.ver
  }

  getText(): string {
    return this.content
  }

  onDocChanged(cb: (changes: SerChange[], version: number) => void): void {
    this.listener = cb
  }

  async applyChanges(changes: SerChange[]): Promise<boolean> {
    this.applyCalls.push(changes)
    if (this.holdApply) {
      await new Promise<void>(() => undefined) // 在途挂起（冲突场景构造）
      return false
    }
    this.undoStack.push({ changes, before: this.content })
    this.content = applyToText(this.content, changes)
    this.ver++
    this.listener?.(changes, this.ver)
    return true
  }

  async undo(): Promise<boolean> {
    const top = this.undoStack.pop()
    if (!top) {
      return false
    }
    const inverse: SerChange[] = top.changes.map((c) => ({
      offset: c.offset,
      length: c.text.length,
      text: top.before.slice(c.offset, c.offset + c.length),
    }))
    this.content = top.before
    this.ver++
    this.listener?.(inverse, this.ver)
    return true
  }

  async redo(): Promise<boolean> {
    return false
  }
}

function applyToText(text: string, changes: SerChange[]): string {
  const sorted = [...changes].sort((a, b) => a.offset - b.offset)
  let out = text
  let shift = 0
  for (const c of sorted) {
    out = out.slice(0, c.offset + shift) + c.text + out.slice(c.offset + shift + c.length)
    shift += c.text.length - c.length
  }
  return out
}

interface LinkedPanel {
  controller: WebviewSyncController
  session: DocumentSession
  doc: FakeDoc
  hostSent: WebviewToHost[]
  sessionId: string
  notices: SessionNotice[]
}

async function setupLinked(text: string): Promise<LinkedPanel> {
  const doc = new FakeDoc(text)
  const notices: SessionNotice[] = []
  const session = new DocumentSession(doc, { docUri: DOC_URI, onNotice: (notice) => notices.push(notice) })
  doc.onDocChanged((changes, version) => session.handleDocChanged(changes, version))
  const hostSent: WebviewToHost[] = []
  let sessionId = ''
  const bridge: VsCodeBridge = {
    postMessage: (m) => {
      const msg = m as WebviewToHost
      hostSent.push(msg)
      if (sessionId) {
        void session.handleWebviewMessage(msg, sessionId)
      }
    },
    getState: () => undefined,
    setState: () => undefined,
  }
  const controller = new WebviewSyncController(bridge)
  // 面板通道先就位，再 mount：ready → init 全文往返自动完成
  sessionId = session.attachPanel({
    send: (m: HostToWebview) => controller.handleHostMessage(m),
  })
  controller.mount(document.createElement('div'), [keymap.of(defaultKeymap)])
  await settle()
  return { controller, session, doc, hostSent, sessionId, notices }
}

/** 宿主请求队列串行化后排空（applyChanges async 链） */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('单元格编辑权威链路', () => {
  it('格内全选再删除只清空当前格，保留管道、分隔行和其他格', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('苹果')
    deleteCharBackward(view)
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC.replace('苹果', ''))
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
    for (let i = 0; i < 3; i++) deleteCharForward(view)
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC.replace('| 苹果 |', '| |'))
    linked.controller.dispose()
  })

  it('从第二格扩选到前格后键入管道只替换第二格内容', () => {
    const at = TABLE_DOC.indexOf('| 3 |') + 2
    const view = makeEditView(TABLE_DOC, at + 1)
    view.dispatch({ selection: EditorSelection.single(at + 1, TABLE_DOC.indexOf('苹果') + 2) })
    expect(tablePipeKeyHandler(view)).toBe(true)
    expect(view.state.doc.toString()).toBe(TABLE_DOC.replace('| 3 |', '| \\| |'))
    view.destroy()
  })

  it.each(['text', 'empty', 'zero'] as const)('三列表格点击中间 %s 格后输入保持在第二列', (kind) => {
    const row = kind === 'text' ? '| 带 | sss | 右 |'
      : kind === 'empty' ? '| 带 |  | 右 |' : '| 带 || 右 |'
    const doc = '| A | B | C |\n| --- | --- | --- |\n' + row + '\n'
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [livePreviewDecorations, tableEditing] }),
    })
    const cells = view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[1]!
      .querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')
    expect(cells).toHaveLength(3)
    const middle = cells[1]!
    const ranges = splitTableRowCells(row, doc.indexOf(row))
    const right = ranges[2]!.contentFrom
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(right)
    middle.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 440, clientY: 50,
    }))
    middle.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, button: 0, clientX: 440, clientY: 50,
    }))
    const cursor = view.state.selection.main.head
    expect(cursor).toBeGreaterThanOrEqual(kind === 'empty' ? ranges[1]!.from : ranges[1]!.contentFrom)
    expect(cursor).toBeLessThanOrEqual(ranges[1]!.contentTo)
    expect(view.state.selection.main.assoc).toBe(kind === 'empty' ? 1 : -1)
    if (kind === 'zero') {
      expect(view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[1]!
        .querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')[1]!
        .classList.contains('vsidian-table-grid-empty-active')).toBe(true)
    }
    view.dispatch({ changes: { from: cursor, insert: '中' }, userEvent: 'input.type' })
    const editedLine = view.state.doc.line(3)
    const editedCells = splitTableRowCells(editedLine.text, editedLine.from)
    expect(editedLine.text.slice(editedCells[1]!.contentFrom - editedLine.from,
      editedCells[1]!.contentTo - editedLine.from)).toContain('中')
    expect(editedLine.text.slice(editedCells[2]!.contentFrom - editedLine.from,
      editedCells[2]!.contentTo - editedLine.from)).toBe('右')
    hit.mockRestore()
    view.destroy()
  })

  it.each(['backward', 'forward'] as const)('单元格边界 %s 删除不会删掉隐藏的表格标记', (direction) => {
    const from = TABLE_DOC.indexOf('苹果')
    const view = makeEditView(TABLE_DOC, direction === 'backward' ? from : from + 2)
    for (let i = 0; i < 5; i++) {
      (direction === 'backward' ? deleteCharBackward : deleteCharForward)(view)
    }
    expect(view.state.doc.toString()).toBe(TABLE_DOC.replace('| 苹果 |',
      direction === 'backward' ? '|苹果 |' : '| 苹果|'))
    view.destroy()
  })

  it('格内新输入的空格仍可退格删除', () => {
    const text = TABLE_DOC.replace('苹果', '苹果 ')
    const view = makeEditView(text, text.indexOf('苹果') + 3)
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.destroy()
  })

  it('空单元格新输入的空格也可退格删除，不能把可编辑空白当作结构标记', () => {
    const text = TABLE_DOC.replace('苹果', '')
    const view = makeEditView(text, text.indexOf('|  |') + 2)
    const at = view.state.selection.main.head
    view.dispatch({ changes: { from: at, insert: ' ' }, selection: { anchor: at + 1 }, userEvent: 'input.type' })
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(text)
    view.destroy()
  })

  it.each(['backward', 'forward', 'selection', 'native'] as const)('中格以 %s 删光后保留原生输入所需的空文本承载', (method) => {
    const text = '| 左 |middle| 右 |\n| --- | --- | --- |\n| a | b | c |'
    const from = text.indexOf('middle')
    const view = makeEditView(text, method === 'backward' ? from + 6 : from)
    if (method === 'native') {
      view.dispatch({ changes: { from, to: from + 6 }, selection: { anchor: from }, userEvent: 'input.type' })
    } else if (method === 'selection') {
      view.dispatch({ selection: EditorSelection.single(from, from + 6) })
      deleteCharBackward(view)
    } else {
      for (let i = 0; i < 10; i++) (method === 'backward' ? deleteCharBackward : deleteCharForward)(view)
    }
    expect(view.state.doc.line(1).text).toBe('| 左 | | 右 |')
    const middle = view.contentDOM.querySelector('.vsidian-table-grid-row')!
      .querySelectorAll('.vsidian-table-grid-cell')[1]!
    expect(middle.getAttribute('contenteditable')).not.toBe('false')
    expect(middle.textContent).toBe(' ')
    const at = view.state.selection.main.head
    view.dispatch({ changes: { from: at, insert: 'abc' }, selection: { anchor: at + 3 }, userEvent: 'input.type' })
    deleteCharBackward(view)
    expect(view.state.doc.line(1).text).toBe('| 左 |ab | 右 |')
    view.destroy()
  })

  it.each([0, 1])('省略边界管道的表头清空第 %i 格后仍保持两列', (column) => {
    const text = 'a|b\n---|---\nc|d'
    const at = column * 2
    const view = makeEditView(text, at)
    view.dispatch({ selection: EditorSelection.single(at, at + 1) })
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe((column === 0 ? '| |b|' : '|a| |') + '\n---|---\nc|d')
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(2)
    view.destroy()
  })

  it('删除隐藏转义符会暴露额外列时保留原文，不破坏安全表格', () => {
    const text = '| a\\|b | c |\n| --- | --- |\n| d | e |'
    const at = text.indexOf('\\')
    const view = makeEditView(text, at + 1)
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(text)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(2)
    view.destroy()
  })

  it('Home 落到表格源行首后退格不能吞掉前一行分隔声明', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('| 苹果 |'))
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.destroy()
  })

  it('从格内拖到隐藏管道外时，鼠标选区仍限定在原格内容中', () => {
    const at = TABLE_DOC.indexOf('苹果')
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: TABLE_DOC,
        extensions: [livePreviewDecorations, tableEditing, keymap.of(defaultKeymap)] }),
    })
    const cell = view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]!
      .querySelector<HTMLElement>('.vsidian-table-grid-cell')!
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(at + 2)
    cell.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 80, clientY: 20,
    }))
    hit.mockReturnValue(at - 2)
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 0, clientY: 20,
    }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    expect(view.state.selection.main.from).toBe(at)
    expect(view.state.selection.main.to).toBe(at + 2)
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(TABLE_DOC.replace('苹果', ''))
    hit.mockRestore()
    view.destroy()
  })

  it.each([2, 3])('格内连续点击 %i 次后删除不包含源码标记', (detail) => {
    const at = TABLE_DOC.indexOf('苹果')
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: TABLE_DOC,
        extensions: [livePreviewDecorations, tableEditing, keymap.of(defaultKeymap)] }),
    })
    const cell = view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]!
      .querySelector<HTMLElement>('.vsidian-table-grid-cell')!
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(at + 1)
    cell.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1, detail,
    }))
    cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail }))
    expect(view.state.selection.main.from).toBe(at)
    expect(view.state.selection.main.to).toBe(at + 2)
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(TABLE_DOC.replace('苹果', ''))
    hit.mockRestore()
    view.destroy()
  })

  it('格内反向键盘扩选越过隐藏管道后删除仍保留结构，格外选中整表可以删除', () => {
    const at = TABLE_DOC.indexOf('苹果')
    const view = makeEditView(TABLE_DOC, at + 2)
    view.dispatch({ selection: EditorSelection.single(at + 2, at - 2), userEvent: 'select' })
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe(TABLE_DOC.replace('苹果', ''))
    view.dispatch({ selection: EditorSelection.single(0, view.state.doc.length), userEvent: 'select' })
    deleteCharBackward(view)
    expect(view.state.doc.toString()).toBe('')
    view.destroy()
  })

  it('特殊空白格组合提交遇全文重同步时保留本地净输入并暂停，不能静默覆盖', async () => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.dispatch({ changes: { from: pos, insert: '你' }, userEvent: 'input.type.compose' })
    linked.controller.handleHostMessage({ kind: 'doc.resync', version: 2, text: '远端全文\n' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(view.state.doc.toString()).toContain('| | | 你|')
    expect(view.state.doc.toString()).not.toBe('远端全文\n')
    expect(linked.hostSent.some((msg) => msg.kind === 'conflict.report')).toBe(true)
    expect((view.dom.parentElement?.parentElement?.querySelector('.vsidian-suspend-banner') as HTMLElement)?.style.display)
      .toBe('flex')
    expect(linked.session.getConflictState(linked.sessionId)?.webviewText).toBe(view.state.doc.toString())
    linked.session.detachPanel(linked.sessionId)
    expect(linked.notices).toMatchObject([{ type: 'panel-closed-with-input', webviewText: view.state.doc.toString() }])
  })

  it('特殊空白格组合净结果替换了原空白时重建装饰，不保留预编辑旧格位', async () => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.dispatch({ changes: { from: pos - 1, to: pos, insert: '你' }, userEvent: 'input.type.compose' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    const actual = view.state.field(liveDecorationsField).decos
    const rebuilt = buildLivePreviewDecorations(view.state.doc, view.state.selection)
    expect(collect(actual)).toEqual(collect(rebuilt))
    expect(RangeSet.eq([actual], [rebuilt])).toBe(true)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(0)
    expect(linked.doc.getText()).toBe(view.state.doc.toString())
  })

  it('千行安全表格的组合取消仅重建当前行，不再全表扫描', async () => {
    const source = 'a|b|c\n---|---|---\n' +
      Array.from({ length: 1000 }, (_, i) => `a${i}|b${i}|c${i}\n`).join('') + ' | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.lastIndexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.dispatch({ changes: { from: pos, insert: 'n' }, userEvent: 'input.type.compose' })
    view.dispatch({ changes: { from: pos, to: pos + 1, insert: '' }, userEvent: 'input.type.compose' })
    const before = getTableGridStats().rowsScanned
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(getTableGridStats().rowsScanned - before).toBeLessThan(20)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row').length).toBeGreaterThan(0)
  })

  it('长文档连续候选只发一次全文基线，后续候选桥消息随编辑量增长', async () => {
    const prefix = '```\n' + ('x'.repeat(1000) + '\n').repeat(1000) + '```\n\n'
    const source = prefix + 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    let length = 0
    for (let i = 1; i <= 12; i++) {
      view.dispatch({ changes: { from: pos, to: pos + length, insert: 'n'.repeat(i) }, userEvent: 'input.type.compose' })
      length = i
    }
    const full = linked.hostSent.filter((msg) => msg.kind === 'conflict.report' && msg.compositionPending)
    const patches = linked.hostSent.filter((msg) => msg.kind === 'composition.changed')
    expect(full).toHaveLength(1)
    expect(patches).toHaveLength(12)
    expect(JSON.stringify(patches).length).toBeLessThan(12000)
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(0)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(linked.doc.getText()).toBe(view.state.doc.toString())
  })
  it('纯空白格 IME 组合预编辑与取消不规范化源行，也不向宿主写回', async () => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionupdate'))
    view.dispatch({ changes: { from: pos, insert: 'n' }, userEvent: 'input.type.compose' })
    expect(view.state.doc.line(3).text).toBe(' | | n')
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(2)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')[2]?.textContent).toContain('n')
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(0)
    view.dispatch({ changes: { from: pos, to: pos + 1, insert: '' }, userEvent: 'input.type.compose' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(view.state.doc.toString()).toBe(source)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(2)
    expect(linked.doc.getText()).toBe(source)
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(0)
    linked.session.detachPanel(linked.sessionId)
    expect(linked.notices.filter((notice) => notice.type === 'panel-closed-with-input')).toHaveLength(0)
  })

  it('纯空白格 IME 组合提交后补边界，只向宿主写一笔并维持目标列', async () => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionupdate'))
    view.dispatch({ changes: { from: pos, insert: 'ni' }, userEvent: 'input.type.compose' })
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(0)
    view.dispatch({ changes: { from: pos, to: pos + 2, insert: '你' }, userEvent: 'input.type.compose' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(1)
    expect(linked.doc.getText()).toBe(view.state.doc.toString())
    expect(view.state.doc.line(3).text).toBe('| | | 你|')
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(3)
    const table = splitReadingBlocks(linked.doc.getText()).find((block) => block.kind === 'table')!
    expect(Array.from(createReadingBlockElement(table, linked.doc.getText()).querySelectorAll('tbody td'),
      (cell) => cell.textContent)).toEqual(['', '', '你'])
  })

  it('纯空白格组合中面板关闭：未写回的候选文本通过宿主快照可取回', async () => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.dispatch({ changes: { from: pos, insert: 'ni' }, userEvent: 'input.type.compose' })
    await settle()
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(0)
    linked.session.detachPanel(linked.sessionId)
    expect(linked.notices).toMatchObject([{ type: 'panel-closed-with-input', webviewText: view.state.doc.toString() }])
  })

  it('另一面板占住宿主队列时，空白格组合提交后立即关闭仍取回完整候选', async () => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const blocker = linked.session.attachPanel({ send: () => undefined })
    await linked.session.handleWebviewMessage({ kind: 'ready' }, blocker)
    linked.doc.holdApply = true
    void linked.session.handleWebviewMessage({ kind: 'edit.request', sessionId: blocker, docUri: DOC_URI,
      seq: 1, baseVersion: 1, changes: [{ offset: 0, length: 0, text: 'X' }] }, blocker)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.dispatch({ changes: { from: pos, insert: '你' }, userEvent: 'input.type.compose' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(1)
    expect(linked.hostSent.some((msg) => msg.kind === 'conflict.report' && msg.compositionPending === false)).toBe(true)
    linked.session.detachPanel(linked.sessionId)
    expect(linked.notices).toMatchObject([{ type: 'panel-closed-with-input', webviewText: view.state.doc.toString() }])
    expect(view.state.doc.line(3).text).toBe('| | | 你|')
  })

  it.each([false, true])('纯空白格组合提交时外部%s增量按原有规则重定位或暂停', async (overlap) => {
    const source = 'a|b|c\n---|---|---\n | | \n'
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = source.indexOf(' | | ') + 5
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    view.dispatch({ changes: { from: pos, insert: 'ni' }, userEvent: 'input.type.compose' })
    const offset = overlap ? pos - 1 : 0
    linked.doc.content = source.slice(0, offset) + 'X' + source.slice(offset + 1)
    linked.doc.ver++
    linked.session.handleDocChanged([{ offset, length: 1, text: 'X' }], linked.doc.ver)
    view.dispatch({ changes: { from: pos, to: pos + 2, insert: '你' }, userEvent: 'input.type.compose' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    if (overlap) {
      expect(view.state.doc.toString()).toContain('你')
      expect(linked.hostSent.some((msg) => msg.kind === 'conflict.report')).toBe(true)
      expect(linked.notices.some((notice) => notice.type === 'conflict')).toBe(true)
    } else {
      expect(view.state.doc.toString()).toBe(linked.doc.getText())
      expect(linked.doc.getText()).toContain('X|b|c')
      expect(linked.doc.getText()).toContain('| | | 你|')
    }
  })
  it.each([
    [2, 'input.paste'],
    [3, 'input.type.compose'],
  ])('%i 列纯空白行末格首次 %s 输入：单笔权威写回并在阅读视图保持目标列', async (columns, userEvent) => {
    const header = Array.from({ length: columns }, (_, i) => String.fromCharCode(97 + i)).join('|')
    const delimiter = Array(columns).fill('---').join('|')
    const source = `${header}\n${delimiter}\n | | \n`
    const linked = await setupLinked(source)
    const view = linked.controller.getView()!
    const pos = tableRowCellsForColumns(' | | ', source.indexOf(' | | '), columns)![columns - 1]!.contentFrom
    view.dispatch({ selection: EditorSelection.single(pos) })
    view.dispatch({ changes: { from: pos, insert: 'X' }, userEvent })
    await settle()
    expect(linked.doc.getText()).toBe(view.state.doc.toString())
    expect(linked.hostSent.filter((msg) => msg.kind === 'edit.request')).toHaveLength(1)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(columns)
    const table = splitReadingBlocks(linked.doc.getText()).find((block) => block.kind === 'table')!
    const reading = createReadingBlockElement(table, linked.doc.getText())
    expect(Array.from(reading.querySelectorAll('tbody td'), (cell) => cell.textContent))
      .toEqual(Array.from({ length: columns }, (_, i) => i === columns - 1 ? 'X' : ''))
  })
  it('视图单元格替换 → 权威文档更新 → 保存回读一致 → 再渲染一致', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    const at = TABLE_DOC.indexOf('苹果')
    view.dispatch({ changes: { from: at, to: at + 2, insert: '香蕉' } })
    await settle()
    // 权威文档（保存回读语义）逐字一致：行内其余部分不动
    expect(linked.doc.getText()).toBe(TABLE_DOC.replace('苹果', '香蕉'))
    // 权威文本重建装饰与编辑后视图渲染一致（单元格内容更新、结构不变）
    const rebuilt = buildLivePreviewDecorations(view.state.doc, view.state.selection)
    expect(textsFor(rebuilt, LIVE_CLASS_NAMES.tableCell, view.state.doc.toString())).toContain('香蕉')
    expect(textsFor(rebuilt, LIVE_CLASS_NAMES.tableLine, view.state.doc.toString())).toHaveLength(4)
  })

  it('键入 | 转义经完整链路：权威文档落为 \\|（保存回读正确）', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('果') + 1) })
    expect(tablePipeKeyHandler(view)).toBe(true)
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC.replace('| 苹果 | 3 |', '| 苹果\\| | 3 |'))
  })

  it('撤销一次 = 撤销一次单元格提交（宿主权威栈回流）', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    const at = TABLE_DOC.indexOf('苹果')
    view.dispatch({ changes: { from: at, to: at + 2, insert: '香蕉' } })
    await settle()
    expect(linked.doc.getText()).toContain('香蕉')
    await linked.session.handleWebviewMessage(
      { kind: 'history.request', op: 'undo' },
      linked.sessionId,
    )
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
  })

  it('外部变更（另一面板改同一表格）经统一 doc.changed 链路应用', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    const at = TABLE_DOC.indexOf('苹果')
    view.dispatch({ changes: { from: at, to: at + 2, insert: '芒果' } })
    await settle() // 本地编辑确认（权威已含芒果）
    // 另一面板把数量 3 → 30（权威系坐标基于已确认文本）
    const three = TABLE_DOC.indexOf('| 3 |') + 2
    const externalText = linked.doc.getText().replace('| 3 |', '| 30 |')
    linked.doc.content = externalText
    linked.doc.ver++
    linked.session.handleDocChanged([{ offset: three, length: 1, text: '30' }], linked.doc.ver)
    await settle()
    expect(view.state.doc.toString()).toContain('芒果')
    expect(view.state.doc.toString()).toContain('| 30 |')
    expect(linked.doc.getText()).toContain('芒果')
    expect(linked.doc.getText()).toContain('| 30 |')
  })

  it('IME 组合期间外部增量缓冲；组合上屏后对账不丢输入', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    const at = TABLE_DOC.indexOf('苹果') + 2
    view.dispatch({ selection: EditorSelection.single(at) })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    // 组合期间外部把 4 → 40
    const four = TABLE_DOC.indexOf('| 4 |') + 2
    linked.doc.content = TABLE_DOC.replace('| 4 |', '| 40 |')
    linked.doc.ver++
    linked.session.handleDocChanged([{ offset: four, length: 1, text: '40' }], linked.doc.ver)
    // 组合文本上屏（CM6 在 compositionend 后的最终事务形态）
    view.dispatch({ changes: { from: at, insert: '汁' }, userEvent: 'input.type.compose' })
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    await settle()
    expect(view.state.doc.toString()).toContain('苹果汁')
    expect(view.state.doc.toString()).toContain('| 40 |')
    expect(linked.doc.getText()).toContain('苹果汁')
    expect(linked.doc.getText()).toContain('| 40 |')
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
  })

  it('网格边框附近点击被约束在被点击的单元格源区间，不落到隐藏管道符', () => {
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc: TABLE_DOC, extensions: [livePreviewDecorations] }),
    })
    const first = view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[1]!
      .querySelector<HTMLElement>('.vsidian-table-grid-cell')!
    const pipe = TABLE_DOC.indexOf('| 苹果 |')
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(pipe)
    const originalPosAtDOM = view.posAtDOM.bind(view)
    const domMap = vi.spyOn(view, 'posAtDOM').mockImplementation((node, offset) =>
      node === first ? pipe : originalPosAtDOM(node, offset))
    first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
    expect(view.state.selection.main.from).toBe(pipe + 2)
    view.dispatch({ selection: EditorSelection.single(pipe) }) // 浏览器默认定位若晚于装饰处理
    first.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }))
    expect(view.state.selection.main.from).toBe(pipe + 2)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
    hit.mockRestore()
    domMap.mockRestore()
    view.destroy()
  })

  it('活动格粘贴经同一 CM6 事务写回，网格和邻格不变', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    const at = TABLE_DOC.indexOf('苹果') + 2
    view.dispatch({ selection: EditorSelection.single(at) })
    view.dispatch({ changes: { from: at, insert: '汁' }, userEvent: 'input.paste' })
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC.replace('苹果', '苹果汁'))
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')[1]
      ?.querySelectorAll(':scope > .vsidian-table-grid-cell')).toHaveLength(2)
  })

  it('单元格在途编辑与外部变更真重叠：暂停并保留输入（不静默丢字）', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    linked.doc.holdApply = true // 写回在途挂起（未确认状态）
    const at = TABLE_DOC.indexOf('苹果')
    view.dispatch({ changes: { from: at, to: at + 2, insert: '梨' } })
    // 外部直接覆盖同一区间（权威系）——与未确认编辑真重叠
    linked.doc.content = TABLE_DOC.replace('苹果', '外部改')
    linked.doc.ver++
    linked.session.handleDocChanged(
      [{ offset: at, length: 2, text: '外部改' }],
      linked.doc.ver,
    )
    await settle()
    // 本地输入保留、写回暂停（conflict.report 上报）
    expect(view.state.doc.toString()).toContain('梨')
    expect(linked.hostSent.some((m) => m.kind === 'conflict.report')).toBe(true)
  })
})

// ---- 大表性能边界 ----

function bigTableDoc(rows: number): string {
  const lines = ['| 名字 | 数量 | 备注 |', '| --- | :---: | --- |']
  for (let i = 1; i <= rows; i++) {
    lines.push(`| 第${i}项 | ${i} | 备注内容 ${i} |`)
  }
  lines.push('')
  return lines.join('\n')
}

it('千行表纯空白格首键资格判断只触及有界行数', () => {
  const doc = 'a|b|c\n---|---|---\n' + Array.from({ length: 1000 }, (_, i) => `a${i}|b${i}|c${i}\n`).join('') + ' | | \n'
  const state = EditorState.create({ doc, extensions: [livePreviewDecorations] })
  const line = state.doc.line(state.doc.lines - 1)
  const spy = vi.spyOn(state.doc, 'lineAt')
  expect(blankRowInputPlan(state, line.from + 5, line.from + 5, 'X')).not.toBeNull()
  expect(spy.mock.calls.length).toBeLessThan(16)
  spy.mockRestore()
})

describe('千行单表性能边界', () => {
  it('光标跨行仅重建局部装饰，不重复遍历整张表规划网格', () => {
    const doc = bigTableDoc(1000)
    const state0 = EditorState.create({ doc, extensions: [liveDecorationsField] })
    const before = getTableGridStats()
    const at = state0.doc.line(502).from + 3
    const state1 = state0.update({ selection: EditorSelection.single(at) }).state
    const after = getTableGridStats()
    expect(state1.doc.toString()).toBe(doc)
    expect(after.rowsScanned - before.rowsScanned).toBeLessThan(20)
  })
  it('网格 DOM 仍由 CM6 视口裁剪，千行表不常驻全部单元格节点', () => {
    const doc = bigTableDoc(1000)
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [livePreviewDecorations] }),
    })
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-cell').length).toBeLessThan(150)
    view.destroy()
  })

  it('装饰全量构建在时限内完成且行数正确', () => {
    const doc = bigTableDoc(1000)
    const text = Text.of(doc.split('\n'))
    const t0 = performance.now()
    const set = buildLivePreviewDecorations(text, EditorSelection.single(0))
    const elapsed = performance.now() - t0
    expect(textsFor(set, LIVE_CLASS_NAMES.tableLine, doc)).toHaveLength(1002)
    // 宽松上限（CI 抖动余量）；具体数值记录于 docs/perf
    expect(elapsed).toBeLessThan(2000)
  })

  it('单格编辑的增量装饰更新与全量重建对拍一致（时限内）', () => {
    const doc = bigTableDoc(1000)
    const state0 = EditorState.create({
      doc,
      extensions: [liveDecorationsField],
      selection: EditorSelection.single(0),
    })
    // 第 500 数据行（全文行号 502）的单元格内容替换
    const line = state0.doc.line(502)
    const cellAt = line.from + line.text.indexOf('500') // 数量列内容
    const t0 = performance.now()
    const tr = state0.update({
      changes: { from: cellAt, to: cellAt + 3, insert: '五百' },
      selection: EditorSelection.single(cellAt),
    })
    const elapsed = performance.now() - t0
    const full = buildLivePreviewDecorations(tr.state.doc, tr.state.selection)
    expect(RangeSet.eq([tr.state.field(liveDecorationsField).decos], [full])).toBe(true)
    expect(elapsed).toBeLessThan(500)
  })

  it('千行表单元格编辑写回链路正确（首尾行编辑均落盘正确）', async () => {
    const doc = bigTableDoc(1000)
    const linked = await setupLinked(doc)
    const view = linked.controller.getView()!
    const first = view.state.doc.line(3) // 首个数据行
    const last = view.state.doc.line(1002) // 末个数据行
    view.dispatch({
      changes: [
        { from: first.from + 2, to: first.from + 5, insert: '首行政' },
        { from: last.from + 2, to: last.from + 8, insert: '末行政' },
      ],
    })
    await settle()
    const saved = linked.doc.getText()
    expect(saved).toContain('| 首行政 | 1 | 备注内容 1 |')
    expect(saved).toContain('| 末行政 | 1000 | 备注内容 1000 |')
    expect(saved.split('\n')).toHaveLength(1003)
  })
})
