// 大纲定位纯函数（#66）：标题序列 + 当前行 → 所在控制域标题索引。
//
// 语义（单一事实源，供常驻高亮与后续滚动展开复用）：以视口顶部行为准，
// 向上最近的标题即当前控制域——即最大的 i 使 items[i].line <= line。
// 跨级与同名标题按文档序逐项保留，索引天然区分（不按 level 或文字归并）；
// 首标题之前的行不属于任何控制域（null）。后续折叠票（#67）的「可见祖先
// 回退」在本函数外层包装（条目可见性是渲染层概念，不进定位语义）。
import type { OutlineItem } from './outline'

/**
 * 当前行所在控制域的标题索引：视口顶部行向上最近标题。
 * items 须按文档序产出（extractOutline 保证 line 单调不减）。
 * 无标题序列、行在首标题之前或行号无效（<1 / 非有限值）返回 null。
 */
export function locateOutlineIndex(items: readonly OutlineItem[], line: number): number | null {
  if (items.length === 0 || !Number.isFinite(line) || line < 1) {
    return null
  }
  // 二分求「最后一个 line <= 当前行」的条目（序列 line 单调不减）
  let lo = 0
  let hi = items.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (items[mid]!.line <= line) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans >= 0 ? ans : null
}
