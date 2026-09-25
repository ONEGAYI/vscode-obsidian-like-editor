// 标题绘制 CSS 契约（#55）：实时预览标题行开头不得绘制左缘竖线。
// 断言对象是用户看到的东西——左缘着色只能经 box-shadow / border-left 落笔，
// 故钉住标题类规则不得声明这两种绘制；同时守住相邻语法的左缘样式
// （引用块竖线）与标题活动行背景不被本契约误伤。真宿主计算值断言见
// 集成用例 view.state.paint.heading 探针（cases.ts 标题装饰用例）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

interface RuleBlock {
  selector: string
  body: string
}

function ruleBlocks(): RuleBlock[] {
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? []
  return blocks.map((block) => {
    const [selector, body] = block.split('{')
    return { selector: (selector ?? '').trim(), body: body ?? '' }
  })
}

/** 选择器包含 text 的所有规则块 */
function rulesMentioning(text: string): RuleBlock[] {
  return ruleBlocks().filter((b) => b.selector.includes(text))
}

function rule(selector: string): string {
  const found = ruleBlocks().filter((b) => b.selector.endsWith(selector))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return `{${found[0]!.body}`
}

describe('标题行绘制 CSS 契约（#55：无左缘竖线）', () => {
  it('标题类规则不声明 box-shadow / border-left（左缘竖线的落笔通道）', () => {
    const headingRules = rulesMentioning('vsidian-heading')
    expect(headingRules.length).toBeGreaterThanOrEqual(8) // line/-1..6/inview/active 族都在
    for (const r of headingRules) {
      expect(
        r.body.includes('box-shadow'),
        `规则 ${r.selector} 不得绘制 box-shadow（左缘竖线回归）：${r.body}`,
      ).toBe(false)
      expect(
        r.body.includes('border-left'),
        `规则 ${r.selector} 不得绘制 border-left（左缘竖线回归）：${r.body}`,
      ).toBe(false)
    }
  })

  it('标题呈现保留：字号分级与活动行背景（防止误删标题样式）', () => {
    expect(rule('#app .cm-editor .cm-scroller .vsidian-heading-line')).toMatch(/font-weight:\s*600/)
    expect(rule('#app .cm-editor .cm-scroller .vsidian-heading-line-1')).toMatch(/font-size:\s*1\.55em/)
    expect(rule('#app .cm-editor .cm-scroller .vsidian-heading-inview.vsidian-heading-active'))
      .toMatch(/background-color:\s*var\(--vscode-editor-lineHighlightBackground/)
  })

  it('引用块左缘竖线不受本修复影响（相邻语法样式仍在）', () => {
    expect(rule('#app .cm-editor .cm-scroller .vsidian-quote-line'))
      .toMatch(/box-shadow:\s*inset 3px 0 0 var\(--vscode-textBlockQuote-border/)
  })

  it('标题左缘强调色变量已随竖线移除（不再有无消费者的公开变量）', () => {
    expect(css.includes('--vsidian-heading-accent')).toBe(false)
  })
})
