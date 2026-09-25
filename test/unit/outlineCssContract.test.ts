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

  it('面板高度受宿主约束：宿主为 flex 列容器，面板 flex 填满且可收缩', () => {
    // 滚动成立的前提（P1-1 回归）：面板高度必须被宿主钳制在侧栏剩余空间内
    // （height:auto 时面板长到内容高度、clientHeight==scrollHeight，
    // overflow-y 永不激活，长大纲被宿主 overflow:hidden 裁到不可达）。
    // 布局链与 .vsidian-main > .vsidian-view-reading 同构：宿主 flex 列 +
    // 面板 flex:1 + min-height:0（允许收缩到容器内），overflow-y 才有
    // scrollHeight > clientHeight 的滚动余量。
    const host = rule('#app .vsidian-sidebar .vsidian-sidebar-panel')
    expect(host).toMatch(/display:\s*flex/)
    expect(host).toMatch(/flex-direction:\s*column/)
    expect(host).toMatch(/min-height:\s*0/)
    const panel = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-panel')
    expect(panel).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(panel).toMatch(/min-height:\s*0/)
  })

  it('面板纵向滚动：超长大纲不撑破侧栏（overflow-y 在高度约束下激活）', () => {
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-panel')).toMatch(/overflow:\s*hidden/)
    const panel = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-panel')
    expect(panel).toMatch(/overflow-y:\s*auto/)
    expect(panel).toMatch(/min-height:\s*0/)
  })

  it('面板内容与侧栏边缘有内边距（左右 12px，不贴边框线）', () => {
    // 用户可见的留白：级 1 条目缩进为 0，面板本体须自带左右 padding，
    // 否则内容直接顶着侧栏左缘分隔线/右缘
    const panel = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-panel')
    expect(panel).toMatch(/padding:\s*4px 12px/)
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
    // 条目在 flex 列面板内不收缩（滚动成立的另一半）：条目 overflow:hidden
    // 使 flex item 的 min-height:auto 解析为 0，缺 flex:0 0 auto 时长面板
    // 条目被均匀压扁、内容总高不再溢出容器，overflow-y 依旧永不激活
    expect(item).toMatch(/flex:\s*0\s+0\s+auto/)
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
    // 图标尺寸选择器必须命中 DOM 实际结构（.vsidian-sidebar-toolbar-actions，
    // 见 syncController buildSidebar）：类名写错时规则永不匹配，SVG 无尺寸
    // 属性回退到默认 26×26 溢出按钮盒（P1-2 回归）
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-toolbar-actions button svg'))
      .toMatch(/width:\s*16px/)
  })

  it('active 态按钮背景高亮：两态差异唯一来源是 outline-active 类规则', () => {
    const active = rule(
      '#app .vsidian-sidebar.vsidian-outline-active .vsidian-sidebar-toolbar button.vsidian-outline-toggle',
    )
    expect(active).toMatch(/background:\s*var\(--vscode-toolbar-hoverBackground/)
  })
})
