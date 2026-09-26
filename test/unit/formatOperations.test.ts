import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { planFormatOperation } from '../../src/webview/formatOperations'

function apply(text: string, op: Parameters<typeof planFormatOperation>[1], from: number, to = from,
  region?: Parameters<typeof planFormatOperation>[3], action?: Parameters<typeof planFormatOperation>[4]) {
  const plan = planFormatOperation(text, op, { from, to }, region, action)
  if (!plan) return { text, selection: null }
  let next = text
  for (const change of [...plan.changes].reverse()) {
    next = next.slice(0, change.from) + change.insert + next.slice(change.to)
  }
  return { text: next, selection: plan.selection }
}

describe('格式操作的文本契约', () => {
  it('中文、中英混排及词边界：光标优先右词，行末取左词', () => {
    expect(apply('中文 English', 'bold', 0).text).toBe('**中文** English')
    expect(apply('中文 English', 'bold', 3).text).toBe('中文 **English**')
    expect(apply('中文 English', 'bold', 10).text).toBe('中文 **English**')
  })

  it('无选区在格式内取消整个段，有选区仅取消片段', () => {
    expect(apply('**编辑文字**', 'bold', 4).text).toBe('编辑文字')
    expect(apply('**编辑文字**', 'bold', 3, 5).text).toBe('**编**辑文**字**')
  })

  it('混合格式统一应用且不叠加标记；重复切换可还原', () => {
    expect(apply('**前**后', 'bold', 0, 6).text).toBe('**前后**')
    expect(apply('前**中**后', 'bold', 0, 7).text).toBe('**前中后**')
    expect(apply('**前后**', 'bold', 2, 4).text).toBe('前后')
    expect(apply('**前后**', 'bold', 0, 6).text).toBe('前后')
    expect(apply('**前中**后', 'bold', 3, 7).text).toBe('**前中后**')
  })

  it('底层添加与清除各自幂等', () => {
    expect(apply('**字**', 'bold', 2, 3, undefined, 'add').text).toBe('**字**')
    expect(apply('字', 'bold', 0, 1, undefined, 'remove').text).toBe('字')
    expect(apply('**字**', 'bold', 2, 3, undefined, 'remove').text).toBe('字')
    expect(apply('字', 'bold', 0, 1, undefined, 'add').text).toBe('**字**')
  })

  it('显式选区严格按选区，不吞相邻文字，跨段保留结构', () => {
    expect(apply('甲乙丙', 'italic', 1, 2).text).toBe('甲*乙*丙')
    expect(apply('# 标题\n\n- 列表', 'bold', 2, 9).text).toBe('# **标题**\n\n- **列**表')
  })

  it('空白插入成对标记并把光标置于中间；公式双链无选区也插入空结构', () => {
    expect(apply('甲 乙', 'inlineCode', 1)).toEqual({ text: '甲`` 乙', selection: { anchor: 2 } })
    expect(apply('', 'inlineMath', 0)).toEqual({ text: '$$', selection: { anchor: 1 } })
    expect(apply('', 'wikilink', 0)).toEqual({ text: '[[]]', selection: { anchor: 2 } })
  })

  it('代码块与行内代码中不写 Markdown 行内样式', () => {
    expect(apply('```\n正文\n```', 'bold', 5).text).toBe('```\n正文\n```')
    expect(apply('`正文`', 'bold', 2).text).toBe('`正文`')
  })

  it('标题同级不变，取消标题保留行内样式；列表与引用转换', () => {
    expect(apply('## **标题**', 'heading2', 5).text).toBe('## **标题**')
    expect(apply('## **标题**', 'headingNone', 5).text).toBe('**标题**')
    expect(apply('正文', 'bulletList', 1).text).toBe('- 正文')
    expect(apply('- 正文', 'taskList', 3).text).toBe('- [ ] 正文')
    expect(apply('正文', 'quote', 1).text).toBe('> 正文')
    expect(apply('- 正文', 'bulletList', 3).text).toBe('正文')
    expect(apply('- [x] 完成', 'taskList', 6).text).toBe('完成')
    expect(apply('> 正文', 'quote', 3).text).toBe('正文')
    expect(apply('标题\n====', 'headingNone', 1).text).toBe('标题')
    expect(apply('标题\n----', 'heading2', 1).text).toBe('标题\n----')
    expect(apply('标题\n----', 'heading3', 1).text).toBe('### 标题')
  })

  it('显式选区围栏精确包裹，前后文独立成段且文首尾无多余空行', () => {
    expect(apply('前中文后', 'codeBlock', 1, 3).text).toBe('前\n\n```\n中文\n```\n\n后')
    expect(apply('文字', 'codeBlock', 0, 2).text).toBe('```\n文字\n```')
    expect(apply('文字', 'blockMath', 0, 0).text).toBe('$$\n文字\n$$')
  })

  it('无选区按段落围栏，取消保留间隔；含反引号内容使用更长围栏', () => {
    expect(apply('前段\n\n后段', 'codeBlock', 1).text).toBe('```\n前段\n```\n\n后段')
    expect(apply('```\n前段\n```\n\n后段', 'codeBlock', 5).text).toBe('前段\n\n后段')
    expect(apply('a`b', 'codeBlock', 0, 3).text).toBe('```\na`b\n```')
    expect(apply('````\na```b\n````', 'codeBlock', 5).text).toBe('a```b')
    expect(apply('```\n前段\n```', 'codeBlock', 0, 10).text).toBe('前段')
  })

  it('列表和引用内围栏保留容器；表格单元格禁用块级围栏', () => {
    expect(apply('- 第一段', 'codeBlock', 4).text).toBe('- ```\n  第一段\n  ```')
    expect(apply('> 引用', 'blockMath', 3).text).toBe('> $$\n> 引用\n> $$')
    expect(apply('- ```\n  第一段\n  ```', 'codeBlock', 9).text).toBe('- 第一段')
    expect(apply('> $$\n> 引用\n> $$', 'blockMath', 7).text).toBe('> 引用')
    expect(apply('- $$\n  公式\n  $$', 'blockMath', 8).text).toBe('- 公式')
    const table = '| A | B |\n| --- | --- |\n| x | y |'
    expect(apply(table, 'codeBlock', table.indexOf('x')).text).toBe(table)
  })

  it('容器内显式选区仍只包裹文字，前后文留在同一容器', () => {
    expect(apply('- 前中文后', 'codeBlock', 3, 5).text)
      .toBe('- 前\n\n  ```\n  中文\n  ```\n\n  后')
    expect(apply('> 前中文后', 'blockMath', 3, 5).text)
      .toBe('> 前\n>\n> $$\n> 中文\n> $$\n>\n> 后')
    expect(apply('- 前甲\n  乙后', 'codeBlock', 3, 8).text)
      .toBe('- 前\n\n  ```\n  甲\n  乙\n  ```\n\n  后')
    expect(apply('> 前甲\n> 乙后', 'blockMath', 3, 8).text)
      .toBe('> 前\n>\n> $$\n> 甲\n> 乙\n> $$\n>\n> 后')
  })

  it('空段插入空结构并定位光标；块级公式再次操作可取消', () => {
    expect(apply('', 'codeBlock', 0)).toEqual({ text: '```\n\n```', selection: { anchor: 4 } })
    expect(apply('$$\n公式\n$$', 'blockMath', 4).text).toBe('公式')
  })

  it('表格矩形选区逐格应用，不改分隔符和其他列', () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |'
    const region = { tableFrom: 0, rowFrom: 0, rowTo: 1, columnFrom: 0, columnTo: 0 }
    expect(apply(table, 'bold', table.indexOf('A'), table.indexOf('A'), region).text)
      .toBe('| **A** | B |\n| --- | --- |\n| **x** | y |')
  })

  it('清除行内格式保留段落，链接仅包裹选中文字', () => {
    expect(apply('# **粗体**与*斜体*', 'clearInline', 2, 13).text).toBe('# 粗体与斜体')
    expect(apply('**前中后**', 'clearInline', 3, 4).text).toBe('**前**中**后**')
    expect(apply('# **标题**\n\n- *列表*', 'clearInline', 2, 16).text)
      .toBe('# 标题\n\n- 列表')
    expect(apply('甲乙', 'link', 0, 2).text).toBe('[甲乙]()')
    expect(apply('[甲乙](目标)', 'link', 2).text).toBe('甲乙')
    expect(apply('a`b', 'inlineCode', 0, 3).text).toBe('``a`b``')
    expect(apply('``a`b`` and **bold**', 'clearInline', 14, 18).text)
      .toBe('``a`b`` and bold')
    expect(apply('``a`b`` and word', 'inlineCode', 12, 16).text)
      .toBe('``a`b`` and `word`')
  })

  it('局部取消多反引号代码时保留未选中字面反引号和代码内容', () => {
    const source = '``a`b``'
    const expected = 'a`` `b ``'
    expect(apply(source, 'inlineCode', 2, 3).text).toBe(expected)
    expect(apply(source, 'clearInline', 2, 3).text).toBe(expected)
    expect(new MarkdownIt().renderInline(expected)).toBe('a<code>`b</code>')
    const leadingTick = apply('`a', 'inlineCode', 0, 2).text
    expect(leadingTick).toBe('`` `a ``')
    expect(new MarkdownIt().renderInline(leadingTick)).toBe('<code>`a</code>')
  })

  it('局部取消斜体保留选区外的原始下划线标记', () => {
    expect(apply('_one_ _two_', 'italic', 7, 10).text).toBe('_one_ two')
    expect(apply('_one_ _two_', 'clearInline', 7, 10).text).toBe('_one_ two')
  })

  it('分割线插入：光标处成段插入 --- 并规整前后空行，光标落在行尾', () => {
    // 空文档：只插入 --- 本体
    expect(apply('', 'horizontalRule', 0)).toEqual({ text: '---', selection: { anchor: 3 } })
    // 行内光标：左右文字各自成段，前后空行隔开
    expect(apply('上文\n下文', 'horizontalRule', 2))
      .toEqual({ text: '上文\n\n---\n\n下文', selection: { anchor: 7 } })
    expect(apply('左字右字', 'horizontalRule', 2))
      .toEqual({ text: '左字\n\n---\n\n右字', selection: { anchor: 7 } })
    // 已有空行不叠加：前侧空行 / 后侧空行 / 空行行内三种位置
    expect(apply('上文\n\n下文', 'horizontalRule', 2))
      .toEqual({ text: '上文\n\n---\n\n下文', selection: { anchor: 7 } })
    expect(apply('上文\n\n下文', 'horizontalRule', 3))
      .toEqual({ text: '上文\n\n---\n\n下文', selection: { anchor: 7 } })
    // 文档末尾：后无内容时不追加尾部空行
    expect(apply('上文', 'horizontalRule', 2))
      .toEqual({ text: '上文\n\n---', selection: { anchor: 7 } })
    // 选区内容保留在分割线之后（与 fencePlan 等兄弟插入操作口径一致）
    expect(apply('前文中段后文', 'horizontalRule', 2, 4))
      .toEqual({ text: '前文\n\n---\n\n中段后文', selection: { anchor: 7 } })
    // 跨行选区：选区整体（含中间行）保留在 --- 之后，不静默丢弃
    expect(apply('第一段\n选中AA\n选中BB\n后续', 'horizontalRule', 6, 13))
      .toEqual({ text: '第一段\n选中\n\n---\n\nAA\n选中BB\n后续', selection: { anchor: 11 } })
  })

  it('分割线插入：表格矩形选区内禁用（块级结构不入格）', () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |'
    const region = { tableFrom: 0, rowFrom: 0, rowTo: 0, columnFrom: 0, columnTo: 0 }
    expect(apply(table, 'horizontalRule', table.indexOf('A'), table.indexOf('A'), region).text).toBe(table)
  })

  it('高亮（#105）：扩词包裹、选区包裹、两态取消与清除均正确', () => {
    expect(apply('中文 English', 'highlight', 0).text).toBe('==中文== English')
    expect(apply('甲乙丙', 'highlight', 1, 2).text).toBe('甲==乙==丙')
    expect(apply('==编辑文字==', 'highlight', 4).text).toBe('编辑文字')
    expect(apply('前==中==后', 'highlight', 0, 7).text).toBe('==前中后==')
    expect(apply('# ==亮== 与 **粗**', 'clearInline', 2, 13).text).toBe('# 亮 与 粗')
  })

  it('高亮（#105）：空白插入成对标记并把光标置于开围栏内侧（按 == 长度）', () => {
    expect(apply('', 'highlight', 0)).toEqual({ text: '====', selection: { anchor: 2 } })
    expect(apply('甲 乙', 'highlight', 1)).toEqual({ text: '甲==== 乙', selection: { anchor: 3 } })
  })

  it('高亮（#105）：行内代码内不写高亮，代码块内不写行内样式', () => {
    expect(apply('`==码==`', 'highlight', 4).text).toBe('`==码==`')
    expect(apply('```\n==文==\n```', 'highlight', 6).text).toBe('```\n==文==\n```')
  })
})
