// 分割线绘制 CSS 契约（#106）：Live 渲染态横线与阅读 <hr> 颜色同源。
// 断言对象是用户看到的东西——横线只能经 border-top 落笔，颜色必须出自
// 同一 CSS 变量（--vsidian-hr-color，定义于 #app，主题变量自适应）；
// 纵向节奏（上下 margin）两模式同值；同时钉住快速操作条
// horizontalRule 图标的明暗接线。真宿主可见性断言见集成用例
// view.state.paint.hr 探针（cases.ts 分割线用例）。
import { describe, expect, it } from 'vitest'
import { cssRule, cssRuleBlocks, cssRuleExact, readMainCss } from './cssContract'

const css = readMainCss()

describe('分割线绘制 CSS 契约（#106：Live 与阅读横线同源）', () => {
  it('#app 定义横线颜色变量：按编辑器前景色派生（明暗主题均可辨识）', () => {
    const app = cssRuleExact(css, '#app')
    expect(app).toMatch(/--vsidian-hr-color:\s*color-mix\(in srgb, var\(--vscode-editor-foreground, #808080\) 35%, transparent\)/)
  })

  it('Live 渲染态横线：widget 元素以 border-top 绘制并消费同一变量', () => {
    const body = cssRule(css, '#app .cm-editor .cm-scroller .vsidian-hr')
    expect(body).toMatch(/display:\s*block/)
    expect(body).toMatch(/border-top:\s*2px solid var\(--vsidian-hr-color\)/)
  })

  it('阅读模式 <hr> 消费同一颜色变量（两模式观感同源）', () => {
    const body = cssRule(css, '#app .vsidian-view-reading .vsidian-reading-hr hr')
    expect(body).toMatch(/border-top:\s*2px solid var\(--vsidian-hr-color\)/)
  })

  it('Live 线贴行盒顶对齐行号：margin-top 归零、下留白撑约一行占空', () => {
    // CM6 行号锚定行盒顶部：对称 margin 会把线推到行号下方约一行
    // （视觉实测），故 margin-top 归零、占空交给 margin-bottom
    expect(cssRule(css, '#app .cm-editor .cm-scroller .vsidian-hr')).toMatch(/margin:\s*0 0 0\.8em 0/)
    expect(cssRule(css, '#app .cm-editor .cm-scroller .vsidian-hr')).toMatch(/line-height:\s*0/)
    // 阅读模式无行号，保持上下对称节奏
    expect(cssRule(css, '#app .vsidian-view-reading .vsidian-reading-hr hr')).toMatch(/margin:\s*0\.45em 0/)
  })

  it('快速操作条分割线图标明暗接线齐全', () => {
    const light = cssRuleBlocks(css).filter((b) => b.selector === "#app .vsidian-quick-actions [data-icon='horizontalRule']")
    expect(light, 'light 段图标规则应唯一存在').toHaveLength(1)
    expect(light[0]!.body).toMatch(/light-horizontalRule\.svg/)
    const dark = cssRuleBlocks(css).filter((b) =>
      b.selector.endsWith("body.vscode-high-contrast #app .vsidian-quick-actions [data-icon='horizontalRule']"))
    expect(dark, 'dark/high-contrast 段图标规则应唯一存在').toHaveLength(1)
    expect(dark[0]!.body).toMatch(/dark-horizontalRule\.svg/)
  })
})
