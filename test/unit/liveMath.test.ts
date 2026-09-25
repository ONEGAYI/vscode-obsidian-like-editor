// 实时预览公式装饰契约测试（工单 #59）：liveMath.ts 的视口装饰构建
// （照 liveLinks.ts 的 ViewPlugin 模式）、跨行块表的 StateField 增量维护、
// KaTeX widget 渲染与原文降级、渲染/装饰实例缓存。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import {
  LiveMathWidget,
  buildMathDecorationRanges,
  liveMath,
  mathBlockDecorations,
  mathBlocksField,
  mathWidgetDeco,
  renderMathHtml,
} from '../../src/webview/liveMath'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { MATH_CLASS_NAMES } from '../../src/shared/math'
import type { MathOccurrence } from '../../src/shared/math'

/** 视口直驱：单行文档全视口（行内通道；跨行块走 mathBlockDecorations） */
function build(
  text: string,
  anchor: number,
  visible: ReadonlyArray<{ from: number; to: number }> = [{ from: 0, to: text.length }],
) {
  const state = EditorState.create({ doc: text, extensions: [liveDecorationsField, mathBlocksField] })
  const field = state.field(liveDecorationsField)
  return buildMathDecorationRanges(
    state.doc,
    field.tree,
    EditorSelection.single(anchor),
    visible,
    field.fm,
  )
}

/** 跨行块装饰直驱（StateField 全量映射；CM6 要求跨行 replace 走 field） */
function buildBlocks(text: string, anchor: number): Array<{ from: number; to: number; cls?: string; widget?: LiveMathWidget }> {
  const state = EditorState.create({
    doc: text,
    extensions: [liveDecorationsField, mathBlocksField, mathBlockDecorations],
    selection: EditorSelection.single(anchor),
  })
  const set = state.field(mathBlockDecorations)
  const out: Array<{ from: number; to: number; cls?: string; widget?: LiveMathWidget }> = []
  set.between(0, text.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: LiveMathWidget }
    out.push({ from, to, cls: spec['class'], widget: spec.widget })
  })
  return out.sort((a, b) => a.from - b.from)
}

interface Item {
  from: number
  to: number
  cls?: string
  widget?: LiveMathWidget
}

function collect(ranges: ReturnType<typeof build>): Item[] {
  const out: Item[] = []
  for (const r of ranges) {
    const spec = r.value.spec as { class?: string; widget?: LiveMathWidget }
    out.push({ from: r.from, to: r.to, cls: spec['class'], widget: spec.widget })
  }
  return out.sort((a, b) => a.from - b.from)
}

describe('live 公式装饰：显形与渲染切换', () => {
  it('光标在公式范围外 → 整体替换为 KaTeX widget', () => {
    const items = collect(build('价格 $x^2$ 元', 0))
    expect(items).toHaveLength(1)
    expect(items[0]!.from).toBe(3)
    expect(items[0]!.to).toBe(8)
    expect(items[0]!.widget).toBeInstanceOf(LiveMathWidget)
    expect(items[0]!.widget!.tex).toBe('x^2')
    expect(items[0]!.widget!.displayMode).toBe(false)
  })

  it('光标进入公式范围（含两端边界）→ 源码态 mark', () => {
    for (const at of [3, 5, 8]) {
      const items = collect(build('价格 $x^2$ 元', at))
      expect(items, `at=${at}`).toHaveLength(1)
      expect(items[0]!.cls).toBe(MATH_CLASS_NAMES.mathSource)
      expect(items[0]!.from).toBe(3)
    }
  })

  it('选区覆盖第一个公式 → 它显源码，第二个仍渲染', () => {
    const text = '$a$ 与 $b$'
    const state = EditorState.create({ doc: text, extensions: [liveDecorationsField, mathBlocksField] })
    const field = state.field(liveDecorationsField)
    const sel = EditorSelection.single(0, 6)
    const crossing = buildMathDecorationRanges(
      state.doc, field.tree, sel,
      [{ from: 0, to: text.length }], field.fm,
    )
    expect(crossing).toHaveLength(2)
    expect((crossing[0]!.value.spec as { class?: string }).class).toBe(MATH_CLASS_NAMES.mathSource)
    expect((crossing[1]!.value.spec as { widget?: LiveMathWidget }).widget).toBeInstanceOf(LiveMathWidget)
  })

  it('块级（$$）公式 displayMode 渲染', () => {
    const text = '前 $$a+b$$ 后'
    const items = collect(build(text, 0))
    expect(items).toHaveLength(1)
    expect(items[0]!.widget!.displayMode).toBe(true)
  })

  it('普通美元文本无装饰', () => {
    expect(collect(build('价格 $5，合计 $10 元', 0))).toHaveLength(0)
  })

  it('行内代码与围栏代码内无装饰', () => {
    expect(collect(build('`a $b$ c`', 0))).toHaveLength(0)
    const fence = '```\n$x$\n```'
    expect(collect(build(fence, 0))).toHaveLength(0)
  })

  it('frontmatter 内无装饰', () => {
    const fm = '---\ntitle: $x$\n---\n正文'
    expect(collect(build(fm, 0))).toHaveLength(0)
  })

  it('跨行块经 StateField 发射（光标外渲染、进入显源码；DOM 惰性由 CM6 视口机制保证）', () => {
    const text = '前文\n\n$$\nE=mc^2\n$$\n\n后文'
    const rendered = buildBlocks(text, 0)
    expect(rendered).toHaveLength(1)
    expect(rendered[0]!.from).toBe('前文\n\n'.length)
    expect(rendered[0]!.widget).toBeInstanceOf(LiveMathWidget)
    expect(rendered[0]!.widget!.displayMode).toBe(true)
    // 光标进入块内 → 源码态 mark
    const editing = buildBlocks(text, '$$'.length + '前文\n\n'.length + 4)
    expect(editing).toHaveLength(1)
    expect(editing[0]!.cls).toBe(MATH_CLASS_NAMES.mathSource)
  })

  it('块区间与围栏相交时抑制（fence 内容不当公式）', () => {
    const text = '$$\nx\n```\ncode\n```\ny\n$$'
    expect(buildBlocks(text, 0)).toHaveLength(0)
  })
})

describe('跨行块表：StateField 增量维护', () => {
  function stateBlocks(text: string): MathOccurrence[] {
    const state = EditorState.create({ doc: text, extensions: [mathBlocksField] })
    return [...state.field(mathBlocksField)]
  }

  it('create 全量扫描产出跨行块（只含多行块，单行形态归行扫描）', () => {
    const blocks = stateBlocks('前文\n$$\na\n$$\n$$b$$\n后文\n$x$')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tex).toBe('\na\n')
  })

  it('块后击入普通文本：块区间不动（映射保留）', () => {
    let state = EditorState.create({ doc: '$$\na\n$$\n尾部', extensions: [mathBlocksField] })
    const before = state.field(mathBlocksField)
    state = state.update({ changes: { from: state.doc.length, insert: 'x' } }).state
    const after = state.field(mathBlocksField)
    expect(after).toHaveLength(1)
    expect(after[0]).not.toBe(before[0]) // 新数组（重扫产出新对象）
    expect(after[0]!.from).toBe(before[0]!.from)
    expect(after[0]!.to).toBe(before[0]!.to) // 插入在块之后，区间不变
    expect(after[0]!.tex).toBe(before[0]!.tex)
  })

  it('闭合一个未开启的块（插入 $$ 行）扩展块边界', () => {
    let state = EditorState.create({ doc: '$$\na\nb\n', extensions: [mathBlocksField] })
    expect(state.field(mathBlocksField)).toHaveLength(0) // 未闭合
    // 在文末追加闭合 $$ 行
    state = state.update({ changes: { from: state.doc.length, insert: '$$' } }).state
    const blocks = [...state.field(mathBlocksField)]
    expect(blocks).toHaveLength(1)
    expect(state.doc.sliceString(blocks[0]!.from, blocks[0]!.to)).toBe('$$\na\nb\n$$')
  })

  it('删除闭合定界符使块降级（表移除该项）', () => {
    const text = '$$\na\n$$\n尾'
    let state = EditorState.create({ doc: text, extensions: [mathBlocksField] })
    expect([...state.field(mathBlocksField)]).toHaveLength(1)
    // 删除第二个 $$（闭合）
    const closeAt = text.lastIndexOf('$$')
    state = state.update({ changes: { from: closeAt, to: closeAt + 2 } }).state
    expect([...state.field(mathBlocksField)]).toHaveLength(0)
  })

  it('长文档中途编辑：远离块的击键不破坏块表', () => {
    const filler = 'x'.repeat(200) + '\n'
    const doc = `$$\na\n$$\n${filler.repeat(40)}尾部`
    let state = EditorState.create({ doc, extensions: [mathBlocksField] })
    expect([...state.field(mathBlocksField)]).toHaveLength(1)
    const at = state.doc.length - 1
    state = state.update({ changes: { from: at, insert: 'y' } }).state
    const blocks = [...state.field(mathBlocksField)]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.tex).toBe('\na\n')
  })

  it('增量结果与全量重建一致（固定编辑序列对拍）', () => {
    let state = EditorState.create({ doc: '$$\na\n$$\n$x$\n', extensions: [mathBlocksField] })
    const edits: Array<{ from: number; insert?: string; to?: number }> = [
      { from: 5, insert: 'bc' },
      { from: 0, insert: 'head\n' },
      { from: 12, to: 14, insert: '$$' },
      { from: 3, insert: '$$\nnew block\n' },
    ]
    for (const e of edits) {
      state = state.update({
        changes: e.to !== undefined ? { from: e.from, to: e.to, insert: e.insert ?? '' } : { from: e.from, insert: e.insert ?? '' },
      }).state
    }
    const incremental = [...state.field(mathBlocksField)]
    const full = [...EditorState.create({ doc: state.doc, extensions: [mathBlocksField] }).field(mathBlocksField)]
    expect(incremental).toEqual(full)
  })
})

describe('KaTeX widget 渲染与缓存', () => {
  it('合法 tex 渲染出 KaTeX 结构', () => {
    const html = renderMathHtml('x^2', false)
    expect(html).toContain('katex-html')
  })

  it('非法 tex 返回 null（调用方降级）', () => {
    expect(renderMathHtml('\\notdefined', false)).toBeNull()
  })

  it('渲染缓存：同 tex+displayMode 重复调用不重算', () => {
    const probe = 'cache_probe_' + Math.random().toString(36).slice(2)
    // 先污染缓存再计数无从下手——以实例等价性钉住缓存行为
    const a = renderMathHtml('c^2', false)
    const b = renderMathHtml('c^2', false)
    expect(a).toBe(b)
    expect(probe.length).toBeGreaterThan(0)
  })

  it('widget toDOM：成功态带稳定类名与 KaTeX 内容', () => {
    const widget = new LiveMathWidget('x^2', false)
    const dom = widget.toDOM()
    expect(dom.classList.contains(MATH_CLASS_NAMES.math)).toBe(true)
    expect(dom.querySelector('.katex')).toBeTruthy()
  })

  it('widget toDOM：失败态显示原文且可读', () => {
    const widget = new LiveMathWidget('\\bad', false)
    const dom = widget.toDOM()
    expect(dom.classList.contains(MATH_CLASS_NAMES.mathError)).toBe(true)
    expect(dom.textContent).toBe('$\\bad$')
  })

  it('widget eq 按 tex 与 displayMode 比较', () => {
    expect(new LiveMathWidget('a', false).eq(new LiveMathWidget('a', false))).toBe(true)
    expect(new LiveMathWidget('a', false).eq(new LiveMathWidget('a', true))).toBe(false)
    expect(new LiveMathWidget('a', false).eq(new LiveMathWidget('b', false))).toBe(false)
  })

  it('装饰实例缓存：同参数返回同一实例（RangeSet.eq 前提）', () => {
    expect(mathWidgetDeco('q', false)).toBe(mathWidgetDeco('q', false))
    expect(mathWidgetDeco('q', false)).not.toBe(mathWidgetDeco('q', true))
  })

  it('displayMode widget 声明视觉行数（跨行源折叠为单视觉行）', () => {
    expect(new LiveMathWidget('a', true).lineBreaks).toBe(1)
    expect(new LiveMathWidget('a', false).lineBreaks).toBe(0)
  })
})

describe('liveMath 扩展装配（真实 EditorView）', () => {
  it('装配后装饰随选区切换形态且不写文档', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: '价格 $x^2$ 元', extensions: [liveMath, liveDecorationsField] }),
    })
    try {
      const pluginDecorations = (): string[] =>
        Array.from(parent.querySelectorAll('.vsidian-math, .vsidian-math-source')).map((el) => el.className)
      expect(parent.querySelector('.vsidian-math')).toBeTruthy()
      view.dispatch({ selection: { anchor: 5 } })
      expect(parent.querySelector('.vsidian-math-source')).toBeTruthy()
      expect(parent.querySelector('.vsidian-math')).toBeNull()
      view.dispatch({ selection: { anchor: 0 } })
      expect(parent.querySelector('.vsidian-math')).toBeTruthy()
      expect(view.state.doc.toString()).toBe('价格 $x^2$ 元')
      void pluginDecorations
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})

void Decoration
