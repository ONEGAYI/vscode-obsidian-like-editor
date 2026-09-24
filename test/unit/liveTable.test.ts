// @vitest-environment jsdom
// 表格单元格编辑契约（工单 #12）：live 装饰 + 单元格编辑链路 + 权威回读。
//
// 核心断言（用户可观察行为，非实现复述）：
// - 装饰：表格行/单元格/管道符/对齐的稳定类名；无 widget 交互控件
//   （表格编辑面即 CM6 源文本行：编辑直接发生在权威文本上，无覆盖层状态机）
// - 编辑链路：视图单元格输入（CM6 事务）→ edit.request → 宿主权威文档
//   → 保存回读（getText）→ 以权威文本重建装饰与编辑后呈现一致
// - 键入 | 自动转义 \|；代码 span 内不转义；\ 之后不重复转义
// - 撤销一次 = 撤销一次单元格提交（宿主权威栈经 history.request 回流）
// - 外部变更（另一面板改同一表格）经统一 doc.changed 链路应用
// - IME 组合期间外部增量缓冲、组合上屏后对账不丢输入（复用 #3 链路）
// - 真冲突进入暂停并保留输入（conflict.report），不静默丢字
// - 增量装饰与全量重建对拍一致（RangeSet.eq）
// - 千行单表：装饰构建/单格编辑增量在宽松时限内完成且写回正确
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState, RangeSet, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import {
  LIVE_CLASS_NAMES,
  buildLivePreviewDecorations,
  liveDecorationsField,
} from '../../src/webview/liveDecorations'
import { tableEditing, tablePipeKeyHandler } from '../../src/webview/tableEditing'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { DocumentSession, type HostDocumentPort } from '../../src/host/documentSession'
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

  it('表格装饰不含任何 widget 或隐藏区间（编辑面即源文本，无交互控件实例）', () => {
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
  // 面板通道先就位，再 mount：ready → init 全文往返自动完成
  sessionId = session.attachPanel({
    send: (m: HostToWebview) => controller.handleHostMessage(m),
  })
  controller.mount(document.createElement('div'))
  await settle()
  return { controller, session, doc, hostSent, sessionId }
}

/** 宿主请求队列串行化后排空（applyChanges async 链） */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('单元格编辑权威链路', () => {
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

describe('千行单表性能边界', () => {
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
