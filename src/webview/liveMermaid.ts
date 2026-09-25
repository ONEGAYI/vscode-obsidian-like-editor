// Live 视图 Mermaid 装饰（工单 #60）：照 liveMath.ts 的双层模式——
// - mermaidFencesField（StateField）：全文档围栏表（含非 mermaid 围栏，
//   供嵌套伪围栏抑制与增量窗口定位复用），create 全量扫描、update 增量
//   重建（种子 = 变更区间 ∪ 相交旧围栏；窗口起点回溯到变更前最后一个已
//   闭合围栏之后——已知顶层起点，扫描天然精确；无锚点围栏时自种子首行
//   回溯 MERMAID_FENCE_LOOKBACK_LINES 行起步，并以文末开放围栏开启行
//   （trailingOpenStart）为窗口下界——否则窗口可落在长开放围栏中部，
//   内容行的 ``` 被当开启符产出幻影 span；纯选区移动不触发重扫）
// - mermaidDecorations（StateField）：跨行块 replace 装饰（CM6 硬约束：
//   跨行 replace 必须来自 StateField 而非插件装饰集，#59 已踩过）；逐围栏
//   按 selectionTouchesRange 切换——光标/选区触及围栏区间时不发射（源码
//   显形可编辑，既有 code-line 装饰继续生效），离开恢复渲染 widget
//
// 渲染与降级（mermaidRender.ts）：
// - widget toDOM 产出稳定类名容器并携带源码 data 属性，异步渲染（缓存
//   优先）；语法失败进 error 态（错误信息 + 源码可读，光标进入仍可编辑）
// - 装饰实例按源码 LRU 缓存（同码复用，RangeSet.eq 前提）
//
// 抑制边界：frontmatter 内围栏不渲染（源码降级）；伪围栏（外层长围栏内、
// 缩进 ≥4 视觉列）由围栏状态机天然不产出。已知差异（shared/mermaid.ts
// 头注释）：引用行（> ```mermaid）live 不识别、阅读渲染——降级方向安全。
import { RangeSet, StateField, type Extension, type Range, type Text, type Transaction } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { liveDecorationsField, selectionTouchesRange } from './liveDecorations'
import { renderMermaidInto } from './mermaidRender'
import {
  MERMAID_CLASS_NAMES,
  MERMAID_CODE_ATTR,
  MERMAID_STATE_ATTR,
  scanFencesDetailed,
  type FenceSpan,
} from '../shared/mermaid'

/** 无锚点围栏时的增量回溯窗口（行）：覆盖绝大多数围栏的开启行；更长围栏
 *  的远端击键按已知限制降级（文档装载/resync 的全量扫描恢复） */
export const MERMAID_FENCE_LOOKBACK_LINES = 2048

/** 未闭合围栏向下延伸的熔断上限（行）：超过后停止延伸（照 #59 公式块表
 *  MATH_BLOCK_EXTEND_LIMIT 形态），超长围栏的增量重建漏配对 → live 显
 *  源码，文档装载/resync 的全量扫描恢复——降级方向安全 */
export const MERMAID_FENCE_EXTEND_LIMIT = 8192

/** 延伸批大小（行）：每批只对新增行段续扫（开放状态延续），不重扫窗口 */
const MERMAID_FENCE_EXTEND_BATCH = 256

/** 最近一次围栏表重建执行的延伸批次数（测试观测面：钉住熔断真实发生且
 *  批次有界——表空结果无法区分「熔断停止」与「从未延伸」） */
export const mermaidFenceExtendStats = { batches: 0 }

/** 装饰实例缓存上限（键是图源码；与渲染缓存同量级） */
export const MERMAID_DECO_CACHE_LIMIT = 64

// ---- widget 与装饰实例缓存 ----

/**
 * live Mermaid widget：光标在围栏外时把整个 mermaid 围栏替换为渲染容器
 * （异步渲染，先占位后填充——照 LiveImageWidget 两段式先例）。lineBreaks
 * 声明 1 个视觉行（块级折叠的行高估算依据，照表格/公式块先例）。
 */
export class LiveMermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }

  eq(other: LiveMermaidWidget): boolean {
    return other.code === this.code
  }

  get lineBreaks(): number {
    return 1
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = MERMAID_CLASS_NAMES.diagram
    div.setAttribute(MERMAID_CODE_ATTR, this.code)
    div.setAttribute(MERMAID_STATE_ATTR, 'pending')
    renderMermaidInto(div, this.code)
    return div
  }

  ignoreEvent(): boolean {
    return false // 交给 CM6：光标定位与编辑入口
  }
}

const decoCache = new Map<string, ReturnType<typeof Decoration.replace>>()

/** replace widget 装饰实例缓存（同源码复用，RangeSet.eq 成立） */
export function mermaidWidgetDeco(code: string): ReturnType<typeof Decoration.replace> {
  const hit = decoCache.get(code)
  if (hit) {
    return hit
  }
  const deco = Decoration.replace({ widget: new LiveMermaidWidget(code) })
  decoCache.set(code, deco)
  while (decoCache.size > MERMAID_DECO_CACHE_LIMIT) {
    const oldest = decoCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    decoCache.delete(oldest)
  }
  return deco
}

// ---- 围栏表（StateField 增量维护） ----

function docLines(doc: Text): string[] {
  const out: string[] = []
  for (let i = 1; i <= doc.lines; i++) {
    out.push(doc.line(i).text)
  }
  return out
}

/**
 * 全文档围栏表（StateField 值形态）：已闭合围栏列表 + 文末开放围栏的
 * 开启行行首 offset（trailingOpenStart，或 null）。后者是无锚点回溯窗口
 * 的正确性锚——窗口起点可落在长开放围栏中部，若不知晓窗口外的开放
 * 状态，内容行里的 ``` 会被当开启符，产出全量扫描不存在的幻影 span
 * （若 info 为 mermaid 即误渲染为图且随编辑自我稳定）。
 */
export interface MermaidFenceTable {
  spans: readonly FenceSpan[]
  /** 上次扫描记录的未闭合围栏开启行行首 offset（文末开放时非 null；
 *  仅覆盖到文末的扫描（create / 延伸到文末）拥有终态话语权，未覆盖
 *  文末的窗口重建保留映射后的旧值——失效值最坏导致多扫，不产幻影） */
  trailingOpenStart: number | null
}

/**
 * 增量重建围栏表：种子 = 变更区间（新坐标）∪ 映射后与之相交的旧围栏；
 * 扫描起点 = 变更前最后一个已闭合围栏的行尾之后（该处已知为顶层状态，
 * 前向扫描精确）；无锚点时自种子区间首行回溯 MERMAID_FENCE_LOOKBACK_LINES
 * 行起步，且若已知文末开放围栏（trailingOpenStart）在窗口之前，窗口
 * 起点下移到其开启行——从开启行重扫等价于以「已处于开放围栏」状态起步，
 * 幻影围栏不产生且闭合时 code 完整。窗口尾部仍处开放围栏时按批增量续扫
 * （只扫新行段、开放状态延续）到闭合、文末或熔断上限。窗口外的旧围栏
 * 坐标已映射，原样保留。
 */
function rebuildFences(prev: MermaidFenceTable, tr: Transaction): MermaidFenceTable {
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
  const mapped = prev.spans.map((s) => ({
    from: changes.mapPos(s.from, 1),
    to: changes.mapPos(s.to, -1),
    span: s,
  }))
  for (const m of mapped) {
    if (m.to >= seedFrom && m.from <= seedTo) {
      seedFrom = Math.min(seedFrom, m.from)
      seedTo = Math.max(seedTo, m.to)
    }
  }
  // 扫描起点：种子前最后一个已闭合围栏之后（顶层锚点）；无锚点自种子
  // 首行回溯起步，并以已知文末开放围栏的开启行为窗口下界
  let anchorEnd = -1
  for (const m of mapped) {
    if (m.to < seedFrom) {
      anchorEnd = Math.max(anchorEnd, m.to)
    }
  }
  const prevOpenMapped = prev.trailingOpenStart !== null
    ? changes.mapPos(prev.trailingOpenStart, 1)
    : null
  let firstLine: number
  if (anchorEnd >= 0) {
    firstLine = doc.lineAt(Math.min(Math.max(anchorEnd + 1, 0), doc.length)).number
  } else {
    firstLine = Math.max(
      1,
      doc.lineAt(Math.min(Math.max(seedFrom, 0), doc.length)).number - MERMAID_FENCE_LOOKBACK_LINES,
    )
    if (prevOpenMapped !== null && prevOpenMapped < doc.line(firstLine).from) {
      firstLine = doc.lineAt(Math.min(Math.max(prevOpenMapped, 0), doc.length)).number
    }
  }
  let lastLine = doc.lineAt(Math.min(Math.max(seedTo, 0), doc.length)).number
  const collectLines = (fromLine: number, toLine: number): string[] => {
    const out: string[] = []
    for (let i = fromLine; i <= toLine; i++) {
      out.push(doc.line(i).text)
    }
    return out
  }
  let lines = collectLines(firstLine, lastLine)
  let scan = scanFencesDetailed(lines, doc.line(firstLine).from)
  // 尾部开放围栏：按批增量续扫（只扫新行段，开放状态延续——从零重扫
  // 会让未闭合长尾呈平方级成本）到闭合、文末或熔断上限
  let extended = 0
  mermaidFenceExtendStats.batches = 0
  while (scan.open !== null && lastLine < doc.lines && extended < MERMAID_FENCE_EXTEND_LIMIT) {
    const nextLast = Math.min(lastLine + MERMAID_FENCE_EXTEND_BATCH, doc.lines)
    const batch = collectLines(lastLine + 1, nextLast)
    const batchStart = doc.line(lastLine + 1).from
    lastLine = nextLast
    extended += MERMAID_FENCE_EXTEND_BATCH
    mermaidFenceExtendStats.batches += 1
    const more = scanFencesDetailed(batch, batchStart, scan.open)
    scan = { spans: scan.spans.concat(more.spans), open: more.open }
  }
  // 文末开放状态：覆盖到文末（或熔断时保守取当前开放起点——宁多扫不漏记）
  let trailingOpenStart: number | null = prevOpenMapped
  if (scan.open !== null) {
    trailingOpenStart = scan.open.from
  } else if (lastLine >= doc.lines) {
    trailingOpenStart = null
  }
  const windowStart = doc.line(firstLine).from
  const windowEnd = doc.line(lastLine).to
  const out: FenceSpan[] = []
  for (const m of mapped) {
    if (m.to <= windowStart || m.from > windowEnd) {
      out.push({
        from: m.from,
        to: m.to,
        char: m.span.char,
        run: m.span.run,
        mermaid: m.span.mermaid,
        code: m.span.code,
      })
    }
  }
  out.push(...scan.spans)
  out.sort((a, b) => a.from - b.from)
  return { spans: out, trailingOpenStart }
}

/** 全文档围栏表（#60）：docChanged 时增量重建；选区/视口变化零成本 */
export const mermaidFencesField = StateField.define<MermaidFenceTable>({
  create(state) {
    const scan = scanFencesDetailed(docLines(state.doc), 0)
    return { spans: scan.spans, trailingOpenStart: scan.open?.from ?? null }
  },
  update(value, tr) {
    if (!tr.docChanged) {
      return value
    }
    return rebuildFences(value, tr)
  },
})

// ---- 装饰构建 ----

/**
 * mermaid 围栏装饰构建（#60 契约入口；纯数据输入，可单测直驱）：
 * 光标/选区触及围栏区间 → 不发射（源码显形）；范围外 → replace widget。
 * frontmatter 内围栏抑制（源码降级边界）。
 */
export function buildMermaidDecorationRanges(
  selection: import('@codemirror/state').EditorSelection,
  fm: { end: number } | null,
  fences: readonly FenceSpan[],
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  for (const fence of fences) {
    if (!fence.mermaid) {
      continue
    }
    if (fm && fence.from < fm.end) {
      continue
    }
    if (selectionTouchesRange(selection, fence.from, fence.to)) {
      continue
    }
    out.push(mermaidWidgetDeco(fence.code).range(fence.from, fence.to))
  }
  return out
}

/** 跨行块装饰（StateField，#60）：CM6 约束——跨行 replace 只能由 field
 *  提供；widget DOM 由 CM6 按视口惰性创建（屏外不物化）。 */
export const mermaidDecorations = StateField.define<DecorationSet>({
  create(state) {
    const field = state.field(liveDecorationsField, false)
    if (!field) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildMermaidDecorationRanges(state.selection, field.fm, state.field(mermaidFencesField).spans),
      true,
    )
  },
  update(value, tr) {
    // Transaction 没有 selectionSet（那是 ViewUpdate 的属性）：以显式
    // selection 判定选区变化（liveDecorationsField/liveMath 同款口径）
    if (!tr.docChanged && tr.selection === undefined) {
      return value
    }
    const field = tr.state.field(liveDecorationsField, false)
    if (!field) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildMermaidDecorationRanges(tr.state.selection, field.fm, tr.state.field(mermaidFencesField).spans),
      true,
    )
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** live Mermaid 扩展装配：围栏表 StateField + 跨行块装饰 StateField */
export const liveMermaid: Extension = [mermaidFencesField, mermaidDecorations]
