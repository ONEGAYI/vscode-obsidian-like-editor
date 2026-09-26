import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/webview/main.css', 'utf8')
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'u').exec(css)?.[1] ?? ''
}

describe('快速操作条样式契约', () => {
  it('展开占流内高度、窄窗口换行；隐藏态不绘制', () => {
    const bar = rule('#app .vsidian-quick-actions')
    expect(bar).toMatch(/display:\s*flex/u)
    expect(bar).toMatch(/flex-wrap:\s*wrap/u)
    expect(bar).toMatch(/flex:\s*0 0 auto/u)
    expect(rule('#app .vsidian-quick-actions[hidden]')).toMatch(/display:\s*none/u)
    expect(rule('#app .vsidian-quick-actions .vsidian-quick-heading-menu[hidden]'))
      .toMatch(/display:\s*none/u)
  })

  it('明暗主题来自 VSCode 变量，活动与混合态有绘制差别并有焦点轮廓', () => {
    expect(rule('#app .vsidian-quick-actions')).toMatch(/var\(--vscode-editor-background/u)
    expect(rule("#app .vsidian-quick-actions button[data-format-state='active']"))
      .toMatch(/background:\s*var\(--vscode-button-background/u)
    expect(rule("#app .vsidian-quick-actions button[data-format-state='mixed']"))
      .toMatch(/border-color:\s*var\(--vscode-focusBorder/u)
    expect(css).toMatch(/#app \.vsidian-quick-actions button:focus-visible\s*\{\s*outline:\s*1px solid var\(--vscode-focusBorder/u)
  })

  it('图标同画布居中，分组竖线仅在同行显示，明暗与禁用态有绘制规则', () => {
    expect(rule('#app .vsidian-quick-actions .vsidian-quick-action-group[data-separated="true"]::before'))
      .toMatch(/border-left:\s*2px solid/u)
    expect(rule('#app .vsidian-quick-actions .vsidian-quick-icon')).toMatch(/mask-size:\s*contain/u)
    expect(rule('#app .vsidian-quick-actions .vsidian-quick-icon')).toMatch(/width:\s*18px/u)
    expect(rule('#app .vsidian-quick-actions button:disabled'))
      .toMatch(/opacity:\s*0\.45/u)
    expect(rule('#app .vsidian-quick-actions .vsidian-quick-icon'))
      .toMatch(/background-color:\s*currentColor/u)
    expect(css).toMatch(/vscode-dark[^{}]*\[data-icon='strikethrough'\]/u)
  })
})
