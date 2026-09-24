// @vitest-environment jsdom
// 编辑器铬件（光标/选区）主题适配契约（钉子测试）：CM6 baseTheme 按浅色
// 主题渲染光标（黑）与选区（浅灰），dark 变体需显式声明 darkTheme 而
// 扩展未声明——深色 webview 下黑底黑光标（用户验收发现）。main.css 以
// VSCode 主题变量覆盖，本测试读 CSS 源文本钉住覆盖规则不被无意删改。
// jsdom 声明仅为与其余 webview 单测同环境；本测试只读文件、不触 DOM。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

function extractOne(label: string, pattern: RegExp): RegExpMatchArray {
  const matches = [...css.matchAll(pattern)]
  expect(
    matches.length,
    `main.css 中「${label}」应恰好出现一次（模式 ${String(pattern)}，实际 ${matches.length} 处）`,
  ).toBe(1)
  return matches[0]!
}

describe('编辑器铬件主题适配（光标/选区走 VSCode 主题变量）', () => {
  it('光标颜色：.cm-cursor/.cm-dropCursor 引 --vscode-editorCursor-foreground', () => {
    const rule = extractOne(
      '光标颜色规则',
      /\.cm-cursor,\s*\n#app \.cm-editor \.cm-dropCursor\s*\{[^}]*\}/g,
    )
    expect(rule[0], '光标颜色须引主题变量（黑底黑光标的根治）').toMatch(
      /border-left-color:\s*var\(--vscode-editorCursor-foreground/,
    )
  })

  it('选区背景：引 --vscode-editor-selectionBackground（含聚焦态覆盖）', () => {
    const rule = extractOne(
      '选区背景规则',
      /\.cm-selectionLayer \.cm-selectionBackground,\s*\n#app \.cm-editor\.cm-focused[^{]*\{[^}]*\}/g,
    )
    expect(rule[0], '选区背景须引主题变量（取代 CM6 浅色默认 #d9d9d9）').toMatch(
      /background:\s*var\(--vscode-editor-selectionBackground/,
    )
  })
})
