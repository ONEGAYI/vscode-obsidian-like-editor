import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { readFileSync } from 'node:fs'
import { planCreateTable } from '../../src/webview/tableCreate'

const TABLE = '|  |  |\n| --- | --- |\n|  |  |'

function apply(doc: string, from: number, to = from): { text: string; selection: number } {
  const plan = planCreateTable(doc, from, to)
  return {
    text: doc.slice(0, plan.changes.from) + plan.changes.insert + doc.slice(plan.changes.to),
    selection: plan.selection,
  }
}

describe('planCreateTable：光标处建立两列两内容行的空表格', () => {
  it('在行内把左右文字分到表格上下，并各留一空行', () => {
    const result = apply('左文右文\n尾段', 2)
    expect(result.text).toBe(`左文\n\n${TABLE}\n\n右文\n尾段`)
    expect(result.selection).toBe(result.text.indexOf(TABLE) + 2)
  })

  it('在已有空行插入时不累积多余空行', () => {
    expect(apply('前段\n\n后段', 3).text).toBe(`前段\n\n${TABLE}\n\n后段`)
  })

  it('在行尾、文首与空文档插入时保持周边内容', () => {
    expect(apply('上文\n下一段', 2).text).toBe(`上文\n\n${TABLE}\n\n下一段`)
    expect(apply('后段', 0).text).toBe(`${TABLE}\n\n后段`)
    expect(apply('', 0).text).toBe(TABLE)
  })

  it('选区替换仍只产生一笔变更，并保留选区两端的文字', () => {
    expect(apply('前缀待替换后缀', 2, 5).text).toBe(`前缀\n\n${TABLE}\n\n后缀`)
  })

  it('生成合法 GFM：两个空表头格与两个空数据格', () => {
    const html = new MarkdownIt().render(apply('', 0).text)
    expect(html.match(/<th>/g)).toHaveLength(2)
    expect(html.match(/<td>/g)).toHaveLength(2)
  })
})

it('命令面板按界面语言显示 Create a Table / 创建表格', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: { commands: Array<{ command: string; title: string; category: string }> }
  }
  const command = manifest.contributes.commands.find((item) => item.command === 'onegayi.vsidian.table.create')
  expect(command).toMatchObject({ title: '%command.table.create.title%', category: 'Vsidian' })
  const english = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>
  const chinese = JSON.parse(readFileSync('package.nls.zh-cn.json', 'utf8')) as Record<string, string>
  expect(english['command.table.create.title']).toBe('Create a Table')
  expect(chinese['command.table.create.title']).toBe('创建表格')
})
