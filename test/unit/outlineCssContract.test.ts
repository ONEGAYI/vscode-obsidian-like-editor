// 大纲面板 CSS 契约（#54）：钉住 main.css 中大纲面板的关键规则——面板显隐
// 唯一开关（侧栏容器的 outline-active 类）、条目按级别缩进（用户可见的层级
// 表达）、侧栏顶栏按钮形态。样式表被误删或只剩 DOM 类名时，集成绘制层探针
// （elementFromPoint 命中、computed 背景）会失去差异来源，本契约先在源头钉住。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

function rule(selector: string, declaration?: RegExp): string {
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? []
  const found = blocks.filter((block) => block.split('{')[0]?.trim().endsWith(selector) &&
    (declaration === undefined || declaration.test(block.split('{')[1] ?? '')))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!
}

describe('大纲面板显隐（#54）', () => {
  it('面板默认隐藏，侧栏容器的 outline-active 类是唯一显隐开关', () => {
    const hidden = rule('#app .vsidian-sidebar .vsidian-outline-panel')
    expect(hidden).toMatch(/display:\s*none/)
    const shown = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-panel')
    expect(shown).toMatch(/display:\s*flex/)
    expect(shown).toMatch(/flex-direction:\s*column/)
  })

  it('面板纵向滚动：超长大纲不撑破侧栏', () => {
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-panel')).toMatch(/overflow:\s*hidden/)
    const panel = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-panel')
    expect(panel).toMatch(/overflow-y:\s*auto/)
    expect(panel).toMatch(/min-height:\s*0/)
  })
})

describe('大纲条目按级别缩进（用户可见的层级表达）', () => {
  it('级别 1 无缩进，级别 2–6 逐级递增（padding-inline-start）', () => {
    expect(rule('.vsidian-sidebar .vsidian-outline-item.vsidian-outline-level-1'))
      .toMatch(/padding-inline-start:\s*0/)
    const lv2 = rule('.vsidian-sidebar .vsidian-outline-item.vsidian-outline-level-2')
    expect(lv2).toMatch(/padding-inline-start:\s*10px/)
    for (const level of [3, 4, 5, 6]) {
      const r = rule(`.vsidian-sidebar .vsidian-outline-item.vsidian-outline-level-${level}`)
      expect(r).toMatch(new RegExp(`padding-inline-start:\\s*${(level - 1) * 10}px`))
    }
  })

  it('条目基础样式：不换行省略（长标题不撑破侧栏）、高度可点读、继承前景色', () => {
    const item = rule('.vsidian-sidebar .vsidian-outline-item')
    expect(item).toMatch(/white-space:\s*nowrap/)
    expect(item).toMatch(/overflow:\s*hidden/)
    expect(item).toMatch(/text-overflow:\s*ellipsis/)
    expect(item).toMatch(/color:\s*inherit/)
  })

  it('空态占位：弱化文字（用户可读的「无标题」反馈）', () => {
    const empty = rule('.vsidian-sidebar .vsidian-outline-empty')
    expect(empty).toMatch(/opacity:\s*0\.7/)
    expect(empty).toMatch(/padding:\s*8px 10px/)
  })
})

describe('侧栏顶栏按钮（#54）', () => {
  it('按钮为透明图标按钮，与主编辑区顶栏同形态（悬停高亮跟随 VSCode 变量）', () => {
    const btn = rule('#app .vsidian-sidebar .vsidian-sidebar-toolbar button')
    expect(btn).toMatch(/background:\s*transparent/)
    expect(btn).toMatch(/border:\s*none/)
    expect(css, '悬停高亮规则应存在').toMatch(
      /#app \.vsidian-sidebar \.vsidian-sidebar-toolbar button:hover/,
    )
    expect(rule('#app .vsidian-sidebar .vsidian-toolbar-actions button svg'))
      .toMatch(/width:\s*16px/)
  })

  it('active 态按钮背景高亮：两态差异唯一来源是 outline-active 类规则', () => {
    const active = rule(
      '#app .vsidian-sidebar.vsidian-outline-active .vsidian-sidebar-toolbar button.vsidian-outline-toggle',
    )
    expect(active).toMatch(/background:\s*var\(--vscode-toolbar-hoverBackground/)
  })
})
