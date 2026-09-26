// Mermaid 暗色主题装配契约（工单 #110）：themeVariables 映射纯函数——
// VSCode 色板（--vscode-* 计算值）→ mermaid 暗色取值；空色板回退到与
// Dark Modern 量级一致的暗色兜底；关键墨水色对画布底满足 WCAG AA。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  MERMAID_DARK_FALLBACK_PALETTE,
  buildDarkMermaidThemeVariables,
  resolveVscodeMermaidPalette,
  type VscodeMermaidPalette,
} from '../../src/webview/mermaidTheme'

/** 相对亮度（WCAG）：sRGB → 线性 → L */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) {
    throw new Error(`非 6 位十六进制色值: ${hex}`)
  }
  const n = parseInt(m[1]!, 16)
  const chan = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

describe('buildDarkMermaidThemeVariables', () => {
  it('空色板（变量未注入/测试环境）：全部键有非空兜底值', () => {
    const tv = buildDarkMermaidThemeVariables({})
    for (const key of [
      'primaryColor',
      'primaryTextColor',
      'primaryBorderColor',
      'lineColor',
      'signalColor',
      'signalTextColor',
      'textColor',
      'edgeLabelBackground',
    ]) {
      expect(typeof tv[key], `${key} 应为字符串`).toBe('string')
      expect((tv[key] as string).length, `${key} 不为空`).toBeGreaterThan(0)
    }
  })

  it('提供的色板值优先于兜底（--vscode-* 计算值直通）', () => {
    const palette: VscodeMermaidPalette = {
      foreground: '#d4d4d4',
      background: '#1a1b1c',
      widgetBackground: '#303031',
      widgetBorder: '#454545',
    }
    const tv = buildDarkMermaidThemeVariables(palette)
    expect(tv['primaryTextColor']).toBe('#d4d4d4')
    expect(tv['lineColor']).toBe('#d4d4d4')
    expect(tv['signalColor']).toBe('#d4d4d4')
    expect(tv['signalTextColor']).toBe('#d4d4d4')
    expect(tv['textColor']).toBe('#d4d4d4')
    expect(tv['primaryColor']).toBe('#303031')
    expect(tv['primaryBorderColor']).toBe('#454545')
    expect(tv['edgeLabelBackground']).toBe('#1a1b1c')
  })

  it('兜底取值满足可读性：连线/文字对画布底 ≥ 4.5:1，节点文字对节点底 ≥ 4.5:1', () => {
    const tv = buildDarkMermaidThemeVariables({})
    expect(contrast(tv['lineColor']!, MERMAID_DARK_FALLBACK_PALETTE.background!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tv['signalTextColor']!, MERMAID_DARK_FALLBACK_PALETTE.background!)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tv['primaryTextColor']!, tv['primaryColor']!)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('resolveVscodeMermaidPalette（取值链路，#110）', () => {
  it('读取注入元素的 --vscode-* 计算值并 trim；缺失键不出现（走兜底）', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.style.setProperty('--vscode-editor-foreground', ' #cccccc ')
    root.style.setProperty('--vscode-editor-background', '#1f1f1f')
    const palette = resolveVscodeMermaidPalette(root)
    expect(palette.foreground).toBe('#cccccc')
    expect(palette.background).toBe('#1f1f1f')
    expect(palette.widgetBackground).toBeUndefined()
    expect(palette.widgetBorder).toBeUndefined()
    root.remove()
  })
})
