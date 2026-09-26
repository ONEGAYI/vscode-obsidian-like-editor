// 实时预览 Mermaid 装饰契约测试（工单 #60）：liveMermaid.ts 的围栏表
// StateField 增量维护（含文末开放状态锚定与延伸熔断）、跨行块装饰
// （CM6 约束：StateField 提供）、光标进出显隐切换、frontmatter/伪围栏
// 抑制、装饰实例缓存；宿主链路 undo 用例仿 liveMath.test.ts 的
// setupLinked 模式（mock 宿主端口）。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { defaultKeymap } from '@codemirror/commands'
import {
  LiveMermaidWidget,
  MERMAID_FENCE_EXTEND_LIMIT,
  mermaidDecorations,
  mermaidFenceExtendStats,
  mermaidFencesField,
  mermaidWidgetDeco,
} from '../../src/webview/liveMermaid'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { codeCardConfigFacet, codeCardFoldField, codeCardFoldToggle } from '../../src/webview/codeCardState'
import { MERMAID_CLASS_NAMES } from '../../src/shared/mermaid'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { DocumentSession, type HostDocumentPort } from '../../src/host/documentSession'
import type { HostToWebview, SerChange, WebviewToHost } from '../../src/shared/protocol'

/** 装饰集合直驱：跨行 replace 装饰来自 StateField（CM6 硬约束） */
function buildBlocks(
  text: string,
  anchor: number,
): Array<{ from: number; to: number; cls?: string; widget?: LiveMermaidWidget }> {
  const state = EditorState.create({
    doc: text,
    extensions: [liveDecorationsField, mermaidFencesField, mermaidDecorations],
    selection: EditorSelection.single(anchor),
  })
  const set = state.field(mermaidDecorations)
  const out: Array<{ from: number; to: number; cls?: string; widget?: LiveMermaidWidget }> = []
  set.between(0, text.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: LiveMermaidWidget }
    out.push({ from, to, cls: spec['class'], widget: spec.widget })
  })
  return out.sort((a, b) => a.from - b.from)
}

const DOC = [
  '# 标题',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  '正文段落。',
].join('\n')

const FENCE_FROM = DOC.indexOf('```mermaid')
const FENCE_TO = DOC.lastIndexOf('```') + 3 // 闭围栏行行尾（排他端）

describe('live Mermaid 装饰：显隐切换', () => {
  it('光标在围栏外 → 整块替换为渲染 widget（区间覆盖开闭围栏行）', () => {
    const items = buildBlocks(DOC, 0)
    expect(items).toHaveLength(1)
    expect(items[0]!.from).toBe(FENCE_FROM)
    expect(items[0]!.to).toBe(FENCE_TO)
    expect(items[0]!.widget).toBeInstanceOf(LiveMermaidWidget)
    expect(items[0]!.widget!.code).toBe('graph TD\nA-->B')
  })

  it('光标进入围栏区间（含边界）→ 无替换装饰，源码显形可编辑', () => {
    for (const at of [FENCE_FROM, FENCE_FROM + 8, FENCE_TO - 1]) {
      expect(buildBlocks(DOC, at), `at=${at}`).toHaveLength(0)
    }
  })

  it('多图相邻：光标在第一图内 → 其余图仍渲染', () => {
    const text = [
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      '```mermaid',
      'sequenceDiagram',
      'A->>B: hi',
      '```',
    ].join('\n')
    expect(buildBlocks(text, 5)).toHaveLength(1) // 仅第二图渲染
    // 光标在两图之后的行尾：两图都渲染（位置 0 会触及首图边界显源码）
    expect(buildBlocks(`${text}\n`, text.length + 1)).toHaveLength(2)
  })

  it('非 mermaid 围栏与伪围栏（外层长围栏内/缩进 4）不产出装饰', () => {
    const js = buildBlocks('```js\nlet a\n```', 0)
    expect(js).toHaveLength(0)
    const nested = buildBlocks('````md\n```mermaid\nA-->B\n```\n````', 0)
    expect(nested).toHaveLength(0)
    const indented = buildBlocks('    ```mermaid\n    A-->B\n    ```', 0)
    expect(indented).toHaveLength(0)
  })

  it('frontmatter 内的 mermaid 围栏不渲染（源码降级边界）', () => {
    const text = '---\ntitle: t\n```mermaid\nA-->B\n```\n---\n\n正文'
    expect(buildBlocks(text, text.length)).toHaveLength(0)
  })

  it('未闭合围栏（EOF）不产出（稳定降级为源码）', () => {
    expect(buildBlocks('```mermaid\ngraph TD', 0)).toHaveLength(0)
  })

  it('呈现态折叠的围栏不发射 SVG（卡片收起接管），再切换恢复渲染', () => {
    let state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField, mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardFoldField, mermaidDecorations,
      ],
      selection: EditorSelection.single(0),
    })
    expect(state.field(mermaidDecorations).size).toBe(1)
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    expect(state.field(mermaidDecorations).size).toBe(0)
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    expect(state.field(mermaidDecorations).size).toBe(1)
  })
})

describe('装饰实例缓存与 widget 形态', () => {
  it('同源码的 deco 实例复用（RangeSet.eq 前提）', () => {
    const a = mermaidWidgetDeco('A-->B')
    const b = mermaidWidgetDeco('A-->B')
    expect(a).toBe(b)
  })

  it('widget eq 按源码比较；lineBreaks 为 1（块级视觉行）', () => {
    const w = new LiveMermaidWidget('A-->B')
    expect(w.eq(new LiveMermaidWidget('A-->B'))).toBe(true)
    expect(w.eq(new LiveMermaidWidget('C-->D'))).toBe(false)
    expect(w.lineBreaks).toBe(1)
  })

  it('toDOM 产出 frame 包裹的渲染容器＋按钮组，携带源码 data 属性（#111）', () => {
    const w = new LiveMermaidWidget('graph TD\nA-->B')
    const dom = w.toDOM()
    // frame 是定位宿主，渲染语义仍在内层稳定类名容器
    expect(dom.className).toBe('vsidian-graphic-frame')
    const inner = dom.querySelector(`.${MERMAID_CLASS_NAMES.diagram}`)
    expect(inner).not.toBeNull()
    expect(inner!.getAttribute('data-vsidian-mermaid-code')).toBe('graph TD\nA-->B')
    // 按钮组：edit（仅实时预览装配）+ popup；显隐由 CSS 承担
    const chrome = dom.querySelector('.vsidian-graphic-chrome')
    expect(chrome).not.toBeNull()
    expect(chrome!.querySelectorAll('button')).toHaveLength(2)
    expect(chrome!.querySelector('.vsidian-graphic-chrome-edit')).not.toBeNull()
    expect(chrome!.querySelector('.vsidian-graphic-chrome-popup')).not.toBeNull()
  })

  it('禁点击进编辑（#111 契约 2）：widget 吞掉指向图形的鼠标事件', () => {
    const w = new LiveMermaidWidget('A-->B')
    expect(w.ignoreEvent()).toBe(true)
  })
})

describe('围栏表 StateField：文档编辑的增量维护', () => {
  it('编辑围栏内容后围栏表更新（区间与内容跟随）', () => {
    const text = DOC + '\n'
    const state = EditorState.create({ doc: text, extensions: [mermaidFencesField] })
    const before = state.field(mermaidFencesField).spans
    expect(before).toHaveLength(1)
    // 在围栏内容行插入 "C-->D\n"（源码修改触发重渲染的增量路径）
    const insertAt = text.indexOf('graph TD') + 'graph TD'.length
    const tr = state.update({ changes: { from: insertAt, insert: '\nC-->D' } })
    const after = tr.state.field(mermaidFencesField).spans
    expect(after).toHaveLength(1)
    expect(after[0]!.to).toBe(before[0]!.to + '\nC-->D'.length)
    expect(after[0]!.code).toBe('graph TD\nC-->D\nA-->B')
  })

  it('删除闭围栏 → 围栏未闭合，装饰退场（源码显形）', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const closeAt = DOC.lastIndexOf('```')
    const tr = state.update({ changes: { from: closeAt, to: closeAt + 3, insert: 'xyz' } })
    // 闭围栏行变成内容行：围栏延伸到 EOF 未闭合 → 不产出
    expect(tr.state.field(mermaidFencesField).spans).toHaveLength(0)
  })

  it('围栏前的普通编辑：表项坐标映射（不重建误伤）', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const tr = state.update({ changes: { from: 0, insert: '头部\n\n' } })
    const after = tr.state.field(mermaidFencesField).spans
    expect(after).toHaveLength(1)
    expect(after[0]!.from).toBe(4 + FENCE_FROM)
    expect(after[0]!.code).toBe('graph TD\nA-->B')
  })

  it('围栏外新建围栏：新增围栏被增量扫描捕获', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const tr = state.update({
      changes: { from: DOC.length, insert: '\n```mermaid\nC-->D\n```' },
    })
    const after = tr.state.field(mermaidFencesField).spans
    expect(after).toHaveLength(2)
    expect(after[1]!.code).toBe('C-->D')
  })

  it('纯选区移动不重扫（表项稳定，装饰字段随选区切换显隐）', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const tr = state.update({ selection: EditorSelection.single(2) })
    expect(tr.state.field(mermaidFencesField)).toBe(state.field(mermaidFencesField))
  })

  it('trailingOpenStart：全量扫描记录文末未闭合围栏的开启行（D-2）', () => {
    const text = '正文\n\n```mermaid\ngraph TD'
    const state = EditorState.create({ doc: text, extensions: [mermaidFencesField] })
    expect(state.field(mermaidFencesField).trailingOpenStart).toBe(text.indexOf('```mermaid'))
    // 闭合后清空
    const closed = state.update({ changes: { from: state.doc.length, insert: '\n```' } })
    expect(closed.state.field(mermaidFencesField).trailingOpenStart).toBeNull()
  })

  it('无锚回溯落在开放围栏中部：窗口知晓窗口外开放状态，不产全量不存在的幻影 span（D-2）', () => {
    // 文档顶部 ````md 开放围栏（run=4，全文未闭合），内容行含 ```mermaid 与
    // ```（run=3 < 4，不闭合外层）；击键在 2048 行外——无锚点回溯起步行
    // 大于开启行，窗口内扫描若不知晓窗口外开放状态，会把内容行的
    // ```mermaid 当开启符、后续 ``` 当闭合，产出全量扫描不存在的幻影
    // mermaid span（误渲染为图且随编辑自我稳定）
    const lines: string[] = ['````md']
    for (let i = 0; i < 1997; i++) {
      lines.push(`filler ${i}`)
    }
    lines.push('```mermaid', 'graph TD', 'A-->B', '```') // 行 1999-2002：窗口内幻影候选
    for (let i = 0; i < 1397; i++) {
      lines.push(`tail ${i}`)
    }
    expect(lines).toHaveLength(3399)
    const doc = lines.join('\n')
    let state = EditorState.create({ doc, extensions: [mermaidFencesField] })
    const full = [...state.field(mermaidFencesField).spans]
    expect(full).toHaveLength(0) // 全量扫描：外层未闭合 → 零 span
    // 远端击键（文末，回溯窗口 [约1353, 3401] 不含行 1 的开启行）
    state = state.update({ changes: { from: state.doc.length - 2, insert: 'x' } }).state
    const incremental = [...state.field(mermaidFencesField).spans]
    expect(incremental).toEqual(full) // 与全量一致：零 span、无幻影
  })

  it('未闭合围栏长尾的延伸熔断：窗口内开启后延伸有界（D-3）', () => {
    // 行 1 开启 + 超过熔断上限的普通行长尾；击键在开块行邻近（窗口含行 1）
    // → 增量延伸按批推进并在 MERMAID_FENCE_EXTEND_LIMIT 行熔断（批次数有
    // 上界），表不产出、不崩溃，且与全量扫描一致。表空结果本身无法区分
    // 「熔断停止」与「从未延伸」，故断言批次 > 0 与批次 ≤ 上限/批大小
    // （照 liveMath N-3 用例形态）
    const lines = ['```mermaid', ...Array.from({ length: MERMAID_FENCE_EXTEND_LIMIT + 600 }, (_, i) => `text ${i}`)]
    let state = EditorState.create({ doc: lines.join('\n'), extensions: [mermaidFencesField] })
    expect(state.field(mermaidFencesField).spans).toHaveLength(0) // 全量：未闭合
    const at = state.doc.line(2).from + 2 // 击键在开块行邻近，窗口内含行 1
    state = state.update({ changes: { from: at, insert: 'x' } }).state
    expect(mermaidFenceExtendStats.batches).toBeGreaterThan(0) // 真实进入延伸
    expect(mermaidFenceExtendStats.batches)
      .toBeLessThanOrEqual(Math.ceil(MERMAID_FENCE_EXTEND_LIMIT / 256) + 1) // 熔断有界
    const incremental = [...state.field(mermaidFencesField).spans]
    const full = [...EditorState.create({ doc: state.doc, extensions: [mermaidFencesField] }).field(mermaidFencesField).spans]
    expect(incremental).toHaveLength(0) // 熔断后同样降级
    expect(incremental).toEqual(full)
  })

  it('闭合在延伸上限内的长围栏照常配对：增量续扫与全量一致（D-3）', () => {
    // 围栏体 3000 行（> 回溯窗口 2048、< 熔断 8192）：在围栏中段击键，
    // 窗口末尾处于开放围栏中 → 增量延伸到闭合行，span 与全量一致
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const lines = ['```mermaid', ...body, '```', '尾部']
    let state = EditorState.create({ doc: lines.join('\n'), extensions: [mermaidFencesField] })
    const midLine = 1 + Math.floor(body.length / 2) // 行号（1 基）：围栏中段
    const at = state.doc.line(midLine).from + 2
    state = state.update({ changes: { from: at, insert: 'x' } }).state
    const incremental = [...state.field(mermaidFencesField).spans]
    const full = [...EditorState.create({ doc: state.doc, extensions: [mermaidFencesField] }).field(mermaidFencesField).spans]
    expect(incremental).toHaveLength(1)
    expect(incremental).toEqual(full)
  })
})

// ---- 宿主权威链路（视图 → edit.request → TextDocument → undo 回流） ----
// 仿 liveMath.test.ts 的 setupLinked 模式（mock 宿主端口；syncController
// 扩展装配内含 liveMermaid，围栏装饰与编辑事务走生产链路）

class FakeDoc implements HostDocumentPort {
  content: string
  ver: number
  applyCalls: SerChange[][] = []
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

async function setupLinkedMermaid(text: string) {
  const doc = new FakeDoc(text)
  const session = new DocumentSession(doc, { docUri: 'file:///d%3A/notes/mermaid.md', onNotice: () => undefined })
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
  controller.mount(document.createElement('div'), [keymap.of(defaultKeymap)])
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return { controller, session, doc, hostSent, sessionId }
}

describe('Mermaid 编辑宿主权威链路（D-11，仿 A8）', () => {
  it('围栏内键入 → edit.request 单笔写回 → undo 一次恢复原文与渲染态', async () => {
    const text = '```mermaid\ngraph TD\nA-->B\n```\n'
    const linked = await setupLinkedMermaid(text)
    const view = linked.controller.getView()!
    const at = text.indexOf('B')
    view.dispatch({ selection: EditorSelection.single(at) })
    view.dispatch({ changes: { from: at + 1, insert: 'C' }, userEvent: 'input.type' })
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(linked.doc.getText()).toBe(text.replace('A-->B', 'A-->BC'))
    expect(linked.hostSent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
    await linked.session.handleWebviewMessage(
      { kind: 'history.request', op: 'undo' },
      linked.sessionId,
    )
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    // undo 一次：权威文本与视图原文恢复
    expect(linked.doc.getText()).toBe(text)
    expect(view.state.doc.toString()).toBe(text)
    // 装饰状态恢复：undo 回流后光标仍在围栏内（源码态可编辑）；移开
    // 光标到文末（围栏外）后围栏回到渲染态 widget 容器（围栏表随权威
    // 文本重建；围栏起于 offset 0，光标 0 仍触边界显源码）
    view.dispatch({ selection: EditorSelection.single(text.length) })
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
    const container = view.contentDOM.querySelector(`.${MERMAID_CLASS_NAMES.diagram}`)
    expect(container).not.toBeNull()
    expect(container!.getAttribute('data-vsidian-mermaid-code')).toBe('graph TD\nA-->B')
    linked.controller.dispose()
  })
})
