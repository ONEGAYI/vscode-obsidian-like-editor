// 大纲标题搜索纯函数契约（#68）：大小写不敏感子串匹配剥标记可见文本
// （plainText 口径：`**粗体**` 输「粗体」命中）、命中保留 + 匹配路径祖先
// 保留、片段级命中区间（plainText 内偏移）、无匹配判据、搜索展开集合成
// （命中祖先链并入）、搜索态可见代表回退与组合可见口径。
// 语义单一事实源：src/webview/outlineSearch.ts（与 outlineCollapse 对拍）。
import { describe, expect, it } from 'vitest'
import {
  outlineFilteredVisibleIndices,
  outlineSearchExpandSet,
  outlineSearchFilter,
  outlineSearchRepresentativeIndex,
} from '../../src/webview/outlineSearch'

/** 搜索样例树（与 outlinePanel.test.ts 的 COLLAPSE_DOC 同构）：
 *  0=Alpha(H1,父) 1=Bold 标题(H2,父) 2=Gamma(H3,叶)
 *  3=Delta(H2,父) 4=Epsilon(H4,叶，跨级挂 Delta 下) 5=Zeta(H1,叶) */
const ITEMS = [
  { level: 1, plainText: 'Alpha' },
  { level: 2, plainText: 'Bold 标题' },
  { level: 3, plainText: 'Gamma' },
  { level: 2, plainText: 'Delta' },
  { level: 4, plainText: 'Epsilon' },
  { level: 1, plainText: 'Zeta' },
]

describe('outlineSearchFilter：匹配与过滤（#68）', () => {
  it('大小写不敏感子串匹配 plainText（剥标记口径的纯函数面）', () => {
    const r = outlineSearchFilter(ITEMS, 'BOLD')
    expect(r.matchedIndices).toEqual([1]) // 'Bold 标题'.toLowerCase() 含 'bold'
    expect(r.ranges[1]).toEqual([{ start: 0, end: 4 }])
  })

  it('命中条目与匹配路径祖先保留（kept），其余隐藏', () => {
    // 'gamma' 命中 Gamma(2)：其祖先链 Beta(1)、Alpha(0) 保留；Delta 分支与 Zeta 隐藏
    const r = outlineSearchFilter(ITEMS, 'gamma')
    expect(r.matchedIndices).toEqual([2])
    expect(r.kept).toEqual([true, true, true, false, false, false])
  })

  it('多处出现的全部命中区间都收集（同条目多 mark）', () => {
    // 'alpha' 小写化后 'a' 出现在 0 与 4；'gamma' 同构（g-a-m-m-a）
    const r = outlineSearchFilter(ITEMS, 'A')
    expect(r.matchedIndices).toEqual([0, 2, 3, 5]) // Alpha/Gamma/Delta/Zeta
    expect(r.ranges[0]).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ])
    expect(r.ranges[2]).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
    ])
    expect(r.ranges[3]).toEqual([{ start: 4, end: 5 }]) // 'delta' 仅尾部一处
    expect(r.ranges[5]).toEqual([{ start: 3, end: 4 }]) // 'zeta' 仅尾部一处
    // 非命中条目的区间为空数组（祖先保留但不产生高亮）
    expect(r.ranges[1]).toEqual([])
  })

  it('空输入等于无过滤：kept 全 true、无区间、无匹配占位为 false', () => {
    const r = outlineSearchFilter(ITEMS, '')
    expect(r.kept).toEqual(ITEMS.map(() => true))
    expect(r.matchedIndices).toEqual([])
    expect(r.ranges.every((x) => x.length === 0)).toBe(true)
    expect(r.noMatch).toBe(false)
  })

  it('有词条但无任何命中：noMatch 为 true、kept 全 false', () => {
    const r = outlineSearchFilter(ITEMS, 'zzz')
    expect(r.matchedIndices).toEqual([])
    expect(r.kept).toEqual(ITEMS.map(() => false))
    expect(r.noMatch).toBe(true)
  })

  it('空标题序列不判无匹配（「无标题」占位另有口径）', () => {
    const r = outlineSearchFilter([], 'anything')
    expect(r.noMatch).toBe(false)
    expect(r.kept).toEqual([])
  })

  it('中文子串与混合大小写', () => {
    const items = [
      { level: 1, plainText: '安装指南' },
      { level: 2, plainText: 'Installation Guide' },
    ]
    expect(outlineSearchFilter(items, '指南').matchedIndices).toEqual([0])
    expect(outlineSearchFilter(items, 'INSTALLATION').matchedIndices).toEqual([1])
    expect(outlineSearchFilter(items, '安装GUIDE').matchedIndices).toEqual([]) // 不跨条目
  })
})

describe('outlineSearchExpandSet：命中路径自动展开（#68）', () => {
  it('base ∪ 命中条目祖先链（命中自身不必然展开——其子树由过滤口径隐藏）', () => {
    const base = new Set([0]) // 仅 Alpha 展开（档 1 精确集）
    const r = outlineSearchFilter(ITEMS, 'gamma')
    const out = outlineSearchExpandSet(ITEMS, base, r.matchedIndices)
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1]) // Gamma 的祖先 Beta(1)、Alpha(0)
  })

  it('跨级命中的祖先链自然挂靠（Epsilon 命中 → Delta、Alpha）', () => {
    const r = outlineSearchFilter(ITEMS, 'epsilon')
    const out = outlineSearchExpandSet(ITEMS, new Set(), r.matchedIndices)
    expect([...out].sort((a, b) => a - b)).toEqual([0, 3])
  })

  it('多命中的祖先链取并集；空命中返回 base 引用（零成本无变化）', () => {
    const r = outlineSearchFilter(ITEMS, 'a') // Alpha、Gamma、Delta
    const out = outlineSearchExpandSet(ITEMS, new Set([3]), r.matchedIndices)
    expect([...out].sort((a, b) => a - b)).toEqual([0, 1, 3])
    const base = new Set([1])
    expect(outlineSearchExpandSet(ITEMS, base, [])).toBe(base)
  })
})

describe('outlineSearchRepresentativeIndex：搜索态高亮代表（#68）', () => {
  it('自身（折叠可见 ∧ 搜索保留）即代表', () => {
    const all = new Set([0, 1, 3]) // 全父展开
    expect(outlineSearchRepresentativeIndex(ITEMS, all, ITEMS.map(() => true), 2)).toBe(2)
  })

  it('被搜索过滤的条目回退到第一个可见祖先（kept 口径）', () => {
    const all = new Set([0, 1, 3])
    const kept = [true, true, false, true, true, true] // Gamma 被过滤
    expect(outlineSearchRepresentativeIndex(ITEMS, all, kept, 2)).toBe(1) // Beta
  })

  it('折叠遮蔽与搜索过滤组合：沿链找第一个双重可见者', () => {
    const none = new Set<number>() // 全父折叠
    const kept = [true, false, true, true, false, true]
    // located=Gamma(2)：折叠隐藏（Beta 折叠）且 kept；Beta 可见但不 kept；Alpha 可见且 kept
    expect(outlineSearchRepresentativeIndex(ITEMS, none, kept, 2)).toBe(0)
  })

  it('链上无可见代表（含顶层被过滤）返回 null；索引越界返回 null', () => {
    const none = new Set<number>()
    expect(outlineSearchRepresentativeIndex(ITEMS, none, ITEMS.map(() => false), 2)).toBeNull()
    expect(outlineSearchRepresentativeIndex(ITEMS, new Set([0]), ITEMS.map(() => true), -1)).toBeNull()
    expect(outlineSearchRepresentativeIndex(ITEMS, new Set([0]), ITEMS.map(() => true), 9)).toBeNull()
  })
})

describe('outlineFilteredVisibleIndices：折叠可见 ∩ 搜索保留（probe 权威口径）', () => {
  it('搜索关闭口径（kept 全 true）与折叠可见一致', () => {
    const expanded = new Set([0]) // 档 1：Beta/Delta 子树折叠
    expect(outlineFilteredVisibleIndices(ITEMS, expanded, ITEMS.map(() => true))).toEqual([0, 1, 3, 5])
  })

  it('搜索过滤与折叠遮蔽取交集', () => {
    const all = new Set([0, 1, 3]) // 全展开
    const kept = [true, true, false, true, false, true]
    expect(outlineFilteredVisibleIndices(ITEMS, all, kept)).toEqual([0, 1, 3, 5])
    // 折叠 Delta（Epsilon 被遮蔽）与 Epsilon 保留：交集语义下 Epsilon 不可见
    const partial = new Set([0, 1]) // Delta 折叠
    expect(outlineFilteredVisibleIndices(ITEMS, partial, kept)).toEqual([0, 1, 3, 5])
  })
})
