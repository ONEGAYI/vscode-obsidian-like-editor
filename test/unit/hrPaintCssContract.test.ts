// 分割线绘制 CSS 契约（#106）：Live 渲染态横线与阅读 <hr> 颜色同源。
// 断言对象是用户看到的东西——横线只能经 border-top 落笔，颜色必须出自
// 同一 CSS 变量（--vsidian-hr-color，定义于 #app，主题变量自适应）；
// 同时钉住快速操作条 horizontalRule 图标的明暗接线。真宿主可见性断言见
// 集成用例 view.state.paint.hr 探针（cases.ts 分割线用例）。
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

function rule(selector: string): string {
  const found = ruleBlocks().filter((b) => b.selector.endsWith(selector))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!.body
}

describe('分割线绘制 CSS 契约（#106：Live 与阅读横线同源）', () => {
  it('#app 定义横线颜色变量：主题变量自适应，不写死颜色', () => {
    const app = rule('#app')
    expect(app).toMatch(/--vsidian-hr-color:\s*var\(--vscode-panel-border,\s*rgba\(128, 128, 128, 0\.45\)\)/)
  })

  it('Live 渲染态横线：widget 元素以 border-top 绘制并消费同一变量', () => {
    const body = rule('#app .cm-editor .cm-scroller .vsidian-hr')
    expect(body).toMatch(/display:\s*block/)
    expect(body).toMatch(/border-top:\s*1px solid var\(--vsidian-hr-color\)/)
  })

  it('阅读模式 <hr> 消费同一颜色变量（两模式观感同源）', () => {
    const body = rule('#app .vsidian-view-reading .vsidian-reading-hr hr')
    expect(body).toMatch(/border-top:\s*1px solid var\(--vsidian-hr-color\)/)
    expect(body).not.toMatch(/--vscode-panel-border/)
  })

  it('快速操作条分割线图标明暗接线齐全', () => {
    const light = ruleBlocks().filter((b) => b.selector === "#app .vsidian-quick-actions [data-icon='horizontalRule']")
    expect(light, 'light 段图标规则应唯一存在').toHaveLength(1)
    expect(light[0]!.body).toMatch(/light-horizontalRule\.svg/)
    const dark = ruleBlocks().filter((b) =>
      b.selector.endsWith("body.vscode-high-contrast #app .vsidian-quick-actions [data-icon='horizontalRule']"))
    expect(dark, 'dark/high-contrast 段图标规则应唯一存在').toHaveLength(1)
    expect(dark[0]!.body).toMatch(/dark-horizontalRule\.svg/)
  })
})
