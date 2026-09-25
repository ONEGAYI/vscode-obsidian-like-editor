// 表格矩形格区与边沿控件的 CSS 契约。真实绘制仍由浏览器和宿主探针验证；
// 此处防止关键样式被删后，只剩 DOM 类名使交互测试误报通过。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? []

function rule(selector: string, declaration?: RegExp): string {
  const found = blocks.filter((block) => block.split('{')[0]!.split(',')
    .some((part) => part.trim() === selector) &&
    (declaration === undefined || declaration.test(block.split('{')[1]!)))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!.split('{')[1]!
}

const cell = '#app .cm-editor .cm-scroller .vsidian-table-grid-row > .vsidian-table-grid-cell'
const controls = '#app .cm-editor .vsidian-table-controls'

describe('矩形格区绘制契约（#72–#74）', () => {
  it('整格淡底使用主题焦点色，内部格线仍由普通单元格边框绘制', () => {
    const fill = rule(`${cell}.vsidian-table-region-cell`)
    expect(fill).toMatch(/background:\s*color-mix\(in srgb,\s*var\(--vscode-focusBorder,\s*#[\da-f]+\)\s+14%,\s*transparent\)/i)
    expect(fill, '格区填色不应覆盖内部网格边框').not.toMatch(/\bborder(?:-(?:top|bottom|left|right))?\s*:/)
    expect(rule(`${cell}`)).toMatch(/border:\s*1px solid var\(--vscode-panel-border/)
  })

  it('只在矩形外围绘制四条主题色边与四个圆角', () => {
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      expect(rule(`${cell}.vsidian-table-region-${edge}`))
        .toMatch(new RegExp(`border-${edge}:\\s*2px solid var\\(--vscode-focusBorder`))
    }
    for (const [vertical, horizontal] of [
      ['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right'],
    ]) {
      expect(rule(`${cell}.vsidian-table-region-${vertical}.vsidian-table-region-${horizontal}`))
        .toMatch(new RegExp(`border-${vertical}-${horizontal}-radius:\\s*6px`))
    }
  })
})

describe('边沿控件绘制契约（#75）', () => {
  it('控件层不遮挡表格，按钮默认透明但可命中，悬停和焦点时显现', () => {
    expect(rule(controls)).toMatch(/pointer-events:\s*none/)
    const button = rule(`${controls} button`)
    expect(button).toMatch(/opacity:\s*0\s*;/)
    expect(button).toMatch(/pointer-events:\s*auto/)
    for (const selector of ['button:hover', 'button:focus-visible', 'button.vsidian-table-control-hover']) {
      expect(rule(`${controls} ${selector}`)).toMatch(/opacity:\s*1\s*;/)
    }
  })

  it('行列把手为拖动控件，新增入口保持窄条尺寸', () => {
    for (const axis of ['row', 'column']) {
      expect(rule(`${controls} .vsidian-table-${axis}-handle`)).toMatch(/cursor:\s*grab/)
    }
    expect(rule(`${controls} .vsidian-table-insert-row`, /(?:^|;)\s*height:/))
      .toMatch(/height:\s*12px/)
    expect(rule(`${controls} .vsidian-table-insert-column`, /(?:^|;)\s*width:/))
      .toMatch(/width:\s*12px/)
  })
})
