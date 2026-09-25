// 大纲拖拽排序纯函数契约（#70）：控制域原子移动计划 = 源整段剪切 + 目标
// 整段插入合并为一次编辑事务（升序互不重叠 SerChange，一次 CM6 dispatch
// = 单笔 edit.request = 撤销一次）。本文件是语义单一事实源的对拍：
// - 移动原子 = 被拖标题的整个控制域（outlineSectionLineRange 同款几何），
//   段尾空行属于该控制域、随段搬移
// - 三态落点：before/after 对齐目标层级（delta = to.level - from.level），
//   inside = 目标 level + 1；子树整体递归同步调级（逐条 clamp 1..6）
// - 误伤红线：控制域外内容字节级零变更（frontmatter、代码围栏内相似结构、
//   跨级标题挂靠、Setext 段原样保留；Setext 仅在被搬移段子树内规范化 ATX）
// - 无效落点：目标在源子树内（含自身）返回 null，不产生任何变更
// - 三态命中判定（outlineDropPositionAt）：上缘 25% before、下缘 25%
//   after、中部 50% inside
import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { extractOutline } from '../../src/webview/outline'
import {
  outlineDropAllowed,
  outlineDropPositionAt,
  outlineMovePlan,
} from '../../src/webview/outlineDrag'

/** 应用一组变更（升序互不重叠；从后往前套用原坐标）得到结果文本 */
function applyChanges(
  text: string,
  changes: ReadonlyArray<{ offset: number; length: number; text: string }>,
): string {
  let out = text
  for (const c of [...changes].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, c.offset) + c.text + out.slice(c.offset + c.length)
  }
  return out
}

/** 变更序列不变式：升序且互不重叠（CM6 单事务 dispatch 的前提） */
function assertOrderedChanges(
  changes: ReadonlyArray<{ offset: number; length: number; text: string }>,
  docLength: number,
): void {
  let prevEnd = -1
  for (const c of changes) {
    expect(c.offset, `变更起点应为非负（实际 ${c.offset}）`).toBeGreaterThanOrEqual(0)
    expect(c.offset + c.length, `变更终点不得越界（实际 ${c.offset + c.length} > ${docLength}）`)
      .toBeLessThanOrEqual(docLength)
    expect(c.offset, `变更应升序（${c.offset} 应大于前项终点 ${prevEnd}）`).toBeGreaterThan(prevEnd)
    prevEnd = c.offset + c.length
  }
}

/** 误伤红线的字节级不变式：结果剔除搬移段后 === 原文剔除源段。
 *  （控制域按嵌套定义——父域包含子域，"段级保留"按此口径才精确：
 *  除搬移块外的一切字节，含 frontmatter/围栏/Setext/空行，原样原序） */
function assertMovedSegmentIsolated(
  original: string,
  result: string,
  plan: { sliceFrom: number; sliceTo: number; movedText: string },
): void {
  const removeSource = original.slice(0, plan.sliceFrom) + original.slice(plan.sliceTo)
  expect(result.replace(plan.movedText, ''), '控制域外内容应逐字节零变更')
    .toBe(removeSource)
}

// 样例 A：多级 + 跨级挂靠（丁 H4 挂乙 H2 下）+ 同级 + 文末段（有尾换行）。
// 行号：1 甲 5 乙 9 丁 13 丙 17 戊；20 行（末尾空行 = 文档以 \n 结束）
const DOC_A = [
  '# 甲', '', '甲内容', '',
  '## 乙', '', '乙内容', '',
  '#### 丁', '', '丁内容', '',
  '## 丙', '', '丙内容', '',
  '# 戊', '', '戊内容', '',
].join('\n')
const docA = Text.of(DOC_A.split('\n'))
const itemsA = extractOutline(docA)

// 样例 B：frontmatter + 代码围栏内伪标题 + Setext 段 + 文末段无尾换行。
// 行号：5 主 11 副标题(Setext H1) 16 尾
const DOC_B = [
  '---', 'title: 样例', '---', '',
  '# 主', '',
  '```text', '# 围栏内伪标题', '```', '',
  '副标题', '========', '',
  'Setext 内容', '',
  '# 尾', '尾内容',
].join('\n')
const docB = Text.of(DOC_B.split('\n'))
const itemsB = extractOutline(docB)

// 样例 C：H6 边界（clamp 用）
const DOC_C = '# A\n\n## B\n\n###### C\n\nc 内容\n\n# D\n\nd 内容'
const docC = Text.of(DOC_C.split('\n'))
const itemsC = extractOutline(docC)

describe('拖拽前置：样例序列（防止后续断言建立在错误地基上）', () => {
  it('样例 A：5 条标题，跨级丁挂乙下', () => {
    expect(itemsA.map((i) => [i.level, i.text])).toEqual([
      [1, '甲'], [2, '乙'], [4, '丁'], [2, '丙'], [1, '戊'],
    ])
  })

  it('样例 B：frontmatter 与围栏内伪标题不产条目，Setext 为 H1', () => {
    expect(itemsB.map((i) => [i.level, i.text, i.line])).toEqual([
      [1, '主', 5], [1, '副标题', 11], [1, '尾', 16],
    ])
  })
})

describe('落点有效性（outlineDropAllowed）', () => {
  it('目标在源子树内（含自身、含跨级挂靠后代）一律无效', () => {
    // 甲的子树 = [甲,乙,丁,丙]（乙丁丙全挂甲下）
    expect(outlineDropAllowed(itemsA, 0, 0)).toBe(false)
    expect(outlineDropAllowed(itemsA, 0, 1)).toBe(false)
    expect(outlineDropAllowed(itemsA, 0, 2)).toBe(false)
    expect(outlineDropAllowed(itemsA, 0, 3)).toBe(false)
    // 戊不在甲子树内 → 有效
    expect(outlineDropAllowed(itemsA, 0, 4)).toBe(true)
    // 乙的子树 = [乙,丁]（跨级丁挂乙下）
    expect(outlineDropAllowed(itemsA, 1, 2)).toBe(false)
    expect(outlineDropAllowed(itemsA, 1, 3)).toBe(true)
  })

  it('越界索引无效', () => {
    expect(outlineDropAllowed(itemsA, -1, 3)).toBe(false)
    expect(outlineDropAllowed(itemsA, 0, 99)).toBe(false)
  })
})

describe('三态落点命中判定（outlineDropPositionAt：边缘 25% 容差）', () => {
  const top = 100
  const height = 40

  it('上缘 1/4 内 before，下缘 1/4 内 after，中部 inside', () => {
    expect(outlineDropPositionAt(top, height, top + 4)).toBe('before')
    expect(outlineDropPositionAt(top, height, top + 9)).toBe('before') // < 0.25
    expect(outlineDropPositionAt(top, height, top + 10)).toBe('inside') // = 0.25 落中部
    expect(outlineDropPositionAt(top, height, top + 20)).toBe('inside')
    expect(outlineDropPositionAt(top, height, top + 30)).toBe('inside') // = 0.75 落中部
    expect(outlineDropPositionAt(top, height, top + 31)).toBe('after') // > 0.75
    expect(outlineDropPositionAt(top, height, top + 38)).toBe('after')
  })

  it('指针越出条目上下缘时钳制到最近态（合成事件坐标漂移防御）', () => {
    expect(outlineDropPositionAt(top, height, top - 50)).toBe('before')
    expect(outlineDropPositionAt(top, height, top + height + 50)).toBe('after')
  })
})

describe('移动计划（outlineMovePlan）：三态写回全文对拍', () => {
  it('before：源段整段搬移到目标标题行首，对齐目标层级', () => {
    // 丙(3) 拖到 乙(1) 之前：丙段（含尾空行）整体移到乙行首；同层 delta 0
    const plan = outlineMovePlan(docA, itemsA, 3, 1, 'before')!
    expect(plan).not.toBeNull()
    assertOrderedChanges(plan.changes, docA.length)
    const result = applyChanges(DOC_A, plan.changes)
    expect(result).toBe([
      '# 甲', '', '甲内容', '',
      '## 丙', '', '丙内容', '',
      '## 乙', '', '乙内容', '',
      '#### 丁', '', '丁内容', '',
      '# 戊', '', '戊内容', '',
    ].join('\n'))
    assertMovedSegmentIsolated(DOC_A, result, plan)
  })

  it('before 调级：源标题对齐目标层级，子树递归同步', () => {
    // 丁(2,H4) 拖到 戊(4,H1) 之前 → 丁对齐 H1，跨级随行动作无（丁是叶）
    const plan = outlineMovePlan(docA, itemsA, 2, 4, 'before')!
    const result = applyChanges(DOC_A, plan.changes)
    expect(result).toBe([
      '# 甲', '', '甲内容', '',
      '## 乙', '', '乙内容', '',
      '## 丙', '', '丙内容', '',
      '# 丁', '', '丁内容', '',
      '# 戊', '', '戊内容', '',
    ].join('\n'))
    assertMovedSegmentIsolated(DOC_A, result, plan)
  })

  it('after：插入点 = 目标控制域末尾，源子树整体搬移并递归调级', () => {
    // 乙(1) 拖到 戊(4) 之后：乙+丁（跨级子树）随行，乙对齐 H1、丁降 H3
    const plan = outlineMovePlan(docA, itemsA, 1, 4, 'after')!
    assertOrderedChanges(plan.changes, docA.length)
    expect(plan.levelDelta).toBe(-1)
    const result = applyChanges(DOC_A, plan.changes)
    expect(result).toBe([
      '# 甲', '', '甲内容', '',
      '## 丙', '', '丙内容', '',
      '# 戊', '', '戊内容',
      '# 乙', '', '乙内容', '',
      '### 丁', '', '丁内容', '', '',
    ].join('\n'))
    assertMovedSegmentIsolated(DOC_A, result, plan)
  })

  it('inside：成为目标最后子级（level+1），插入点在目标控制域末尾', () => {
    // 丁(2,H4) 拖到 丙(3,H2) 内部 → 丁成为丙的子级 H3，物理移到丙段尾
    const plan = outlineMovePlan(docA, itemsA, 2, 3, 'inside')!
    expect(plan.levelDelta).toBe(-1) // 2 + 1 - 4
    const result = applyChanges(DOC_A, plan.changes)
    expect(result).toBe([
      '# 甲', '', '甲内容', '',
      '## 乙', '', '乙内容', '',
      '## 丙', '', '丙内容', '',
      '### 丁', '', '丁内容', '',
      '# 戊', '', '戊内容', '',
    ].join('\n'))
    assertMovedSegmentIsolated(DOC_A, result, plan)
  })

  it('inside 落 H6 目标：调级 clamp 不越 6', () => {
    // D(H1) 拖到 C(H6) 内部 → 目标 level+1 = 7，clamp 到 6；插入点与源段
    // 首重合（C 段尾 = D 段首），合并为单条整段替换
    const plan = outlineMovePlan(docC, itemsC, 3, 2, 'inside')!
    assertOrderedChanges(plan.changes, docC.length)
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]!.text).toContain('###### D')
    const result = applyChanges(DOC_C, plan.changes)
    expect(result).toBe('# A\n\n## B\n\n###### C\n\nc 内容\n\n###### D\n\nd 内容')
    assertMovedSegmentIsolated(DOC_C, result, plan)
  })
})

describe('移动计划：误伤红线（控制域外字节级零变更）', () => {
  it('frontmatter 与代码围栏内相似结构逐字节保留（搬移段携带围栏随行）', () => {
    // 主(0) 拖到 副标题(1) 之后：主段含围栏整体随行；Setext 段原样
    const plan = outlineMovePlan(docB, itemsB, 0, 1, 'after')!
    assertOrderedChanges(plan.changes, docB.length)
    const result = applyChanges(DOC_B, plan.changes)
    expect(result).toBe([
      '---', 'title: 样例', '---', '',
      '副标题', '========', '',
      'Setext 内容', '',
      '# 主', '',
      '```text', '# 围栏内伪标题', '```', '',
      '# 尾', '尾内容',
    ].join('\n'))
    // frontmatter 逐字节未动
    expect(result.startsWith('---\ntitle: 样例\n---\n')).toBe(true)
    // 围栏（属于搬移段自身）随行原样
    expect(result).toContain('```text\n# 围栏内伪标题\n```')
    // Setext 段（控制域外）原样保留
    expect(result).toContain('副标题\n========\n\nSetext 内容')
    assertMovedSegmentIsolated(DOC_B, result, plan)
  })

  it('Setext 标题被搬移时规范化为 ATX 单行（控制域内允许；delta 0 同样规范）', () => {
    // 副标题(1) 拖到 尾(2) 之前：Setext 标题区（内容+下划线两行）→ ATX 一行
    const plan = outlineMovePlan(docB, itemsB, 1, 2, 'before')!
    const result = applyChanges(DOC_B, plan.changes)
    expect(result).toBe([
      '---', 'title: 样例', '---', '',
      '# 主', '',
      '```text', '# 围栏内伪标题', '```', '',
      '# 副标题', '',
      'Setext 内容', '',
      '# 尾', '尾内容',
    ].join('\n'))
    assertMovedSegmentIsolated(DOC_B, result, plan)
  })

  it('文末段（无尾换行）搬走后：插入文本补尾换行，不与后续行粘连', () => {
    // 尾(2) 拖到 主(0) 之前：尾段 "# 尾\n尾内容"（无尾 \n）插入行首前补齐；
    // 副标题段尾空行（原 # 尾 前的领空）留在原位成为文档尾
    const plan = outlineMovePlan(docB, itemsB, 2, 0, 'before')!
    const result = applyChanges(DOC_B, plan.changes)
    expect(result).toBe([
      '---', 'title: 样例', '---', '',
      '# 尾', '尾内容',
      '# 主', '',
      '```text', '# 围栏内伪标题', '```', '',
      '副标题', '========', '',
      'Setext 内容', '', '',
    ].join('\n'))
    assertMovedSegmentIsolated(DOC_B, result, plan)
  })

  it('插入点无前置换行（文末无尾换行的 after）时，搬移段前置换行防粘连', () => {
    // 主(0) 拖到 尾(2) 之后：插入点 = doc.length，前一字符非 \n → 前置补 \n
    const plan = outlineMovePlan(docB, itemsB, 0, 2, 'after')!
    const result = applyChanges(DOC_B, plan.changes)
    expect(result.endsWith('# 尾\n尾内容\n# 主\n\n```text\n# 围栏内伪标题\n```\n\n')).toBe(true)
    assertMovedSegmentIsolated(DOC_B, result, plan)
  })
})

describe('移动计划：无效落点与退化情形', () => {
  it('拖入自身控制域内部（含自身）返回 null：三态同拒', () => {
    expect(outlineMovePlan(docA, itemsA, 0, 0, 'before')).toBeNull()
    expect(outlineMovePlan(docA, itemsA, 0, 1, 'inside')).toBeNull()
    expect(outlineMovePlan(docA, itemsA, 0, 2, 'before')).toBeNull() // 跨级后代
    expect(outlineMovePlan(docA, itemsA, 1, 2, 'after')).toBeNull()
  })

  it('越界索引返回 null', () => {
    expect(outlineMovePlan(docA, itemsA, -1, 4, 'before')).toBeNull()
    expect(outlineMovePlan(docA, itemsA, 0, 99, 'after')).toBeNull()
  })

  it('插入点与源段首重合（after 紧邻前兄弟）合并为单条整段替换（原地调级语义）', () => {
    // 样例 C：A(0) 拖到 B(1) 内部？B ∈ subtree(A) 无效——改用 D(3) after C(2)：
    // C 段尾换行后 = D 段首，插入点 == sliceFrom → 单变更
    const plan = outlineMovePlan(docC, itemsC, 3, 2, 'after')!
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]!.length).toBe(plan.sliceTo - plan.sliceFrom)
    const result = applyChanges(DOC_C, plan.changes)
    // D 对齐 C 的层级（H6）；物理位置不变
    expect(result).toBe('# A\n\n## B\n\n###### C\n\nc 内容\n\n###### D\n\nd 内容')
  })

  it('搬移段文本（movedText）以换行收尾（有后续内容的插入点）', () => {
    const plan = outlineMovePlan(docB, itemsB, 2, 0, 'before')!
    expect(plan.movedText.endsWith('\n')).toBe(true)
    const plan2 = outlineMovePlan(docB, itemsB, 0, 2, 'after')!
    expect(plan2.movedText.endsWith('\n')).toBe(true)
  })
})
