// 高亮绘制 CSS 契约（#105）：钉住 main.css 高亮相关关键规则——底色变量
// 的三侧同源（live 正文 span / 阅读 mark / 大纲条目）与快速操作图标接线。
// 真实宿主的 computed backgroundColor / elementFromPoint 断言在集成
// paint.highlight（本契约防样式表被误删或只剩类名——样式注入失效时
// DOM 存在性照样通过，底色必须是 computed 可读的差异来源）。
import { describe, expect, it } from 'vitest'
import { cssRule, readMainCss } from './cssContract'

const css = readMainCss()

describe('高亮渲染 CSS 契约（#105）', () => {
  it('底色变量定义于 #app：主题变量自适应（搜索命中高亮色）+ 明显琥珀回退', () => {
    const app = cssRule(css, '#app')
    // 用户验收：词高亮色 editorWordHighlightBackground 实测对比仅约
    // 1.4:1 几乎不可见，改选更明显的主题变量（明显性优先于「不落黄」）
    expect(app).toMatch(/--vsidian-highlight-background:\s*var\(--vscode-editor-findMatchHighlightBackground/u)
    // 宿主变量缺失时回退明显琥珀半透明（0.4 浓度，可辨识的荧光笔观感）
    expect(app).toMatch(/rgba\(234, 179, 8, 0\.4\)/u)
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
