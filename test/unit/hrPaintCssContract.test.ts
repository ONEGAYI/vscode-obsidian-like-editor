// 分割线绘制 CSS 契约（#106）：Live 渲染态横线与阅读 <hr> 颜色同源。
// 断言对象是用户看到的东西——Live 态横线以居中渐变落笔（行高恒等于
// 正文行高，不改行号间距）、阅读态以 border-top 落笔，颜色必须出自
// 同一 CSS 变量（--vsidian-hr-color，定义于 #app）；同时钉住快速操作条
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

  it('Live 渲染态横线：inline-block 居中渐变、行高恒等于正文行高', () => {
    const body = cssRule(css, '#app .cm-editor .cm-scroller .vsidian-hr')
    // 必须行内：CM6 在 replace widget 前后各插 img.cm-widgetBuffer（光标
    // 停靠点），display:block 会截断行内流把行高撑到约两倍（真宿主实测
    // 49px vs 21px）；inline-block 高度 = 字号×行高（与 .cm-scroller
    // 同源变量的同一公式），行号间距不受影响
    expect(body).toMatch(/display:\s*inline-block/)
    expect(body).toMatch(/vertical-align:\s*top/)
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/height:\s*calc\(var\(--vsidian-content-font-size\) \* var\(--vsidian-content-line-height\)\)/)
    // 2px 居中横线经 linear-gradient 落笔，色值出自同源变量
    expect(body).toMatch(/linear-gradient\(/)
    expect(body).toMatch(/var\(--vsidian-hr-color\) calc\(50% - 1px\)/)
    expect(body).toMatch(/var\(--vsidian-hr-color\) calc\(50% \+ 1px\)/)
    expect(body).toMatch(/margin:\s*0/)
  })

  it('阅读模式 <hr> 消费同一颜色变量（两模式观感同源）', () => {
    const body = cssRule(css, '#app .vsidian-view-reading .vsidian-reading-hr hr')
    expect(body).toMatch(/border-top:\s*2px solid var\(--vsidian-hr-color\)/)
  })

  it('阅读模式无行号，保持上下对称节奏', () => {
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
