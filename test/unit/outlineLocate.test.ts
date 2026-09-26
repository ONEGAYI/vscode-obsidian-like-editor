// 大纲定位纯函数契约（#66）：标题序列 + 当前行 → 所在控制域标题索引。
// 语义（共识 #66）：以视口顶部行为准，向上最近的标题即当前控制域——
// 即最大的 i 使 items[i].line <= line。本函数是高亮与后续滚动展开
// （#67 可见祖先回退在其外层包装）共用的单一事实源，不依赖 DOM。
import { describe, it, expect } from 'vitest'
import { locateOutlineIndex } from '../../src/webview/outlineLocate'
import type { OutlineItem } from '../../src/webview/outline'

/** 序列刻意覆盖：首行非 1 基起点（frontmatter/序言之后）、跨级（H2 直跟
 *  H4）、同名标题（两个「同名」不混淆）、Setext 混排。locate 只消费
 *  level/line；plainText/spans 按当前 OutlineItem 形态补齐（#65 起必填） */
const item = (level: number, text: string, line: number): OutlineItem => ({
  level, text, plainText: text, spans: [], line,
})
const ITEMS: OutlineItem[] = [
  item(1, '主标题', 3),
  item(2, '同名', 10),
  item(4, '跨级四级', 12),
  item(2, '同名', 20),
  item(1, '尾部一级', 30),
]

describe('locateOutlineIndex：当前行 → 所在控制域标题索引', () => {
  it('空序列恒 null（无标题文档无控制域）', () => {
    expect(locateOutlineIndex([], 1)).toBeNull()
    expect(locateOutlineIndex([], 100)).toBeNull()
  })

  it('首标题之前的行不属于任何控制域（文档首、frontmatter、序言）', () => {
    expect(locateOutlineIndex(ITEMS, 1)).toBeNull()
    expect(locateOutlineIndex(ITEMS, 2)).toBeNull()
  })

  it('恰在标题行：命中该标题自身（行相等含在内）', () => {
    expect(locateOutlineIndex(ITEMS, 3)).toBe(0)
    expect(locateOutlineIndex(ITEMS, 10)).toBe(1)
    expect(locateOutlineIndex(ITEMS, 30)).toBe(4)
  })

  it('标题行之后的正文行：向上最近标题（视口顶行所在控制域）', () => {
    expect(locateOutlineIndex(ITEMS, 5)).toBe(0)
    expect(locateOutlineIndex(ITEMS, 9)).toBe(0)
    expect(locateOutlineIndex(ITEMS, 11)).toBe(1)
  })

  it('跨级标题按挂靠语义：H2 直跟 H4，其间行归 H4 控制域', () => {
    // line 12（H4）到 line 19（下一标题前）都是「跨级四级」的控制域
    expect(locateOutlineIndex(ITEMS, 13)).toBe(2)
    expect(locateOutlineIndex(ITEMS, 19)).toBe(2)
  })

  it('同名标题不混淆：命中位置最近的同名项（索引区分）', () => {
    expect(locateOutlineIndex(ITEMS, 21)).toBe(3)
    expect(locateOutlineIndex(ITEMS, 29)).toBe(3)
    // 同在两个「同名」的控制域内，索引必须指向后者
    expect(locateOutlineIndex(ITEMS, 11)).not.toBe(3)
  })

  it('末标题之后的行：文档尾部仍归末标题控制域', () => {
    expect(locateOutlineIndex(ITEMS, 31)).toBe(4)
    expect(locateOutlineIndex(ITEMS, 1000)).toBe(4)
  })

  it('无效行号防御：0、负数、非有限值恒 null', () => {
    expect(locateOutlineIndex(ITEMS, 0)).toBeNull()
    expect(locateOutlineIndex(ITEMS, -5)).toBeNull()
    expect(locateOutlineIndex(ITEMS, Number.NaN)).toBeNull()
    expect(locateOutlineIndex(ITEMS, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('标题行降序输入不崩溃（防御：outline 序按文档序产出，此为容错）', () => {
    const unsorted: OutlineItem[] = [
      item(1, '后', 50),
      item(1, '前', 5),
    ]
    // 只要求不抛错、返回索引或 null 之一（实现可选择二分的任意稳定行为）
    const result = locateOutlineIndex(unsorted, 10)
    expect(result === null || (result >= 0 && result < unsorted.length)).toBe(true)
  })
})
