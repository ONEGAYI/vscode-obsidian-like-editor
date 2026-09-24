// Markdown 文档工具契约（工单 #8）：
// - frontmatterRange：两视图共用的 frontmatter 边界判定（live 装饰与阅读
//   切块都必须把 `---` 头块排除在 Markdown 语法解析之外——否则 `# 伪标题`
//   会被两视图各自误解析且语义不一致）
// - docInput：CM6 Text → @lezer Input（lineChunks 形态，解析不复制全文字符串）
// - visitRange / chainAt：语法树区间查询（二分下降，供装饰增量构建使用）
// - markdownTreeParser：来自 @codemirror/lang-markdown 的 markdownLanguage
//   解析器（含 GFM：任务列表 TaskMarker、删除线等），live 装饰的语义来源
import { describe, it, expect } from 'vitest'
import { Text } from '@codemirror/state'
import {
  chainAt,
  docInput,
  frontmatterRange,
  markdownTreeParser,
  visitRange,
} from '../../src/webview/markdownDoc'

describe('frontmatterRange：frontmatter 边界判定（两视图共用语义）', () => {
  it('标准 --- 开合：范围覆盖头尾两行（不含尾换行）', () => {
    const text = '---\ntitle: 标题\n# 不是标题\ntags: x\n---\n\n# 正文标题\n'
    const r = frontmatterRange(text)
    expect(r).not.toBeNull()
    expect(text.slice(r!.start, r!.end)).toBe('---\ntitle: 标题\n# 不是标题\ntags: x\n---')
    expect(r!.start).toBe(0)
  })

  it('... 收尾同样识别；行尾空格容忍（范围含结束行行尾空格）', () => {
    const text = '---  \nkey: v\n...  \n正文'
    const r = frontmatterRange(text)
    expect(r).not.toBe(null)
    expect(text.slice(r!.start, r!.end)).toBe('---  \nkey: v\n...  ')
  })

  it.each([
    ['未闭合（无结束行）', '---\nkey: v\n正文继续'],
    ['空 frontmatter（开行下一行即闭行）', '---\n---\n正文'],
    ['首行不是 ---（正文中的 --- 不是 frontmatter）', '正文\n---\nkey: v\n---\n'],
    ['空文档', ''],
    ['只有一个 --- 行', '---'],
  ])('%s → null', (_label, text) => {
    expect(frontmatterRange(text)).toBeNull()
  })

  it('结束行前允许任意内容行（含缩进/列表形态）', () => {
    const text = '---\n- 列表形态\n  缩进行\n---\n'
    const r = frontmatterRange(text)
    expect(r).not.toBe(null)
    expect(text.slice(r!.start, r!.end)).toBe('---\n- 列表形态\n  缩进行\n---')
  })
})

describe('markdownTreeParser + docInput：解析器与输入适配', () => {
  it('解析产出块/行内节点（ATX 标题、粗体、行内代码、任务标记）', () => {
    const text = '# 标题\n\n**粗** 与 `码` 与 [x] 任务\n'
    const tree = markdownTreeParser.parse(docInput(Text.of(text.split('\n'))))
    const names: string[] = []
    visitRange(tree, 0, text.length, (node) => {
      names.push(node.name)
    })
    expect(names).toContain('ATXHeading1')
    expect(names).toContain('HeaderMark')
    expect(names).toContain('StrongEmphasis')
    expect(names).toContain('EmphasisMark')
    expect(names).toContain('InlineCode')
    expect(names).toContain('CodeMark')
  })

  it('docInput（lineChunks 形态）与字符串解析结果一致', () => {
    const text = '段落一\n\n> 引用\n\n```js\ncode()\n```\n'
    const viaInput = markdownTreeParser.parse(docInput(Text.of(text.split('\n'))))
    const viaString = markdownTreeParser.parse(text)
    expect(viaInput.toString()).toBe(viaString.toString())
  })
})

describe('visitRange：区间相交节点访问（前序，含祖先路径）', () => {
  const text = '# 标题\n\n- 项 **粗**\n- [x] 任务\n\n> 引用行\n\n```js\ncode\n```\n'
  const tree = markdownTreeParser.parse(text)

  it('限定区间只访问相交子树（标题+首个列表项的粗体）', () => {
    const seen: Array<{ name: string; from: number; to: number; parents: string[] }> = []
    // 区间：'- 项 **粗**' 行（0 起第 4 行，offset 7..17）
    visitRange(tree, 7, 17, (node, path) => {
      seen.push({ name: node.name, from: node.from, to: node.to, parents: path.map((p) => p.name) })
    })
    const names = seen.map((s) => s.name)
    expect(names).toContain('BulletList')
    expect(names).toContain('ListItem')
    expect(names).toContain('StrongEmphasis')
    expect(names).not.toContain('FencedCode')
    expect(names).not.toContain('Blockquote')
    // 祖先路径：StrongEmphasis 的父母含 Paragraph/ListItem
    const strong = seen.find((s) => s.name === 'StrongEmphasis')!
    expect(strong.parents).toContain('ListItem')
  })

  it('区间完全落在围栏内：访问 FencedCode 与其子节点，不访问前后块', () => {
    const codeStart = text.indexOf('code')
    const seen: string[] = []
    visitRange(tree, codeStart, codeStart + 2, (node) => {
      seen.push(node.name)
    })
    expect(seen).toContain('FencedCode')
    expect(seen).toContain('CodeText')
    expect(seen).not.toContain('ATXHeading1')
    expect(seen).not.toContain('Blockquote')
  })
})

describe('chainAt：位置处的命名节点链（包含判定）', () => {
  const text = '> 引用内 **粗**\n\n```js\nlet x\n```\n'
  const tree = markdownTreeParser.parse(text)

  it('引用内粗体位置：链含 Blockquote 与 StrongEmphasis', () => {
    const pos = text.indexOf('粗')
    const names = chainAt(tree, pos).map((n) => n.name)
    expect(names).toContain('Blockquote')
    expect(names).toContain('StrongEmphasis')
  })

  it('围栏内容位置：链含 FencedCode 与 CodeText', () => {
    const pos = text.indexOf('let')
    const names = chainAt(tree, pos).map((n) => n.name)
    expect(names).toContain('FencedCode')
    expect(names).toContain('CodeText')
  })

  it('普通段落位置：链不含块级容器（仅 Document/Paragraph）', () => {
    const plain = '普通段落文本\n'
    const t2 = markdownTreeParser.parse(plain)
    const names = chainAt(t2, 3).map((n) => n.name)
    expect(names).not.toContain('Blockquote')
    expect(names).not.toContain('FencedCode')
    expect(names).not.toContain('ListItem')
  })
})
