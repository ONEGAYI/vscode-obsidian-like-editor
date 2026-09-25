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
  outlineChangesOrdered,
  outlineCopyText,
  outlineDeleteChange,
  outlineHeadingSpan,
  outlineLevelChanges,
  outlineRenameChange,
  outlineSectionLineRange,
  outlineSiblingIndices,
  outlineSplitContainerPrefix,
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

/** 重命名后的文档文本（断言对象是用户看到的文档文本，不是 span 数值） */
function renameTo(docText: string, index: number, newText: string): string {
  const doc = Text.of(docText.split('\n'))
  const items = extractOutline(doc)
  const change = outlineRenameChange(doc, items, index, newText)
  expect(change, `条目 ${index} 应有重命名变更`).not.toBeNull()
  return applyChanges(docText, [change!])
}

/** 文档经仓库自己的解析器（extractOutline）复解析后的 [级别, 原文] 序列
 *  ——写操作结果的裁判：标题没消失、没多出幻影标题，都由它给结论 */
function outlineOf(docText: string): Array<[number, string]> {
  const doc = Text.of(docText.split('\n'))
  return extractOutline(doc).map((item) => [item.level, item.text])
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

  it('同名标题逐项独立（不合并；子树与同级按文档序索引区分）', () => {
    const dup = Text.of(['# 同名', '', '## 同名', '', '正文', '', '## 同名', '', '# 同名', ''].join('\n').split('\n'))
    const dupItems = extractOutline(dup)
    expect(dupItems.map((i) => [i.level, i.line])).toEqual([[1, 1], [2, 3], [2, 7], [1, 9]])
    // 第二个同名 H2（index 2）的控制域不含第一个（索引序天然区分）
    expect(outlineSubtreeIndices(dupItems, 2)).toEqual([2])
    expect(outlineSectionLineRange(dupItems, 2, dup.lines)).toEqual({ startLine: 7, endLine: 8 })
    // 第一个 H1 的子树 = 前两个同名 H2；末个同名 H1 是顶层独立段
    expect(outlineSubtreeIndices(dupItems, 0)).toEqual([0, 1, 2])
    expect(outlineSectionLineRange(dupItems, 3, dup.lines)).toEqual({ startLine: 9, endLine: dup.lines })
    // 删除第二个同名 H2：只删其段，第一个同名段完整保留
    const change = outlineDeleteChange(dup, dupItems, 2)!
    const after = dup.toString().slice(0, change.offset) + change.text + dup.toString().slice(change.offset + change.length)
    expect(after.split('\n').filter((l) => l === '## 同名')).toHaveLength(1)
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

// ---- review-loops A1：超长 Setext 标题区几何（废除 8 行扫描截断） ----

describe('超长 Setext 标题的标题区几何（review-loops A1）', () => {
  // 10 行内容 + 下划线：CommonMark 完全合法（长段落下接 === 即 Setext H1）
  const longDoc = Text.of([
    '首行内容',
    '内容第2行', '内容第3行', '内容第4行', '内容第5行',
    '内容第6行', '内容第7行', '内容第8行', '内容第9行', '内容第10行',
    '===',
    '后续段落',
  ])
  const longItems = extractOutline(longDoc)

  it('extractOutline 前置：10 行内容 Setext 产出单条目（level 1、内容首行）', () => {
    expect(longItems.length).toBe(1)
    expect(longItems[0]).toMatchObject({ level: 1, line: 1 })
  })

  it('outlineHeadingSpan 覆盖全部内容行与下划线行（不再 8 行截断）', () => {
    expect(outlineHeadingSpan(longDoc, longItems[0]!))
      .toEqual({ from: 0, to: longDoc.line(11).to })
  })

  it('重命名整标题区替换：幻影标题不再产生', () => {
    const change = outlineRenameChange(longDoc, longItems, 0, '新名')!
    const after = applyChanges(longDoc.toString(), [change])
    expect(after).toBe('# 新名\n后续段落')
    expect(extractOutline(Text.of(after.split('\n'))).length).toBe(1)
  })

  it('调级整区替换为 ATX（同源修复）', () => {
    const changes = outlineLevelChanges(longDoc, longItems, 0, 1, false)!
    const after = applyChanges(longDoc.toString(), changes)
    expect(after).toBe(`## ${longItems[0]!.text}\n后续段落`)
    expect(extractOutline(Text.of(after.split('\n'))).length).toBe(1)
  })

  it('防御语义：内容行间空行后远距 === 不误认下划线（空行即停，回退单行）', () => {
    // 合法 Setext 内容不含空行；此形态仅在行号漂移的异常输入下出现
    const doc = Text.of(['段落甲', '', '===', '后续'])
    const span = outlineHeadingSpan(doc, { level: 1, text: '段落甲', plainText: '段落甲', line: 1 })
    expect(span).toEqual({ from: 0, to: doc.line(1).to })
  })
})

// ---- review-loops 第 2 轮：容器内 / 缩进标题的标题区几何（写操作不得越过标题区） ----

describe('容器内 / 缩进标题的标题区几何（review-loops 第 2 轮）', () => {
  it('块引用内标题 + 下方 --- 分隔线：只重写标题行，分隔线与正文不动', () => {
    // 旧实现按列 0 判 ATX → `> # 引用标题` 判否 → 进入 Setext 扫描 → 命中
    // 下方 `---` → span 覆盖两行 → 重命名把分隔线一并删除（数据丢失）
    expect(renameTo('> # 引用标题\n---\n正文', 0, '新名')).toBe('> # 新名\n---\n正文')
  })

  it('缩进 1–3 空格的 ATX 标题 + 下方 ---：缩进与分隔线均保留', () => {
    expect(renameTo('   # 缩进标题\n---\n正文', 0, '新名')).toBe('   # 新名\n---\n正文')
  })

  it('缩进标题 + 多行正文 + 远距 ---：正文与分隔线全保留（旧实现整段吞并）', () => {
    const body = ['正文一', '正文二', '正文三', '正文四'].join('\n')
    expect(renameTo(`   # 缩进标题\n${body}\n---\n尾`, 0, '新名'))
      .toBe(`   # 新名\n${body}\n---\n尾`)
  })

  it('缩进的 Setext 下划线（≤3 空格）仍属标题区：重命名不残留下划线行', () => {
    // 旧实现下划线正则锚定列 0 → 未命中 → 单行回退 → 留下 `  ===` 幻影行
    expect(renameTo('标题\n  ===\n正文', 0, '新名')).toBe('# 新名\n正文')
  })

  it('块引用内的 Setext 标题：整标题区替换，容器前缀保留', () => {
    expect(renameTo('> 引用标题\n> ===\n> 正文', 0, '新名')).toBe('> # 新名\n> 正文')
  })

  it('调级同样只动标题区（缩进标题 + 远距 --- 的正文与分隔线保留）', () => {
    const text = '   # 缩进标题\n正文一\n正文二\n---\n尾'
    const doc = Text.of(text.split('\n'))
    const items = extractOutline(doc)
    const changes = outlineLevelChanges(doc, items, 0, 1, false)!
    expect(applyChanges(text, changes)).toBe('   ## 缩进标题\n正文一\n正文二\n---\n尾')
  })

  it('兜底语义：`> 段落` 后的裸 `---` 不是其下划线（解析器同判：该形态无标题节点）', () => {
    // 复核 ⑤ 事实核对：`> 段落\n---` 不经 extractOutline 产出条目——解析器
    // 的 heading 节点为空（下划线行无 `>` 也不是列表续行），`---` 是顶层
    // 分隔线。因此兜底扫描不得吞并它（第 2 轮这条语义正确，保留并补上
    // 「谁给的结论」：由仓库自己的解析器判）。
    const doc = Text.of(['> 段落', '---', '后续'])
    expect(extractOutline(doc)).toEqual([])
    const span = outlineHeadingSpan(doc, { level: 1, text: '段落', plainText: '段落', line: 1 })
    // 兜底区间 = 首行内容起点（容器前缀 `> ` 之后）到首行行尾（不含下一行）
    expect(span).toEqual({ from: 2, to: doc.line(1).to })
  })

  it('真实条目形态（`- T\\n  ===`、`> T\\n>  ===`）确为标题：兜底必须覆盖下划线行', () => {
    // 复核 ⑤：这两种形态是真实条目（解析器产出 SetextHeading），不是「不可达
    // 的异常输入」——因此下划线行必须进入标题区，否则重命名留幻影下划线。
    const cases: Array<{ text: string; from: number }> = [
      { text: '- T\n  ===\n', from: 2 }, // 列表项内容列 2 上的续行
      { text: '> T\n>  ===\n', from: 2 }, // 块引用标记链相同的下划线行
    ]
    for (const { text, from } of cases) {
      const doc = Text.of(text.split('\n'))
      const items = extractOutline(doc)
      expect(items, `${JSON.stringify(text)} 应为真实条目`).toHaveLength(1)
      const span = outlineHeadingSpan(doc, { level: 1, text: 'T', plainText: 'T', line: 1 })
      expect(span, `${JSON.stringify(text)} 兜底应覆盖下划线行`).toEqual({ from, to: doc.line(2).to })
    }
  })
})

// ---- review-loops 第 3 轮：语法树权威标题区 + 兜底几何修正（复核 ①②③④） ----

describe('标题区权威范围：语法树节点优先，启发式只兜底（第 3 轮复核方案）', () => {
  it('extractOutline 逐条携带标题区范围（解析器 heading 节点起点 → 标题块末行行尾）', () => {
    // 范围不含容器标记与缩进（那些字节在范围之前，写回时留在原地）；
    // ATX = 标题行行尾（不含块尾换行），Setext = 下划线行行尾
    const cases: Array<{ text: string; spans: Array<{ from: number; to: number }> }> = [
      { text: '- 父项\n  - # 子标题\n  正文\n---\n尾', spans: [{ from: 9, to: 14 }] },
      { text: '- T\n  U\n  ===\n\nnext', spans: [{ from: 2, to: 13 }] },
      { text: '> T\n>  ===\n\ntext', spans: [{ from: 2, to: 10 }] },
      { text: ' > # 缩进引用标题\n---\n尾', spans: [{ from: 3, to: 11 }] },
      { text: '标题\n  ===\n正文', spans: [{ from: 0, to: 8 }] },
      { text: '　标题\n===\n\ntext', spans: [{ from: 0, to: 7 }] },
    ]
    for (const { text, spans } of cases) {
      const doc = Text.of(text.split('\n'))
      expect(extractOutline(doc).map((item) => item.headingSpan), JSON.stringify(text)).toEqual(spans)
    }
  })

  it('兜底覆盖不到的深层形态（块引用内列表的 Setext）由权威范围兜住', () => {
    // '> - T' 的标记链是 ['>','-']，下划线行 '>   ===' 是 ['>']——兜底判据
    // 认不出这一层（手写条目退化单行，属已知限界）；真条目由语法树范围覆盖
    const input = '> - T\n>   ===\n\ntext'
    const doc = Text.of(input.split('\n'))
    const bare = { level: 1, text: 'T', plainText: 'T', line: 1 }
    expect(outlineHeadingSpan(doc, bare)).toEqual({ from: 4, to: doc.line(1).to })
    const after = renameTo(input, 0, '新名')
    expect(after).toBe('> - # 新名\n\ntext')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('权威范围越界/倒置/与条目行不符/起点非内容列时回退启发式（结果与缺省字段一致）', () => {
    const text = '   # 缩进标题\n---\n正文'
    const doc = Text.of(text.split('\n'))
    const item = extractOutline(doc)[0]!
    const withoutSpan: typeof item = { ...item }
    delete withoutSpan.headingSpan
    const baseline = applyChanges(text, [outlineRenameChange(doc, [withoutSpan], 0, '新名')!])
    expect(baseline).toBe('   # 新名\n---\n正文') // 兜底路径的用户可见结果
    const corrupt: Array<{ from: number; to: number }> = [
      { from: -1, to: 5 }, // 起点越界
      { from: 0, to: doc.length + 1 }, // 终点越界
      { from: 10, to: 3 }, // 倒置
      { from: 3, to: 3 }, // 零长（起点=终点，恰为内容列）：同属退化范围
      { from: 12, to: 16 }, // 与条目行不符（起点落在第 2 行）
      { from: 0, to: 5 }, // 起点不是标题内容列（会与容器前缀重叠）
    ]
    for (const headingSpan of corrupt) {
      const change = outlineRenameChange(doc, [{ ...item, headingSpan }], 0, '新名')
      expect(applyChanges(text, [change!]), JSON.stringify(headingSpan)).toBe(baseline)
    }
  })

  it('零长范围（from === to）同属退化：退化为兜底单行标题区，不产出零长替换（防御纵深）', () => {
    // 真条目的 headingSpan 由语法树产出（node.from < 标题块行尾恒成立），零长
    // 范围没有现网可达路径——本用例防的是未来生产者交出退化范围：只拒
    // `from > to` 的判据会放行零长，它被当权威范围返回后重命名产出
    // { offset: 3, length: 0, text: '# 新名' }，套回文档得 `   # 新名# 缩进标题`
    // （拼接标题、原标题残留在后）。正确行为是退化为兜底：替换整段标题内容
    // （内容起点到行尾；行首缩进/容器前缀按字节留在原地），原标题不留残迹。
    const text = '   # 缩进标题\n---\n正文'
    const doc = Text.of(text.split('\n'))
    const item = extractOutline(doc)[0]!
    const contentFrom = item.headingSpan!.from // 真实内容起点（缩进之后、ATX 标记之前）
    const withoutSpan: typeof item = { ...item }
    delete withoutSpan.headingSpan
    const baseline = applyChanges(text, [outlineRenameChange(doc, [withoutSpan], 0, '新名')!])
    expect(baseline).toBe('   # 新名\n---\n正文') // 兜底口径的用户可见结果
    const headingLine = doc.line(item.line)
    const degenerate = { from: contentFrom, to: contentFrom }
    const rename = outlineRenameChange(doc, [{ ...item, headingSpan: degenerate }], 0, '新名')!
    // 变更必须等于兜底：offset = 内容起点、length = 内容起点到行尾（行首缩进
    // 是容器/缩进前缀，按字节留在原地，不进入替换区间）
    expect(rename).toEqual({
      offset: contentFrom,
      length: headingLine.to - contentFrom,
      text: '# 新名',
    })
    const afterRename = applyChanges(text, [rename])
    expect(afterRename).toBe(baseline)
    expect(afterRename).not.toContain('缩进标题') // 原标题不残留
    expect(outlineOf(afterRename)).toEqual([[1, '新名']])
    // 调级同形态：同样退化为兜底单行标题区（零长 → 内容起点到行尾，无拼接残留）
    const level = outlineLevelChanges(doc, [{ ...item, headingSpan: degenerate }], 0, 1, false)!
    expect(level).toEqual([{
      offset: contentFrom,
      length: headingLine.to - contentFrom,
      text: '## 缩进标题',
    }])
    expect(applyChanges(text, level)).toBe('   ## 缩进标题\n---\n正文')
  })

  it('收紧不影响正常路径：真实条目的权威范围照常优先（与删掉 headingSpan 的兜底结果对照）', () => {
    // 常规 ATX：权威范围与兜底同区间，结果一致——收紧不得让正常条目改道兜底
    const atx = '   # 缩进标题\n---\n正文'
    const atxDoc = Text.of(atx.split('\n'))
    const atxItem = extractOutline(atxDoc)[0]!
    const atxWithout: typeof atxItem = { ...atxItem }
    delete atxWithout.headingSpan
    expect(applyChanges(atx, [outlineRenameChange(atxDoc, [atxItem], 0, '新名')!]))
      .toBe(applyChanges(atx, [outlineRenameChange(atxDoc, [atxWithout], 0, '新名')!]))
    // 兜底认不出标记链的形态（`> - T` 对下划线 `>   ===`，见上一条用例）：
    // 权威范围覆盖下划线行，与兜底（残留幻影 `>   ===`）不同——真条目确实
    // 走的是权威路径，收紧零长判据没有把这条路径一并退化掉
    const input = '> - T\n>   ===\n\ntext'
    const doc = Text.of(input.split('\n'))
    const item = extractOutline(doc)[0]!
    const withoutSpan: typeof item = { ...item }
    delete withoutSpan.headingSpan
    const authoritative = applyChanges(input, [outlineRenameChange(doc, [item], 0, '新名')!])
    const fallback = applyChanges(input, [outlineRenameChange(doc, [withoutSpan], 0, '新名')!])
    expect(authoritative).toBe('> - # 新名\n\ntext')
    expect(fallback).toBe('> - # 新名\n>   ===\n\ntext')
    expect(authoritative).not.toBe(fallback)
    expect(outlineOf(authoritative)).toEqual([[1, '新名']])
  })
})

describe('非 ASCII 空白开头的标题：空白是内容不是缩进（第 3 轮复核 ①）', () => {
  it('全角空格 / NBSP 开头的 Setext：重命名后标题仍在（旧实现产出非标题）', () => {
    // 旧实现按 trimStart 切前缀 → 空白被吞进前缀 → 结果 `　# 新名` 是段落
    // （解析器复解析零条目：标题消失）
    for (const lead of ['\u3000', '\u00a0']) {
      const input = `${lead}标题\n===\n\ntext`
      const after = renameTo(input, 0, '新名')
      expect(after, JSON.stringify(lead)).toBe('# 新名\n\ntext')
      expect(outlineOf(after), JSON.stringify(lead)).toEqual([[1, '新名']])
    }
  })

  it('调级同源：全角空格开头的标题升高一级后仍是标题', () => {
    const text = '\u3000标题\n===\n\ntext'
    const doc = Text.of(text.split('\n'))
    const items = extractOutline(doc)
    const after = applyChanges(text, outlineLevelChanges(doc, items, 0, 1, false)!)
    expect(after).toBe('## 标题\n\ntext')
    expect(outlineOf(after)).toEqual([[2, '标题']])
  })

  it('结构前缀只认 ASCII 空白与容器标记（Unicode 空白留在余下内容里）', () => {
    expect(outlineSplitContainerPrefix('\u3000标题')).toEqual({ prefix: '', markers: [], rest: '\u3000标题' })
    expect(outlineSplitContainerPrefix('\u00a0# 标题')).toEqual({ prefix: '', markers: [], rest: '\u00a0# 标题' })
    expect(outlineSplitContainerPrefix('  - # T')).toEqual({ prefix: '  - ', markers: ['-'], rest: '# T' })
    expect(outlineSplitContainerPrefix('> \t> T')).toEqual({ prefix: '> \t> ', markers: ['>', '>'], rest: 'T' })
  })
})

describe('列表 / 块引用内 Setext：下划线行属标题区（第 3 轮复核 ②④）', () => {
  it('列表内 Setext（内容行续行）：整标题区替换，不产生幻影标题', () => {
    // 旧实现前缀全等比较失败 → 扫描提前中断 → 只替换首行 → `  ===` 成为
    // 下一段落的下划线，凭空多出标题 U
    const after = renameTo('- T\n  U\n  ===\n\nnext', 0, '新名')
    expect(after).toBe('- # 新名\n\nnext')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('列表内 Setext（`---` 下划线，level 2）：下划线行随标题区替换', () => {
    // 旧实现残留 `  ---` 行；新实现整标题区（内容 + 下划线）→ ATX 单行
    const after = renameTo('- T\n  ---\n- 二\n  内容', 0, '新名')
    expect(after).toBe('- ## 新名\n- 二\n  内容')
    expect(outlineOf(after)).toEqual([[2, '新名']])
  })

  it('有序列表内 Setext：内容列上的续行同样覆盖', () => {
    const after = renameTo('1. T\n   ===\n\ntext', 0, '新名')
    expect(after).toBe('1. # 新名\n\ntext')
    expect(after).not.toContain('===')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('块引用内 Setext 下划线空白不对称：标记链相等即覆盖（复核 ④）', () => {
    // `> ` 与 `>  ` 的标记链同为 ['>']：旧实现按前缀串全等比较 → 不等 →
    // 扫描中断 → 重命名后残留 `>  ===`
    expect(renameTo('> T\n>  ===\n\ntext', 0, '新名')).toBe('> # 新名\n\ntext')
    expect(renameTo('> 引用标题\n>  ===\n> 正文', 0, '新名')).toBe('> # 新名\n> 正文')
  })

  it('调级同源：Setext 下划线行随标题区一起被 ATX 行替换（无残留）', () => {
    const text = '- T\n  ===\n\nnext'
    const doc = Text.of(text.split('\n'))
    const items = extractOutline(doc)
    const after = applyChanges(text, outlineLevelChanges(doc, items, 0, 1, false)!)
    expect(after).toBe('- ## T\n\nnext')
    expect(outlineOf(after)).toEqual([[2, 'T']])
  })
})

describe('缩进后的容器标记：ATX 判定与前缀口径一致（第 3 轮复核 ③）', () => {
  it('列表内缩进 ATX：只替换标题文字，列表标记/正文/分隔线逐字节保留', () => {
    // 旧实现按列 0 认容器标记 → `  - # 子标题` 判否 → 进入 Setext 扫描 →
    // 命中远处 `---` → 正文与 `- ` 一起被吞（用户可见的数据丢失）
    const input = '- 父项\n  - # 子标题\n  正文\n---\n尾'
    const after = renameTo(input, 0, '新名')
    expect(after).toBe('- 父项\n  - # 新名\n  正文\n---\n尾')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('缩进 1 空格的块引用 ATX：`>` 与缩进保留（不吞下方 `---`）', () => {
    const after = renameTo(' > # 缩进引用标题\n---\n尾', 0, '新名')
    expect(after).toBe(' > # 新名\n---\n尾')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('缩进块引用 ATX + 多行正文 + `---`：正文序列与分隔线全保留', () => {
    // 旧实现三行全丢（`  > # 引用标题\n  正文一\n  正文二\n---` 被当作标题区）
    const input = '  > # 引用标题\n  正文一\n  正文二\n---\n尾'
    const after = renameTo(input, 0, '新名')
    expect(after).toBe('  > # 新名\n  正文一\n  正文二\n---\n尾')
    // 第二行起是独立的 Setext 标题（解析器判定）：改完仍在，且首条已改名
    expect(outlineOf(after).map(([level]) => level)).toEqual([1, 2])
    expect(outlineOf(after)[0]).toEqual([1, '新名'])
  })
})

// ---- review-loops 第 4 轮：深层嵌套容器的标题区几何（P2；缩进上限归解析器） ----

describe('深层嵌套容器：结构前缀不设缩进上限，标题区只覆盖标题行（第 4 轮复核 P2）', () => {
  it('解析器裁判：4 空格 ATX 与缩进不足的伪续行均不产条目（放宽不越过解析器）', () => {
    // `    #`/`    - #` 是缩进代码块（顶层 4 空格不是列表项，标记前的缩进
    // 超过 3 空格也不进列表）；`- T\n ===` 的 1 空格行是惰性续行，`===` 不能
    // 成为其下划线。放宽的是前缀扫描「认出容器标记链」的能力，不是「认标题」
    expect(extractOutline(Text.of(['    # T', '正文']))).toEqual([])
    expect(extractOutline(Text.of(['    - # T', '正文']))).toEqual([])
    expect(extractOutline(Text.of(['- T', ' ===', 'next']))).toEqual([])
  })

  it('结构前缀：任意长度 ASCII 缩进后的容器标记计入前缀（标记链与 rest 口径不变）', () => {
    expect(outlineSplitContainerPrefix('    - # T')).toEqual({ prefix: '    - ', markers: ['-'], rest: '# T' })
    expect(outlineSplitContainerPrefix('     # T')).toEqual({ prefix: '     ', markers: [], rest: '# T' })
    expect(outlineSplitContainerPrefix('        > T')).toEqual({ prefix: '        > ', markers: ['>'], rest: 'T' })
    // 标记后无空白不是列表标记：`    ---` 是分隔线/下划线，缩进留在 rest
    expect(outlineSplitContainerPrefix('    ---')).toEqual({ prefix: '', markers: [], rest: '    ---' })
  })

  it('兜底路径副作用：`    # T` 行按 ATX 单行处理（旧口径判否 → 进入下划线扫描）', () => {
    // 该形态不是真标题（上条已由解析器判否），只可能来自手写/异体条目。
    // 放宽后 isAtxLine 判是，区间收敛为「内容起点 → 本行行尾」；旧口径会向下
    // 扫到 `===` 把两行当标题区（即整行 + 下一行被替换）——单行是更保守的一侧
    const doc = Text.of(['    # T', '===', '尾'])
    expect(outlineHeadingSpan(doc, { level: 1, text: 'T', plainText: 'T', line: 1 }))
      .toEqual({ from: 4, to: doc.line(1).to })
  })

  it('复核者实测：2 空格列表内 4 空格嵌套 ATX，重命名保留标记/正文/分隔线（旧实现数据丢失）', () => {
    // 旧实现：内容列算作 4（`    ` 后是 `- `，扫描器停在 3 空格），权威范围
    // 起点校验被拒（真内容列 6）→ 回落启发式 → 向下扫到 `---` → `- # 孙`
    // 之后到 `---` 的字节整体替换 → `    正文` 与 `---` 两行被删
    const input = '  - 父\n    - # 孙\n    正文\n---\n尾'
    const after = renameTo(input, 0, '新名')
    expect(after).toBe('  - 父\n    - # 新名\n    正文\n---\n尾')
    expect(after).toContain('    正文')
    expect(after).toContain('---')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('复核者实测：同形态调级只动标题文字（列表标记、正文、分隔线逐字节保留）', () => {
    const text = '  - 父\n    - # 孙\n    正文\n---\n尾'
    const doc = Text.of(text.split('\n'))
    const items = extractOutline(doc)
    const after = applyChanges(text, outlineLevelChanges(doc, items, 0, 1, false)!)
    expect(after).toBe('  - 父\n    - ## 孙\n    正文\n---\n尾')
    expect(outlineOf(after)).toEqual([[2, '孙']])
  })

  it('三层嵌套（每层 4 空格递进）：重命名只动标题文字', () => {
    const input = '- 一\n    - 二\n        - # 三\n        正文\n---\n尾'
    const after = renameTo(input, 0, '新名')
    expect(after).toBe('- 一\n    - 二\n        - # 新名\n        正文\n---\n尾')
    expect(after).toContain('        正文')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })

  it('四层嵌套（每层 4 空格递进）：重命名与调级都只动标题文字', () => {
    const text = '- 一\n    - 二\n        - 三\n            - # 四\n            正文\n---\n尾'
    expect(renameTo(text, 0, '新名'))
      .toBe('- 一\n    - 二\n        - 三\n            - # 新名\n            正文\n---\n尾')
    const doc = Text.of(text.split('\n'))
    const items = extractOutline(doc)
    const after = applyChanges(text, outlineLevelChanges(doc, items, 0, 1, false)!)
    expect(after).toBe('- 一\n    - 二\n        - 三\n            - ## 四\n            正文\n---\n尾')
    expect(after).toContain('            正文')
    expect(after).toContain('---')
  })

  it('深层嵌套内的 Setext 标题：整标题区（内容 + 下划线）替换，列表标记保留', () => {
    // 内容行 `    - 子标题`（嵌套列表项，内容列 6）、下划线 `      ===`
    // （同内容列）——权威范围覆盖两行；旧实现起点校验被拒 → 兜底把 `- `
    // 一起替换掉（列表结构消失）
    const input = '  - 父\n    - 子标题\n      ===\n    正文\n---\n尾'
    const after = renameTo(input, 0, '新名')
    expect(after).toBe('  - 父\n    - # 新名\n    正文\n---\n尾')
    expect(after).not.toContain('===')
    expect(outlineOf(after)).toEqual([[1, '新名']])
  })
})

// ---- review-loops 第 2 轮 R2-7：写回变更段的顺序断言（applyOutlineEdits 兜底） ----

describe('写回变更段顺序断言：升序互不重叠、允许相邻（review-loops 第 2 轮 R2-7）', () => {
  // 为何允许相邻：判据只拦「会让 CM6 ChangeSet flush 合成」的输入——重叠段
  // 与乱序段会让写入结果与计划错位（静默错位写权威文档）；而首尾相接的两段
  // （前段 end === 后段 offset）是合法输入，一次事务按段序落位不产生歧义，
  // 拖拽搬移的「删源段 + 在插入点放搬移段」正是此形态（接缝处相邻）。
  // 零长插入（length 0）的合法性同样只在接缝处：与紧邻段相接合法，落在
  // 前段区间内（前段未结束）则与真重叠同类，判否。
  it('空数组：无相邻对可查，恒为真（写回侧另有 empty 早退）', () => {
    expect(outlineChangesOrdered([])).toBe(true)
  })

  it('单段：无配对可查，恒为真（含零长插入单段）', () => {
    expect(outlineChangesOrdered([{ offset: 0, length: 3 }])).toBe(true)
    expect(outlineChangesOrdered([{ offset: 10, length: 0 }])).toBe(true)
  })

  it('相邻段通过：前段 end === 后段 offset；多段连续相接同样通过', () => {
    expect(outlineChangesOrdered([{ offset: 0, length: 3 }, { offset: 3, length: 2 }])).toBe(true)
    expect(outlineChangesOrdered([
      { offset: 0, length: 3 },
      { offset: 3, length: 2 },
      { offset: 5, length: 1 },
    ])).toBe(true)
  })

  it('零长插入与后续段相邻通过（插入点正好是后段起点）', () => {
    expect(outlineChangesOrdered([
      { offset: 5, length: 0 },
      { offset: 5, length: 2 },
    ])).toBe(true)
  })

  it('真重叠拒绝：前段未结束即开始后段', () => {
    expect(outlineChangesOrdered([
      { offset: 0, length: 3 },
      { offset: 2, length: 4 },
    ])).toBe(false)
  })

  it('零长插入落在前段区间内同样拒绝（零长只在接缝处合法）', () => {
    expect(outlineChangesOrdered([
      { offset: 0, length: 5 },
      { offset: 3, length: 0 },
    ])).toBe(false)
    // 同点插入（offset 相同、前段有长度）：仍在前段区间内，同判否
    expect(outlineChangesOrdered([
      { offset: 10, length: 2 },
      { offset: 10, length: 0 },
    ])).toBe(false)
  })

  it('乱序拒绝：后段 offset 小于前段', () => {
    expect(outlineChangesOrdered([
      { offset: 10, length: 2 },
      { offset: 5, length: 1 },
    ])).toBe(false)
    expect(outlineChangesOrdered([
      { offset: 0, length: 1 },
      { offset: 1, length: 1 },
      { offset: 0, length: 1 },
    ])).toBe(false)
  })

  it('违例出现在末对时同样拒绝（逐对扫描，而非只看首对）', () => {
    expect(outlineChangesOrdered([
      { offset: 0, length: 2 },
      { offset: 2, length: 2 },
      { offset: 3, length: 1 },
    ])).toBe(false)
  })
})
