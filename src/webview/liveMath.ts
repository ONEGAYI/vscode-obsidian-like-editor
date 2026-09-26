// Live 视图公式装饰（工单 #59）：照 liveLinks.ts 的双层模式——
// - mathBlocksField（StateField）：跨行 `$$` 块表，create 全量扫描、
//   update 增量重建（种子 = 变更区间 ∪ 相交旧块，向上回溯固定窗口
//   MATH_BLOCK_LOOKBACK_LINES 起步；纯选区移动不触发重扫）
// - ViewPlugin（visibleRanges）：视口行内扫描（$…$、段内 $$、行首单行
//   $$）+ 块表与视口相交的跨行块，逐条按 selectionTouchesRange 切换
//   「源码态 mark」与「渲染态 replace widget」（光标进入公式范围显源码、
//   离开恢复排版——与链接/双链同语义）
//
// ---- 渲染（KaTeX）与降级 ----
// - renderMathHtml 结果按 `tex + displayMode` 缓存（LRU，共享模块
//   mathRenderCache——live 与阅读两通道同一缓存；#59 评审 C2），击键与
//   视口滚动不重渲染；widget 装饰实例同样按参数缓存（RangeSet.eq 前提）
// - 解析失败（renderMathHtml 返回 null）→ widget 显示原文（vsidian-math-error
//   样式化降级，源文不丢、邻近内容不受影响、光标进入仍可编辑）
//
// 代码上下文抑制：行内出现查 chainAt（照 #11 双链先例）；跨行块要求整个
// 区间不与围栏/缩进代码节点相交（块中段混入 fence 时 live 显源码降级——
// markdown-it 对该形态的解析可能渲染公式，降级方向安全，差异记录于
// docs/perf/2026-09-math-rendering.md）。
//
// 已知限制：跨行块超过 MATH_BLOCK_LOOKBACK_LINES（512 行）回溯窗口时，
// 远端击键后的增量重建可能暂时漏配对（live 显源码），文档装载/resync 的
// 全量扫描恢复——降级方向安全；未闭合块的向下延伸在 MATH_BLOCK_EXTEND_LIMIT
// 行后熔断（超长闭合同理漏配对）。
import { EditorSelection, RangeSet, StateField, type Extension, type Range, type Text, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import type { Tree } from '@lezer/common'
import { chainAt, visitRange, type SourceRange } from './markdownDoc'
import { liveDecorationsField, selectionTouchesRange } from './liveDecorations'
import { MATH_CLASS_NAMES, opensMathBlockLine, scanMathInLine, scanMathRanges, type MathOccurrence } from '../shared/math'
import { MATH_RENDER_CACHE_LIMIT, mathRenderStats, renderMathHtml } from './mathRenderCache'
import { t } from '../shared/i18n'

export { MATH_RENDER_CACHE_LIMIT, mathRenderStats, renderMathHtml }

/** 块表增量重建的向上回溯窗口（行）：覆盖绝大多数跨行块的开启定界符；
 *  超长块的远端击键按已知限制降级（见模块头注释） */
export const MATH_BLOCK_LOOKBACK_LINES = 512

/** 未闭合块向下延伸的熔断上限（行）：超过后停止延伸（#59 评审 C3），
 *  超长闭合的块增量窗口漏配对 → live 显源码，全量扫描恢复 */
export const MATH_BLOCK_EXTEND_LIMIT = 4096

/** 延伸批大小（行）：每批 concat 后增量续扫新行段 */
const MATH_BLOCK_EXTEND_BATCH = 256

/** 最近一次块表重建执行的延伸批次数（测试观测面：钉住熔断真实发生且
 *  批次有界——块表空结果无法区分「熔断停止」与「从未延伸」） */
export const mathBlockExtendStats = { batches: 0 }

const mathSourceDeco = Decoration.mark({ class: MATH_CLASS_NAMES.mathSource })

// ---- widget 与装饰实例缓存 ----

/**
 * live 公式 widget：光标在范围外时把 `$…$` / `$$…$$` 整体替换为 KaTeX
 * 排版（或失败时的原文降级 span）。displayMode 声明一个视觉行（跨行源
 * 折叠后的行高估算依据，照表格 TableCellBreakWidget 的 lineBreaks 先例）。
 */
export class LiveMathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly displayMode: boolean,
  ) {
    super()
  }

  eq(other: LiveMathWidget): boolean {
    return other.tex === this.tex && other.displayMode === this.displayMode
  }

  get lineBreaks(): number {
    return this.displayMode ? 1 : 0
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    const html = renderMathHtml(this.tex, this.displayMode)
    if (html === null) {
      span.className = MATH_CLASS_NAMES.mathError
      span.title = t('decor.mathError')
      span.textContent = this.displayMode ? `$$${this.tex}$$` : `$${this.tex}$`
      return span
    }
    span.className = this.displayMode
      ? `${MATH_CLASS_NAMES.math} ${MATH_CLASS_NAMES.mathBlock}`
      : MATH_CLASS_NAMES.math
    span.dataset['vsidianRenderedMath'] = 'true'
    span.innerHTML = html
    return span
  }

  ignoreEvent(): boolean {
    return false // 交给 CM6：光标定位与编辑入口
  }
}

const widgetDecoCache = new Map<string, ReturnType<typeof Decoration.replace>>()

/** replace widget 装饰实例缓存（同 tex+displayMode 复用，RangeSet.eq 成立） */
export function mathWidgetDeco(tex: string, displayMode: boolean): ReturnType<typeof Decoration.replace> {
  const key = `${displayMode ? 'D' : 'I'}\u0000${tex}`
  const hit = widgetDecoCache.get(key)
  if (hit) {
    return hit
  }
  const deco = Decoration.replace({ widget: new LiveMathWidget(tex, displayMode) })
  widgetDecoCache.set(key, deco)
  while (widgetDecoCache.size > MATH_RENDER_CACHE_LIMIT) {
    const oldest = widgetDecoCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    widgetDecoCache.delete(oldest)
  }
  return deco
}

// ---- 跨行块表（StateField 增量维护） ----

/** 全文档行数组（块表全量扫描用；文本较短时才复制，长文本走增量路径） */
function docLines(doc: Text): string[] {
  const out: string[] = []
  for (let i = 1; i <= doc.lines; i++) {
    out.push(doc.line(i).text)
  }
  return out
}

/** 全量扫描：只保留跨行块（单行形态由 ViewPlugin 行扫描负责——屏外不装饰） */
function scanAllBlocks(doc: Text): readonly MathOccurrence[] {
  return scanMathRanges(docLines(doc), 0).filter((hit) =>
    doc.lineAt(hit.from).number !== doc.lineAt(hit.to - 1).number)
}

/**
 * 增量重建块表：种子 = 变更区间（新坐标）∪ 映射后与之相交的旧块；起点
 * 向上回溯 MATH_BLOCK_LOOKBACK_LINES 行（覆盖种子前开启的块定界符）；
 * 终点延伸到种子末行行尾，末尾仍在块中时继续到闭合或文末。
 * 重扫区间外的旧块（坐标已映射）原样保留。
 */
function rebuildBlocks(
  prev: readonly MathOccurrence[],
  tr: Transaction,
): readonly MathOccurrence[] {
  const changes = tr.changes
  const doc = tr.state.doc
  let seedFrom = doc.length + 1
  let seedTo = -1
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    seedFrom = Math.min(seedFrom, fromB)
    seedTo = Math.max(seedTo, toB)
  })
  if (seedTo < 0) {
    return prev
  }
  const mapped = prev.map((b) => ({
    from: changes.mapPos(b.from, 1),
    to: changes.mapPos(b.to, -1),
    hit: b,
  }))
  for (const b of mapped) {
    if (b.to >= seedFrom && b.from <= seedTo) {
      seedFrom = Math.min(seedFrom, b.from)
      seedTo = Math.max(seedTo, b.to)
    }
  }
  const firstLine = Math.max(1, doc.lineAt(Math.min(seedFrom, doc.length)).number - MATH_BLOCK_LOOKBACK_LINES)
  let lastLine = doc.lineAt(Math.min(Math.max(seedTo, 0), doc.length)).number
  // 先取种子范围行；末尾处于未闭合块中时延伸到闭合或文末
  const collectLines = (fromLine: number, toLine: number): string[] => {
    const out: string[] = []
    for (let i = fromLine; i <= toLine; i++) {
      out.push(doc.line(i).text)
    }
    return out
  }
  let lines = collectLines(firstLine, lastLine)
  // 末尾处于未闭合块中时延伸到闭合、文末或熔断上限；扫描按增量续扫
  // （只扫新 concat 的行段，open 状态延续）——从零重扫会让未闭合长尾
  // 呈平方级成本（#59 评审 C3）
  let openFrom = scanOpenIncrement(lines, 0, null)
  let scanned = lines.length
  let extended = 0
  mathBlockExtendStats.batches = 0
  while (openFrom !== null && lastLine < doc.lines && extended < MATH_BLOCK_EXTEND_LIMIT) {
    const nextLast = Math.min(lastLine + MATH_BLOCK_EXTEND_BATCH, doc.lines)
    lines = lines.concat(collectLines(lastLine + 1, nextLast))
    lastLine = nextLast
    extended += MATH_BLOCK_EXTEND_BATCH
    mathBlockExtendStats.batches += 1
    openFrom = scanOpenIncrement(lines, scanned, openFrom)
    scanned = lines.length
  }
  const start = doc.line(firstLine).from
  const end = doc.line(lastLine).to
  const rebuilt = scanMathRanges(lines, start).filter((hit) =>
    doc.lineAt(hit.from).number !== doc.lineAt(hit.to - 1).number)
  // 合并：重扫区间 [start, end] 外的旧块保留（坐标已映射）
  const out: MathOccurrence[] = []
  for (const b of mapped) {
    if (b.to <= start || b.from >= end) {
      out.push({ from: b.from, to: b.to, kind: b.hit.kind, tex: b.hit.tex })
    }
  }
  out.push(...rebuilt)
  out.sort((a, b) => a.from - b.from)
  return out
}

/** 块开启状态的行序列续扫（#59 评审 C3 增量化 + B-4/C4 谓词统一）：
 *  open 为 [0, fromIndex) 已扫部分的未闭合块开启行号（或 null），只扫
 *  新增行段并返回新的开启行号——scanMathRanges 不产出未闭合块，此处
 *  单独判定以驱动重建范围的延伸。开启判定与 scanMathRanges 共用
 *  opensMathBlockLine（shared/math.ts 单一事实源）。 */
function scanOpenIncrement(lines: readonly string[], fromIndex: number, open: number | null): number | null {
  for (let i = fromIndex; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    if (open === null) {
      if (opensMathBlockLine(trimmed)) {
        open = i
      }
    } else if (trimmed.includes('$$')) {
      open = null
    }
  }
  return open
}

/** 跨行块表（#59）：docChanged 时增量重建；选区/视口变化零成本 */
export const mathBlocksField = StateField.define<readonly MathOccurrence[]>({
  create(state) {
    return scanAllBlocks(state.doc)
  },
  update(value, tr) {
    if (!tr.docChanged) {
      return value
    }
    return rebuildBlocks(value, tr)
  },
})

// ---- 视口装饰构建 ----

/** 公式排除的代码上下文（lezer 节点名；照 #11 双链先例） */
const MATH_CODE_CONTEXTS = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'CodeMark',
  'CodeInfo',
  'InlineCode',
])

/** occurrence 是否处于代码上下文或 frontmatter 内（源码降级边界）。
 *  跨行块额外要求区间不与围栏/缩进代码节点相交。 */
function mathSuppressed(doc: Text, tree: Tree, hit: MathOccurrence, fm: SourceRange | null): boolean {
  if (fm && hit.from < fm.end) {
    return true
  }
  for (const node of chainAt(tree, hit.from)) {
    if (MATH_CODE_CONTEXTS.has(node.name)) {
      return true
    }
  }
  if (doc.lineAt(hit.from).number !== doc.lineAt(Math.max(hit.from, hit.to - 1)).number) {
    let fence = false
    visitRange(tree, hit.from, hit.to, (node) => {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        fence = true
      }
    })
    if (fence) {
      return true
    }
  }
  return false
}

/**
 * 构建视口内行内公式装饰（#59 契约入口；纯数据输入，可单测直驱）：
 * 行内 `$…$`、段内 `$$…$$`、行首单行 `$$x$$` 限视口行（屏外不物化）；
 * 光标/选区触及公式范围 → 源码态 mark；范围外 → replace widget。
 * 跨行块的装饰走 mathBlockDecorations（StateField）——CM6 不允许插件
 * 装饰集包含跨行 replace。
 */
export function buildMathDecorationRanges(
  doc: Text,
  tree: Tree,
  selection: EditorSelection,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  fm: SourceRange | null,
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  const seenLines = new Set<number>()
  for (const range of visibleRanges) {
    let pos = range.from
    while (pos < range.to) {
      const line = doc.lineAt(pos)
      if (!seenLines.has(line.number)) {
        seenLines.add(line.number)
        for (const hit of scanMathInLine(line.text, line.from)) {
          emitMathHit(out, doc, tree, hit, selection, fm)
        }
      }
      if (line.to >= range.to) {
        break
      }
      pos = line.to + 1
    }
  }
  return out
}

/** 单条 occurrence → 装饰（显形/渲染切换与代码上下文抑制的共用出口） */
function emitMathHit(
  out: Array<Range<Decoration>>,
  doc: Text,
  tree: Tree,
  hit: MathOccurrence,
  selection: EditorSelection,
  fm: SourceRange | null,
): void {
  if (mathSuppressed(doc, tree, hit, fm)) {
    return
  }
  if (selectionTouchesRange(selection, hit.from, hit.to)) {
    out.push(mathSourceDeco.range(hit.from, hit.to))
  } else {
    out.push(mathWidgetDeco(hit.tex, hit.kind === 'block').range(hit.from, hit.to))
  }
}

/**
 * 跨行块装饰（StateField，#59）：CM6 约束——跨行 replace 只能由 field
 * 提供。全文档块表逐块发射，widget DOM 由 CM6 按视口惰性创建（屏外
 * 不物化）；docChanged/selectionSet 时重建（块表增量由 mathBlocksField
* 承担，此处仅做逐块映射，成本 O(块数)）。
 */
function buildMathBlockDecorationRanges(
  doc: Text,
  tree: Tree,
  selection: EditorSelection,
  fm: SourceRange | null,
  blocks: readonly MathOccurrence[],
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  for (const hit of blocks) {
    emitMathHit(out, doc, tree, hit, selection, fm)
  }
  return out
}

export const mathBlockDecorations = StateField.define<DecorationSet>({
  create(state) {
    const field = state.field(liveDecorationsField, false)
    if (!field) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildMathBlockDecorationRanges(
        state.doc,
        field.tree,
        state.selection,
        field.fm,
        state.field(mathBlocksField),
      ),
      true,
    )
  },
  update(value, tr) {
    // Transaction 没有 selectionSet（那是 ViewUpdate 的属性）：以显式
    // selection 判定选区变化（liveDecorationsField 同款口径）
    if (!tr.docChanged && tr.selection === undefined) {
      return value
    }
    const field = tr.state.field(liveDecorationsField, false)
    if (!field) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildMathBlockDecorationRanges(
        tr.state.doc,
        field.tree,
        tr.state.selection,
        field.fm,
        tr.state.field(mathBlocksField),
      ),
      true,
    )
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** live 公式扩展装配（照 livePreviewDecorations 的数组常量形态）：
 *  跨行块表 StateField + 跨行块装饰 StateField + 行内视口装饰 ViewPlugin */
export const liveMath: Extension = [
  mathBlocksField,
  mathBlockDecorations,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(update: import('@codemirror/view').ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = this.build(update.view)
        }
      }
      private build(view: EditorView): DecorationSet {
        const field = view.state.field(liveDecorationsField, false)
        if (!field) {
          return RangeSet.empty
        }
        return RangeSet.of(
          buildMathDecorationRanges(
            view.state.doc,
            field.tree,
            view.state.selection,
            view.visibleRanges,
            field.fm,
          ),
          true,
        )
      }
    },
    { decorations: (plugin) => plugin.decorations },
  ),
]
