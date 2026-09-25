// 大纲提取纯函数契约（#54）：extractOutline 以 CM6 全文文本为唯一依据，
// 按 Markdown 语义产出标题序列（级别 + 文字 + 起始行号）。
// - ATX（#）与 Setext（下划线式）语义：与 liveDecorations 同一解析器
//   （@codemirror/lang-markdown），同一 frontmatter 判定（markdownDoc）
// - 伪标题排除：代码围栏内、frontmatter 内的 # 行不成标题
// - 层级与顺序保真：跨级标题、同名标题逐项保留，不合并不丢行
import { describe, it, expect } from 'vitest'
import { Text } from '@codemirror/state'
import { extractOutline, outlineItemsEqual } from '../../src/webview/outline'

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
