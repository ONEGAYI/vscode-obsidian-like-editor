// 大纲控制域纯函数契约（#69）：标题索引 → 控制域几何（子树/同级组/行范围）
// 与写操作变更计划（调级/重命名/删除）+ 复制载荷。控制域定义是 #69 右键
// 菜单与 #70 拖拽排序的共用契约——本文件是其单一事实源的语义对拍：
// - 子树 = 下一个 level<=自身 的标题之前全部条目（跨级挂靠与折叠树一致）
// - 同级组 = 同父直接子级（parent 语义；跨级时混合 level 同组）
// - 行范围结束边界 = 下一个 level<=自身 标题行前一行；文末兜底
// - 写操作全部输出 SerChange（一次 CM6 事务 = 单笔 edit.request = 撤销一次），
//   控制域外字节级零变更
// - Setext 标题的调级/重命名规范化为 ATX 单行（口径见模块头）
import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import { extractOutline } from '../../src/webview/outline'
import {
  outlineAtxLine,
  outlineCopyText,
  outlineDeleteChange,
  outlineHeadingSpan,
  outlineLevelChanges,
  outlineRenameChange,
  outlineSectionLineRange,
  outlineSiblingIndices,
  outlineSubtreeIndices,
} from '../../src/webview/outlineSection'

// 样例文档：多级嵌套 + 跨级（H5 挂 H2 下）+ 同级多个 + Setext（独立段，
// 前置空行防 lazy continuation 吞并）+ 文末段标题。
// 行号（1 基）：1 Alpha 3 Beta 5 Gamma 7 Delta 9 Epsilon 11 Zeta 14 Setext 17 Omega
const DOC = [
  '# Alpha',
  'Alpha 内容',
  '## Beta',
  'Beta 内容',
  '### Gamma',
  'Gamma 内容',
  '## Delta',
  'Delta 内容',
  '##### Epsilon',
  'Epsilon 内容',
  '# Zeta',
  'Zeta 内容',
  '',
  'Setext 标题',
  '==================',
  'Setext 内容',
  '## Omega',
  'Omega 内容',
].join('\n')

const doc = Text.of(DOC.split('\n'))
const items = extractOutline(doc)

/** 应用一组变更（升序互不重叠）得到结果文本（写回语义的对拍器） */
function applyChanges(text: string, changes: ReadonlyArray<{ offset: number; length: number; text: string }>): string {
  let out = text
  for (const c of [...changes].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, c.offset) + c.text + out.slice(c.offset + c.length)
  }
  return out
}

describe('控制域几何：子树与同级组（跨级挂靠语义）', () => {
  it('条目序列解析正确（前置：8 个标题，Setext level 1）', () => {
    expect(items.map((i) => [i.level, i.text, i.line])).toEqual([
      [1, 'Alpha', 1],
      [2, 'Beta', 3],
      [3, 'Gamma', 5],
      [2, 'Delta', 7],
      [5, 'Epsilon', 9],
      [1, 'Zeta', 11],
      [1, 'Setext 标题', 14],
      [2, 'Omega', 17],
    ])
  })

  it('子树 = 下一个 level<=自身 之前全部条目（含自身；跨级 H5 挂 H2 下）', () => {
    expect(outlineSubtreeIndices(items, 0)).toEqual([0, 1, 2, 3, 4])
    expect(outlineSubtreeIndices(items, 1)).toEqual([1, 2])
    expect(outlineSubtreeIndices(items, 2)).toEqual([2]) // 叶
    expect(outlineSubtreeIndices(items, 3)).toEqual([3, 4]) // 跨级：Epsilon 归 Delta
    expect(outlineSubtreeIndices(items, 5)).toEqual([5])
    expect(outlineSubtreeIndices(items, 6)).toEqual([6, 7]) // Setext H1 含 Omega
    expect(outlineSubtreeIndices(items, 7)).toEqual([7])
  })

  it('子树越界与空序列防御：返回空数组', () => {
    expect(outlineSubtreeIndices([], 0)).toEqual([])
    expect(outlineSubtreeIndices(items, -1)).toEqual([])
    expect(outlineSubtreeIndices(items, items.length)).toEqual([])
  })

  it('同级组 = 同父直接子级（含自身）；跨级挂靠时混合 level 同组', () => {
    // parents: Alpha/Beta/Gamma/Delta/Epsilon/Zeta/Setext/Omega
    //        = null/0/1/0/3/null/null/6
    expect(outlineSiblingIndices(items, 0)).toEqual([0, 5, 6]) // 顶层组
    expect(outlineSiblingIndices(items, 1)).toEqual([1, 3]) // Alpha 的直接子级
    expect(outlineSiblingIndices(items, 4)).toEqual([4]) // Delta 唯一直接子级（跨级孤子）
    expect(outlineSiblingIndices(items, 7)).toEqual([7]) // Setext 的孤子
    expect(outlineSiblingIndices(items, 2)).toEqual([2])
  })

  it('同级组越界防御：返回空数组', () => {
    expect(outlineSiblingIndices([], 0)).toEqual([])
    expect(outlineSiblingIndices(items, 99)).toEqual([])
  })
})

describe('控制域行范围：结束边界 = 下一个 level<=自身 标题前一行；文末兜底', () => {
  it('中间标题：含正文直到下一同级/更浅标题行之前', () => {
    expect(outlineSectionLineRange(items, 1, 18)).toEqual({ startLine: 3, endLine: 6 })
    expect(outlineSectionLineRange(items, 3, 18)).toEqual({ startLine: 7, endLine: 10 }) // 跨级子随父
    expect(outlineSectionLineRange(items, 0, 18)).toEqual({ startLine: 1, endLine: 10 })
  })

  it('叶标题与顶层相邻：段边界立即收敛', () => {
    expect(outlineSectionLineRange(items, 2, 18)).toEqual({ startLine: 5, endLine: 6 })
    expect(outlineSectionLineRange(items, 5, 18)).toEqual({ startLine: 11, endLine: 13 }) // 含段尾空行
  })

  it('末标题控制域到文末（文末兜底）；Setext 段含内容行', () => {
    expect(outlineSectionLineRange(items, 6, 18)).toEqual({ startLine: 14, endLine: 18 })
    expect(outlineSectionLineRange(items, 7, 18)).toEqual({ startLine: 17, endLine: 18 })
  })

  it('文末有空行时 endLine 仍为文档行数（行数含尾空行）', () => {
    const trailing = Text.of([...DOC.split('\n'), '', ''].flat())
    expect(outlineSectionLineRange(items, 7, trailing.lines)).toEqual({ startLine: 17, endLine: 20 })
  })

  it('越界防御：返回 null', () => {
    expect(outlineSectionLineRange(items, -1, 18)).toBeNull()
    expect(outlineSectionLineRange(items, items.length, 18)).toBeNull()
  })
})

describe('标题区偏移与 ATX 行文本（Setext 语义）', () => {
  it('ATX 标题区 = 单行 [line.from, line.to]', () => {
    expect(outlineHeadingSpan(doc, items[1]!)).toEqual({ from: DOC.indexOf('## Beta'), to: DOC.indexOf('## Beta') + '## Beta'.length })
  })

  it('Setext 标题区 = 内容行 + 下划线行', () => {
    const from = DOC.indexOf('Setext 标题')
    expect(outlineHeadingSpan(doc, items[6]!)).toEqual({ from, to: from + 'Setext 标题\n=================='.length })
  })

  it('ATX 行文本：# 数量 + 空格 + 原文（含行内标记）', () => {
    expect(outlineAtxLine(1, 'Alpha')).toBe('# Alpha')
    expect(outlineAtxLine(3, '**粗** 与 `码`')).toBe('### **粗** 与 `码`')
  })
})

describe('调整层级：四项写回（钳制/递归/控制域外零变更/单事务）', () => {
  it('增加一级：重写 # 数量，控制域外内容零变更', () => {
    const changes = outlineLevelChanges(doc, items, 1, 1, false)
    expect(changes).toEqual([
      { offset: DOC.indexOf('## Beta'), length: '## Beta'.length, text: '### Beta' },
    ])
    const after = applyChanges(DOC, changes!)
    expect(after).toContain('### Beta')
    expect(after).toContain('Beta 内容') // 控制域内正文不动
    expect(after).toContain('## Delta') // 兄弟不动
  })

  it('递归增加：整棵子树逐条 +1', () => {
    const changes = outlineLevelChanges(doc, items, 1, 1, true)
    expect(changes).toEqual([
      { offset: DOC.indexOf('## Beta'), length: '## Beta'.length, text: '### Beta' },
      { offset: DOC.indexOf('### Gamma'), length: '### Gamma'.length, text: '#### Gamma' },
    ])
  })

  it('递归增加跨级子树：H5 Epsilon 随 Delta 子树 +1', () => {
    const changes = outlineLevelChanges(doc, items, 3, 1, true)
    expect(changes).toEqual([
      { offset: DOC.indexOf('## Delta'), length: '## Delta'.length, text: '### Delta' },
      { offset: DOC.indexOf('##### Epsilon'), length: '##### Epsilon'.length, text: '###### Epsilon' },
    ])
  })

  it('H1 非递归减少钳制不动：无可变更返回 null', () => {
    expect(outlineLevelChanges(doc, items, 0, -1, false)).toBeNull()
  })

  it('H1 递归减少：自身钳制不动，子树内更深层照常 -1', () => {
    const changes = outlineLevelChanges(doc, items, 0, -1, true)
    const after = applyChanges(DOC, changes!)
    expect(after).toContain('# Alpha') // H1 不动
    expect(after).toContain('# Beta') // H2→H1
    expect(after).toContain('## Gamma') // H3→H2
    expect(after).toContain('# Delta') // H2→H1
    expect(after).toContain('#### Epsilon') // H5→H4
    expect(changes).toEqual([
      { offset: DOC.indexOf('## Beta'), length: '## Beta'.length, text: '# Beta' },
      { offset: DOC.indexOf('### Gamma'), length: '### Gamma'.length, text: '## Gamma' },
      { offset: DOC.indexOf('## Delta'), length: '## Delta'.length, text: '# Delta' },
      { offset: DOC.indexOf('##### Epsilon'), length: '##### Epsilon'.length, text: '#### Epsilon' },
    ])
  })

  it('H6 增加钳制不动：子树递归时 H6 条目跳过、其余照动', () => {
    const maxed = Text.of(['# H', '', '###### Six', '', '## Two', ''].join('\n').split('\n'))
    const maxedItems = extractOutline(maxed)
    // Six 无子树且已 H6：增加 → null（自身钳制且无子树可动）
    expect(outlineLevelChanges(maxed, maxedItems, 1, 1, false)).toBeNull()
    expect(outlineLevelChanges(maxed, maxedItems, 1, 1, true)).toBeNull() // H6 无子树，递归同空
    // H 子树含 Six：H→H2、Six H6 钳制跳过、Two H2→H3
    const changes = outlineLevelChanges(maxed, maxedItems, 0, 1, true)
    expect(changes).toEqual([
      { offset: 0, length: 3, text: '## H' },
      { offset: maxed.toString().indexOf('## Two'), length: '## Two'.length, text: '### Two' },
    ])
  })

  it('Setext 调级规范化为 ATX 单行（内容行+下划线行 → 一行）', () => {
    const changes = outlineLevelChanges(doc, items, 6, 1, false)
    const from = DOC.indexOf('Setext 标题')
    expect(changes).toEqual([
      { offset: from, length: 'Setext 标题\n=================='.length, text: '## Setext 标题' },
    ])
    const after = applyChanges(DOC, changes!)
    expect(after).toContain('## Setext 标题')
    expect(after).not.toContain('====')
  })

  it('减少一级：H2→H1；子树递归减少跨级深标题', () => {
    const changes = outlineLevelChanges(doc, items, 3, -1, true)
    expect(changes).toEqual([
      { offset: DOC.indexOf('## Delta'), length: '## Delta'.length, text: '# Delta' },
      { offset: DOC.indexOf('##### Epsilon'), length: '##### Epsilon'.length, text: '#### Epsilon' },
    ])
  })

  it('变更按 offset 升序（一次事务多段的稳定序）', () => {
    const changes = outlineLevelChanges(doc, items, 0, 1, true)
    expect(changes!.map((c) => c.offset)).toEqual([...changes!.map((c) => c.offset)].sort((a, b) => a - b))
  })

  it('越界防御：返回 null', () => {
    expect(outlineLevelChanges(doc, items, 99, 1, false)).toBeNull()
    expect(outlineLevelChanges(doc, [], 0, 1, false)).toBeNull()
  })
})

describe('重命名：编辑原文、整标题区替换为 ATX 行', () => {
  it('ATX 标题：整行替换（# 数量保持，原文可含标记）', () => {
    const changes = outlineRenameChange(doc, items, 1, '**Beta** 新名')
    expect(changes).toEqual({
      offset: DOC.indexOf('## Beta'),
      length: '## Beta'.length,
      text: '## **Beta** 新名',
    })
  })

  it('Setext 标题：两行（内容+下划线）替换为 ATX 单行', () => {
    const changes = outlineRenameChange(doc, items, 6, '改名')
    expect(changes).toEqual({
      offset: DOC.indexOf('Setext 标题'),
      length: 'Setext 标题\n=================='.length,
      text: '# 改名',
    })
  })

  it('越界防御：返回 null', () => {
    expect(outlineRenameChange(doc, items, -1, 'x')).toBeNull()
  })
})

describe('删除：整控制域（标题行+内容直到下一同级/更浅标题）', () => {
  it('中间段：吃掉段前换行，相邻段内容不丢不重排', () => {
    const changes = outlineDeleteChange(doc, items, 1)
    const betaFrom = DOC.indexOf('## Beta')
    const gammaEnd = DOC.indexOf('Gamma 内容') + 'Gamma 内容'.length // 段尾（Gamma 内容行行尾）
    expect(changes).toEqual({
      offset: betaFrom - 1, // 吃掉前一行换行：段前内容行与后段直接相接
      length: gammaEnd - (betaFrom - 1),
      text: '',
    })
    const after = applyChanges(DOC, [changes!])
    expect(after).toBe([
      '# Alpha',
      'Alpha 内容',
      '## Delta',
      'Delta 内容',
      '##### Epsilon',
      'Epsilon 内容',
      '# Zeta',
      'Zeta 内容',
      '',
      'Setext 标题',
      '==================',
      'Setext 内容',
      '## Omega',
      'Omega 内容',
    ].join('\n'))
  })

  it('首行段：从 0 开始删除（不留开头空行）', () => {
    const changes = outlineDeleteChange(doc, items, 0)
    expect(changes!.offset).toBe(0)
    const after = applyChanges(DOC, [changes!])
    expect(after.startsWith('# Zeta')).toBe(true)
    expect(after).toContain('Omega 内容') // 后续完整保留
  })

  it('文末段：删到 doc 末尾（前一行成文末，无残留空行）', () => {
    const changes = outlineDeleteChange(doc, items, 7)
    const after = applyChanges(DOC, [changes!])
    expect(after.endsWith('Setext 内容')).toBe(true)
    expect(after).not.toContain('Omega')
  })

  it('跨级子树整体删除：Epsilon 随 Delta 段（下一个 level<=2 之前）', () => {
    const changes = outlineDeleteChange(doc, items, 3)
    const after = applyChanges(DOC, [changes!])
    expect(after).not.toContain('Delta')
    expect(after).not.toContain('Epsilon')
    expect(after).toContain('Gamma 内容') // 前段完整
    expect(after).toContain('# Zeta') // 后段完整
  })

  it('唯一标题删除：空文档', () => {
    const single = Text.of(['# 唯一', '内容', ''].join('\n').split('\n'))
    const singleItems = extractOutline(single)
    const changes = outlineDeleteChange(single, singleItems, 0)
    expect(applyChanges(single.toString(), [changes!])).toBe('')
  })

  it('越界防御：返回 null', () => {
    expect(outlineDeleteChange(doc, items, 8)).toBeNull()
  })
})

describe('复制载荷：四种文本形态（标题链接由宿主拼接，不经此）', () => {
  const styled = Text.of(['# **重点** 结论', '内容', '## *斜体*', '内容', '### 深', '', '# 顶层二', '尾', ''].join('\n').split('\n'))
  const styledItems = extractOutline(styled)

  it('标题：剥标记可见文本（plainText）', () => {
    expect(outlineCopyText('heading', styled, styledItems, 0)).toBe('重点 结论')
  })

  it('标题和兄弟标题：同父全部标题（含自身），逐行 plainText', () => {
    // 顶层组 = 0 与 3
    expect(outlineCopyText('siblings', styled, styledItems, 0)).toBe('重点 结论\n顶层二')
    // Alpha 直接子级 = 仅斜体（深 H3 挂斜体下，非 Alpha 直接子级）
    expect(outlineCopyText('siblings', styled, styledItems, 1)).toBe('斜体')
    expect(outlineCopyText('siblings', styled, styledItems, 2)).toBe('深') // 斜体的孤子
  })

  it('标题和子标题：控制域内全部后代标题（含自身）', () => {
    expect(outlineCopyText('children', styled, styledItems, 0)).toBe('重点 结论\n斜体\n深')
    expect(outlineCopyText('children', styled, styledItems, 2)).toBe('深') // 叶 = 仅自身
  })

  it('该段内容：整控制域源文（含标题行与正文，标记原样）', () => {
    expect(outlineCopyText('section', styled, styledItems, 1)).toBe('## *斜体*\n内容\n### 深')
    expect(outlineCopyText('section', styled, styledItems, 0)).toBe('# **重点** 结论\n内容\n## *斜体*\n内容\n### 深')
  })

  it('该段内容（文末段剥尾空行——复制单节不带尾部空行）', () => {
    expect(outlineCopyText('section', styled, styledItems, 3)).toBe('# 顶层二\n尾')
  })

  it('越界防御：返回 null', () => {
    expect(outlineCopyText('heading', styled, styledItems, 9)).toBeNull()
  })
})
