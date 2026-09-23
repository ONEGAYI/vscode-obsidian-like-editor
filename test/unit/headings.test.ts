// 标题装饰核心契约（工单 #5）：全文文本模型之上，标题装饰必须增量更新。
// - 行首 # 语法的行级判定（纯函数，切片范围：不认缩进、最多 6 级）
// - 直接装饰（StateField，影响块高度）：整篇构建一次 + 事务增量维护，
//   增量计划只覆盖受影响行（键入不遍历全文）
// - 间接装饰（ViewPlugin 数据来源，纯视口内）：只按 visibleRanges 构建，
//   不触碰 DOM 测量（防布局循环）
// - 增量结果与全量重建对拍一致（固定编辑序列）
// 依据：docs/adr/0005-viewport-rendering.md、探索笔记 03 §5、
// docs/specs/mvp.md「MVP 性能契约」。
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState, RangeSet, Text, type Transaction } from '@codemirror/state'
import {
  HEADING_CLASS_NAMES,
  buildHeadingDecorations,
  buildViewportHeadingDecorations,
  getHeadingStats,
  headingField,
  parseHeadingLine,
  planHeadingRebuild,
} from '../../src/webview/headings'

/** 把装饰集合收集为可断言的明细（按 from 升序） */
function collect(set: { between: (a: number, b: number, f: (from: number, to: number, value: { spec: Record<string, unknown> }) => void) => void }) {
  const out: Array<{ from: number; to: number; cls?: string; kind: 'line' | 'replace' }> = []
  set.between(0, Infinity, (from, to, value) => {
    const cls = typeof value.spec['class'] === 'string' ? value.spec['class'] : undefined
    out.push({ from, to, cls, kind: cls === undefined ? 'replace' : 'line' })
  })
  return out
}

/** 增量结果与全量重建对拍：RangeSet.eq 为静态方法，Decoration 值比较
 *  依赖模块级实例缓存（引用相等），因此对拍同时覆盖排序与实例复用 */
function setsEqual(state: EditorState, full: ReturnType<typeof buildHeadingDecorations>): boolean {
  return RangeSet.eq([state.field(headingField)], [full])
}

function stateWithDoc(doc: string, selection?: { anchor: number; head?: number }) {
  return EditorState.create({
    doc,
    extensions: [headingField],
    selection: selection
      ? EditorSelection.single(selection.anchor, selection.head ?? selection.anchor)
      : undefined,
  })
}

describe('parseHeadingLine：行首 # 语法判定（切片范围）', () => {
  it.each([
    ['# 标题', { level: 1, markerEnd: 2 }],
    ['## 二级', { level: 2, markerEnd: 3 }],
    ['###### 六级', { level: 6, markerEnd: 7 }],
    ['#', { level: 1, markerEnd: 1 }],
    ['##', { level: 2, markerEnd: 2 }],
    ['# ', { level: 1, markerEnd: 2 }],
    ['##  ## 嵌套标记', { level: 2, markerEnd: 3 }],
  ])('%j → %j', (line, expected) => {
    expect(parseHeadingLine(line)).toEqual(expected)
  })

  it.each([
    ['####### 七级'],
    ['#无空格'],
    ['  # 缩进标题（切片不认）'],
    ['#\tTab 分隔（切片不认）'],
    ['正文 # 行中出现'],
    [''],
    ['普通段落'],
  ])('%j 不判定为标题', (line) => {
    expect(parseHeadingLine(line)).toBeNull()
  })
})

describe('planHeadingRebuild：增量重建计划只覆盖受影响行', () => {
  const doc = 'abc\ndef\nghi\njkl\nmno'
  const base = EditorState.create({ doc })

  it('行内单字符插入 → 仅该行', () => {
    const tr = base.update({ changes: { from: 5, insert: 'x' } }) // def 行中部
    const plan = planHeadingRebuild(tr)
    expect(plan).toEqual([{ fromLine: 2, toLine: 2 }])
  })

  it('插入换行拆分 → 覆盖新增行', () => {
    const tr = base.update({ changes: { from: 3, insert: '\n\n新行' } })
    // 新文档：abc / (空) / 新行 / def / ghi / jkl / mno；插入点位置 3 归属
    // 行 1（换行符），保守把行 1 纳入重建（多余重建无害）
    expect(planHeadingRebuild(tr)).toEqual([{ fromLine: 1, toLine: 3 }])
  })

  it('跨行删除 → 覆盖合并后行及邻接行', () => {
    const tr = base.update({ changes: { from: 1, to: 6 } }) // 删 'bc\nd' → 'aef\n...'
    const plan = planHeadingRebuild(tr)
    expect(plan).toEqual([{ fromLine: 1, toLine: 1 }])
  })

  it('纯选区移动（文本未变）→ 旧选区行 + 新选区行', () => {
    const from = base.update({ selection: EditorSelection.single(4) }) // 行 2
    const tr = from.state.update({ selection: EditorSelection.single(12) }) // 行 4
    expect(planHeadingRebuild(tr)).toEqual([
      { fromLine: 2, toLine: 2 },
      { fromLine: 4, toLine: 4 },
    ])
  })

  it('跨行选区展开 → 行区间展开', () => {
    const from = base.update({ selection: EditorSelection.single(0) })
    const tr = from.state.update({ selection: EditorSelection.single(4, 12) }) // 行 2..4
    // 旧选区行 1 与新区间相邻，合并为一个计划区间
    expect(planHeadingRebuild(tr)).toEqual([{ fromLine: 1, toLine: 4 }])
  })

  it('编辑同时改选区 → 计划合并重叠区间', () => {
    const from = base.update({ selection: EditorSelection.single(4) }) // 行 2
    const tr = from.state.update({
      changes: { from: 8, insert: 'x' }, // 行 3
      selection: EditorSelection.single(9),
    })
    // 旧选区行 2 与变更行 3 相邻，合并
    expect(planHeadingRebuild(tr)).toEqual([{ fromLine: 2, toLine: 3 }])
  })

  it('无文档与选区变化 → 空计划', () => {
    const tr = base.update({}) as Transaction
    expect(planHeadingRebuild(tr)).toEqual([])
  })
})

describe('buildHeadingDecorations：直接装饰（整篇构建）', () => {
  const doc = '# 一级\n正文甲\n## 二级\n正文乙\n### 三级'

  it('标题行得到行级样式类；非活动标题行额外隐藏 # 标记（replace）', () => {
    // 光标在行 3（## 二级，[9,14)）：该行活动显示源码，其余标题隐藏标记。
    // 行界：行1 [0,4) / 行2 [5,8) / 行3 [9,14) / 行4 [15,18) / 行5 [19,24)
    const set = buildHeadingDecorations(
      Text.of(doc.split('\n')),
      EditorSelection.single(9),
    )
    const items = collect(set)
    expect(items).toEqual([
      { from: 0, to: 0, cls: 'oile-heading-line oile-heading-line-1', kind: 'line' },
      { from: 0, to: 2, cls: undefined, kind: 'replace' },
      { from: 9, to: 9, cls: 'oile-heading-line oile-heading-line-2', kind: 'line' },
      { from: 19, to: 19, cls: 'oile-heading-line oile-heading-line-3', kind: 'line' },
      { from: 19, to: 23, cls: undefined, kind: 'replace' },
    ])
  })

  it('选区跨多行时覆盖的标题行都视为活动（显示源码）', () => {
    const lines = doc.split('\n')
    const set = buildHeadingDecorations(
      Text.of(lines),
      EditorSelection.single(0, 12), // 覆盖行 1..3
    )
    const replaces = collect(set).filter((i) => i.kind === 'replace')
    // 仅行 5（### 三级）非活动，保留 replace [19,23)
    expect(replaces).toEqual([{ from: 19, to: 23, cls: undefined, kind: 'replace' }])
  })

  it('普通行无任何装饰', () => {
    const set = buildHeadingDecorations(Text.of(['普通一', '普通二']), EditorSelection.single(0))
    expect(collect(set)).toEqual([])
  })

  it('全量构建统计扫描行数', () => {
    buildHeadingDecorations(Text.of(['# 一', '二']), EditorSelection.single(0))
    expect(getHeadingStats().fullBuildLines).toBe(2)
  })
})

describe('标题 StateField：增量维护与全量对拍一致', () => {
  it('初始 create 即整篇构建', () => {
    const state = stateWithDoc('# 一\n二\n## 三\n四')
    const stats = getHeadingStats()
    expect(stats.fullBuildLines).toBe(4)
    expect(setsEqual(state, buildHeadingDecorations(state.doc, state.selection))).toBe(true)
  })

  it('单字符插入只重扫该行（不遍历全文）', () => {
    const state = stateWithDoc('# 一\n正文一行内容\n## 二\n正文二行内容\n# 三\n结尾')
    const pos = state.doc.line(4).from + 2
    // StateField 更新是惰性的：读取 field（渲染路径等价物）驱动 update 重放
    const next = state.update({ changes: { from: pos, insert: '字' } }).state
    collect(next.field(headingField))
    const stats = getHeadingStats()
    expect(stats.lastUpdateScannedLines).toBe(1)
    expect(stats.totalUpdates).toBe(1)
  })

  it('普通行改标题 / 标题改普通行：装饰随之增删', () => {
    let state = stateWithDoc('普通行\n# 标题\n普通行')
    const headingCount = (s: EditorState) =>
      collect(s.field(headingField)).filter((i) => i.kind === 'line').length
    expect(headingCount(state)).toBe(1)

    // 普通行（行 1）改为标题：光标在行 1，活动无 replace
    state = state.update({ changes: { from: 0, to: 3, insert: '## 新标题' } }).state
    expect(headingCount(state)).toBe(2)
    expect(setsEqual(state, buildHeadingDecorations(state.doc, state.selection))).toBe(true)

    // 行 2 标题改回普通行
    state = state.update({ changes: { from: state.doc.line(2).from, to: state.doc.line(2).from + 4, insert: '正文' } }).state
    expect(headingCount(state)).toBe(1)
    expect(setsEqual(state, buildHeadingDecorations(state.doc, state.selection))).toBe(true)
  })

  it('选区进出标题行：源码态（replace 增删）增量更新', () => {
    // 行界：行1 [0,3) / 行2 [4,6) / 行3 [7,11) / 行4 [12,14)
    let state = stateWithDoc('# 甲\n正文\n## 乙\n正文', { anchor: 5 }) // 初始在行 2：两标题都非活动
    let replaces = collect(state.field(headingField)).filter((i) => i.kind === 'replace')
    expect(replaces.map((r) => r.from)).toEqual([0, 7]) // 行 1 [0,2)、行 3 [7,10)

    // 选区进入标题行 1：该行显示源码，其 replace 消失
    state = state.update({ selection: EditorSelection.single(0) }).state
    replaces = collect(state.field(headingField)).filter((i) => i.kind === 'replace')
    expect(replaces).toEqual([{ from: 7, to: 10, cls: undefined, kind: 'replace' }])
    expect(getHeadingStats().lastUpdateScannedLines).toBe(2) // 旧行 2 + 新行 1

    // 选区进入标题行 3：行 1 恢复隐藏、行 3 显示源码
    state = state.update({ selection: EditorSelection.single(8) }).state
    replaces = collect(state.field(headingField)).filter((i) => i.kind === 'replace')
    expect(replaces).toEqual([{ from: 0, to: 2, cls: undefined, kind: 'replace' }])
    expect(setsEqual(state, buildHeadingDecorations(state.doc, state.selection))).toBe(true)
  })

  it('固定编辑序列后增量结果与全量重建完全一致（对拍）', () => {
    let state = stateWithDoc(
      '# 起始标题\n第一段\n## 二级标题\n第二段\n### 三级\n## 另一个二级\n结尾段\n',
      { anchor: 0 },
    )
    const ops: Array<(s: EditorState) => Transaction> = [
      (s) => s.update({ changes: { from: s.doc.line(2).to, insert: '追加字' } }),
      (s) => s.update({ selection: EditorSelection.single(s.doc.line(3).from) }),
      (s) => s.update({ changes: { from: s.doc.line(3).from, to: s.doc.line(3).to, insert: '#### 四级标题' } }),
      (s) => s.update({ selection: EditorSelection.single(s.doc.line(1).from + 2) }),
      (s) => s.update({ changes: { from: s.doc.line(4).from, to: s.doc.line(4).from + 4, insert: '普通行' } }),
      (s) => s.update({ selection: EditorSelection.range(0, s.doc.length) }), // 全选：全部标题源码态
      (s) => s.update({ selection: EditorSelection.single(1) }),
      (s) => s.update({ changes: { from: 0, to: s.doc.line(1).to, insert: '# 重写的一级' } }),
    ]
    for (const op of ops) {
      state = op(state).state
    }
    expect(setsEqual(state, buildHeadingDecorations(state.doc, state.selection))).toBe(true)
    // 编辑与选区混合序列全部走增量，未发生全量重建（重扫行数远小于全文）
    expect(getHeadingStats().lastUpdateScannedLines).toBeLessThan(state.doc.lines)
  })

  it('10 万行文档：一次键入仍只重扫 1 行（体量无关的键入路径）', () => {
    const lines: string[] = []
    for (let i = 1; i <= 100_000; i++) {
      lines.push(i % 50 === 0 ? `## 第 ${i} 节 标题样本行` : `第 ${i} 行 普通段落样本文本，固定宽度。`)
    }
    let state = EditorState.create({ doc: lines.join('\n'), extensions: [headingField] })
    expect(getHeadingStats().fullBuildLines).toBe(100_000)
    const mid = state.doc.line(50_001).from + 3
    state = state.update({ changes: { from: mid, insert: '字' } }).state
    // 先读取 field（驱动惰性 update 重放），再断言重扫行数
    expect(setsEqual(state, buildHeadingDecorations(state.doc, state.selection))).toBe(true)
    expect(getHeadingStats().lastUpdateScannedLines).toBe(1)
  })
})

describe('buildViewportHeadingDecorations：间接装饰（纯视口内）', () => {
  const doc = '# 标题一\n正文一\n## 标题二\n正文二\n### 标题三'

  it('只为 visibleRanges 内的标题行生成装饰', () => {
    // 行界：行1 [0,5) / 行2 [6,9) / 行3 [10,16) / 行4 [17,20) / 行5 [21,28)
    const text = Text.of(doc.split('\n'))
    const line3End = text.line(3).to
    const set = buildViewportHeadingDecorations(
      text,
      [{ from: 0, to: line3End }], // 视口只含行 1-3
      EditorSelection.single(1), // 光标在行 1 标题上 → 该行 active
    )
    const items = collect(set)
    // 行 1、行 3 在视口内得 inview；行 5（### 标题三）在视口外无装饰
    expect(items).toEqual([
      { from: 0, to: 0, cls: 'oile-heading-inview oile-heading-active', kind: 'line' },
      { from: 10, to: 10, cls: 'oile-heading-inview', kind: 'line' },
    ])
  })

  it('活动标题行额外获得源码态提示类', () => {
    const text = Text.of(doc.split('\n'))
    const set = buildViewportHeadingDecorations(
      text,
      [{ from: 0, to: text.length }],
      EditorSelection.single(10), // 光标在行 3 标题上
    )
    const items = collect(set)
    expect(items).toContainEqual({ from: 10, to: 10, cls: 'oile-heading-inview oile-heading-active', kind: 'line' })
  })

  it('多个不连续可见区间都覆盖（长行折叠形态）', () => {
    const text = Text.of(doc.split('\n'))
    const set = buildViewportHeadingDecorations(
      text,
      [
        { from: 0, to: text.line(1).to },
        { from: text.line(5).from, to: text.length },
      ],
      EditorSelection.single(0),
    )
    const items = collect(set)
    expect(items.map((i) => i.from)).toEqual([0, 21]) // 行 1 与行 5，跳过中间
  })

  it('输入为纯数据（doc/visibleRanges/selection），不接收 view 或 DOM（类型契约由模块签名保证）', () => {
    // 行为冒烟：空视口范围 → 空装饰集
    const set = buildViewportHeadingDecorations(Text.of(['# x']), [], EditorSelection.single(0))
    expect(collect(set)).toEqual([])
  })
})

describe('稳定类名约定（#6/#8 样式入口预留）', () => {
  it('类名常量与装饰输出一致', () => {
    expect(HEADING_CLASS_NAMES.line).toBe('oile-heading-line')
    expect(HEADING_CLASS_NAMES.level(3)).toBe('oile-heading-line-3')
    expect(HEADING_CLASS_NAMES.inview).toBe('oile-heading-inview')
    expect(HEADING_CLASS_NAMES.active).toBe('oile-heading-active')
  })
})
