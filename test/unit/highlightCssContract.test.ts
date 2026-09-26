// 高亮绘制 CSS 契约（#105）：钉住 main.css 高亮相关关键规则——底色变量
// 的三侧同源（live 正文 span / 阅读 mark / 大纲条目）与快速操作图标接线。
// 真实宿主的 computed backgroundColor / elementFromPoint 断言在集成
// paint.highlight（本契约防样式表被误删或只剩类名——样式注入失效时
// DOM 存在性照样通过，底色必须是 computed 可读的差异来源）。
import { describe, expect, it } from 'vitest'
import { cssRule, cssRuleExact, readMainCss } from './cssContract'

const css = readMainCss()

describe('高亮渲染 CSS 契约（#105）', () => {
  it('底色变量定义于 #app：Obsidian 式固定荧光黄，浅色主题分支覆盖', () => {
    const app = cssRuleExact(css, '#app')
    // 两轮视觉实测主题变量（词高亮/搜索命中色）在用户主题下对比均仅
    // 约 1.15–1.45:1 不可见，主题跟随路线证伪，按用户决议切固定黄
    expect(app).toMatch(/--vsidian-highlight-background:\s*rgba\(255, 208, 0, 0\.35\)/u)
    // 浅色主题提高浓度与饱和度（body.vscode-light 为 VSCode webview
    // 标准主题类注入），保证白底目视可辨
    const light = cssRule(css, 'body.vscode-light #app')
    expect(light).toMatch(/--vsidian-highlight-background:\s*#ffe066/u)
  })

  it('live 正文 span 常显高亮底（底色引用同源变量）', () => {
    expect(cssRule(css, '#app .cm-editor .cm-scroller .vsidian-highlight'))
      .toMatch(/background-color:\s*var\(--vsidian-highlight-background\)/u)
  })

  it('阅读 mark 重置浏览器默认黄底：底色与 live 同源、颜色继承正文', () => {
    const mark = cssRule(css, '#app .vsidian-view-reading .vsidian-reading-block mark')
    expect(mark).toMatch(/background-color:\s*var\(--vsidian-highlight-background\)/u)
    expect(mark).toMatch(/color:\s*inherit/u)
  })

  it('大纲条目透传：底色与正文同源变量', () => {
    expect(cssRule(css, '.vsidian-sidebar .vsidian-outline-item .vsidian-outline-highlight'))
      .toMatch(/background-color:\s*var\(--vsidian-highlight-background\)/u)
  })

  it('快速操作条 highlight 图标明暗双主题接线（#104 资产）', () => {
    expect(css).toMatch(/#app \.vsidian-quick-actions \[data-icon='highlight'\]\s*\{\s*--vsidian-quick-icon:[^{}]*light-highlight\.svg/u)
    expect(css).toMatch(/vscode-dark[^{}]*\[data-icon='highlight'\][^{}]*\{[^{}]*dark-highlight\.svg/u)
  })
})
