// 大纲折叠状态机纯函数契约（#67）：档位（No-Expand、H1–H5）+ 手动折叠
// 集合 → 每条目可见性的推导规则、only-expand 滚动展开、编辑后折叠集合
// 的 diff 迁移（重命名不扰动视图）。语义单一事实源在 src/webview/
// outlineCollapse.ts 顶部注释，本文件钉住其中的可观察契约：
// - 「展开到 n」= 展开所有 level≤n 且有子项的父节点（非显示 level≤n 的
//   标题）：Hn 的直接子级可见、更深层折叠
// - 跨级标题自然挂靠（H1 直接跟 H3 时 H3 挂在 H1 下）
// - 迁移：LCS((level, plainText)) 锚点 + 段内顺序对应（重命名保键），
//   删除丢键、降格为叶丢键、新增/升格父节点自动展开（新标题可见）
import { describe, expect, it } from 'vitest'
import {
  OUTLINE_EXPAND_LEVEL_DEFAULT,
  outlineCollapseFacts,
  outlineExpandAncestors,
  outlineExpandSetForLevel,
  outlineHiddenFlags,
  outlineRepresentativeIndex,
  outlineVisibleIndices,
  migrateOutlineExpanded,
} from '../../src/webview/outlineCollapse'
import type { OutlineItem } from '../../src/webview/outline'

/** 最小 OutlineItem 构造（纯函数只消费 level 与 plainText） */
function items(...specs: Array<[number, string]>): OutlineItem[] {
  return specs.map(([level, plainText], i) => ({
    level,
    text: plainText,
    plainText,
    spans: [],
    line: i + 1,
  }))
}

/** 嵌套样例：跨级（E 跳过 H2/H3 挂 D 下）+ 顶层两个 H1 */
const NESTED = items(
  [1, 'A'],
  [2, 'B'],
  [3, 'C'],
  [2, 'D'],
  [4, 'E'],
  [1, 'F'],
)
// parents:      A:null  B:0  C:1  D:0  E:3  F:null
// hasChildren:  A:T     B:T  C:F  D:T  E:F  F:F

describe('父结构与父节点判定（跨级自然挂靠）', () => {
  it('parents：向上最近更浅标题（跨级 E(H4) 直接挂 D(H2)）', () => {
    const facts = outlineCollapseFacts(NESTED)
    expect(facts.parents).toEqual([null, 0, 1, 0, 3, null])
  })

  it('hasChildren：后一标题层级更深即为父节点（叶节点永不进展开集）', () => {
    const facts = outlineCollapseFacts(NESTED)
    expect(facts.hasChildren).toEqual([true, true, false, true, false, false])
  })

  it('跨级序列 [H1,H3,H2]：H3 挂 H1 下，H2 也挂 H1 下', () => {
    const seq = items([1, '甲'], [3, '丙'], [2, '乙'])
    const facts = outlineCollapseFacts(seq)
    expect(facts.parents).toEqual([null, 0, 0])
    expect(facts.hasChildren).toEqual([true, false, false])
  })

  it('空序列与单标题边界稳定（无父节点、无崩溃）', () => {
    expect(outlineCollapseFacts([]).parents).toEqual([])
    expect(outlineCollapseFacts([]).hasChildren).toEqual([])
    const single = outlineCollapseFacts(items([2, '孤']))
    expect(single.parents).toEqual([null])
    expect(single.hasChildren).toEqual([false])
  })
})

describe('档位展开集（「展开到 Hn」语义）', () => {
  it('档位 n = 展开所有 level≤n 且有子项的父节点（叶节点永不入选）', () => {
    expect(outlineExpandSetForLevel(NESTED, 0)).toEqual(new Set())
    expect(outlineExpandSetForLevel(NESTED, 1)).toEqual(new Set([0]))
    expect(outlineExpandSetForLevel(NESTED, 2)).toEqual(new Set([0, 1, 3]))
    // C 无子、E 无子：档 3/4 与档 2 同集；档 5（默认）= 全部父节点
    expect(outlineExpandSetForLevel(NESTED, 3)).toEqual(new Set([0, 1, 3]))
    expect(outlineExpandSetForLevel(NESTED, 5)).toEqual(new Set([0, 1, 3]))
  })

  it('H6 恒为叶（Markdown 无更深层），档 5 即全展开', () => {
    const seq = items([1, 'A'], [6, 'Z'], [2, 'B'])
    expect(outlineExpandSetForLevel(seq, 5)).toEqual(new Set([0, 2]))
  })

  it('默认档位为 5（H5 全展开）', () => {
    expect(OUTLINE_EXPAND_LEVEL_DEFAULT).toBe(5)
  })
})

describe('可见性推导（hiddenFlags / visibleIndices）', () => {
  it('档 5（全父展开）：全部条目可见', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 5)
    expect(outlineVisibleIndices(NESTED, expanded)).toEqual([0, 1, 2, 3, 4, 5])
    expect(outlineHiddenFlags(NESTED, expanded).every((h) => !h)).toBe(true)
  })

  it('档 1：H1 直接子级可见（B、D、F），更深层（C、E）折叠隐藏', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 1)
    expect(outlineVisibleIndices(NESTED, expanded)).toEqual([0, 1, 3, 5])
  })

  it('档 0（No-Expand）：只露顶层（A、F），子级全部隐藏', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 0)
    expect(outlineVisibleIndices(NESTED, expanded)).toEqual([0, 5])
  })

  it('手动折叠叠加：档 5 基础上折叠 B，则 C 隐藏而其余展开', () => {
    const expanded = new Set([0, 3]) // 档 5 集合移除 1（B）
    expect(outlineVisibleIndices(NESTED, expanded)).toEqual([0, 1, 3, 4, 5])
  })

  it('手动展开叠加：档 0 基础上展开 B，则 B 的直接子级 C 可见（D/E 仍隐藏）', () => {
    const expanded = new Set([1])
    expect(outlineVisibleIndices(NESTED, expanded)).toEqual([0, 1, 2, 5])
  })

  it('嵌套折叠（折叠 A）：一切深度 > 1 的条目隐藏（含已展开的 B 不生效）', () => {
    // A 折叠后其子树整体隐藏；B 即使在 expanded 中也不改变 A 子树的隐藏
    const expanded = new Set([1, 3])
    expect(outlineVisibleIndices(NESTED, expanded)).toEqual([0, 5])
  })

  it('空序列与无子项平级文档：任何档位全可见（无折叠点）', () => {
    expect(outlineVisibleIndices([], new Set())).toEqual([])
    const flat = items([2, '甲'], [2, '乙'], [2, '丙'])
    for (const level of [0, 1, 2, 5]) {
      expect(outlineVisibleIndices(flat, outlineExpandSetForLevel(flat, level)))
        .toEqual([0, 1, 2])
    }
  })
})

describe('高亮回退（第一个可见祖先）', () => {
  it('条目自身可见：返回自身', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 5)
    expect(outlineRepresentativeIndex(NESTED, expanded, 3)).toBe(3)
  })

  it('条目被折叠遮蔽：返回最近的可见祖先（档 1 下 C → B、E → D）', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 1)
    expect(outlineRepresentativeIndex(NESTED, expanded, 2)).toBe(1)
    expect(outlineRepresentativeIndex(NESTED, expanded, 4)).toBe(3)
  })

  it('多层折叠：沿祖先链上溯到第一个可见者（档 0 下 E → A）', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 0)
    expect(outlineRepresentativeIndex(NESTED, expanded, 4)).toBe(0)
  })

  it('顶层条目恒可见（回退总有解）；索引越界返回 null', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 0)
    expect(outlineRepresentativeIndex(NESTED, expanded, 0)).toBe(0)
    expect(outlineRepresentativeIndex(NESTED, expanded, 99)).toBeNull()
    expect(outlineRepresentativeIndex([], new Set(), 0)).toBeNull()
  })
})

describe('only-expand（滚动动态展开）', () => {
  it('目标被折叠遮蔽：展开其全部祖先链（只增不减，其他折叠不动）', () => {
    const before = outlineExpandSetForLevel(NESTED, 0) // {}
    const after = outlineExpandAncestors(NESTED, before, 4) // E → 展开 D、A
    expect(after).toEqual(new Set([0, 3]))
    // 目标此后可见
    expect(outlineVisibleIndices(NESTED, after)).toContain(4)
  })

  it('目标已可见：返回原集合引用（调用方零成本判无变化）', () => {
    const expanded = outlineExpandSetForLevel(NESTED, 5)
    expect(outlineExpandAncestors(NESTED, expanded, 4)).toBe(expanded)
  })

  it('only-expand 不折叠其他区域：原有展开项全部保留', () => {
    const before = new Set([1]) // 手动展开 B
    const after = outlineExpandAncestors(NESTED, before, 4) // E 需要 D、A
    expect(after).toEqual(new Set([0, 1, 3]))
  })

  it('索引越界返回原集合（防御，不崩不扩）', () => {
    const expanded = new Set([0])
    expect(outlineExpandAncestors(NESTED, expanded, -1)).toBe(expanded)
    expect(outlineExpandAncestors(NESTED, expanded, 99)).toBe(expanded)
  })
})

describe('编辑后折叠集合迁移（刷新存活）', () => {
  it('重命名标题：展开键不扰动（按位置迁移）', () => {
    const prev = items([1, '旧甲'], [2, '乙'], [3, '丙'])
    const next = items([1, '新甲'], [2, '乙'], [3, '丙'])
    expect(migrateOutlineExpanded(prev, next, new Set([0, 1]))).toEqual(new Set([0, 1]))
  })

  it('删除子标题使其父降格为叶：父的展开键被清除（safeFilter）', () => {
    const prev = items([1, '甲'], [2, '乙'], [3, '丙'])
    const next = items([1, '甲'], [2, '乙']) // 丙删除，乙降格为叶
    expect(migrateOutlineExpanded(prev, next, new Set([0, 1]))).toEqual(new Set([0]))
  })

  it('删除折叠中的父标题：其键随之消失，兄弟关系自然修复', () => {
    const prev = items([1, '甲'], [2, '乙'], [2, '丁'])
    const next = items([1, '甲'], [2, '丁']) // 乙删除
    expect(migrateOutlineExpanded(prev, next, new Set([0, 1]))).toEqual(new Set([0]))
  })

  it('前插新 H1：新顶层是父节点且自动展开（新标题可见）', () => {
    const prev = items([2, '乙'])
    const next = items([1, '新'], [2, '乙'])
    expect(migrateOutlineExpanded(prev, next, new Set())).toEqual(new Set([0]))
  })

  it('尾部新增深层标题：升格为父的条目自动展开', () => {
    const prev = items([1, '甲'], [2, '乙'])
    const next = items([1, '甲'], [2, '乙'], [3, '新丙'])
    // 丙新增：祖先链 [乙, 甲] 展开（乙由叶升格父）
    expect(migrateOutlineExpanded(prev, next, new Set([0]))).toEqual(new Set([0, 1]))
  })

  it('在已折叠父节点下新增兄弟：不折叠其他区域（该父仍折叠）', () => {
    const prev = items([1, '甲'], [2, '乙'], [3, '丙'], [2, '丁'])
    const next = items([1, '甲'], [2, '乙'], [3, '丙'], [2, '丁'], [3, '新'])
    // 甲展开（0 在集合）、乙折叠（1 不在集合）；新增挂在丁（升格父）下
    // → 丁展开；乙保持折叠（不无故折叠用户视图）
    expect(migrateOutlineExpanded(prev, next, new Set([0]))).toEqual(new Set([0, 3]))
  })

  it('前部批量插入（行号偏移）：既有展开键按偏移平移', () => {
    const prev = items([1, '甲'], [2, '乙'], [3, '丙'])
    const next = items([1, '零'], [1, '甲'], [2, '乙'], [3, '丙'])
    // 甲乙丙整体后移 1；零是新 H1（父节点自动展开）
    expect(migrateOutlineExpanded(prev, next, new Set([0, 1])))
      .toEqual(new Set([0, 1, 2]))
  })

  it('清空全部标题：迁移结果为空集', () => {
    const prev = items([1, '甲'], [2, '乙'])
    expect(migrateOutlineExpanded(prev, items(), new Set([0, 1]))).toEqual(new Set())
  })

  it('从空到有：全部按新增处理（新父自动展开）', () => {
    const next = items([1, '甲'], [2, '乙'])
    expect(migrateOutlineExpanded(items(), next, new Set())).toEqual(new Set([0]))
  })

  it('非法键防御：指向叶节点的键（不应出现）被 safeFilter 清除', () => {
    const seq = items([1, '甲'], [2, '乙'])
    expect(migrateOutlineExpanded(seq, seq, new Set([0, 1]))).toEqual(new Set([0]))
  })

  it('序列未变：键原样保留（同一集合语义）', () => {
    const seq = items([1, '甲'], [2, '乙'], [3, '丙'])
    expect(migrateOutlineExpanded(seq, seq, new Set([0, 1]))).toEqual(new Set([0, 1]))
  })
})
