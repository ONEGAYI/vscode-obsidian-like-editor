// 语法树驱动的 Live Preview 装饰（工单 #8，取代 #5 的行级正则判定）。
//
// 架构（依据 ADR-0005、mvp.md「MVP 性能契约」，#5 的直接/间接分类沿用）：
// - 语义来源：@codemirror/lang-markdown 的 markdownLanguage 解析器（GFM）。
//   解析树在 StateField 内自持，经 @lezer TreeFragment 做增量解析——
//   正常键入只重解析变更附近（实测 10 万行文档中部键入 ≈1ms），整篇
//   解析仅发生在 create 与全文替换（必要初始化/重同步）
// - 直接装饰（影响块高度）→ StateField 常驻 RangeSet 整篇维护：
//   · 行级类：标题（#5 类名不变）、围栏/缩进代码、引用、列表（含嵌套
//     深度与有序/子弹区分）、水平线、frontmatter
//   · 标记隐藏（replace）：非活动行的 #/**/`/>/- 等标记与任务 [x] 字形
//     widget（光标行显示源码——#5 选区联动语义）
//   · 内容 span：oile-header-{n} / oile-strong / oile-emphasis / oile-inline-code
// - 间接装饰（纯视口内）→ ViewPlugin 按直接装饰集合与 visibleRanges 计算
//   标题行强调与活动提示（不触碰 view/DOM 测量，防布局循环）
// - 增量策略：键入路径的重建区间 = 变更行 ∪ 旧树相交装饰节点（映射后）
//   ∪ 选区旧行/新行；结构编辑（围栏开闭、列表吸收等）经「容器分类差异
//   探测」扩展重建范围至受影响容器边界——正确性优先，触发频率低
// - frontmatter：与阅读视图共用 markdownDoc.frontmatterRange（有界扫描），
//   头块内不产生 Markdown 装饰（伪标题/伪列表按源码呈现）
// - 未支持语法（脚注、定义列表等）：无装饰即局部源码降级，不整篇改写
import {
  EditorSelection,
  RangeSet,
  StateField,
  Text,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { TreeFragment, type SyntaxNode, type Tree } from '@lezer/common'
import {
  chainAt,
  docInput,
  FM_SCAN_LIMIT,
  frontmatterRange,
  markdownTreeParser,
  visitRange,
  type SourceRange,
} from './markdownDoc'

/** 标题类名（#5 契约保持不变） */
export const HEADING_CLASS_NAMES = {
  line: 'oile-heading-line',
  level: (lv: number) => `oile-heading-line-${lv}`,
  inview: 'oile-heading-inview',
  active: 'oile-heading-active',
} as const

/** #8 新增稳定类名（Obsidian 对应选择器见 docs/design/obsidian-selector-map.md） */
export const LIVE_CLASS_NAMES = {
  /** 标题内容 span（Obsidian `.cm-header-{n}`） */
  headerSpan: (lv: number) => `oile-header-${Math.min(6, Math.max(1, lv))}`,
  /** 粗体内容 span（`.cm-strong`） */
  strong: 'oile-strong',
  /** 斜体内容 span（`.cm-emphasis`） */
  emphasis: 'oile-emphasis',
  /** 行内代码内容 span（`.cm-inline-code`） */
  inlineCode: 'oile-inline-code',
  /** 引用行（`.HyperMD-quote` / `.cm-quote`） */
  quoteLine: 'oile-quote-line',
  /** 围栏/缩进代码行（`.HyperMD-codeblock`） */
  codeLine: 'oile-code-line',
  /** 列表项行（`.HyperMD-list-line`，本项目自有组合形态） */
  listLine: 'oile-list-line',
  /** 无序列表行修饰（标记隐藏后以 ::before 呈现圆点） */
  listBullet: 'oile-list-bullet',
  /** 有序列表行修饰（编号保留可见） */
  listOrdered: 'oile-list-ordered',
  /** 任务标记字形（Obsidian `.cm-task-*` 方向；#9 换交互 checkbox） */
  taskGlyph: 'oile-task-glyph',
  taskChecked: 'oile-task-checked',
  /** 水平线行（`.cm-hr`） */
  hrLine: 'oile-hr-line',
  /** frontmatter 行（`.cm-hmd-frontmatter` 方向） */
  frontmatterLine: 'oile-frontmatter-line',
} as const

// ---- 装饰实例缓存：增量与全量构建产出相同实例，使 RangeSet.eq 成立 ----

const hideDeco = Decoration.replace({})

const lineDecoCache = new Map<string, ReturnType<typeof Decoration.line>>()
function lineDeco(cls: string): ReturnType<typeof Decoration.line> {
  let deco = lineDecoCache.get(cls)
  if (!deco) {
    deco = Decoration.line({ class: cls })
    lineDecoCache.set(cls, deco)
  }
  return deco
}

const headerSpanDecos = [1, 2, 3, 4, 5, 6].map((lv) =>
  Decoration.mark({ class: LIVE_CLASS_NAMES.headerSpan(lv) }),
)
const strongDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.strong })
const emphasisDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.emphasis })
const inlineCodeDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.inlineCode })

/** 任务字形 widget：#8 只读呈现（CSS 绘制勾选态），#9 换交互元素 */
class TaskGlyphWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: TaskGlyphWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.checked
      ? `${LIVE_CLASS_NAMES.taskGlyph} ${LIVE_CLASS_NAMES.taskChecked}`
      : LIVE_CLASS_NAMES.taskGlyph
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}
const taskGlyphDecos = [
  Decoration.replace({ widget: new TaskGlyphWidget(false) }),
  Decoration.replace({ widget: new TaskGlyphWidget(true) }),
]

/** 行是否被选区覆盖（任一 range 的行区间覆盖该行即视为活动，显示源码）。
 *  #10 起 liveLinks 的链接/图片装饰复用同一活动语义 */
export function isLineActive(selection: EditorSelection, doc: Text, lineNumber: number): boolean {
  for (const r of selection.ranges) {
    if (doc.lineAt(r.from).number <= lineNumber && lineNumber <= doc.lineAt(r.to).number) {
      return true
    }
  }
  return false
}

/** ATXHeading{1..6} / SetextHeading{1..2} → 级别；其余 null */
function headingLevelOf(name: string): number | null {
  let m = /^ATXHeading([1-6])$/.exec(name)
  if (m) {
    return Number(m[1])
  }
  m = /^SetextHeading([1-2])$/.exec(name)
  if (m) {
    return Number(m[1])
  }
  return null
}

/** 名为 name 的直接子节点（mark 查找用） */
function childNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) {
      return c
    }
  }
  return null
}

/** 跳过 pos 起的连续空格（ATX 标记后的分隔空格） */
function skipSpaces(doc: Text, pos: number): number {
  let p = pos
  while (p < doc.length) {
    const ch = doc.sliceString(p, p + 1)
    if (ch !== ' ' && ch !== '\t') {
      break
    }
    p += 1
  }
  return p
}

/** 区间行号集合：把节点/区间限制到 [fromLine, toLine] 后逐行回调。
 *  节点结束位置含块尾换行（Lezer 块节点常态），行号按去掉尾换行计算 */
function eachNodeLine(
  doc: Text,
  node: { from: number; to: number },
  fromLine: number,
  toLine: number,
  fn: (lineNo: number) => void,
): void {
  const first = Math.max(fromLine, doc.lineAt(Math.min(node.from, doc.length)).number)
  let endPos = Math.min(node.to, doc.length)
  if (endPos > node.from && doc.sliceString(endPos - 1, endPos) === '\n') {
    endPos -= 1
  }
  const last = Math.min(toLine, doc.lineAt(endPos).number)
  for (let n = first; n <= last; n++) {
    fn(n)
  }
}

function emitForRange(
  tree: Tree,
  doc: Text,
  selection: EditorSelection,
  fm: SourceRange | null,
  fromLine: number,
  toLine: number,
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  const lineCls: Array<Set<string> | undefined> = new Array(toLine - fromLine + 1).fill(undefined)
  const addLineCls = (lineNo: number, cls: string): void => {
    const idx = lineNo - fromLine
    let set = lineCls[idx]
    if (!set) {
      set = new Set()
      lineCls[idx] = set
    }
    set.add(cls)
  }
  const active = (lineNo: number): boolean => isLineActive(selection, doc, lineNo)

  // frontmatter：按行给类（树发射被裁剪到 fm 之后）
  if (fm) {
    const fmLast = doc.lineAt(Math.min(fm.end, doc.length)).number
    for (let n = Math.max(1, fromLine); n <= Math.min(toLine, fmLast); n++) {
      addLineCls(n, LIVE_CLASS_NAMES.frontmatterLine)
    }
  }

  const emitFrom = Math.max(doc.line(fromLine).from, fm ? fm.end : 0)
  const emitTo = doc.line(toLine).to

  visitRange(tree, emitFrom, emitTo, (node, path) => {
    // frontmatter 区域内的树节点不发射（头块按源码呈现）
    if (fm && node.from < fm.end) {
      return
    }
    const level = headingLevelOf(node.name)
    if (level !== null) {
      const mark = childNamed(node, 'HeaderMark')
      let contentFrom = node.from
      let contentTo = node.to
      if (mark && mark.from === node.from) {
        // ATX：# 标记在头部（HeaderMark 仅覆盖 # 字符），内容跳过标记后的空格
        contentFrom = skipSpaces(doc, mark.to)
        addLineCls(doc.lineAt(node.from).number, `${HEADING_CLASS_NAMES.line} ${HEADING_CLASS_NAMES.level(level)}`)
      } else {
        // Setext：内容行 = 下划线标记之前的行；下划线行不套标题行级类
        const underlineLine = mark ? doc.lineAt(mark.from).number : doc.lineAt(node.to).number
        contentTo = mark
          ? doc.line(Math.max(1, underlineLine - 1)).to
          : node.to
        eachNodeLine(doc, { from: node.from, to: contentTo }, fromLine, toLine, (n) => {
          if (n < underlineLine) {
            addLineCls(n, `${HEADING_CLASS_NAMES.line} ${HEADING_CLASS_NAMES.level(level)}`)
          }
        })
      }
      if (contentTo > contentFrom && contentFrom >= emitFrom) {
        out.push(headerSpanDecos[level - 1]!.range(contentFrom, contentTo))
      }
      return
    }
    switch (node.name) {
      case 'FencedCode':
      case 'CodeBlock':
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.codeLine))
        return
      case 'Blockquote':
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.quoteLine))
        return
      case 'HorizontalRule':
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.hrLine))
        return
      case 'ListItem': {
        const depth = 1 + path.filter((p) => p.name === 'ListItem').length
        const nearestList = [...path].reverse().find((p) => p.name === 'BulletList' || p.name === 'OrderedList')
        const ordered = nearestList?.name === 'OrderedList'
        const cls = `${LIVE_CLASS_NAMES.listLine} ${ordered ? LIVE_CLASS_NAMES.listOrdered : LIVE_CLASS_NAMES.listBullet} ${LIVE_CLASS_NAMES.listLine}-d${Math.min(8, depth)}`
        eachNodeLine(doc, node, fromLine, toLine, (n) => {
          for (const part of cls.split(' ')) {
            addLineCls(n, part)
          }
        })
        return
      }
      case 'Emphasis':
        pushInnerSpan(out, node, 'EmphasisMark', emphasisDeco)
        return
      case 'StrongEmphasis':
        pushInnerSpan(out, node, 'EmphasisMark', strongDeco)
        return
      case 'InlineCode':
        pushInnerSpan(out, node, 'CodeMark', inlineCodeDeco)
        return
      case 'HeaderMark':
      case 'QuoteMark': {
        const lineNo = doc.lineAt(node.from).number
        if (!active(lineNo)) {
          // 标记字符 + 其后一个空格一并隐藏（#5 语义：'# '/'> '）
          const to =
            node.to < doc.length && doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          out.push(hideDeco.range(node.from, to))
        }
        return
      }
      case 'ListMark': {
        // 有序列表编号保留；无序标记隐藏（吞并其后一个空格）
        const ordered =
          [...path].reverse().find((p) => p.name === 'BulletList' || p.name === 'OrderedList')
            ?.name === 'OrderedList'
        if (ordered) {
          return
        }
        const lineNo = doc.lineAt(node.from).number
        if (!active(lineNo)) {
          const to = node.to < doc.length && doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          out.push(hideDeco.range(node.from, to))
        }
        return
      }
      case 'EmphasisMark': {
        const lineNo = doc.lineAt(node.from).number
        if (!active(lineNo)) {
          out.push(hideDeco.range(node.from, node.to))
        }
        return
      }
      case 'CodeMark': {
        // 仅行内代码的反引号隐藏；围栏 ``` 保留可见
        if (path[path.length - 1]?.name === 'InlineCode') {
          const lineNo = doc.lineAt(node.from).number
          if (!active(lineNo)) {
            out.push(hideDeco.range(node.from, node.to))
          }
        }
        return
      }
      case 'TaskMarker': {
        const lineNo = doc.lineAt(node.from).number
        if (!active(lineNo)) {
          const checked = doc.sliceString(node.from + 1, Math.min(node.from + 2, node.to)) !== ' '
          out.push(taskGlyphDecos[checked ? 1 : 0]!.range(node.from, node.to))
        }
        return
      }
      default:
        return
    }
  })

  for (let i = 0; i < lineCls.length; i++) {
    const set = lineCls[i]
    if (set && set.size > 0) {
      const line = doc.line(fromLine + i)
      out.push(lineDeco([...set].sort().join(' ')).range(line.from))
    }
  }
  return out
}

/** 节点首尾 mark 之间的内容 span */
function pushInnerSpan(
  out: Array<Range<Decoration>>,
  node: SyntaxNode,
  markName: string,
  deco: Decoration,
): void {
  let first: SyntaxNode | null = null
  let last: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === markName) {
      if (!first) {
        first = c
      }
      last = c
    }
  }
  if (first && last && last.from > first.to) {
    out.push(deco.range(first.to, last.from))
  }
}

// ---- 增量观测（单测与性能探针；字段名沿用 #5 的协议通道） ----

const stats = {
  fullBuildLines: 0,
  lastUpdateScannedLines: 0,
  totalUpdates: 0,
  totalScannedLines: 0,
}

export interface HeadingStats {
  fullBuildLines: number
  lastUpdateScannedLines: number
  totalUpdates: number
  totalScannedLines: number
}

export function getHeadingStats(): HeadingStats {
  return { ...stats }
}

// ---- 解析与装饰状态 ----

interface LiveDecoState {
  decos: DecorationSet
  tree: Tree
  fragments: readonly TreeFragment[]
  fm: SourceRange | null
}

function parseTree(doc: Text, fragments?: readonly TreeFragment[]): Tree {
  return markdownTreeParser.parse(docInput(doc), fragments)
}

function frontmatterOf(doc: Text): SourceRange | null {
  // 有界扫描：frontmatter 判定只依赖文档头部（markdownDoc 内限制扫描长度）
  return frontmatterRange(headText(doc))
}

/** 文档头部字符串（frontmatter 判定的输入，有界；截断口径同源 markdownDoc） */
function headText(doc: Text): string {
  return doc.sliceString(0, Math.min(doc.length, FM_SCAN_LIMIT))
}

/** 全量构建（create / 全文替换 / 探针对拍） */
export function buildLivePreviewDecorations(doc: Text, selection: EditorSelection): DecorationSet {
  const tree = parseTree(doc)
  const fm = frontmatterOf(doc)
  stats.fullBuildLines = doc.lines
  return RangeSet.of(emitForRange(tree, doc, selection, fm, 1, doc.lines), true)
}

/** 变更行区间（新文档坐标，行扩展） */
interface LineSpan {
  fromLine: number
  toLine: number
}

interface ChangedRange4 {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

/** 选区驱动的重建行（#5 语义：旧选区行映射 + 新选区行） */
function selectionSpans(tr: Transaction): LineSpan[] {
  const doc = tr.state.doc
  const spans: LineSpan[] = []
  for (const r of tr.startState.selection.ranges) {
    const from = tr.changes.mapPos(r.from, -1)
    const to = tr.changes.mapPos(r.to, 1)
    spans.push({ fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number })
  }
  for (const r of tr.state.selection.ranges) {
    spans.push({ fromLine: doc.lineAt(r.from).number, toLine: doc.lineAt(r.to).number })
  }
  return spans
}

/** 装饰承载节点名（旧侧种子收集用——不含巨型容器，见模块头注释） */
const SEED_NODE_NAMES = new Set([
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
  'HeaderMark', 'EmphasisMark', 'QuoteMark', 'ListMark', 'TaskMarker',
  'Emphasis', 'StrongEmphasis', 'InlineCode', 'HorizontalRule', 'ListItem',
])

/** 分类容器（尾部差异探测用） */
const CONTAINER_NAMES = new Set(['FencedCode', 'CodeBlock', 'Blockquote', 'ListItem'])

/**
 * 一次 docChanged 事务的重建行区间计算：
 * 1. 种子：变更行（新坐标行扩展）+ 旧树相交装饰节点（映射后的行区间）+
 *    选区旧行/新行 + frontmatter 变化时的头块行
 * 2. 容器差异扩展：种子末行的下一行处比较新旧树的容器分类（名字集合与
 *    映射后范围）；分类变化（围栏开闭、列表吸收等）时扩展到容器边界，
 *    迭代至不动点——正常键入在首轮即收敛
 */
function planRebuildSpans(
  tr: Transaction,
  oldTree: Tree,
  newTree: Tree,
  changed: readonly ChangedRange4[],
  oldFm: SourceRange | null,
  newFm: SourceRange | null,
): LineSpan[] {
  const doc = tr.state.doc
  const oldDoc = tr.startState.doc
  const spans: LineSpan[] = []
  const pushSpan = (from: number, to: number): void => {
    if (to < from || from > doc.length) {
      return
    }
    spans.push({
      fromLine: doc.lineAt(Math.min(from, doc.length)).number,
      toLine: doc.lineAt(Math.min(Math.max(to, from), doc.length)).number,
    })
  }
  for (const c of changed) {
    pushSpan(c.fromB, c.toB)
    // 旧侧：变更旧行区间内相交的装饰承载节点 → 映射为新坐标
    const oldFrom = oldDoc.lineAt(Math.min(c.fromA, oldDoc.length)).from
    const oldTo = oldDoc.lineAt(Math.min(c.toA, oldDoc.length)).to
    visitRange(oldTree, oldFrom, oldTo, (node) => {
      if (SEED_NODE_NAMES.has(node.name)) {
        pushSpan(tr.changes.mapPos(node.from, -1), tr.changes.mapPos(node.to, 1))
      }
    })
  }
  // 选区显式变化才扩展重建行（#5 语义：编辑事务的默认选区映射不触发）
  if (tr.selection !== undefined) {
    spans.push(...selectionSpans(tr))
  }

  if (!sameRange(newFm, oldFm)) {
    const lastLine = Math.max(
      newFm ? doc.lineAt(Math.min(newFm.end, doc.length)).number : 0,
      oldFm ? oldDoc.lineAt(Math.min(oldFm.end, oldDoc.length)).number : 0,
    )
    spans.push({ fromLine: 1, toLine: Math.max(1, Math.min(lastLine, doc.lines)) })
  }

  mergeSpans(spans, doc.lines)
  expandSpansByContainerDiff(spans, tr, oldTree, newTree, changed)
  return spans
}

function sameRange(a: SourceRange | null, b: SourceRange | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.start === b.start && a.end === b.end
}

/** 就地合并重叠/相邻区间并裁剪到文档行界 */
function mergeSpans(spans: LineSpan[], totalLines: number): void {
  for (const s of spans) {
    s.fromLine = Math.max(1, Math.min(s.fromLine, totalLines))
    s.toLine = Math.max(1, Math.min(s.toLine, totalLines))
  }
  spans.sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine)
  const merged: LineSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.fromLine <= last.toLine + 1) {
      last.toLine = Math.max(last.toLine, s.toLine)
    } else {
      merged.push({ ...s })
    }
  }
  spans.length = 0
  spans.push(...merged)
}

/** 容器分类差异探测：扩展 spans 至受影响容器边界（迭代至不动点） */
function expandSpansByContainerDiff(
  spans: LineSpan[],
  tr: Transaction,
  oldTree: Tree,
  newTree: Tree,
  changed: readonly ChangedRange4[],
): void {
  const doc = tr.state.doc
  const oldDoc = tr.startState.doc
  const inverted = tr.changes.invertedDesc
  for (let iter = 0; iter < 128 && spans.length > 0; iter++) {
    let grew = false
    for (const span of spans) {
      if (span.toLine >= doc.lines) {
        continue
      }
      const probePos = doc.line(span.toLine + 1).from
      const newChain = chainAt(newTree, probePos)
      const oldPos = Math.min(inverted.mapPos(probePos, -1), oldDoc.length)
      const oldChain = chainAt(oldTree, oldPos)
      const newKinds = new Set(newChain.filter((c) => CONTAINER_NAMES.has(c.name)).map((c) => c.name))
      const oldKinds = new Set(oldChain.filter((c) => CONTAINER_NAMES.has(c.name)).map((c) => c.name))
      let needExpand = !setEquals(newKinds, oldKinds)
      if (!needExpand) {
        // 同名容器范围差异（列表吸收等）：新范围越过映射旧范围且增量不来自变更
        for (const kind of newKinds) {
          const n = newChain.find((c) => c.name === kind)!
          const o = oldChain.find((c) => c.name === kind)!
          const mappedOFrom = tr.changes.mapPos(o.from, -1)
          const mappedOTo = tr.changes.mapPos(o.to, 1)
          if (n.to > mappedOTo && !changedCovers(changed, mappedOTo, n.to)) {
            needExpand = true
            break
          }
          if (n.from < mappedOFrom && !changedCovers(changed, n.from, mappedOFrom)) {
            needExpand = true
            break
          }
        }
      }
      if (!needExpand) {
        continue
      }
      let fromLine = span.fromLine
      let toLine = span.toLine
      for (const c of newChain) {
        if (CONTAINER_NAMES.has(c.name)) {
          fromLine = Math.min(fromLine, doc.lineAt(c.from).number)
          toLine = Math.max(toLine, doc.lineAt(Math.min(c.to, doc.length)).number)
        }
      }
      for (const c of oldChain) {
        if (CONTAINER_NAMES.has(c.name)) {
          fromLine = Math.min(fromLine, doc.lineAt(tr.changes.mapPos(c.from, -1)).number)
          toLine = Math.max(toLine, doc.lineAt(Math.min(tr.changes.mapPos(c.to, 1), doc.length)).number)
        }
      }
      if (toLine > span.toLine || fromLine < span.fromLine) {
        span.fromLine = Math.max(1, fromLine)
        span.toLine = Math.min(doc.lines, toLine)
        grew = true
      }
    }
    if (!grew) {
      return
    }
    mergeSpans(spans, doc.lines)
  }
}

function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false
    }
  }
  return true
}

/** [from, to) 与任一变更区间（新坐标）相交 */
function changedCovers(changed: readonly ChangedRange4[], from: number, to: number): boolean {
  for (const c of changed) {
    if (c.fromB < to && c.toB > from) {
      return true
    }
  }
  return false
}

// ---- StateField ----

export const liveDecorationsField = StateField.define<LiveDecoState>({
  create(state) {
    const tree = parseTree(state.doc)
    const fm = frontmatterOf(state.doc)
    stats.fullBuildLines = state.doc.lines
    return {
      decos: RangeSet.of(emitForRange(tree, state.doc, state.selection, fm, 1, state.doc.lines), true),
      tree,
      fragments: TreeFragment.addTree(tree),
      fm,
    }
  },
  update(value, tr) {
    if (!tr.docChanged && tr.selection === undefined) {
      return value
    }
    if (!tr.docChanged) {
      // 纯选区移动：树不变，仅活动语义重建（#5 的选区联动路径）
      const doc = tr.state.doc
      let decos = value.decos
      let scanned = 0
      for (const span of selectionSpans(tr)) {
        const from = doc.line(span.fromLine).from
        const to = doc.line(span.toLine).to
        decos = decos.update({
          filterFrom: from,
          filterTo: to,
          filter: () => false,
          add: emitForRange(value.tree, doc, tr.state.selection, value.fm, span.fromLine, span.toLine),
          sort: true,
        })
        scanned += span.toLine - span.fromLine + 1
      }
      stats.totalUpdates += 1
      stats.lastUpdateScannedLines = scanned
      stats.totalScannedLines += scanned
      return { ...value, decos }
    }

    const doc = tr.state.doc
    const changed: ChangedRange4[] = []
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      changed.push({ fromA, toA, fromB, toB })
    })
    const fragments = TreeFragment.applyChanges(value.fragments, changed)
    const tree = parseTree(doc, fragments)
    const fmTouched = changed.some((c) => c.fromA < FM_SCAN_LIMIT || c.fromB < FM_SCAN_LIMIT)
    const fm = fmTouched ? frontmatterOf(doc) : value.fm
    const spans = planRebuildSpans(tr, value.tree, tree, changed, value.fm, fm)
    let decos = value.decos.map(tr.changes)
    let scanned = 0
    for (const span of spans) {
      const from = doc.line(span.fromLine).from
      const to = doc.line(span.toLine).to
      decos = decos.update({
        filterFrom: from,
        filterTo: to,
        filter: () => false,
        add: emitForRange(tree, doc, tr.state.selection, fm, span.fromLine, span.toLine),
        sort: true,
      })
      scanned += span.toLine - span.fromLine + 1
    }
    stats.totalUpdates += 1
    stats.lastUpdateScannedLines = scanned
    stats.totalScannedLines += scanned
    if (scanned >= doc.lines) {
      stats.fullBuildLines = doc.lines
    }
    return { decos, tree, fragments: TreeFragment.addTree(tree), fm }
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decos),
})

// ---- 间接装饰（视口内纯样式） ----

/**
 * 间接装饰构建（纯数据输入：doc/visibleRanges/selection/直接装饰集）：
 * 视口内标题行的强调与活动行源码态提示。标题行身份来自直接装饰集
 * （树驱动），围栏内伪标题天然不参与。
 */
export function buildViewportLiveDecorations(
  doc: Text,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  selection: EditorSelection,
  direct: DecorationSet,
): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  for (const range of visibleRanges) {
    direct.between(range.from, range.to, (from, _to, value) => {
      const cls = value.spec['class']
      if (typeof cls !== 'string' || !cls.includes(HEADING_CLASS_NAMES.line) || cls.includes(HEADING_CLASS_NAMES.inview)) {
        return
      }
      const lineNo = doc.lineAt(from).number
      const active = isLineActive(selection, doc, lineNo)
      ranges.push(
        (active ? inviewActiveDeco : inviewDeco).range(doc.line(lineNo).from),
      )
    })
  }
  return RangeSet.of(ranges, true)
}

const inviewDeco = Decoration.line({ class: HEADING_CLASS_NAMES.inview })
const inviewActiveDeco = Decoration.line({
  class: `${HEADING_CLASS_NAMES.inview} ${HEADING_CLASS_NAMES.active}`,
})

/** 间接装饰 ViewPlugin：仅按 visibleRanges 更新，update 内不触发 DOM 测量 */
const viewportLivePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildViewportLiveDecorations(
        view.state.doc,
        view.visibleRanges,
        view.state.selection,
        view.state.field(liveDecorationsField).decos,
      )
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildViewportLiveDecorations(
          update.state.doc,
          update.view.visibleRanges,
          update.state.selection,
          update.state.field(liveDecorationsField).decos,
        )
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** Live Preview 装饰装配：直接（StateField）+ 间接（ViewPlugin） */
export const livePreviewDecorations: Extension = [liveDecorationsField, viewportLivePlugin]
