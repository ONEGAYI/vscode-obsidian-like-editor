// 实时预览代码块卡片装饰契约测试（工单 #79）：呈现态围栏收起（行内容
// 清空、行槽保留）、头部横带、卡片行类与圆角边行、编辑态/选区相交时
// 围栏源码显形且外壳保留、mermaid/frontmatter/伪围栏/未闭合排除、
// 设置总开关关闭、语言标签映射（shared/codeLangs）、增量 == 全量对拍。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  CODE_CARD_CLASS_NAMES,
  CodeCardHeaderWidget,
  CodeCardLineNumberWidget,
  buildCodeCardDecorations,
  codeCardConfigFacet,
  codeCardDecorations,
  codeCardFoldField,
  codeCardFoldToggle,
} from '../../src/webview/liveCodeCard'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { mermaidFencesField } from '../../src/webview/liveMermaid'
import { resolveCodeLanguage } from '../../src/shared/codeLangs'

interface Item {
  from: number
  to: number
  cls?: string
  block?: boolean
  widget?: CodeCardHeaderWidget
  ln?: { value: number; widthCh: number }
  hide?: boolean
}

/** 装饰集合直驱（卡片装饰来自 StateField；围栏表来自 mermaidFencesField） */
function decos(text: string, anchor: number, config?: { card?: boolean; lineNumbers?: boolean; copyButton?: boolean }): Item[] {
  const state = EditorState.create({
    doc: text,
    extensions: [
      liveDecorationsField,
      mermaidFencesField,
      codeCardConfigFacet.of({
        card: config?.card ?? true,
        lineNumbers: config?.lineNumbers ?? true,
        copyButton: config?.copyButton ?? true,
        highlight: true,
      }),
      codeCardFoldField,
      codeCardDecorations,
    ],
    selection: EditorSelection.single(anchor),
  })
  return itemsOf(state.field(codeCardDecorations))
}

/** 折叠态直驱：先建状态再派发折叠切换 effect（foldAt 为围栏起始 offset） */
function decosFolded(text: string, anchor: number, foldAt: number): { items: Item[]; folded: ReadonlySet<number> } {
  let state = EditorState.create({
    doc: text,
    extensions: [
      liveDecorationsField,
      mermaidFencesField,
      codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
      codeCardFoldField,
      codeCardDecorations,
    ],
    selection: EditorSelection.single(anchor),
  })
  state = state.update({ effects: codeCardFoldToggle.of(foldAt) }).state
  return { items: itemsOf(state.field(codeCardDecorations)), folded: state.field(codeCardFoldField) }
}

function itemsOf(set: import('@codemirror/view').DecorationSet): Item[] {
  const out: Item[] = []
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: CodeCardHeaderWidget | CodeCardLineNumberWidget; block?: boolean }
    const widget = spec.widget
    const isHeader = widget instanceof CodeCardHeaderWidget
    const isLn = widget instanceof CodeCardLineNumberWidget
    out.push({
      from,
      to,
      cls: spec['class'],
      block: spec.block,
      widget: isHeader ? (widget as CodeCardHeaderWidget) : undefined,
      ln: isLn
        ? { value: (widget as CodeCardLineNumberWidget).value, widthCh: (widget as CodeCardLineNumberWidget).widthCh }
        : undefined,
      hide: spec['class'] === undefined && spec.widget === undefined && to > from,
    })
  })
  return out.sort((a, b) => a.from - b.from || a.to - b.to)
}

const DOC = ['intro', '', '```js', 'let a = 1', '', 'const b = 2', '```', '', 'outro'].join('\n')
const FENCE_FROM = DOC.indexOf('```js')
const OPEN_LINE = 3 // ```js
const CLOSE_LINE = 7 // ```

const lineOf = (text: string, n: number): { from: number; to: number } => {
  const lines = text.split('\n')
  const from = lines.slice(0, n - 1).reduce((acc, l) => acc + l.length + 1, 0)
  return { from, to: from + lines[n - 1]!.length }
}

describe('代码块卡片：呈现态外壳', () => {
  it('光标在块外 → 两条围栏行内容清空（replace 不含换行，行槽保留）', () => {
    const items = decos(DOC, 0)
    const hides = items.filter((i) => i.hide)
    const open = lineOf(DOC, OPEN_LINE)
    const close = lineOf(DOC, CLOSE_LINE)
    expect(hides).toHaveLength(2)
    expect(hides[0]).toMatchObject({ from: open.from, to: open.to })
    expect(hides[1]).toMatchObject({ from: close.from, to: close.to })
  })

  it('块首行上方插入头部横带（block widget），标签为语言显示名', () => {
    const items = decos(DOC, 0)
    const header = items.find((i) => i.block && i.widget)
    expect(header).toBeDefined()
    expect(header!.from).toBe(FENCE_FROM)
    expect(header!.to).toBe(FENCE_FROM)
    expect(header!.widget!.label).toBe('JavaScript')
  })

  it('卡片行类覆盖全部块行（含围栏行），首尾行带圆角修饰', () => {
    const items = decos(DOC, 0)
    const cardLines = items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))
    expect(cardLines).toHaveLength(5) // 行 3..7
    const withTop = cardLines.filter((i) => i.cls!.includes(CODE_CARD_CLASS_NAMES.edgeTop))
    const withBottom = cardLines.filter((i) => i.cls!.includes(CODE_CARD_CLASS_NAMES.edgeBottom))
    expect(withTop).toHaveLength(1)
    expect(withTop[0]!.from).toBe(lineOf(DOC, OPEN_LINE).from)
    expect(withBottom).toHaveLength(1)
    expect(withBottom[0]!.from).toBe(lineOf(DOC, CLOSE_LINE).from)
  })

  it('空代码块（无内容行）仍呈现卡片', () => {
    const text = 'a\n\n```\n```\n\nb'
    const items = decos(text, 0)
    expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))).toHaveLength(2)
    expect(items.filter((i) => i.hide)).toHaveLength(2)
    expect(items.find((i) => i.widget)?.widget!.label).toBe('Plain text')
  })
})

describe('代码块卡片：编辑态与选区', () => {
  it('光标进入块内（含边界）→ 围栏源码显形，头部与行类保留', () => {
    for (const at of [FENCE_FROM, FENCE_FROM + 5, lineOf(DOC, CLOSE_LINE).from + 1]) {
      const items = decos(DOC, at)
      expect(items.filter((i) => i.hide), `at=${at}`).toHaveLength(0)
      expect(items.find((i) => i.block && i.widget), `at=${at}`).toBeDefined()
      expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line)), `at=${at}`).toHaveLength(5)
    }
  })

  it('非空选区与块相交 → 围栏显形（同单光标语义）', () => {
    const items = decos(DOC, 0)
    void items
    const state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField,
        mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardDecorations,
      ],
      selection: EditorSelection.range(0, FENCE_FROM + 1),
    })
    expect(itemsOf(state.field(codeCardDecorations)).filter((i) => i.hide)).toHaveLength(0)
  })
})

describe('代码块卡片：排除与降级', () => {
  it('mermaid 围栏不产出卡片装饰（专属管线）', () => {
    const text = '```mermaid\ngraph TD\nA-->B\n```'
    expect(decos(text, 0)).toHaveLength(0)
  })

  it('frontmatter 内的围栏不产出（源码降级边界）', () => {
    const text = '---\n```js\nlet a\n```\n---\n\n正文'
    expect(decos(text, text.length)).toHaveLength(0)
  })

  it('未闭合围栏不产出（稳定降级为源码）', () => {
    expect(decos('```js\nlet a', 0)).toHaveLength(0)
  })

  it('嵌套伪围栏只产出外层卡片', () => {
    const text = '````md\n```js\nlet a\n```\n````'
    const items = decos(text, 0)
    const headers = items.filter((i) => i.widget)
    expect(headers).toHaveLength(1)
    expect(headers[0]!.widget!.label).toBe('Markdown')
    // 外层卡片覆盖 5 行（````md 到 ````）
    expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))).toHaveLength(5)
  })

  it('缩进代码块（4 空格）不产出卡片', () => {
    const text = '    let a = 1'
    expect(decos(text, 0)).toHaveLength(0)
  })

  it('卡片总开关关闭 → 无装饰', () => {
    expect(decos(DOC, 0, { card: false })).toHaveLength(0)
  })
})

describe('语言标签映射（shared/codeLangs）', () => {
  it('注册表语言与别名正确路由', () => {
    expect(resolveCodeLanguage('js')?.displayName).toBe('JavaScript')
    expect(resolveCodeLanguage('JS')?.displayName).toBe('JavaScript')
    expect(resolveCodeLanguage('tsx')?.displayName).toBe('TypeScript')
    expect(resolveCodeLanguage('yml')?.displayName).toBe('YAML')
    expect(resolveCodeLanguage('systemverilog')?.displayName).toBe('Verilog')
    expect(resolveCodeLanguage('sv')?.displayName).toBe('Verilog')
    expect(resolveCodeLanguage('c++')?.displayName).toBe('C++')
    expect(resolveCodeLanguage('text')?.displayName).toBe('Plain text')
    expect(resolveCodeLanguage('  ')?.displayName).toBe('Plain text')
    expect(resolveCodeLanguage('zzz')).toBeNull()
  })

  it('未识别语言的标签回退为 trim 后的原文', () => {
    const text = '```zzz\ncode\n```'
    expect(decos(text, 0).find((i) => i.widget)!.widget!.label).toBe('zzz')
  })

  it('无语言标记显示 Plain text', () => {
    const text = '```\ncode\n```'
    expect(decos(text, 0).find((i) => i.widget)!.widget!.label).toBe('Plain text')
  })
})

describe('卡片装饰：增量一致性', () => {
  function makeState(text: string, anchor: number) {
    const base = [
      liveDecorationsField,
      mermaidFencesField,
      codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
      codeCardDecorations,
    ]
    return EditorState.create({ doc: text, extensions: base, selection: EditorSelection.single(anchor) })
  }

  it('块内编辑后字段值 == 全量重建（增量 == 全量对拍）', () => {
    let state = makeState(DOC, 0)
    const inside = lineOf(DOC, 4).from + 4
    state = state.update({ changes: { from: inside, to: inside, insert: 'x' } }).state
    const fresh = makeState(state.doc.toString(), 0)
    expect(itemsOf(state.field(codeCardDecorations)))
      .toEqual(itemsOf(fresh.field(codeCardDecorations)))
  })

  it('新增整块（开闭围栏）后字段值 == 全量重建', () => {
    let state = makeState(DOC, 0)
    const tail = state.doc.length
    state = state.update({ changes: { from: tail, to: tail, insert: '\n```py\nprint(1)\n```' } }).state
    const fresh = makeState(state.doc.toString(), 0)
    expect(itemsOf(state.field(codeCardDecorations)))
      .toEqual(itemsOf(fresh.field(codeCardDecorations)))
  })

  it('光标移动只切显隐，不产生文档变更', () => {
    let state = makeState(DOC, 0)
    const before = state.doc.toString()
    state = state.update({ selection: EditorSelection.single(FENCE_FROM + 4) }).state
    expect(state.doc.toString()).toBe(before)
    expect(itemsOf(state.field(codeCardDecorations)).filter((i) => i.hide)).toHaveLength(0)
  })
})

describe('卡内行号（#80）', () => {
  it('代码行行首挂行号 widget：每块从 1 起，围栏行不占号', () => {
    const items = decos(DOC, 0)
    const lns = items.filter((i) => i.ln)
    expect(lns.map((i) => i.ln!.value)).toEqual([1, 2, 3])
    // 行号在代码行行首（行 4/5/6）
    expect(lns[0]!.from).toBe(lineOf(DOC, 4).from)
    expect(lns[2]!.from).toBe(lineOf(DOC, 6).from)
  })

  it('编辑态行号保留（两态一致）', () => {
    const items = decos(DOC, FENCE_FROM + 4)
    expect(items.filter((i) => i.ln).map((i) => i.ln!.value)).toEqual([1, 2, 3])
  })

  it('多块独立编号互不串号', () => {
    const text = '```js\na\nb\n```\n\n```py\nx\n```'
    const items = decos(text, 0)
    expect(items.filter((i) => i.ln).map((i) => i.ln!.value)).toEqual([1, 2, 1])
  })

  it('列宽随块内行数位数对齐（<10 行 2ch、≥10 行 2ch、≥100 行 3ch）', () => {
    expect(decos(DOC, 0).find((i) => i.ln)!.ln!.widthCh).toBe(2)
    const ten = '```js\n' + Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n') + '\n```'
    expect(decos(ten, 0).find((i) => i.ln)!.ln!.widthCh).toBe(2)
    const big = '```js\n' + Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n```'
    expect(decos(big, 0).find((i) => i.ln)!.ln!.widthCh).toBe(3)
  })

  it('行号子开关关闭 → 无行号 widget，卡片外壳保留', () => {
    const items = decos(DOC, 0, { lineNumbers: false })
    expect(items.filter((i) => i.ln)).toHaveLength(0)
    expect(items.find((i) => i.block && i.widget)).toBeDefined()
    expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))).toHaveLength(5)
  })

  it('行号 widget 形态：toDOM 产出右对齐文本、忽略事件', () => {
    const w = new CodeCardLineNumberWidget(3, 2)
    expect(w.eq(new CodeCardLineNumberWidget(3, 2))).toBe(true)
    expect(w.eq(new CodeCardLineNumberWidget(4, 2))).toBe(false)
    const dom = w.toDOM()
    expect(dom.className).toBe(CODE_CARD_CLASS_NAMES.linenumber)
    expect(dom.textContent).toBe('3')
    expect(w.ignoreEvent()).toBe(true)
  })
})

describe('复制按钮（#81）', () => {
  it('呈现态：头部携带复制按钮与代码体原文', () => {
    const w = decos(DOC, 0).find((i) => i.widget)!.widget!
    expect(w.copy).toBe(true)
    expect(w.code).toBe('let a = 1\n\nconst b = 2')
  })

  it('编辑态（光标在块内）：按钮不发射（隐藏）', () => {
    for (const at of [FENCE_FROM, FENCE_FROM + 5, lineOf(DOC, CLOSE_LINE).from + 1]) {
      expect(decos(DOC, at).find((i) => i.widget)!.widget!.copy, `at=${at}`).toBe(false)
    }
  })

  it('非空选区与块相交：同单光标，按钮不发射', () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField,
        mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardDecorations,
      ],
      selection: EditorSelection.range(0, FENCE_FROM + 1),
    })
    expect(itemsOf(state.field(codeCardDecorations)).find((i) => i.widget)!.widget!.copy).toBe(false)
  })

  it('复制子开关关闭：两态均不发射按钮', () => {
    expect(decos(DOC, 0, { copyButton: false }).find((i) => i.widget)!.widget!.copy).toBe(false)
    expect(decos(DOC, FENCE_FROM + 4, { copyButton: false }).find((i) => i.widget)!.widget!.copy).toBe(false)
  })

  it('多块独立：光标在第一块内，其余块按钮保留', () => {
    const text = '```js\na\n```\n\n```py\nx\n```'
    const items = decos(text, text.indexOf('a'))
    const widgets = items.filter((i) => i.widget).map((i) => i.widget!)
    expect(widgets.map((w) => w.copy)).toEqual([false, true])
  })
})

describe('折叠（#82）', () => {
  it('折叠后：整块收起为单个 replace（含闭围栏行换行），行类/行号/围栏清空均不发射，头部保留且收起态无复制按钮', () => {
    const { items, folded } = decosFolded(DOC, 0, FENCE_FROM)
    expect(folded.has(FENCE_FROM)).toBe(true)
    const hides = items.filter((i) => i.hide)
    expect(hides).toHaveLength(1)
    const open = lineOf(DOC, OPEN_LINE)
    const close = lineOf(DOC, CLOSE_LINE)
    expect(hides[0]!.from).toBe(open.from)
    expect(hides[0]!.to).toBe(Math.min(close.to + 1, DOC.length))
    expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))).toHaveLength(0)
    expect(items.filter((i) => i.ln)).toHaveLength(0)
    const header = items.find((i) => i.widget)!.widget!
    expect(header.folded).toBe(true)
    expect(header.copy).toBe(false)
  })

  it('光标进入已折叠块 → 临时展开（行类/行号/头部恢复，折叠状态保留）', () => {
    const { folded } = decosFolded(DOC, 0, FENCE_FROM)
    void folded
    // 重建一个光标在块内的折叠状态
    let state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField, mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardFoldField, codeCardDecorations,
      ],
      selection: EditorSelection.single(0),
    })
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    state = state.update({ selection: EditorSelection.single(FENCE_FROM + 6) }).state
    const items = itemsOf(state.field(codeCardDecorations))
    expect(items.filter((i) => i.hide)).toHaveLength(0) // 编辑态：围栏显形（未折叠遮挡）
    expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))).toHaveLength(5)
    expect(items.find((i) => i.widget)!.widget!.folded).toBe(false)
    expect(state.field(codeCardFoldField).has(FENCE_FROM)).toBe(true)
  })

  it('光标离开已折叠块 → 恢复收起', () => {
    let state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField, mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardFoldField, codeCardDecorations,
      ],
      selection: EditorSelection.single(FENCE_FROM + 6),
    })
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    state = state.update({ selection: EditorSelection.single(0) }).state
    const items = itemsOf(state.field(codeCardDecorations))
    expect(items.filter((i) => i.hide)).toHaveLength(1)
    expect(items.find((i) => i.widget)!.widget!.folded).toBe(true)
  })

  it('再次切换（展开）：折叠状态清除，回到常规呈现态', () => {
    let state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField, mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardFoldField, codeCardDecorations,
      ],
      selection: EditorSelection.single(0),
    })
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    expect(state.field(codeCardFoldField).has(FENCE_FROM)).toBe(false)
    const items = itemsOf(state.field(codeCardDecorations))
    expect(items.filter((i) => i.cls?.includes(CODE_CARD_CLASS_NAMES.line))).toHaveLength(5)
    expect(items.filter((i) => i.hide)).toHaveLength(2) // 回到围栏行清空
  })

  it('折叠随编辑位置映射：块前插入一行后折叠仍生效', () => {
    let state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField, mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardFoldField, codeCardDecorations,
      ],
      selection: EditorSelection.single(0),
    })
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    state = state.update({ changes: { from: 0, to: 0, insert: '新行\n' } }).state
    const newFenceFrom = state.doc.toString().indexOf('```js')
    expect(newFenceFrom).toBeGreaterThan(FENCE_FROM)
    expect(state.field(codeCardFoldField).has(newFenceFrom)).toBe(true)
    expect(itemsOf(state.field(codeCardDecorations)).find((i) => i.widget)!.widget!.folded).toBe(true)
  })

  it('围栏被删除 → 折叠条目修剪（不自愈到后来者）', () => {
    let state = EditorState.create({
      doc: DOC,
      extensions: [
        liveDecorationsField, mermaidFencesField,
        codeCardConfigFacet.of({ card: true, lineNumbers: true, copyButton: true, highlight: true }),
        codeCardFoldField, codeCardDecorations,
      ],
      selection: EditorSelection.single(0),
    })
    state = state.update({ effects: codeCardFoldToggle.of(FENCE_FROM) }).state
    // 删除整个围栏块（开围栏行行首到闭围栏行行尾 + 换行）
    const close = lineOf(DOC, CLOSE_LINE)
    state = state.update({ changes: { from: FENCE_FROM, to: Math.min(close.to + 1, DOC.length), insert: '' } }).state
    expect(state.field(codeCardFoldField).size).toBe(0)
  })

  it('折叠 chevron：toDOM 常驻按钮、收起态类与 aria', () => {
    const expanded = new CodeCardHeaderWidget('JavaScript', 'javascript', false, 'let a')
    const collapsed = new CodeCardHeaderWidget('JavaScript', 'javascript', false, 'let a', true)
    expect(expanded.eq(collapsed)).toBe(false)
    const dom = collapsed.toDOM()
    const chevron = dom.querySelector(`button.${CODE_CARD_CLASS_NAMES.fold}`)!
    expect(chevron).not.toBeNull()
    expect(chevron.classList.contains(CODE_CARD_CLASS_NAMES.foldCollapsed)).toBe(true)
    const expandedDom = expanded.toDOM()
    expect(expandedDom.querySelector(`.${CODE_CARD_CLASS_NAMES.fold}`)).not.toBeNull()
    expect(expandedDom.querySelector(`.${CODE_CARD_CLASS_NAMES.fold}`)!.classList.contains(CODE_CARD_CLASS_NAMES.foldCollapsed)).toBe(false)
  })
})

describe('头部 widget 形态', () => {
  it('eq 按标签/语言/copy/code 比较；toDOM 产出头部结构与复制按钮', () => {
    const w = new CodeCardHeaderWidget('JavaScript', 'javascript', true, 'let a')
    expect(w.eq(new CodeCardHeaderWidget('JavaScript', 'javascript', true, 'let a'))).toBe(true)
    expect(w.eq(new CodeCardHeaderWidget('JavaScript', 'javascript', false, 'let a'))).toBe(false)
    expect(w.eq(new CodeCardHeaderWidget('JavaScript', 'javascript', true, 'other'))).toBe(false)
    const dom = w.toDOM()
    expect(dom.className).toBe(CODE_CARD_CLASS_NAMES.header)
    expect(dom.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)!.textContent).toBe('JavaScript')
    expect(dom.querySelector(`.${CODE_CARD_CLASS_NAMES.headerActions}`)).not.toBeNull()
    const btn = dom.querySelector(`button.${CODE_CARD_CLASS_NAMES.copy}`)!
    expect(btn).not.toBeNull()
    expect(btn.getAttribute('aria-label')).toBe('复制代码')
    // copy=false 时按钮不渲染
    const noCopy = new CodeCardHeaderWidget('JavaScript', 'javascript', false, 'let a').toDOM()
    expect(noCopy.querySelector(`.${CODE_CARD_CLASS_NAMES.copy}`)).toBeNull()
  })

  it('纯数据构建可脱离 StateField 直驱（供对拍与阅读侧复用）', () => {
    const state = EditorState.create({
      doc: DOC,
      extensions: [liveDecorationsField, mermaidFencesField],
      selection: EditorSelection.single(0),
    })
    const ranges = buildCodeCardDecorations(
      state.doc,
      state.selection,
      state.field(liveDecorationsField).fm,
      state.field(mermaidFencesField).spans,
    )
    expect(ranges.length).toBeGreaterThan(0)
  })
})
