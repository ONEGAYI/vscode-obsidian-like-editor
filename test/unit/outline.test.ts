// 大纲提取纯函数契约（#54）：extractOutline 以 CM6 全文文本为唯一依据，
// 按 Markdown 语义产出标题序列（级别 + 文字 + 起始行号）。
// - ATX（#）与 Setext（下划线式）语义：与 liveDecorations 同一解析器
//   （@codemirror/lang-markdown），同一 frontmatter 判定（markdownDoc）
// - 伪标题排除：代码围栏内、frontmatter 内的 # 行不成标题
// - 层级与顺序保真：跨级标题、同名标题逐项保留，不合并不丢行
// - 增量解析复用（P1-3）：外部传入 liveDecorationsField 维护的增量树时，
//   大文档编辑序列上与全量解析逐项一致——这是 syncController 复用增量树
//   免去去抖定时器内全量 parse 的正确性前提
import { describe, it, expect } from 'vitest'
import { EditorState, Text } from '@codemirror/state'
import { extractOutline, outlineItemsEqual } from '../../src/webview/outline'
import { liveDecorationsField } from '../../src/webview/liveDecorations'

const text = (s: string): Text => Text.of(s.split('\n'))

describe('extractOutline：ATX 标题', () => {
  it('H1–H6 全级别纳入，级别取 # 数量', () => {
    const doc = text([
      '# 一级',
      '## 二级',
      '### 三级',
      '#### 四级',
      '##### 五级',
      '###### 六级',
      '####### 七个井号不是标题',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, '一级'],
      [2, '二级'],
      [3, '三级'],
      [4, '四级'],
      [5, '五级'],
      [6, '六级'],
    ])
  })

  it('ATX 标记与可选关闭序列不进入标题文字', () => {
    const doc = text('## 标题带关闭 ##\n### 标题无空格关闭#\n#  多空格标题  \n')
    const items = extractOutline(doc)
    expect(items.map((i) => i.text)).toEqual(['标题带关闭', '标题无空格关闭#', '多空格标题'])
  })

  it('空标题（只有标记）产出空文字项，不丢行', () => {
    const doc = text('# 有内容\n##\n# 另一个\n')
    const items = extractOutline(doc)
    expect(items.map((i) => [i.level, i.text])).toEqual([[1, '有内容'], [2, ''], [1, '另一个']])
  })
})

describe('extractOutline：Setext 标题', () => {
  it('下划线式标题按语义级别纳入（= 为一级、- 为二级）', () => {
    const doc = text([
      'Setext 一级',
      '===',
      '',
      'Setext 二级',
      '---',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, 'Setext 一级'],
      [2, 'Setext 二级'],
    ])
  })

  it('Setext 多行内容拼为单条标题文字（空格连接）', () => {
    const doc = text('首行内容\n次行内容\n===\n')
    const items = extractOutline(doc)
    expect(items).toHaveLength(1)
    expect(items[0]!.level).toBe(1)
    expect(items[0]!.text).toBe('首行内容 次行内容')
  })
})

describe('extractOutline：伪标题排除', () => {
  it('代码围栏内的 # 行与下划线行不成标题', () => {
    const doc = text([
      '# 真标题',
      '',
      '```text',
      '# 围栏内伪标题',
      '围栏内 Setext 伪标题',
      '===',
      '```',
      '',
      '## 真二级',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => [i.level, i.text])).toEqual([
      [1, '真标题'],
      [2, '真二级'],
    ])
  })

  it('frontmatter 内的 # 行不成标题，其后的真标题正常纳入', () => {
    const doc = text([
      '---',
      'title: 样例',
      '# frontmatter 内伪标题',
      '---',
      '',
      '# frontmatter 后真标题',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => [i.level, i.text])).toEqual([[1, 'frontmatter 后真标题']])
  })

  it('未闭合 frontmatter（无结束行）按普通 Markdown 处理：其内 # 仍是标题', () => {
    const doc = text([
      '---',
      '# 未闭合头块中的标题',
      '',
      '正文。',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => i.text)).toEqual(['未闭合头块中的标题'])
  })

  it('行内代码与列表项内的井号不干扰标题判定', () => {
    const doc = text([
      '`# 行内代码里的井号`',
      '',
      '- 列表项，含 # 非标题',
      '',
      '# 真标题',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => i.text)).toEqual(['真标题'])
  })
})

describe('extractOutline：层级与顺序保真（验收核心）', () => {
  it('跨级跳变（升与降）逐项保留，无归一化', () => {
    const doc = text([
      '# 一级',
      '#### 直接跳四级',
      '## 回落二级',
      '###### 跳六级',
      '# 回一级',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => i.level)).toEqual([1, 4, 2, 6, 1])
  })

  it('同名标题逐项保留，不合并', () => {
    const doc = text([
      '# 同名',
      '## 同名',
      '## 同名',
      '# 同名',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items).toHaveLength(4)
    expect(items.every((i) => i.text === '同名')).toBe(true)
    expect(items.map((i) => i.level)).toEqual([1, 2, 2, 1])
  })

  it('原文顺序与行号：条目按文档出现顺序排列，line 为起始行（1 基）', () => {
    const doc = text([
      '# 首个标题',
      '',
      '正文段落。',
      '',
      '## 次级标题',
      '',
      '结尾。',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => [i.text, i.line])).toEqual([
      ['首个标题', 1],
      ['次级标题', 5],
    ])
  })

  it('Setext 标题的 line 为内容首行（非下划线行）', () => {
    const doc = text([
      '首个标题',
      '',
      'Setext 标题',
      '===',
      '',
    ].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => [i.text, i.line])).toEqual([['Setext 标题', 3]])
  })
})

describe('extractOutline：边界', () => {
  it('空文档与无标题文档产出空序列', () => {
    expect(extractOutline(Text.empty)).toEqual([])
    expect(extractOutline(text('只有正文\n没有标题\n'))).toEqual([])
  })

  it('CRLF 由 CM6 规范化为 LF 后解析（Text.of 行结构）', () => {
    // webview 全程 LF 坐标（协议约定）；Text.of 即 LF 行结构形态
    const doc = text(['# 标题甲', '正文', '## 标题乙', ''].join('\n'))
    const items = extractOutline(doc)
    expect(items.map((i) => i.text)).toEqual(['标题甲', '标题乙'])
  })
})

describe('outlineItemsEqual：DOM 重建判据', () => {
  it('级别与文字序列一致即相等（行号偏移不触发重建）', () => {
    const a = extractOutline(text('# 甲\n\n## 乙\n'))
    const b = extractOutline(text('\n# 甲\n\n\n## 乙\n'))
    expect(a.map((i) => [i.level, i.text])).toEqual(b.map((i) => [i.level, i.text]))
    expect(a.map((i) => i.line)).not.toEqual(b.map((i) => i.line))
    expect(outlineItemsEqual(a, b)).toBe(true)
  })

  it('任一处级别或文字不同即不等', () => {
    const base = extractOutline(text('# 甲\n\n## 乙\n'))
    expect(outlineItemsEqual(base, extractOutline(text('# 甲\n\n### 乙\n')))).toBe(false)
    expect(outlineItemsEqual(base, extractOutline(text('# 甲\n\n## 丙\n')))).toBe(false)
    expect(outlineItemsEqual(base, extractOutline(text('# 甲\n')))).toBe(false)
    expect(outlineItemsEqual([], [])).toBe(true)
  })
})

// ---- #65 行内样式透传：plainText 与标记结构 ----

describe('extractOutline：行内标记结构（#65 白名单透传）', () => {
  it('粗体/斜体/行内代码/删除线各自产出 span，plainText 剥标记', () => {
    const doc = text(['# **粗** 与 *斜*', '## `代码` 与 ~~删除~~', ''].join('\n'))
    const items = extractOutline(doc)
    expect(items[0]!.text, '原文保留行内标记字符（编辑场景资产不丢失）').toBe('**粗** 与 *斜*')
    expect(items[0]!.plainText).toBe('粗 与 斜')
    expect(items[0]!.spans).toEqual([
      { kind: 'strong', start: 0, end: 1 },
      { kind: 'emphasis', start: 4, end: 5 },
    ])
    expect(items[1]!.plainText).toBe('代码 与 删除')
    expect(items[1]!.spans).toEqual([
      { kind: 'code', start: 0, end: 2 },
      { kind: 'strike', start: 5, end: 7 },
    ])
  })

  it('无标记标题：plainText 与 text 一致、spans 为空', () => {
    const items = extractOutline(text('# 普通标题\n正文\n'))
    expect(items[0]!.plainText).toBe('普通标题')
    expect(items[0]!.spans).toEqual([])
  })

  it('嵌套标记（***粗斜体***）产出同区间两种类型的嵌套 span', () => {
    const items = extractOutline(text('# ***粗斜体*** 尾\n'))
    expect(items[0]!.plainText).toBe('粗斜体 尾')
    expect(items[0]!.spans).toEqual([
      { kind: 'emphasis', start: 0, end: 3 },
      { kind: 'strong', start: 0, end: 3 },
    ])
  })

  it('span 偏移随前文标记剥除平移（多段混排）', () => {
    const items = extractOutline(text('# 前缀 **中段** 后缀 *尾段*\n'))
    expect(items[0]!.plainText).toBe('前缀 中段 后缀 尾段')
    expect(items[0]!.spans).toEqual([
      { kind: 'strong', start: 3, end: 5 },
      { kind: 'emphasis', start: 9, end: 11 },
    ])
  })

  it('未闭合标记保持字面文本（不产 span）', () => {
    const items = extractOutline(text('# 未闭合 ** 粗\n'))
    expect(items[0]!.plainText).toBe('未闭合 ** 粗')
    expect(items[0]!.spans).toEqual([])
  })

  it('行内代码内的星号是字面内容（不产 span、不被双链替换）', () => {
    const items = extractOutline(text('# `代码含*星*号与[[双链]]` 尾\n'))
    expect(items[0]!.plainText).toBe('代码含*星*号与[[双链]] 尾')
    expect(items[0]!.spans).toEqual([{ kind: 'code', start: 0, end: 14 }])
  })

  it('ATX 关闭序列剥除后标记结构仍正确', () => {
    const items = extractOutline(text('# **粗** ##\n'))
    expect(items[0]!.text).toBe('**粗**')
    expect(items[0]!.plainText).toBe('粗')
    expect(items[0]!.spans).toEqual([{ kind: 'strong', start: 0, end: 1 }])
  })

  it('空标题：plainText 空串、无 span', () => {
    const items = extractOutline(text('# 有内容\n##\n'))
    expect(items[1]!.plainText).toBe('')
    expect(items[1]!.spans).toEqual([])
  })

  it('Setext 多行标题：换行归一为空格，标记结构保留', () => {
    const items = extractOutline(text('首行 **粗** 内容\n次行\n===\n'))
    expect(items[0]!.text).toBe('首行 **粗** 内容 次行')
    expect(items[0]!.plainText).toBe('首行 粗 内容 次行')
    expect(items[0]!.spans).toEqual([{ kind: 'strong', start: 3, end: 4 }])
  })
})

describe('extractOutline：双链与链接（#65 纯文本降级）', () => {
  it('标题内 wikilink 显示别名纯文本（无别名显示路径或路径#标题）', () => {
    const items = extractOutline(text('# [[笔记|别名]] 双链\n'))
    expect(items[0]!.text).toBe('[[笔记|别名]] 双链')
    expect(items[0]!.plainText).toBe('别名 双链')
    expect(items[0]!.spans).toEqual([])
    expect(extractOutline(text('# [[目录/笔记#标题]]\n'))[0]!.plainText).toBe('目录/笔记#标题')
  })

  it('非法 wikilink（块引用/未闭合）按原文保留', () => {
    const items = extractOutline(text('# [[笔记^块]] 与 [[未闭合\n'))
    expect(items[0]!.plainText).toBe('[笔记^块] 与 [[未闭合')
    expect(items[0]!.spans).toEqual([])
  })

  it('标题内链接显示链接文字纯文本（URL 部分不透出）', () => {
    const items = extractOutline(text('# [链接文字](https://example.com) 尾注\n'))
    expect(items[0]!.plainText).toBe('链接文字 尾注')
    expect(items[0]!.spans).toEqual([])
  })

  it('链接文字内的行内标记仍解析（与 live 呈现一致）', () => {
    const items = extractOutline(text('# [**粗链接**](https://e.com) 尾\n'))
    expect(items[0]!.plainText).toBe('粗链接 尾')
    expect(items[0]!.spans).toEqual([{ kind: 'strong', start: 0, end: 3 }])
  })

  it('引用式链接按原文呈现（live 不解析引用定义，两侧一致）', () => {
    const items = extractOutline(text('# [文字][ref] 乙\n\n[ref]: https://e.com\n'))
    expect(items[0]!.plainText).toBe('[文字][ref] 乙')
    expect(items[0]!.spans).toEqual([])
  })

  it('wikilink 与标记交错：span 裁剪到字面部分（替换文本不带标记）', () => {
    const items = extractOutline(text('# **前 [[a|别名]] 后** 尾\n'))
    expect(items[0]!.plainText).toBe('前 别名 后 尾')
    expect(items[0]!.spans).toEqual([
      { kind: 'strong', start: 0, end: 2 },
      { kind: 'strong', start: 4, end: 6 },
    ])
  })
})

describe('outlineItemsEqual：标记结构判据（#65）', () => {
  it('文字相同、标记结构不同即不等（触发 DOM 重建）', () => {
    const a = [
      { level: 1, text: '*甲*', plainText: '甲', spans: [{ kind: 'emphasis' as const, start: 0, end: 1 }], line: 1 },
    ]
    const b = [
      { level: 1, text: '甲', plainText: '甲', spans: [], line: 1 },
    ]
    expect(outlineItemsEqual(a, b)).toBe(false)
  })

  it('plainText 不同即不等', () => {
    const a = [{ level: 1, text: '甲', plainText: '甲', spans: [], line: 1 }]
    const b = [{ level: 1, text: '甲', plainText: '乙', spans: [], line: 1 }]
    expect(outlineItemsEqual(a, b)).toBe(false)
  })

  it('标记结构一致、行号偏移仍相等', () => {
    const a = extractOutline(text('# *甲*\n'))
    const b = extractOutline(text('\n\n# *甲*\n'))
    expect(outlineItemsEqual(a, b)).toBe(true)
  })
})

describe('extractOutline：增量树复用的正确性对照（P1-3）', () => {
  /** 增量树（liveDecorationsField 随事务维护）与全量解析的大纲对拍 */
  function assertIncrementalMatchesFull(state: EditorState): void {
    const incremental = extractOutline(state.doc, state.field(liveDecorationsField).tree)
    const full = extractOutline(state.doc)
    expect(incremental, '增量树产出的大纲应与全量解析逐项一致').toEqual(full)
  }

  it('传入外部树时直接取用（与全量解析同结果）', () => {
    const doc = text('# 甲\n\n## 乙\n\nSetext 丙\n===\n')
    const state = EditorState.create({ doc, extensions: [liveDecorationsField] })
    expect(extractOutline(doc, state.field(liveDecorationsField).tree))
      .toEqual(extractOutline(doc))
  })

  it('大文档编辑序列：增量树的大纲与全量解析始终一致', () => {
    // 大文档（数千行 + 数百标题）上做结构性编辑序列：每步对拍增量树与
    // 全量解析的大纲。syncController 的去抖刷新复用该增量树（免去 10 万行
    // 级文档约 256ms 的全量 parse），等价性在此钉住。
    const lines: string[] = []
    for (let i = 1; i <= 300; i++) {
      lines.push(`# 章 ${i}`, '', `第 ${i} 章正文第一段。`, '', `第 ${i} 章正文第二段。`, '')
      if (i % 3 === 0) {
        lines.push(`## 节 ${i}-1`, '', `节 ${i}-1 正文。`, '')
      }
      if (i % 50 === 0) {
        lines.push('```text', '# 围栏内伪标题', '```', '')
      }
    }
    let state = EditorState.create({ doc: Text.of(lines), extensions: [liveDecorationsField] })
    assertIncrementalMatchesFull(state)

    const lineOf = (needle: string): number => {
      for (let n = 1; n <= state.doc.lines; n++) {
        if (state.doc.line(n).text.includes(needle)) {
          return n
        }
      }
      throw new Error(`找不到 ${needle}`)
    }

    // 1. 文末追加新标题
    state = state.update({ changes: { from: state.doc.length, insert: '\n## 文末新增标题\n' } }).state
    assertIncrementalMatchesFull(state)
    // 2. 修改中部既有标题文字
    {
      const l = state.doc.line(lineOf('章 100'))
      state = state.update({ changes: { from: l.from + 2, to: l.to, insert: '改写后的第一百章' } }).state
    }
    assertIncrementalMatchesFull(state)
    // 3. 删除一个标题行（含其换行）
    {
      const l = state.doc.line(lineOf('节 300-1'))
      state = state.update({ changes: { from: l.from, to: Math.min(l.to + 1, state.doc.length) } }).state
    }
    assertIncrementalMatchesFull(state)
    // 4. 普通行改标题 / 标题改普通行（前缀形态切换）
    {
      const l = state.doc.line(lineOf('第 5 章正文第一段'))
      state = state.update({ changes: { from: l.from, insert: '### ' } }).state
    }
    assertIncrementalMatchesFull(state)
    {
      const l = state.doc.line(lineOf('章 7'))
      state = state.update({ changes: { from: l.from, to: l.from + 2 } }).state
    }
    assertIncrementalMatchesFull(state)
    // 5. 文档头加 frontmatter（头块内伪标题排除路径）
    state = state.update({ changes: { from: 0, insert: '---\ntitle: 头块\n# 头块内伪标题\n---\n\n' } }).state
    assertIncrementalMatchesFull(state)
    // 6. 移除 frontmatter（头块变普通文本）
    {
      const end = state.doc.line(4).to + 1
      state = state.update({ changes: { from: 0, to: end } }).state
    }
    assertIncrementalMatchesFull(state)
    // 7. ATX 标题行下补下划线（Setext 语义竞争：上行由段落变 Setext 标题）
    {
      const l = state.doc.line(lineOf('第 10 章正文第一段'))
      state = state.update({ changes: { from: l.to + 1, insert: '===\n' } }).state
    }
    assertIncrementalMatchesFull(state)
    // 8. 大段插入（中部整章插入）
    {
      const l = state.doc.line(lineOf('章 200'))
      const chunk = ['# 插入的整章', '', '插入章正文。', '', '## 插入章的小节', '', '小节正文。', '', ''].join('\n')
      state = state.update({ changes: { from: l.from, insert: chunk } }).state
    }
    assertIncrementalMatchesFull(state)
  })
})
