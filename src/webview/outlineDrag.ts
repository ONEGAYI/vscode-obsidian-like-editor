// 大纲拖拽排序纯函数（#70）：控制域原子移动计划与三态落点判定。
//
// 语义单一事实源（供契约测试 outlineDrag.test.ts 对拍）：
//
// 1. 移动原子 = 被拖标题的整个控制域（outlineSectionLineRange 同款几何：
//    标题行 + 内容直到下一 level≤自身 标题前，文末兜底）。段尾空行属于
//    该控制域、随段搬移；目标接缝因此可能从空行分隔退化为单换行分隔
//    （Markdown 语义不变，字节确定性优先）。
//
// 2. 三态落点：before/after 对齐目标层级（delta = to.level - from.level），
//    inside = 目标 level + 1（成为目标的最后子级，插入点在目标控制域
//    末尾——与 after 同点、层级差一）；被搬移子树整体递归同步调级，
//    逐条 clamp 1..6（与 #69 递归调级同口径）。
//
// 3. 无效落点：目标在源子树内（含自身、含跨级挂靠后代）→ null，零变更。
//    拖入自身控制域内部任何三态都拒绝（before/after 落子树内是物理
//    no-op 或原地调级的歧义区，共识口径一律拒绝）。
//
// 4. 误伤红线：控制域外内容字节级零变更。计划只含 1–2 条 SerChange
//    （升序互不重叠，一次 CM6 事务 dispatch = 单笔 edit.request = 宿主
//    撤销一次）：删除源段 + 在插入点放入调级后的搬移段。frontmatter、
//    代码围栏内相似结构、Setext 段（控制域外）原样保留；搬移段子树内的
//    Setext 标题规范化为 ATX 单行（与 #69 调级/重命名同口径——Setext
//    只能表达 1–2 级，统一 ATX 使变换语义单一可预测）。
//
// 5. 接缝换行规范化：插入点后有后续内容时搬移段以 \n 收尾（文末段无
//    尾换行时补齐，插入行首不与后续行粘连；插入点即文档末尾时保持原样，
//    不凭空补尾换行）；插入点前一字符非 \n 且非文档起点时（文末无尾
//    换行的 after/inside）搬移段前置 \n。
//
// 与相邻模块的分工：outlineSection 提供控制域几何与 ATX 行构造；本模块
// 组合出移动计划；syncController 持拖拽会话状态并落 DOM/写回（见其 #70
// 区块）。三态命中判定（outlineDropPositionAt）供控制器的 pointermove
// 换算，边缘容差 25%。
import type { Text } from '@codemirror/state'
import type { SerChange } from '../shared/protocol'
import type { OutlineItem } from './outline'
import { outlineAtxLine, outlineHeadingPrefix, outlineHeadingSpan, outlineSectionLineRange, outlineSubtreeIndices } from './outlineSection'

/** 三态落点：目标之前/之后/内部（内部 = 成为目标最后子级） */
export type OutlineDropPosition = 'before' | 'after' | 'inside'

/** 落点有效性：目标不在源子树内（含自身）且双方索引合法。
 *  有效性只看条目身份不看三态——拖入自身控制域内部任何位置都拒绝 */
export function outlineDropAllowed(
  items: ReadonlyArray<{ level: number }>,
  fromIndex: number,
  toIndex: number,
): boolean {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) {
    return false
  }
  return !outlineSubtreeIndices(items, fromIndex).includes(toIndex)
}

/**
 * 三态落点命中判定：指针 Y 在目标条目内的相对位置 → before/after/inside。
 * 边缘容差 25%：上缘四分之一 before、下缘四分之一 after、中部二分之一
 * inside；指针越出条目上下缘时钳制到最近态（合成事件坐标漂移防御）。
 * 零高度（无布局环境）返回 inside 的判定无意义——调用方保证有布局
 */
export function outlineDropPositionAt(rectTop: number, rectHeight: number, clientY: number): OutlineDropPosition {
  const rel = rectHeight > 0 ? (clientY - rectTop) / rectHeight : 0.5
  if (rel < 0.25) {
    return 'before'
  }
  if (rel > 0.75) {
    return 'after'
  }
  return 'inside'
}

/** 源段 doc 偏移区间 [from, to)：标题行行首到段尾行换行后（文末段为
 *  doc.length）。段自带尾随换行，剪切后接缝干净（上一行尾换行保留） */
function outlineSegmentSpan(
  doc: Text,
  items: readonly OutlineItem[],
  index: number,
): { from: number; to: number } | null {
  const range = outlineSectionLineRange(items, index, doc.lines)
  if (!range) {
    return null
  }
  const from = doc.line(Math.min(Math.max(1, range.startLine), doc.lines)).from
  const to = range.endLine < doc.lines ? doc.line(range.endLine).to + 1 : doc.length
  return { from, to }
}

/** 移动计划：一次编辑事务的全部载荷（1–2 条 SerChange + 搬移段观测面） */
export interface OutlineMovePlan {
  /** 升序互不重叠 SerChange：一次 CM6 dispatch 全部 = 单笔 edit.request */
  changes: SerChange[]
  /** 搬移段文本（子树调级后；恒以单个 \n 收尾，需要时前置 \n） */
  movedText: string
  /** 调级 delta（inside 已含 +1；子树内逐条 clamp 1..6） */
  levelDelta: number
  /** 源段 doc 偏移区间 [sliceFrom, sliceTo) */
  sliceFrom: number
  sliceTo: number
  /** 插入点 doc 偏移（before = 目标标题行首；after/inside = 目标段尾） */
  insertAt: number
}

/**
 * 移动计划：源整段剪切 + 目标整段插入合并为一次编辑事务。无效落点
 * （拖入自身子树、越界）返回 null。插入点与源段首重合时合并为单条
 * 整段替换（剪切点 = 插入点的原地调级，物理位置不变）
 */
export function outlineMovePlan(
  doc: Text,
  items: readonly OutlineItem[],
  fromIndex: number,
  toIndex: number,
  position: OutlineDropPosition,
): OutlineMovePlan | null {
  if (!outlineDropAllowed(items, fromIndex, toIndex)) {
    return null
  }
  const from = items[fromIndex]!
  const to = items[toIndex]!
  const span = outlineSegmentSpan(doc, items, fromIndex)
  if (!span || span.to <= span.from) {
    return null // 防御（空段）
  }
  // 插入点：before = 目标标题行首；after/inside = 目标段尾（inside 与
  // after 同点——inside 语义由 delta+1 表达，成为目标子树末尾的最后子级）
  const targetRange = outlineSectionLineRange(items, toIndex, doc.lines)
  if (!targetRange) {
    return null
  }
  const insertAt = position === 'before'
    ? doc.line(Math.min(Math.max(1, to.line), doc.lines)).from
    : targetRange.endLine < doc.lines ? doc.line(targetRange.endLine).to + 1 : doc.length

  const levelDelta = to.level - from.level + (position === 'inside' ? 1 : 0)

  // 搬移段文本：子树内每个标题区替换为调级后的 ATX 单行（从后往前替换，
  // 段内偏移不漂移）；段尾换行规范化（补齐），插入点无前置换行时前置
  let moved = doc.sliceString(span.from, span.to)
  const subtree = outlineSubtreeIndices(items, fromIndex)
  for (let k = subtree.length - 1; k >= 0; k--) {
    const item = items[subtree[k]!]!
    const heading = outlineHeadingSpan(doc, item)
    const at = heading.from - span.from
    const end = heading.to - span.from
    if (at < 0 || end > moved.length || at >= end) {
      continue // 防御（标题区不在段内——锚点已对齐时不可达）
    }
    moved = moved.slice(0, at) +
      outlineHeadingPrefix(doc, item) + outlineAtxLine(item.level + levelDelta, item.text) +
      moved.slice(end)
  }
  // 尾换行补齐只在插入点后有后续内容时发生（合并替换的文末段保持原样，
  // 不为文档凭空补尾换行）；插入点前一字符非 \n 且非文档起点时前置换行
  const hasFollowing = insertAt === span.from ? span.to < doc.length : insertAt < doc.length
  if (hasFollowing && !moved.endsWith('\n')) {
    moved += '\n'
  }
  if (insertAt > 0 && doc.sliceString(insertAt - 1, insertAt) !== '\n') {
    moved = `\n${moved}`
  }

  // 变更合成（原 doc 坐标，升序不重叠）：插入点与源段首重合 → 单条整段
  // 替换；其余按插入点在源段前/后分两序
  const sliceLength = span.to - span.from
  let changes: SerChange[]
  if (insertAt === span.from) {
    changes = [{ offset: span.from, length: sliceLength, text: moved }]
  } else if (insertAt < span.from) {
    changes = [
      { offset: insertAt, length: 0, text: moved },
      { offset: span.from, length: sliceLength, text: '' },
    ]
  } else {
    changes = [
      { offset: span.from, length: sliceLength, text: '' },
      { offset: insertAt, length: 0, text: moved },
    ]
  }
  return { changes, movedText: moved, levelDelta, sliceFrom: span.from, sliceTo: span.to, insertAt }
}
