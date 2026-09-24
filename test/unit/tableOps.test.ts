// @vitest-environment jsdom
// 表格键盘导航与增删行列的 webview 链路契约（工单 #13）。
//
// 核心断言（用户可观察行为，非实现复述）：
// - Tab/Shift+Tab：表格行内移动单元格光标（keydown 直驱 keymap 链路）；
//   纯选区事务——零写回、零编辑历史、文本逐字节不变
// - 非表格上下文 Tab 不吞输入：处理器返回 false，交默认行为
// - IME 组合进行中不劫持 Tab（组合态键导航拒绝）
// - 增删行列：视图命令 → CM6 事务 → edit.request（一笔）→ 宿主权威文档
//   → 保存回读（getText）逐字一致；撤销一次回原
// - 表头/分隔行语义：删表头 = 数据行升格；分隔行拒绝删除；表头上插行
//   落到分隔行后
// - 增删后装饰的源映射正确：增量装饰与全量重建对拍一致（RangeSet.eq）
// - 阅读模式只读：表格命令零写回
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState, RangeSet } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { buildLivePreviewDecorations, liveDecorationsField, LIVE_CLASS_NAMES } from '../../src/webview/liveDecorations'
import { createTableControls } from '../../src/webview/tableControls'
import {
  tableEditing,
  tableTabForward,
  tableTabBackward,
  runTableEdit,
  runTableRowMove,
  tableRowsAt,
} from '../../src/webview/tableEditing'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { DocumentSession, type HostDocumentPort } from '../../src/host/documentSession'
import type { HostToWebview, SerChange, WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/table13.md'

const TABLE_DOC = [
  '前导段落。',
  '',
  '| 名字 | 数量 |',
  '| --- | :---: |',
  '| 苹果 | 3 |',
  '| `x|y` | 4 |',
  '',
  '结尾段落。',
  '',
].join('\n')

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

function cellTexts(set: DecorationSet, doc: string): string[] {
  return collect(set)
    .filter((i) => i.cls?.split(' ').includes(LIVE_CLASS_NAMES.tableCell))
    .map((i) => (i.to > i.from ? doc.slice(i.from, i.to) : ''))
}

// ---- Tab 导航（keymap 链路） ----

function makeEditView(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      // 多光标用例需显式开启（真实装配未提供多光标创建入口，导航语义
      // 仍按多 range 全有或全无处理）
      extensions: [liveDecorationsField, tableEditing, EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.single(anchor),
    }),
  })
}

const tabKeydown = (view: EditorView, shift = false): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }),
  )
}

describe('表格 Tab/Shift+Tab 导航', () => {
  it('Tab：单元格内 → 下一单元格内容首（keydown 直驱，文本零变化）', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('苹果') + 1)
    tabKeydown(view)
    expect(view.state.selection.main.from).toBe(TABLE_DOC.indexOf('| 3 |') + 2)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.destroy()
  })

  it('Tab：行末单元格 → 下一表格行首格', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('3') + 1)
    tabKeydown(view)
    expect(view.state.selection.main.from).toBe(TABLE_DOC.indexOf('| `x|y` |') + 2)
    view.destroy()
  })

  it('Shift+Tab：单元格内 → 上一单元格内容尾', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('4') + 1)
    tabKeydown(view, true)
    expect(view.state.selection.main.from).toBe(TABLE_DOC.indexOf('`x|y`') + 5)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.destroy()
  })

  it('表头首格 Shift+Tab 与末行末格 Tab：返回 false 交默认（不吞输入）', () => {
    const first = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('名字') + 1)
    expect(tableTabBackward(first)).toBe(false)
    tabKeydown(first, true)
    expect(first.state.doc.toString()).toBe(TABLE_DOC)
    first.destroy()

    const last = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('4') + 1)
    expect(tableTabForward(last)).toBe(false)
    last.destroy()
  })

  it('非表格上下文：Tab 处理器返回 false，无文本与选区强改', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('前导段落') + 2)
    expect(tableTabForward(view)).toBe(false)
    expect(tableTabBackward(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.destroy()
  })

  it('导航是纯选区事务：零出站消息、零编辑历史语义（不产生 edit.request）', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    const sentBefore = linked.hostSent.length
    expect(tableTabForward(view)).toBe(true)
    await settle()
    expect(view.state.selection.main.from).toBe(TABLE_DOC.indexOf('| 3 |') + 2)
    expect(linked.hostSent.length).toBe(sentBefore) // 无任何新出站消息
    expect(linked.doc.getText()).toBe(TABLE_DOC)
  })

  it('多光标：全部 range 命中表格单元格才整体移动', () => {
    const view = makeEditView(TABLE_DOC, 0)
    const a = TABLE_DOC.indexOf('苹果') + 1
    const b = TABLE_DOC.indexOf('`x|y`') + 2
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(a, a), EditorSelection.range(b, b)]) })
    expect(tableTabForward(view)).toBe(true)
    const froms = view.state.selection.ranges.map((r) => r.from)
    expect(froms).toContain(TABLE_DOC.indexOf('| 3 |') + 2)
    expect(froms).toContain(TABLE_DOC.indexOf('| 4 |') + 2)
    view.destroy()
  })

  it('多光标任一 range 在表格外 → 整体返回 false（与 | 键口径一致）', () => {
    const view = makeEditView(TABLE_DOC, 0)
    const a = TABLE_DOC.indexOf('苹果') + 1
    const outside = TABLE_DOC.indexOf('结尾段落')
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(a, a), EditorSelection.range(outside, outside)]) })
    expect(tableTabForward(view)).toBe(false)
    view.destroy()
  })

  it('选区（非空 range）不作单元格导航，交默认行为', () => {
    const view = makeEditView(TABLE_DOC, 0)
    const a = TABLE_DOC.indexOf('苹')
    view.dispatch({ selection: EditorSelection.range(a, a + 2) })
    expect(tableTabForward(view)).toBe(false)
    view.destroy()
  })

  it('IME 组合进行中不劫持 Tab（组合态导航拒绝）', () => {
    const view = makeEditView(TABLE_DOC, TABLE_DOC.indexOf('苹果') + 1)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(tableTabForward(view)).toBe(false)
    expect(tableTabBackward(view)).toBe(false)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    view.destroy()
  })
})

// ---- 增删行列（命令 → 出站 → 权威文档） ----

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
      await new Promise<void>(() => undefined)
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
}

async function setupLinked(text: string): Promise<LinkedPanel> {
  const doc = new FakeDoc(text)
  const session = new DocumentSession(doc, { docUri: DOC_URI })
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
  sessionId = session.attachPanel({
    send: (m: HostToWebview) => controller.handleHostMessage(m),
  })
  controller.mount(document.createElement('div'))
  await settle()
  return { controller, session, doc, hostSent, sessionId }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('表格点阵与悬停控件', () => {
  it('只给安全网格的可见内容行提供抓手、选列与新增入口；状态反馈零写回', async () => {
    const view = makeEditView(TABLE_DOC, 0)
    await Promise.resolve()
    const grips = view.dom.querySelectorAll<HTMLButtonElement>('.vsidian-table-row-handle')
    const columns = view.dom.querySelectorAll<HTMLButtonElement>('.vsidian-table-column-handle')
    expect(grips).toHaveLength(3)
    expect(columns).toHaveLength(2)
    expect(view.dom.querySelectorAll('.vsidian-table-insert-row')).toHaveLength(1)
    expect(view.dom.querySelectorAll('.vsidian-table-insert-column')).toHaveLength(1)
    const hovered = view.contentDOM.querySelector<HTMLElement>('.vsidian-table-grid-row')!
    hovered.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    expect(grips[0]!.classList.contains('vsidian-table-control-hover')).toBe(true)
    expect(view.dom.querySelector('.vsidian-table-insert-column')?.classList.contains('vsidian-table-control-hover')).toBe(true)
    grips[1]!.click()
    expect(view.dom.querySelectorAll('.vsidian-table-row-selected')).toHaveLength(1)
    columns[0]!.click()
    expect(view.dom.querySelectorAll('.vsidian-table-column-selected')).toHaveLength(3)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    await Promise.resolve()
    expect(view.contentDOM.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(3)
    expect(view.dom.querySelectorAll('.vsidian-table-row-handle')).toHaveLength(3)
    view.destroy()

    const unsafe = '| a | b |\n| --- | --- |\n| one |\n'
    const fallback = makeEditView(unsafe, unsafe.length)
    await Promise.resolve()
    expect(fallback.dom.querySelectorAll('.vsidian-table-row-handle')).toHaveLength(0)
    fallback.destroy()
  })

  it('长表滚动复用行结构，控件不按可见行数重复扫描整表', async () => {
    const doc = ['| a | b |', '| --- | --- |', ...Array.from({ length: 1000 }, (_, i) => `| ${i} | x |`), ''].join('\n')
    let scans = 0
    const controls = createTableControls({
      tableRowsAt: (state, pos, tree) => { scans++; return tableRowsAt(state, pos, tree) },
      runTableEditAt: () => false,
      runTableRowMove: () => false,
    })
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({ doc, extensions: [liveDecorationsField, controls], selection: EditorSelection.single(doc.length) }),
    })
    await Promise.resolve()
    expect(scans).toBe(1)
    const first = scans
    for (let i = 0; i < 4; i++) {
      view.scrollDOM.dispatchEvent(new Event('scroll'))
      await Promise.resolve()
    }
    expect(scans - first).toBe(0)
    view.destroy()
  })

  it('底部与右侧入口复用结构命令并经宿主权威文档落盘', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    const oldAddRow = view.dom.querySelector<HTMLButtonElement>('.vsidian-table-insert-row')!
    oldAddRow.click()
    await settle()
    expect(linked.doc.getText()).toContain('| `x|y` | 4 |\n| | |')
    expect(linked.doc.applyCalls).toHaveLength(1)
    oldAddRow.click() // 视口/文档更新后旧 DOM 控件已回收，不能再次写回
    await settle()
    expect(linked.doc.applyCalls).toHaveLength(1)
    view.dom.querySelector<HTMLButtonElement>('.vsidian-table-insert-column')!.click()
    await settle()
    expect(linked.doc.getText()).toContain('| 名字 | 数量 | |')
    expect(linked.doc.getText()).toContain('| --- | :---: | --- |')
    expect(linked.doc.applyCalls).toHaveLength(2)
  })

  it('拖末行至表头只发一次文本事务，可一次撤销；IME 中拒绝拖动', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    expect(runTableRowMove(view, TABLE_DOC.indexOf('`x|y`'), 0)).toBe(true)
    await settle()
    expect(linked.doc.getText()).toContain('| `x|y` | 4 |\n| --- | :---: |\n| 名字 | 数量 |')
    expect(linked.doc.applyCalls).toHaveLength(1)
    await linked.doc.undo()
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC)

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    expect(runTableRowMove(view, TABLE_DOC.indexOf('`x|y`'), 0)).toBe(false)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  })

  it('点阵按住拖至表头上方显示落点，松开只写回一笔；仅点击抓手不写回', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    document.body.appendChild(view.dom.parentElement!)
    const grips = [...view.dom.querySelectorAll<HTMLButtonElement>('.vsidian-table-row-handle')]
    grips[2]!.click()
    expect(linked.doc.applyCalls).toHaveLength(0)
    const header = view.contentDOM.querySelector<HTMLElement>('.vsidian-table-grid-row')!
    header.getBoundingClientRect = () => new DOMRect(0, 0, 400, 20)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    grips[2]!.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 0, clientY: 100,
    }))
    header.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 0, clientY: 1 }))
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 1 }))
    expect(linked.doc.applyCalls).toHaveLength(0)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    grips[2]!.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 0, clientY: 100,
    }))
    header.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 0, clientY: 1 }))
    expect(header.classList.contains('vsidian-table-drop-before')).toBe(true)
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 0, clientY: 1 }))
    await settle()
    expect(linked.doc.getText()).toContain('| `x|y` | 4 |\n| --- | :---: |\n| 名字 | 数量 |')
    expect(linked.doc.applyCalls).toHaveLength(1)
  })

  it('千行表仅为视口中已挂载的网格行建立抓手，滚动回收时同步更新', async () => {
    const doc = ['| a | b |', '| --- | --- |', ...Array.from({ length: 1000 }, (_, i) => `| ${i} | x |`), ''].join('\n')
    const view = makeEditView(doc, 0)
    await Promise.resolve()
    const count = view.dom.querySelectorAll('.vsidian-table-row-handle').length
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(100)
    view.destroy()
  })

  it('仅有表头和分隔行的最小表格仍提供底部新增行及完整的单列选中边界', async () => {
    const view = makeEditView('| a |\n| --- |\n', '| a |\n| --- |\n'.length)
    await Promise.resolve()
    expect(view.dom.querySelectorAll('.vsidian-table-row-handle')).toHaveLength(1)
    expect(view.dom.querySelectorAll('.vsidian-table-insert-row')).toHaveLength(1)
    view.dom.querySelector<HTMLButtonElement>('.vsidian-table-column-handle')!.click()
    const selected = view.dom.querySelector<HTMLElement>('.vsidian-table-column-selected')!
    expect(selected.classList.contains('vsidian-table-column-first')).toBe(true)
    expect(selected.classList.contains('vsidian-table-column-last')).toBe(true)
    view.destroy()
  })

  it('表头滚出视口后右侧新增列与列选择仍锚定首个可见数据行', async () => {
    const view = makeEditView(TABLE_DOC, 0)
    await Promise.resolve()
    const querySelectorAll = view.contentDOM.querySelectorAll.bind(view.contentDOM)
    view.contentDOM.querySelectorAll = ((selector: string) => selector === '.vsidian-table-grid-row'
      ? [...querySelectorAll(selector)].slice(1) as unknown as NodeListOf<Element>
      : querySelectorAll(selector)) as typeof view.contentDOM.querySelectorAll
    view.scrollDOM.dispatchEvent(new Event('scroll'))
    await Promise.resolve()
    expect(view.dom.querySelectorAll('.vsidian-table-column-handle')).toHaveLength(2)
    const add = view.dom.querySelector<HTMLButtonElement>('.vsidian-table-insert-column')
    expect(add).not.toBeNull()
    view.dom.querySelector<HTMLButtonElement>('.vsidian-table-column-handle')!.click()
    expect(view.dom.querySelectorAll('.vsidian-table-column-selected')).toHaveLength(2)
    add!.click()
    expect(view.state.doc.toString()).toContain('| 名字 | 数量 | |')
    expect(view.state.doc.toString()).toContain('| --- | :---: | --- |')
    view.destroy()
  })
})

describe('表格增删行列权威链路', () => {
  it('插入行（命令路径）：一笔 edit.request，权威文档与保存回读一致，焦点落新行首格', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'insertRowBelow' })
    await settle()
    const expected = TABLE_DOC.replace(
      '| 苹果 | 3 |\n| `x|y` | 4 |',
      '| 苹果 | 3 |\n| | |\n| `x|y` | 4 |',
    )
    expect(linked.doc.getText()).toBe(expected)
    // 一笔请求 = 宿主撤销一次
    expect(linked.doc.applyCalls).toHaveLength(1)
    // 焦点：新行首格内容首
    const newRowAt = view.state.doc.toString().indexOf('| | |')
    expect(view.state.selection.main.from).toBe(newRowAt + 2)
    // 表格外区域逐字节不变
    expect(linked.doc.getText().startsWith('前导段落。\n\n| 名字 | 数量 |\n| --- | :---: |\n| 苹果 | 3 |\n')).toBe(true)
    expect(linked.doc.getText().endsWith('\n\n结尾段落。\n')).toBe(true)
  })

  it('删除行：撤销一次完整回原（含转义管道与代码单元格保真）', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'deleteRow' })
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC.replace('| 苹果 | 3 |\n', ''))
    await linked.session.handleWebviewMessage(
      { kind: 'history.request', op: 'undo' },
      linked.sessionId,
    )
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC)
    expect(view.state.doc.toString()).toBe(TABLE_DOC)
  })

  it('删表头：数据行升格为新表头、分隔行随移；分隔行单独删除拒绝', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('名字') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'deleteRow' })
    await settle()
    const expected = TABLE_DOC.replace(
      '| 名字 | 数量 |\n| --- | :---: |\n| 苹果 | 3 |\n',
      '| 苹果 | 3 |\n| --- | :---: |\n',
    )
    expect(linked.doc.getText()).toBe(expected)
    expect(linked.doc.getText()).toContain('| 苹果 | 3 |\n| --- | :---: |\n| `x|y` | 4 |')

    // 分隔行删除拒绝：零写回
    const applyBefore = linked.doc.applyCalls.length
    view.dispatch({ selection: EditorSelection.single(linked.doc.getText().indexOf(':---:')) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'deleteRow' })
    await settle()
    expect(linked.doc.applyCalls).toHaveLength(applyBefore)
  })

  it('插入列：表头/分隔/数据行同步，分隔行对齐段补齐，装饰增量与全量对拍一致', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'insertColumnRight' })
    await settle()
    const after = linked.doc.getText()
    expect(after).toContain('| 名字 | | 数量 |')
    expect(after).toContain('| --- | --- | :---: |')
    expect(after).toContain('| `x|y` | | 4 |')
    // 增量装饰与全量重建对拍（tableCells 边界随文档变更正确平移）
    const incremental = view.state.field(liveDecorationsField).decos
    const full = buildLivePreviewDecorations(view.state.doc, view.state.selection)
    expect(RangeSet.eq([incremental], [full])).toBe(true)
    expect(cellTexts(incremental, view.state.doc.toString())).toContain('`x|y`')
  })

  it('删除列：对齐信息同步删除，撤销一次回原', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('数量') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'deleteColumn' })
    await settle()
    const after = linked.doc.getText()
    expect(after).toContain('| 名字 |')
    expect(after).toContain('| --- |')
    // 光标列（数量，列 1）在各行同步删除：代码行的 4 属列 1 一并移除
    expect(after).toContain('| `x|y` |')
    const incremental = view.state.field(liveDecorationsField).decos
    const full = buildLivePreviewDecorations(view.state.doc, view.state.selection)
    expect(RangeSet.eq([incremental], [full])).toBe(true)
    await linked.session.handleWebviewMessage(
      { kind: 'history.request', op: 'undo' },
      linked.sessionId,
    )
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC)
  })

  it('非表格上下文命令：零写回', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('结尾段落')) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'insertRowBelow' })
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC)
    expect(linked.doc.applyCalls).toHaveLength(0)
  })

  it('阅读模式只读：表格命令忽略，零写回', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    linked.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'insertRowBelow' })
    await settle()
    expect(linked.doc.getText()).toBe(TABLE_DOC)
    expect(linked.doc.applyCalls).toHaveLength(0)
  })

  it('结构变更只触碰表格行：表格外文本逐字节不变（含 frontmatter/标题等区域）', async () => {
    const doc = [
      '---',
      'title: 表格',
      '---',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '尾部段落。',
      '',
    ].join('\n')
    const linked = await setupLinked(doc)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(doc.indexOf('1') + 1) })
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'insertRowBelow' })
    await settle()
    const after = linked.doc.getText()
    expect(after.startsWith('---\ntitle: 表格\n---\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')).toBe(true)
    expect(after.endsWith('\n\n尾部段落。\n')).toBe(true)
  })

  it('runTableEdit 返回值：成功 true / 上下文不符 false', async () => {
    const linked = await setupLinked(TABLE_DOC)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(TABLE_DOC.indexOf('苹果') + 1) })
    expect(runTableEdit(view, 'insertRowAbove')).toBe(true)
    view.dispatch({ selection: EditorSelection.single(0) })
    expect(runTableEdit(view, 'insertRowAbove')).toBe(false)
    await settle()
  })
})

// ---- 性能边界 ----

describe('千行表结构操作性能边界', () => {
  it('千行表中段插行/删列的装饰增量与全量对拍一致（时限内）', async () => {
    const lines = ['| 名字 | 数量 | 备注 |', '| --- | :---: | --- |']
    for (let i = 1; i <= 1000; i++) {
      lines.push(`| 第${i}项 | ${i} | 备注内容 ${i} |`)
    }
    const doc = lines.join('\n') + '\n'
    const linked = await setupLinked(doc)
    const view = linked.controller.getView()!
    view.dispatch({ selection: EditorSelection.single(doc.indexOf('第500项') + 1) })
    const t0 = performance.now()
    linked.controller.handleHostMessage({ kind: 'table.command', op: 'insertRowAbove' })
    await settle()
    const elapsed = performance.now() - t0
    const incremental = view.state.field(liveDecorationsField).decos
    const full = buildLivePreviewDecorations(view.state.doc, view.state.selection)
    expect(RangeSet.eq([incremental], [full])).toBe(true)
    // 1002 行表格 + 尾随空段 = 1003；插行后 1004
    expect(linked.doc.getText().split('\n')).toHaveLength(1004)
    expect(elapsed).toBeLessThan(2000)
  })
})
