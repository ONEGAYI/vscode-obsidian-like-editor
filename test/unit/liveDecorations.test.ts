// 语法树驱动的 Live Preview 装饰契约（工单 #8，取代 #5 的行级正则判定）：
// - 语义来源：@codemirror/lang-markdown 的解析树（含 GFM），标题/粗斜体/
//   列表（含任务）/引用/行内代码/围栏代码/水平线由树节点判定——代码围栏
//   内的伪语法不再误判（#5 切片限制的解除）
// - mark 显形：标题前缀在标题范围内、列表/引用前缀仅在标记附近；行内标记只在自身语法范围内；
//   同一行其他 mark 保持格式化，选区跨范围时按相交范围显形
// - 直接装饰（StateField）：整篇构建一次 + 事务增量维护；正常键入只重扫
//   受影响行（键入不遍历全文）；结构编辑（围栏开闭等）按需扩展重建范围
// - 增量结果与全量重建对拍一致（固定编辑序列，RangeSet.eq）
// - 间接装饰（ViewPlugin 纯数据输入）：视口内标题行强调与活动提示
// - 未支持语法（脚注等）保留原文：无装饰即局部源码降级，不触发整篇重写
// 依据：docs/adr/0005-viewport-rendering.md、docs/specs/mvp.md「MVP 性能契约」。
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState, RangeSet, Text, type Transaction } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import {
  HEADING_CLASS_NAMES,
  LIVE_CLASS_NAMES,
  buildLivePreviewDecorations,
  buildViewportLiveDecorations,
  getHeadingStats,
  liveDecorationsField,
  livePreviewDecorations,
} from '../../src/webview/liveDecorations'

// ---- 断言辅助 ----

interface DecoItem {
  from: number
  to: number
  cls?: string
  widget?: string
}

function collect(set: DecorationSet): DecoItem[] {
  const out: DecoItem[] = []
  set.between(0, Infinity, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: { constructor: { name: string }; checked?: boolean } }
    if (spec['class'] !== undefined) {
      out.push({ from, to, cls: spec['class'] })
    } else if (spec.widget !== undefined) {
      out.push({
        from,
        to,
        widget: `${spec.widget.constructor?.name ?? '?'}:${spec.widget.checked ?? ''}`,
      })
    } else {
      out.push({ from, to }) // 纯隐藏（replace 无 widget）
    }
  })
  return out
}

/** 类名 → 装饰项列表（行级/跨度） */
function byClass(set: DecorationSet): Map<string, DecoItem[]> {
  const map = new Map<string, DecoItem[]>()
  for (const item of collect(set)) {
    if (item.cls !== undefined) {
      for (const cls of item.cls.split(' ')) {
        if (!map.has(cls)) {
          map.set(cls, [])
        }
        map.get(cls)!.push(item)
      }
    }
  }
  return map
}

/** 隐藏（replace 无 widget）区间 */
function hiddenRanges(set: DecorationSet): Array<[number, number]> {
  return collect(set)
    .filter((i) => i.cls === undefined && i.widget === undefined)
    .map((i) => [i.from, i.to] as [number, number])
}

/** 任务 checkbox widget（replace 带 widget）区间与勾选态 */
function taskGlyphs(set: DecorationSet): Array<{ from: number; to: number; checked: boolean }> {
  return collect(set)
    .filter((i) => i.widget !== undefined && i.widget.startsWith('TaskCheckboxWidget:'))
    .map((i) => ({ from: i.from, to: i.to, checked: i.widget!.endsWith('true') }))
}

/** 指定类覆盖的源文本片段集合（跨度取片段；行级装饰零宽 → 取整行文本） */
function coveredTexts(set: DecorationSet, cls: string, doc: string): string[] {
  return (byClass(set).get(cls) ?? []).map((i) => {
    if (i.to > i.from) {
      return doc.slice(i.from, i.to)
    }
    let end = doc.indexOf('\n', i.from)
    if (end < 0) {
      end = doc.length
    }
    return doc.slice(i.from, end)
  })
}

function build(doc: string | Text, selection = { anchor: 0 }): DecorationSet {
  const text = typeof doc === 'string' ? Text.of(doc.split('\n')) : doc
  return buildLivePreviewDecorations(text, EditorSelection.single(selection.anchor))
}

function stateWithDoc(doc: string, selection?: { anchor: number; head?: number }) {
  return EditorState.create({
    doc,
    extensions: [liveDecorationsField],
    selection: selection
      ? EditorSelection.single(selection.anchor, selection.head ?? selection.anchor)
      : undefined,
  })
}

function setsEqual(state: EditorState, full: DecorationSet): boolean {
  return RangeSet.eq([state.field(liveDecorationsField).decos], [full])
}

// ---- 全量构建：覆盖语法的语义 ----

const FULL_DOC = [
  '---',
  'title: 元',
  '# 伪标题',
  '---',
  '# 一级标题',
  '',
  '正文 **粗体** 与 *斜体* 和 `代码` 普通。',
  '',
  '## 二级',
  '',
  '- 普通项',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '1. 有序项',
  '',
  '> 引用第一行',
  '> 引用第二行',
  '',
  '```js',
  'let x = 1 // # 伪标题 [[双链]]',
  '```',
  '',
  '---',
  '',
  '脚注样式 [^1] 文本',
].join('\n')

describe('buildLivePreviewDecorations：全量构建（树驱动语义）', () => {
  // 光标在 0（frontmatter 首行）：frontmatter 外所有行非活动
  const set = build(FULL_DOC)

  it('标题：行级类 + 内容 span 类；#5 类名保持', () => {
    const c = byClass(set)
    expect((c.get(HEADING_CLASS_NAMES.line) ?? []).length).toBe(2)
    expect(coveredTexts(set, HEADING_CLASS_NAMES.level(1), FULL_DOC)).toEqual(['# 一级标题'])
    expect(coveredTexts(set, HEADING_CLASS_NAMES.level(2), FULL_DOC)).toEqual(['## 二级'])
    expect(coveredTexts(set, LIVE_CLASS_NAMES.headerSpan(1), FULL_DOC)).toEqual(['一级标题'])
    expect(coveredTexts(set, LIVE_CLASS_NAMES.headerSpan(2), FULL_DOC)).toEqual(['二级'])
  })

  it('frontmatter：行级类 + 内部伪标题不判定为标题', () => {
    const c = byClass(set)
    expect((c.get(LIVE_CLASS_NAMES.frontmatterLine) ?? []).length).toBe(4) // ---/title/伪标题/--- 四行
    // frontmatter 内的 '# 伪标题' 不得产生标题类（两视图一致语义的边界）
    const headingLines = c.get(HEADING_CLASS_NAMES.line) ?? []
    for (const item of headingLines) {
      expect(FULL_DOC.slice(item.from, item.to)).not.toContain('伪标题')
    }
  })

  it('粗斜体：内容 span + 标记隐藏（非活动行）', () => {
    expect(coveredTexts(set, LIVE_CLASS_NAMES.strong, FULL_DOC)).toEqual(['粗体'])
    expect(coveredTexts(set, LIVE_CLASS_NAMES.emphasis, FULL_DOC)).toEqual(['斜体'])
    const hidden = hiddenRanges(set)
    expect(hidden).toContainEqual([FULL_DOC.indexOf('**'), FULL_DOC.indexOf('**') + 2])
    expect(hidden).toContainEqual([FULL_DOC.indexOf('*斜体*') + 3, FULL_DOC.indexOf('*斜体*') + 4])
  })

  it('行内代码：内容 span + 反引号标记隐藏', () => {
    expect(coveredTexts(set, LIVE_CLASS_NAMES.inlineCode, FULL_DOC)).toEqual(['代码'])
    const tick = FULL_DOC.indexOf('`')
    expect(hiddenRanges(set)).toContainEqual([tick, tick + 1])
  })

  it('引用：行级类 + > 标记隐藏（两行各自判定）', () => {
    expect(coveredTexts(set, LIVE_CLASS_NAMES.quoteLine, FULL_DOC)).toEqual(['> 引用第一行', '> 引用第二行'])
    const hidden = hiddenRanges(set)
    expect(hidden).toContainEqual([FULL_DOC.indexOf('>'), FULL_DOC.indexOf('>') + 2])
  })

  it('围栏代码：三行（含围栏行）行级类；围栏内伪语法无任何标题/列表装饰', () => {
    const codeLines = byClass(set).get(LIVE_CLASS_NAMES.codeLine) ?? []
    expect(codeLines.length).toBe(3)
    // 围栏内的 '# 伪标题' 与 '[[双链]]' 不产生标题/任务装饰
    const inFence = FULL_DOC.slice(FULL_DOC.indexOf('```js'), FULL_DOC.indexOf('```js') + 40)
    for (const item of byClass(set).get(HEADING_CLASS_NAMES.line) ?? []) {
      expect(inFence.includes(FULL_DOC.slice(item.from, item.from + 4))).toBe(false)
    }
    expect(taskGlyphs(set)).toHaveLength(2) // 只有正文中的两个任务
  })

  it('列表：项内行级类（含有序/子弹区分与嵌套深度）；子弹标记隐藏、有序标记保留', () => {
    const c = byClass(set)
    const listLines = c.get(LIVE_CLASS_NAMES.listLine) ?? []
    expect(listLines.length).toBe(4) // 三个无序 + 一个有序
    expect((c.get(LIVE_CLASS_NAMES.listBullet) ?? []).length).toBe(3)
    expect((c.get(LIVE_CLASS_NAMES.listOrdered) ?? []).length).toBe(1)
    // '- 普通项' 的 '-' 被隐藏；'1. 有序项' 的 '1.' 不隐藏
    const plain = FULL_DOC.indexOf('- 普通项')
    expect(hiddenRanges(set)).toContainEqual([plain, plain + 2])
    const ordered = FULL_DOC.indexOf('1. 有序项')
    expect(hiddenRanges(set)).not.toContainEqual([ordered, ordered + 2])
  })

  it('任务项：非活动行 marker 替换为字形 widget（勾选态映射）', () => {
    const glyphs = taskGlyphs(set)
    expect(glyphs).toHaveLength(2)
    const unchecked = FULL_DOC.indexOf('[ ]')
    const checked = FULL_DOC.indexOf('[x]')
    expect(glyphs).toContainEqual({ from: unchecked, to: unchecked + 3, checked: false })
    expect(glyphs).toContainEqual({ from: checked, to: checked + 3, checked: true })
  })

  it('水平线：行级类', () => {
    expect(coveredTexts(set, LIVE_CLASS_NAMES.hrLine, FULL_DOC)).toEqual(['---'])
  })

  it('未支持语法（脚注）保留原文：无装饰、无改写', () => {
    const c = byClass(set)
    const footnotePos = FULL_DOC.indexOf('[^1]')
    // 脚注区间内不存在任何隐藏/替换（源码原样呈现）
    for (const [from, to] of hiddenRanges(set)) {
      expect(from > footnotePos + 4 || to < footnotePos).toBe(true)
    }
    for (const item of c.get(LIVE_CLASS_NAMES.emphasis) ?? []) {
      expect(item.to <= footnotePos).toBe(true)
    }
  })

  it('行尾双空格、行尾空格与末尾无换行：装饰构建不崩且尾部空格不参与隐藏（渲染降级安全）', () => {
    // mvp.md 文档样例清单边角：构建路径必须容忍这些形态（源文呈现，空格原样）
    const trailing = '第一行  \n第二行 \n第三行' // 双空格（硬换行）/ 单空格 / 末尾无换行
    let trailingSet: DecorationSet
    expect(() => {
      trailingSet = build(trailing)
    }).not.toThrow()
    // 行尾空格区间不被隐藏/替换（所见即所键：空格原样呈现）
    for (const [from, to] of hiddenRanges(trailingSet!)) {
      expect(trailing.slice(from, to).trim()).not.toBe('')
    }
    expect(() => build('abc')).not.toThrow() // 单行无换行文档
  })
})

describe('标记作用域：行首及行内语法', () => {
  const doc = '# 标题\n\n**粗** 与 `码`\n\n> 引用\n'

  it('光标在 # 附近：标记不隐藏；移出后隐藏', () => {
    const active = build(doc, { anchor: 0 })
    expect(hiddenRanges(active)).not.toContainEqual([0, 2])
    const inactive = build(doc, { anchor: doc.indexOf('粗') })
    expect(hiddenRanges(inactive)).toContainEqual([0, 2])
  })

  it('光标在粗体内容：** 标记显示；其他行标记保持隐藏', () => {
    const pos = doc.indexOf('粗')
    const active = build(doc, { anchor: pos })
    const marks = doc.indexOf('**')
    expect(hiddenRanges(active)).not.toContainEqual([marks, marks + 2])
    // 引用行标记此时隐藏
    const q = doc.indexOf('>')
    expect(hiddenRanges(active)).toContainEqual([q, q + 2])
    // 光标进引用行：反引号与粗体标记隐藏、引用标记显示
    const inQuote = build(doc, { anchor: q })
    expect(hiddenRanges(inQuote)).not.toContainEqual([q, q + 2])
    expect(hiddenRanges(inQuote)).toContainEqual([marks, marks + 2])
  })

  it('光标在任务 marker 内时以源码呈现（无 widget）', () => {
    const taskDoc = '正文行\n- [ ] 任务\n'
    const active = build(taskDoc, { anchor: taskDoc.indexOf('[') })
    expect(taskGlyphs(active)).toHaveLength(0)
    const inactive = build(taskDoc, { anchor: 0 })
    expect(taskGlyphs(inactive)).toHaveLength(1)
  })
})

describe('mark 作用域显形', () => {
  it('列表正文保持 bullet 隐藏；光标贴近 marker 时只显形当前 bullet', () => {
    const doc = '- 第一项 **强调**\n- 第二项\n'
    const first = doc.indexOf('-')
    const second = doc.indexOf('-', first + 1)
    const body = build(doc, { anchor: doc.indexOf('第一项') + 2 })
    expect(hiddenRanges(body)).toContainEqual([first, first + 2])
    expect(hiddenRanges(body)).toContainEqual([second, second + 2])
    expect(byClass(body).get('vsidian-list-marker-visible')).toBeUndefined()

    const atMarker = build(doc, { anchor: first })
    expect(hiddenRanges(atMarker)).not.toContainEqual([first, first + 2])
    expect(hiddenRanges(atMarker)).toContainEqual([second, second + 2])
    expect(byClass(atMarker).get('vsidian-list-marker-visible')).toHaveLength(1)
    expect(hiddenRanges(build(doc, { anchor: first + 2 }))).not.toContainEqual([first, first + 2])
  })

  it('标题行任意位置显形自身的 #；引用仍只在标记附近显形', () => {
    const doc = '# 很长的标题\n## 另一标题\n> 很长的引用\n'
    const heading = doc.indexOf('#')
    const otherHeading = doc.indexOf('##')
    const quote = doc.indexOf('>')
    const inHeading = hiddenRanges(build(doc, { anchor: doc.indexOf('标题') }))
    expect(inHeading).not.toContainEqual([heading, heading + 2])
    expect(inHeading).toContainEqual([otherHeading, otherHeading + 3])
    expect(hiddenRanges(build(doc, { anchor: doc.indexOf('引用') }))).toContainEqual([quote, quote + 2])
    expect(hiddenRanges(build(doc, { anchor: heading }))).not.toContainEqual([heading, heading + 2])
    expect(hiddenRanges(build(doc, { anchor: quote }))).not.toContainEqual([quote, quote + 2])
  })

  it('标题行内的粗体 mark 仍由粗体自身控制域决定', () => {
    const doc = '# 标题前文 **重点** 标题后文'
    const heading = doc.indexOf('#')
    const strong = doc.indexOf('**')
    const afterStrong = hiddenRanges(build(doc, { anchor: doc.indexOf('标题后文') }))
    expect(afterStrong).not.toContainEqual([heading, heading + 2])
    expect(afterStrong).toContainEqual([strong, strong + 2])
    const inStrong = hiddenRanges(build(doc, { anchor: doc.indexOf('重点') }))
    expect(inStrong).not.toContainEqual([heading, heading + 2])
    expect(inStrong).not.toContainEqual([strong, strong + 2])
  })

  it('Setext 标题正文内的光标也显形下划线标记', () => {
    const doc = '下划线标题\n====\n\n普通正文'
    const underline = doc.indexOf('====')
    const inHeading = hiddenRanges(build(doc, { anchor: doc.indexOf('标题') }))
    expect(inHeading).not.toContainEqual([underline, underline + 4])
    expect(hiddenRanges(build(doc, { anchor: doc.indexOf('普通正文') }))).toContainEqual([underline, underline + 4])
  })

  it('同一行的粗体和行内代码各按自己的内容作用域显形', () => {
    const doc = '前缀 **粗体** 中间 `代码` 尾部 **另一处**'
    const strong = doc.indexOf('**')
    const code = doc.indexOf('`')
    const other = doc.lastIndexOf('**另一处')
    const inStrong = hiddenRanges(build(doc, { anchor: doc.indexOf('粗体') }))
    expect(inStrong).not.toContainEqual([strong, strong + 2])
    expect(inStrong).toContainEqual([code, code + 1])
    expect(inStrong).toContainEqual([other, other + 2])
    const inCode = hiddenRanges(build(doc, { anchor: doc.indexOf('代码') }))
    expect(inCode).toContainEqual([strong, strong + 2])
    expect(inCode).not.toContainEqual([code, code + 1])
    expect(hiddenRanges(build(doc, { anchor: doc.indexOf('中间') }))).toContainEqual([strong, strong + 2])
  })

  it('任务正文保留 checkbox，只有光标进入 [ ] 范围才显示任务源码', () => {
    const doc = '- [ ] 任务正文'
    expect(taskGlyphs(build(doc, { anchor: doc.indexOf('正文') }))).toHaveLength(1)
    expect(taskGlyphs(build(doc, { anchor: doc.indexOf('[') }))).toHaveLength(0)
  })

  it('同一行内移动光标后增量装饰与全量结果一致', () => {
    const doc = '- 正文 **强调** 和 `代码`'
    let state = stateWithDoc(doc, { anchor: doc.indexOf('正文') })
    for (const pos of [0, doc.indexOf('强调'), doc.indexOf('代码'), doc.length]) {
      state = state.update({ selection: EditorSelection.single(pos) }).state
      expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    }
  })

  it('非空选区只显形相交的格式范围', () => {
    const doc = '前 **甲** 中 **乙** 后'
    const first = doc.indexOf('**')
    const second = doc.indexOf('**', first + 2)
    const state = stateWithDoc(doc, { anchor: doc.indexOf('甲'), head: doc.indexOf('甲') + 1 })
    const hidden = hiddenRanges(state.field(liveDecorationsField).decos)
    expect(hidden).not.toContainEqual([first, first + 2])
    expect(hidden).not.toContainEqual([second, second + 2])
    const otherOpen = doc.indexOf('**乙')
    expect(hidden).toContainEqual([otherOpen, otherOpen + 2])
  })
})

describe('边界输入：转义、未闭合、嵌套', () => {
  it('转义标记不产生粗斜体装饰', () => {
    const doc = '转义 \\*不斜体\\* 文本\n'
    const set = build(doc, { anchor: 0 })
    expect(byClass(set).get(LIVE_CLASS_NAMES.emphasis)).toBeUndefined()
    // 反斜杠转义也不是隐藏对象（源码原样）
    expect(hiddenRanges(set)).toEqual([])
  })

  it('未闭合粗体：按字面呈现，无装饰', () => {
    const doc = '未闭合 **粗体没有结束\n'
    const set = build(doc, { anchor: 0 })
    expect(byClass(set).get(LIVE_CLASS_NAMES.strong)).toBeUndefined()
  })

  it('未闭合围栏：后续全部行为代码行，其中伪标题/伪任务不解析', () => {
    const doc = '前文\n\n```\n# 伪标题\n- [ ] 伪任务\n末尾仍围栏内\n'
    const set = build(doc, { anchor: 0 })
    const c = byClass(set)
    const codeLines = c.get(LIVE_CLASS_NAMES.codeLine) ?? []
    expect(codeLines.length).toBe(4) // 围栏开行 + 三内容行
    expect(c.get(HEADING_CLASS_NAMES.line)).toBeUndefined()
    expect(taskGlyphs(set)).toHaveLength(0)
  })

  it('嵌套结构：引用内列表、列表内粗体按语义装饰', () => {
    const doc = '> - 引用内 **粗项**\n>   - 嵌套项\n'
    const set = build(doc, { anchor: 0 })
    const c = byClass(set)
    expect((c.get(LIVE_CLASS_NAMES.quoteLine) ?? []).length).toBe(2)
    const listLines = c.get(LIVE_CLASS_NAMES.listLine) ?? []
    expect(listLines.length).toBe(2)
    expect(coveredTexts(set, LIVE_CLASS_NAMES.strong, doc)).toEqual(['粗项'])
    // 嵌套项（第二行）获得更深一级的缩进类
    expect((c.get(`${LIVE_CLASS_NAMES.listLine}-d2`) ?? []).length).toBe(1)
  })

  it('setext 标题：行级类 + 下划线标记隐藏（非活动）', () => {
    const doc = '主题行\n===\n正文\n'
    const set = build(doc, { anchor: doc.indexOf('正') })
    expect(coveredTexts(set, HEADING_CLASS_NAMES.level(1), doc)).toEqual(['主题行'])
    expect(hiddenRanges(set)).toContainEqual([doc.indexOf('==='), doc.indexOf('===') + 3])
    expect(coveredTexts(set, LIVE_CLASS_NAMES.headerSpan(1), doc)).toEqual(['主题行'])
  })
})

// ---- StateField：增量维护 ----

describe('liveDecorationsField：增量维护与全量对拍', () => {
  it('初始 create 即整篇构建（统计口径）', () => {
    const state = stateWithDoc('# 一\n二\n## 三\n四')
    expect(getHeadingStats().fullBuildLines).toBe(4)
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
  })

  it('普通行单字符插入只重扫该行（键入不遍历全文）', () => {
    let state = stateWithDoc('# 一\n正文一行内容\n## 二\n正文二行内容\n# 三\n结尾')
    const pos = state.doc.line(4).from + 2
    state = state.update({ changes: { from: pos, insert: '字' } }).state
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    expect(getHeadingStats().lastUpdateScannedLines).toBe(1)
  })

  it('普通行改标题 / 标题改普通行：装饰增删且对拍一致', () => {
    let state = stateWithDoc('普通行\n# 标题\n普通行')
    const headingCount = (s: EditorState) =>
      collect(s.field(liveDecorationsField).decos).filter((i) => i.cls?.includes(HEADING_CLASS_NAMES.line)).length
    expect(headingCount(state)).toBe(1)
    state = state.update({ changes: { from: 0, to: 3, insert: '## 新标题' } }).state
    expect(headingCount(state)).toBe(2)
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    state = state.update({ changes: { from: state.doc.line(2).from, to: state.doc.line(2).from + 4, insert: '正文' } }).state
    expect(headingCount(state)).toBe(1)
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
  })

  it('选区进出标题行：源码态（标记隐藏）增量更新', () => {
    let state = stateWithDoc('# 甲\n正文\n## 乙\n正文', { anchor: 5 })
    let hidden = hiddenRanges(state.field(liveDecorationsField).decos)
    expect(hidden.map((h) => h[0])).toEqual([0, 7]) // 两标题行都非活动
    state = state.update({ selection: EditorSelection.single(0) }).state
    hidden = hiddenRanges(state.field(liveDecorationsField).decos)
    expect(hidden).toEqual([[7, 10]])
    state = state.update({ selection: EditorSelection.single(8) }).state
    hidden = hiddenRanges(state.field(liveDecorationsField).decos)
    expect(hidden).toEqual([[0, 2]])
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
  })

  it('围栏开启编辑：其后内容整体转为代码行（增量 == 全量）', () => {
    // 文档中部把段落行改为围栏开行：其后到文末全部成为代码内容
    const doc = '开头段\n\n中部段落\n\n# 会被吞掉的标题\n\n结尾段\n'
    let state = stateWithDoc(doc, { anchor: 0 })
    const at = doc.indexOf('中部段落')
    state = state
      .update({ changes: { from: at, to: at + 4, insert: '```\n中部段落' } })
      .state
    const set = state.field(liveDecorationsField).decos
    // 增量结果与全量一致（尾部整体重分类正确）
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    const c = byClass(set)
    expect(byClass(set).get(HEADING_CLASS_NAMES.line)).toBeUndefined() // 标题被围栏吞掉
    expect((c.get(LIVE_CLASS_NAMES.codeLine) ?? []).length).toBe(6)
  })

  it('围栏闭合编辑：其后的伪标题恢复标题装饰（增量 == 全量）', () => {
    const doc = '```\n围栏内容\n```\n\n# 被隔离的真标题\n正文\n'
    let state = stateWithDoc(doc, { anchor: 0 })
    expect((byClass(state.field(liveDecorationsField).decos).get(HEADING_CLASS_NAMES.line) ?? []).length).toBe(1)
    // 删除闭围栏行（'```\n\n' → '\n'）：围栏吞到文末
    const closeAt = doc.indexOf('```\n\n#') 
    state = state.update({ changes: { from: closeAt, to: closeAt + 3, insert: 'tmp' } }).state
    expect(byClass(state.field(liveDecorationsField).decos).get(HEADING_CLASS_NAMES.line)).toBeUndefined()
    // 恢复闭围栏：其后标题重新可见，且与全量对拍一致
    state = state.update({ changes: { from: closeAt, to: closeAt + 3, insert: '```' } }).state
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    expect((byClass(state.field(liveDecorationsField).decos).get(HEADING_CLASS_NAMES.line) ?? []).length).toBe(1)
  })

  it('固定编辑序列后增量 == 全量（对拍），且无整篇重扫', () => {
    let state = stateWithDoc(
      '# 起始标题\n第一段 **粗** 文本\n## 二级标题\n第二段\n- [ ] 任务项\n> 引用行\n```js\ncode()\n```\n结尾段\n',
      { anchor: 0 },
    )
    const ops: Array<(s: EditorState) => Transaction> = [
      (s) => s.update({ changes: { from: s.doc.line(2).to, insert: '追加' } }),
      (s) => s.update({ selection: EditorSelection.single(s.doc.line(3).from) }),
      (s) => s.update({ changes: { from: s.doc.line(3).from, to: s.doc.line(3).to, insert: '#### 四级标题' } }),
      (s) => s.update({ selection: EditorSelection.single(s.doc.line(1).from + 2) }),
      (s) => s.update({ changes: { from: s.doc.line(5).from, to: s.doc.line(5).from + 2, insert: '- ' } }),
      (s) => s.update({ selection: EditorSelection.range(0, s.doc.length) }),
      (s) => s.update({ selection: EditorSelection.single(1) }),
      (s) => s.update({ changes: { from: 0, to: s.doc.line(1).to, insert: '# 重写的一级' } }),
    ]
    for (const op of ops) {
      state = op(state).state
    }
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    expect(getHeadingStats().lastUpdateScannedLines).toBeLessThan(state.doc.lines)
  })

  it('10 万行文档：一次键入仍只重扫 1 行（体量无关的键入路径）', () => {
    const lines: string[] = []
    for (let i = 1; i <= 100_000; i++) {
      lines.push(i % 50 === 0 ? `## 第 ${i} 节 标题样本行` : `第 ${i} 行 普通段落样本文本，固定宽度内容，用于体量对比测试。`)
    }
    let state = EditorState.create({ doc: lines.join('\n'), extensions: [liveDecorationsField] })
    expect(getHeadingStats().fullBuildLines).toBe(100_000)
    const mid = state.doc.line(50_001).from + 3
    state = state.update({ changes: { from: mid, insert: '字' } }).state
    expect(setsEqual(state, buildLivePreviewDecorations(state.doc, state.selection))).toBe(true)
    expect(getHeadingStats().lastUpdateScannedLines).toBe(1)
  }, 30_000)
})

// ---- 间接装饰（视口内纯样式） ----

describe('buildViewportLiveDecorations：间接装饰（纯数据输入）', () => {
  const doc = '# 标题一\n正文一\n## 标题二\n```js\n# 围栏内伪标题\n```\n### 标题三'

  it('只为视口内标题行生成 inview/active；围栏内伪标题不参与', () => {
    const text = Text.of(doc.split('\n'))
    const set = buildViewportLiveDecorations(
      text,
      [{ from: 0, to: text.length }],
      EditorSelection.single(1),
      buildLivePreviewDecorations(text, EditorSelection.single(1)),
    )
    const items = collect(set)
    expect(items).toEqual([
      { from: 0, to: 0, cls: 'vsidian-heading-inview vsidian-heading-active', widget: undefined },
      { from: text.line(3).from, to: text.line(3).from, cls: 'vsidian-heading-inview', widget: undefined },
      { from: text.line(7).from, to: text.line(7).from, cls: 'vsidian-heading-inview', widget: undefined },
    ])
  })

  it('视口外标题行无装饰；多不连续区间只覆盖区间内', () => {
    const text = Text.of(doc.split('\n'))
    const direct = buildLivePreviewDecorations(text, EditorSelection.single(0))
    const set = buildViewportLiveDecorations(
      text,
      [{ from: text.line(7).from, to: text.length }],
      EditorSelection.single(0),
      direct,
    )
    expect(collect(set).map((i) => i.from)).toEqual([text.line(7).from])
  })

  it('空视口 → 空装饰集', () => {
    const text = Text.of(['# x'])
    const direct = buildLivePreviewDecorations(text, EditorSelection.single(0))
    expect(collect(buildViewportLiveDecorations(text, [], EditorSelection.single(0), direct))).toEqual([])
  })
})

describe('稳定类名常量（#8 样式契约入口）', () => {
  it('live 侧新增类名与既有 #5 标题类名并存', () => {
    expect(HEADING_CLASS_NAMES.line).toBe('vsidian-heading-line')
    expect(LIVE_CLASS_NAMES.headerSpan(3)).toBe('vsidian-header-3')
    expect(LIVE_CLASS_NAMES.strong).toBe('vsidian-strong')
    expect(LIVE_CLASS_NAMES.emphasis).toBe('vsidian-emphasis')
    expect(LIVE_CLASS_NAMES.inlineCode).toBe('vsidian-inline-code')
    expect(LIVE_CLASS_NAMES.quoteLine).toBe('vsidian-quote-line')
    expect(LIVE_CLASS_NAMES.codeLine).toBe('vsidian-code-line')
    expect(LIVE_CLASS_NAMES.listLine).toBe('vsidian-list-line')
    expect(LIVE_CLASS_NAMES.taskCheckbox).toBe('vsidian-task-checkbox')
    expect(LIVE_CLASS_NAMES.taskChecked).toBe('vsidian-task-checked')
    expect(LIVE_CLASS_NAMES.hrLine).toBe('vsidian-hr-line')
    expect(LIVE_CLASS_NAMES.frontmatterLine).toBe('vsidian-frontmatter-line')
  })
})

describe('livePreviewDecorations：装配导出（field + viewport plugin）', () => {
  it('是可直接装配的扩展数组', () => {
    expect(Array.isArray(livePreviewDecorations)).toBe(true)
    expect((livePreviewDecorations as unknown[]).length).toBeGreaterThanOrEqual(2)
  })
})

describe('B-3：frontmatter 截断口径两视图同源', () => {
  const makeDoc = (fmBodyLen: number): string =>
    `---\n${'x'.repeat(fmBodyLen)}\n---\n\n# 标题\n`

  const frontmatterDecoCount = (doc: string): number =>
    (byClass(build(doc)).get(LIVE_CLASS_NAMES.frontmatterLine) ?? []).length

  it('结束行在扫描上限内：两视图都识别 frontmatter', async () => {
    const { frontmatterRange, FM_SCAN_LIMIT } = await import('../../src/webview/markdownDoc')
    const { splitReadingBlocks } = await import('../../src/webview/readingBlocks')
    const doc = makeDoc(FM_SCAN_LIMIT - 200)
    expect(frontmatterRange(doc)).not.toBeNull()
    expect(splitReadingBlocks(doc)[0]!.kind).toBe('frontmatter')
    expect(frontmatterDecoCount(doc)).toBe(3) // ---/body/--- 三行
  })

  it('结束行超出扫描上限：两视图一致降级（都不识别）', async () => {
    const { frontmatterRange, FM_SCAN_LIMIT } = await import('../../src/webview/markdownDoc')
    const { splitReadingBlocks } = await import('../../src/webview/readingBlocks')
    const doc = makeDoc(FM_SCAN_LIMIT + 200)
    // 截断口径上移进 frontmatterRange：找不到结束行 → null（不视为 frontmatter）
    expect(frontmatterRange(doc)).toBeNull()
    expect(splitReadingBlocks(doc)[0]!.kind).not.toBe('frontmatter')
    expect(frontmatterDecoCount(doc)).toBe(0)
  })
})
