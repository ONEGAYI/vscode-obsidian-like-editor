// 标题实时预览装饰（工单 #5 切片，#8 完整双模式显示的第一个纵向切片）。
//
// 架构（依据 ADR-0005、探索笔记 03 §5、mvp.md「MVP 性能契约」）：
// - 直接装饰（影响块高度）→ StateField 常驻 RangeSet：标题行的字号/字重
//   变化会改变行高，`#` 标记的 replace 隐藏在 lineWrapping 下也可能改变
//   折行数——两者都影响纵向块结构，CM6 高度系统要求它们整篇存在且随事务
//   增量维护，不能只按视口提供
// - 间接装饰（纯视口内）→ ViewPlugin 按 visibleRanges 计算：视口内标题的
//   强调样式与活动行源码态提示（纯颜色/边框，不改变高度），视口外不维护
// - 增量策略：正常键入只重扫受影响行（docChanged 的变更行 + 选区移动的
//   旧行/新行），整篇重建仅发生在 create 与全文替换（init/resync，性能
//   契约允许的必要初始化）；RangeSet.map 负责把既有装饰平移到新坐标，
//   每次键入不重新解析全文文本
// - 布局约束：间接装饰构建器只接收纯数据（doc/visibleRanges/selection），
//   不触碰 view/DOM 测量——在 view update 内同步读 DOM 才是布局循环的
//   根源，这里从类型上排除该路径
//
// 类名约定（#6 稳定样式入口，风格沿 `oile-` 前缀）：
// - oile-heading-line / oile-heading-line-{1..6}：直接装饰（标题行本体）
// - oile-heading-inview：间接装饰（视口内标题强调）
// - oile-heading-active：间接装饰（光标所在标题行的源码态提示）
import {
  EditorSelection,
  RangeSet,
  StateField,
  Text,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

/** 标题行判定结果：level 为 1-6，markerEnd 为行首标记（# 及其后的一个空格）长度 */
export interface HeadingLineInfo {
  level: 1 | 2 | 3 | 4 | 5 | 6
  markerEnd: number
}

/**
 * 行首 `#` 语法的行级判定（切片范围，#8 引入 Markdown 解析后由其取代）：
 * - 仅行首（不含缩进）的 1-6 个 `#`，后接一个空格或行尾
 * - 不处理代码块围栏内的伪标题（无语法解析，记录为切片限制）
 */
export function parseHeadingLine(lineText: string): HeadingLineInfo | null {
  const m = /^(#{1,6})( |$)/.exec(lineText)
  if (!m) {
    return null
  }
  const hashes = m[1].length
  return { level: hashes as HeadingLineInfo['level'], markerEnd: hashes + (m[2] ? 1 : 0) }
}

/** 稳定类名常量：一期 CSS 契约入口（ADR-0004） */
export const HEADING_CLASS_NAMES = {
  line: 'oile-heading-line',
  level: (lv: number) => `oile-heading-line-${lv}`,
  inview: 'oile-heading-inview',
  active: 'oile-heading-active',
} as const

// ---- 装饰实例缓存：增量与全量构建产出相同实例，使 RangeSet.eq 的值比较成立 ----
const lineDecos = [1, 2, 3, 4, 5, 6].map(
  (lv) => Decoration.line({ class: `${HEADING_CLASS_NAMES.line} ${HEADING_CLASS_NAMES.level(lv)}` }),
)
const hideMarkerDeco = Decoration.replace({})
const inviewDeco = Decoration.line({ class: HEADING_CLASS_NAMES.inview })
const inviewActiveDeco = Decoration.line({
  class: `${HEADING_CLASS_NAMES.inview} ${HEADING_CLASS_NAMES.active}`,
})

/** 行是否被选区覆盖（任一 range 的行区间覆盖该行即视为活动，显示源码） */
function isLineActive(selection: EditorSelection, doc: Text, lineNumber: number): boolean {
  for (const r of selection.ranges) {
    if (doc.lineAt(r.from).number <= lineNumber && lineNumber <= doc.lineAt(r.to).number) {
      return true
    }
  }
  return false
}

/** 为 [fromLine, toLine] 内的标题行生成直接装饰（行级样式 + 非活动行隐藏标记） */
function headingRangesForLines(
  doc: Text,
  selection: EditorSelection,
  fromLine: number,
  toLine: number,
): Array<Range<typeof lineDecos[number]>> {
  const ranges: Array<Range<Decoration>> = []
  for (let n = fromLine; n <= toLine; n++) {
    const line = doc.line(n)
    const info = parseHeadingLine(line.text)
    if (!info) {
      continue
    }
    ranges.push(lineDecos[info.level - 1].range(line.from))
    if (!isLineActive(selection, doc, n)) {
      ranges.push(hideMarkerDeco.range(line.from, line.from + info.markerEnd))
    }
  }
  return ranges
}

/**
 * 直接装饰整篇构建（create 与探针/对拍用）：扫描全部行。
 * 输出装饰实例为模块级缓存实例，相同文档/选区的增量结果可与之 eq 相等。
 */
export function buildHeadingDecorations(doc: Text, selection: EditorSelection): DecorationSet {
  stats.fullBuildLines = doc.lines
  return RangeSet.of(headingRangesForLines(doc, selection, 1, doc.lines), true)
}

/** 需要重建装饰的行区间（行号，基于事务后文档） */
export interface HeadingRebuildSpan {
  fromLine: number
  toLine: number
}

/**
 * 增量重建计划：一次事务后哪些行需要重新判定标题与活动性。
 * - docChanged：每个变更区间扩到整行（新文档坐标），键入通常只命中 1 行
 * - selectionSet：旧选区行（map 到新文档）与新选区行——标题行的源码态
 *   （是否隐藏 `#` 标记）依赖选区，选区移动只需重判旧行与新行；
 *   选区跨行展开时中间的标题行也要重判，区间按选区范围展开（该成本由
 *   选区语义决定，且不属于每次键入路径）
 * - 输出按行号排序并合并重叠/相邻区间
 */
export function planHeadingRebuild(tr: Transaction): HeadingRebuildSpan[] {
  const spans: HeadingRebuildSpan[] = []
  const doc = tr.state.doc
  if (tr.docChanged) {
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      spans.push({
        fromLine: doc.lineAt(fromB).number,
        toLine: doc.lineAt(toB).number,
      })
    })
  }
  // Transaction 无 selectionSet 属性（那是 ViewUpdate 的）：显式携带选区
  // （tr.selection 非 undefined）即视为选区变化
  if (tr.selection !== undefined) {
    for (const r of tr.startState.selection.ranges) {
      const from = tr.changes.mapPos(r.from, -1)
      const to = tr.changes.mapPos(r.to, 1)
      spans.push({ fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number })
    }
    for (const r of tr.state.selection.ranges) {
      spans.push({ fromLine: doc.lineAt(r.from).number, toLine: doc.lineAt(r.to).number })
    }
  }
  if (spans.length === 0) {
    return []
  }
  spans.sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine)
  const merged: HeadingRebuildSpan[] = [spans[0]]
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1]
    if (s.fromLine <= last.toLine + 1) {
      last.toLine = Math.max(last.toLine, s.toLine)
    } else {
      merged.push({ ...s })
    }
  }
  return merged
}

/** 增量观测（单测与性能探针）：键入路径的重扫行数应与文档体量无关 */
const stats = {
  fullBuildLines: 0,
  lastUpdateScannedLines: 0,
  totalUpdates: 0,
  totalScannedLines: 0,
}

export interface HeadingStats {
  /** 最近一次全量构建扫描的行数 */
  fullBuildLines: number
  /** 最近一次事务增量重扫的行数 */
  lastUpdateScannedLines: number
  totalUpdates: number
  totalScannedLines: number
}

export function getHeadingStats(): HeadingStats {
  return { ...stats }
}

/**
 * 直接装饰 StateField：整篇常驻 + 事务增量维护。
 * - 既有装饰先经 RangeSet.map 平移坐标（装饰级操作，不解析文本）
 * - 计划区间内的装饰全部移除并按新文本/新选区重建（filter+add 一次完成）
 * - 全文替换（init/doc.resync）的计划天然覆盖全篇，退化为整篇重建——
 *   属性能契约允许的必要初始化与重同步
 */
export const headingField = StateField.define<DecorationSet>({
  create(state) {
    return buildHeadingDecorations(state.doc, state.selection)
  },
  update(value, tr) {
    if (!tr.docChanged && tr.selection === undefined) {
      return value
    }
    let result = tr.docChanged ? value.map(tr.changes) : value
    const spans = planHeadingRebuild(tr)
    let scanned = 0
    for (const span of spans) {
      const fromPos = tr.state.doc.line(span.fromLine).from
      const toPos = tr.state.doc.line(span.toLine).to
      const add = headingRangesForLines(tr.state.doc, tr.state.selection, span.fromLine, span.toLine)
      result = result.update({
        filterFrom: fromPos,
        filterTo: toPos,
        filter: () => false,
        // add 必须是 Range 数组（sort 交由 RangeSet.update 处理，
        // point 与 range 同位置的次序由其 startSide 比较保证）
        add,
        sort: true,
      })
      scanned += span.toLine - span.fromLine + 1
    }
    stats.totalUpdates += 1
    stats.lastUpdateScannedLines = scanned
    stats.totalScannedLines += scanned
    // 计划覆盖全篇（init/doc.resync 的全文替换）即为一次全量构建——
    // 性能契约允许的必要初始化与重同步，计入 fullBuild 观测
    if (scanned >= tr.state.doc.lines) {
      stats.fullBuildLines = tr.state.doc.lines
    }
    return result
  },
  provide: (f) => EditorView.decorations.from(f),
})

/**
 * 间接装饰构建（纯数据输入，无 view/DOM——布局循环在类型层面排除）：
 * 只为 visibleRanges 内的标题行生成纯样式装饰（不改高度）。
 */
export function buildViewportHeadingDecorations(
  doc: Text,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  selection: EditorSelection,
): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  for (const range of visibleRanges) {
    const fromLine = doc.lineAt(range.from).number
    const toLine = doc.lineAt(range.to).number
    for (let n = fromLine; n <= toLine; n++) {
      const line = doc.line(n)
      if (!parseHeadingLine(line.text)) {
        continue
      }
      ranges.push(
        (isLineActive(selection, doc, n) ? inviewActiveDeco : inviewDeco).range(line.from),
      )
    }
  }
  return RangeSet.of(ranges, true)
}

/** 间接装饰 ViewPlugin：仅按 visibleRanges 更新，update 内不触发任何 DOM 测量 */
const viewportHeadingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildViewportHeadingDecorations(
        view.state.doc,
        view.visibleRanges,
        view.state.selection,
      )
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildViewportHeadingDecorations(
          update.state.doc,
          update.view.visibleRanges,
          update.state.selection,
        )
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** 标题装饰装配：直接（StateField）+ 间接（ViewPlugin） */
export const headingDecorations: Extension = [headingField, viewportHeadingPlugin]
