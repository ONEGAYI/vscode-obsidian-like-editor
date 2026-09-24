// 阅读视口按需挂载的纯函数层（工单 #7）：
// 挂载窗口计算、占位高度估计、窗口差分（回收策略）与源 offset 映射。
//
// 职责边界（ADR-0005：语法解析与 DOM 挂载分离）：
// - 本模块不触碰 DOM、不解析 Markdown——块模型由 readingBlocks 一次性切分，
//   本模块只做数值几何：给定每块高度估计（未挂载=估计值，挂载后回填实测值），
//   计算滚动位置对应的挂载窗口与差分
// - 占位方式为上下两个 spacer 的"布局信息占位"（高度估计保持滚动条稳定），
//   屏外块不创建内容节点；DOM 装配见 readingVirtualView.ts
// - 窗口宽度只由视口高度与缓冲量决定，与文档体量无关（DOM 有界性的来源）
//
// 超大块限制（如实记录）：单个块（如未拆分的巨型代码围栏）是一个窗口项，
// 无法在块内二次虚拟化——块内 DOM 成本随块体量线性增长，见
// docs/perf/2026-09-reading-viewport-mount.md。
import type { ReadingBlock } from './readingBlocks'

/** 挂载窗口（闭区间索引） */
export interface MountWindow {
  first: number
  last: number
}

/** 高度标定：由实测块反推的行高（px），供未挂载块的行数估计使用 */
export interface HeightCalibration {
  lineHeightPx: number
}

/** 默认行高估计：15px 字号 × 1.6 行高（阅读视图 CSS 默认值） */
export const DEFAULT_LINE_HEIGHT_PX = 24

/** 标题级别 → 字号缩放（与 main.css 的 .vsidian-reading-heading-N 同向一致） */
export const HEADING_HEIGHT_SCALES: Record<number, number> = {
  1: 1.6,
  2: 1.38,
  3: 1.2,
  4: 1.1,
  5: 1,
  6: 1,
}

/** 块级垂直间距估计（px）：块底 margin 0.75em + 标题额外上下 margin */
const MARGIN_PX = { block: 12, heading: 24, code: 16 } as const

/** 块内行数（LF 计数 + 1；块源区间取自全文 text） */
export function blockLineCount(block: ReadingBlock, text: string): number {
  const slice = text.slice(block.start, block.end)
  let lines = 1
  for (let i = 0; i < slice.length; i++) {
    if (slice.charCodeAt(i) === 10 /* \n */) {
      lines += 1
    }
  }
  return lines
}

/** 未挂载块的占位高度初始估计：行数 × 行高 × 种类缩放 + 种类间距 */
export function estimateBlockHeightPx(
  block: ReadingBlock,
  text: string,
  calib: HeightCalibration,
): number {
  const lines = blockLineCount(block, text)
  const scale =
    block.kind === 'heading' ? (HEADING_HEIGHT_SCALES[block.level ?? 1] ?? 1) : 1
  const margin =
    block.kind === 'heading' ? MARGIN_PX.heading : block.kind === 'code-block' ? MARGIN_PX.code : MARGIN_PX.block
  return Math.max(1, Math.round(lines * calib.lineHeightPx * scale) + margin)
}

/** 全部块的初始高度估计（setDocument 时一次计算） */
export function estimateHeights(
  blocks: readonly ReadingBlock[],
  text: string,
  calib: HeightCalibration,
): number[] {
  return blocks.map((b) => estimateBlockHeightPx(b, text, calib))
}

/** 块顶前缀和：tops[i] = 块 i 的顶部位置，tops[n] = 总高（n = 块数） */
export function blockTops(heights: readonly number[]): number[] {
  const tops = new Array<number>(heights.length + 1)
  tops[0] = 0
  for (let i = 0; i < heights.length; i++) {
    tops[i + 1] = tops[i]! + Math.max(heights[i]!, 1)
  }
  return tops
}

/**
 * 挂载窗口：与缓冲区间 [scrollTop - buffer, scrollTop + viewport + buffer)
 * 相交的块索引闭区间。空序列返回 null。窗口宽度只依赖视口与缓冲量——
 * 固定视口下不随块数（文档体量）增长。
 */
export function computeMountWindow(
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  bufferPx: number,
): MountWindow | null {
  const n = heights.length
  if (n === 0) {
    return null
  }
  const tops = blockTops(heights)
  const rangeTop = Math.max(0, scrollTop - bufferPx)
  const rangeBottom = scrollTop + Math.max(viewportHeight, 0) + bufferPx
  // first：最小的与区间上缘相交的块（块底越过 rangeTop）
  let first = 0
  while (first < n - 1 && tops[first + 1]! <= rangeTop) {
    first += 1
  }
  // last：最大的与区间下缘相交的块（块顶早于 rangeBottom）
  let last = n - 1
  while (last > first && tops[last]! >= rangeBottom) {
    last -= 1
  }
  return { first, last }
}

/**
 * 窗口差分（回收策略）：prev → next 需要挂载与回收的索引。
 * 仍在窗口内的块不出现在任一列表（保留已挂载节点，不重建）。
 * prev/next 任一为 null 表示无旧窗口/无新窗口。
 */
export function diffWindow(
  prev: MountWindow | null,
  next: MountWindow | null,
): { mount: number[]; recycle: number[] } {
  if (prev === null && next === null) {
    return { mount: [], recycle: [] }
  }
  if (prev === null) {
    return { mount: rangeIndices(next!), recycle: [] }
  }
  if (next === null) {
    return { recycle: rangeIndices(prev), mount: [] }
  }
  const mount: number[] = []
  const recycle: number[] = []
  for (let i = next.first; i <= next.last; i++) {
    if (i < prev.first || i > prev.last) {
      mount.push(i)
    }
  }
  for (let i = prev.first; i <= prev.last; i++) {
    if (i < next.first || i > next.last) {
      recycle.push(i)
    }
  }
  return { mount, recycle }
}

function rangeIndices(w: MountWindow): number[] {
  const out: number[] = []
  for (let i = w.first; i <= w.last; i++) {
    out.push(i)
  }
  return out
}

/**
 * 源 offset → 块索引：与 readingBlocks.blockForOffset 同语义（floor）——
 * 落在块内返回该块；缝隙返回前一块；越界 clamp 到末块；空序列 null。
 * 虚拟化下目标块可能未挂载（屏外）：此映射不依赖 DOM，供标题跳转定位。
 */
export function blockIndexForOffset(
  blocks: readonly ReadingBlock[],
  offset: number,
): number | null {
  if (blocks.length === 0) {
    return null
  }
  let result: number | null = null
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.start <= offset && offset < b.end) {
      return i
    }
    if (offset >= b.end) {
      result = i
    } else {
      break
    }
  }
  return result ?? blocks.length - 1
}

/**
 * 视口锚点索引：首个与滚动位置相交的块（块底越过 scrollTop）。
 * 滚动超过末块底返回末索引；空序列返回 null。
 * 与 #6 的 findReadingAnchor（DOM 版）同判定，但基于高度表而非布局读数。
 */
export function anchorIndexAtScroll(
  tops: readonly number[],
  heights: readonly number[],
  scrollTop: number,
): number | null {
  const n = heights.length
  if (n === 0) {
    return null
  }
  for (let i = 0; i < n; i++) {
    if (tops[i]! + Math.max(heights[i]!, 1) > scrollTop) {
      return i
    }
  }
  return n - 1
}

/** 实测样本：一个已挂载块的行数与实测外高 */
export interface HeightSample {
  lines: number
  heightPx: number
}

/**
 * 由实测样本更新行高标定。估计模型为 `行数 × 行高 + 块级间距`，因此样本
 * 先扣除块级间距再按行折算；取中位数，夹在 [8, 64] px 防异常布局值污染
 * 估计。非正行数/非正高度样本忽略；无有效样本保持原值。
 */
export function recalibrate(
  samples: readonly HeightSample[],
  prev: HeightCalibration,
): HeightCalibration {
  const ratios: number[] = []
  for (const s of samples) {
    if (s.lines > 0 && s.heightPx > MARGIN_PX.block) {
      ratios.push((s.heightPx - MARGIN_PX.block) / s.lines)
    }
  }
  if (ratios.length === 0) {
    return prev
  }
  ratios.sort((a, b) => a - b)
  const mid = Math.floor(ratios.length / 2)
  const median = ratios.length % 2 === 1 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2
  return { lineHeightPx: Math.min(64, Math.max(8, median)) }
}
