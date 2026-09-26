// Mermaid 暗色主题装配（工单 #110）：暗色分支的 themeVariables 与 VSCode
// 注入色板（--vscode-* 计算值）对齐——墨水色组（连线、信号线、文字）取
// 编辑器前景色，节点组取编辑器部件底色与描边，边标签底取编辑器画布底。
// 变量缺失（测试环境、宿主未注入）回退到与 Dark Modern 量级一致的暗色
// 兜底；亮色分支不经过本模块（维持 #60 现状）。
//
// 只覆盖对齐正文所需的最小键集：其余变量由 mermaid dark 基底主题自行
// 派生（本身已是暗色友好取值），避免整套主题硬编码后随上游版本漂移。

/** VSCode 侧取值来源（webview 由 VSCode 自动注入，宿主不手动注入） */
export interface VscodeMermaidPalette {
  /** 墨水色：连线、信号线、各类文字（--vscode-editor-foreground） */
  foreground: string
  /** 画布底：边标签背景（--vscode-editor-background） */
  background: string
  /** 节点填充（--vscode-editorWidget-background） */
  widgetBackground: string
  /** 节点描边（--vscode-editorWidget-border） */
  widgetBorder: string
}

/** 兜底色板：jsdom 单测与变量未注入环境的确定性取值 */
export const MERMAID_DARK_FALLBACK_PALETTE: Readonly<VscodeMermaidPalette> = {
  foreground: '#cccccc',
  background: '#1f1f1f',
  widgetBackground: '#2d2d30',
  widgetBorder: '#3c3c3c',
}

/** 解析宿主注入的 VSCode 色板；无 DOM 或变量缺失的键不出现（走兜底） */
export function resolveVscodeMermaidPalette(root?: HTMLElement): Partial<VscodeMermaidPalette> {
  if (typeof document === 'undefined') {
    return {}
  }
  const style = getComputedStyle(root ?? document.body)
  const read = (name: string): string | undefined => {
    const value = style.getPropertyValue(name).trim()
    return value === '' ? undefined : value
  }
  return {
    foreground: read('--vscode-editor-foreground'),
    background: read('--vscode-editor-background'),
    widgetBackground: read('--vscode-editorWidget-background'),
    widgetBorder: read('--vscode-editorWidget-border'),
  }
}

/** 色板 → mermaid 暗色 themeVariables（纯函数；键集见文件头注释） */
export function buildDarkMermaidThemeVariables(palette: Partial<VscodeMermaidPalette>): Record<string, string> {
  const foreground = palette.foreground ?? MERMAID_DARK_FALLBACK_PALETTE.foreground
  const background = palette.background ?? MERMAID_DARK_FALLBACK_PALETTE.background
  const widgetBackground = palette.widgetBackground ?? MERMAID_DARK_FALLBACK_PALETTE.widgetBackground
  const widgetBorder = palette.widgetBorder ?? MERMAID_DARK_FALLBACK_PALETTE.widgetBorder
  return {
    primaryColor: widgetBackground,
    primaryTextColor: foreground,
    primaryBorderColor: widgetBorder,
    // mermaid dark 基底会把 primaryColor 压暗约 35% 再派生 mainBkg（实测
    // #313131 → #1f2020，节点体块与画布近乎零色差）；直接覆写 mainBkg
    // 保住节点体块感，描边与文字仍由前景色承担辨识
    mainBkg: widgetBackground,
    lineColor: foreground,
    signalColor: foreground,
    signalTextColor: foreground,
    textColor: foreground,
    edgeLabelBackground: background,
  }
}
