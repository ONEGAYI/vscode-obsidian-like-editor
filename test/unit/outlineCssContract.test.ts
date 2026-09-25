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

// ---- #65 行内样式透传：字重语义与主题色同源 ----

describe('大纲条目字重语义（#65：只认显式标记）', () => {
  it('条目一律常规字重（不继承标题级别加粗），CSS 钉住', () => {
    const item = rule('.vsidian-sidebar .vsidian-outline-item')
    expect(item).toMatch(/font-weight:\s*400/)
  })

  it('仅显式粗体段加重：strong span 字重 700', () => {
    expect(rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-strong'))
      .toMatch(/font-weight:\s*700/)
  })

  it('斜体/行内代码/删除线的透传呈现规则', () => {
    expect(rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-emphasis'))
      .toMatch(/font-style:\s*italic/)
    const code = rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-code')
    expect(code).toMatch(/font-family:\s*var\(--vscode-editor-font-family/)
    expect(code).toMatch(/background-color:\s*var\(--vsidian-live-code-background/)
    expect(rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-strike'))
      .toMatch(/text-decoration:\s*line-through/)
  })
})

describe('主题色同源（#65：大纲层级与正文标题引用同一变量族）', () => {
  it('#app 定义标题层级色变量族 1–6（当前默认前景色，主题分级仅改此处）', () => {
    for (let n = 1; n <= 6; n++) {
      expect(css, `--vsidian-heading-color-${n} 应定义于 #app`).toMatch(
        new RegExp(`--vsidian-heading-color-${n}:\\s*var\\(--vscode-editor-foreground\\)`),
      )
    }
  })

  it('live 标题行级与大纲条目级引用同一变量（一处定义两处生效）', () => {
    for (let n = 1; n <= 6; n++) {
      const live = rule(`#app .cm-editor .cm-scroller .vsidian-heading-line-${n}`)
      expect(live, `live 标题 ${n} 级应引用层级色变量`).toMatch(
        new RegExp(`color:\\s*var\\(--vsidian-heading-color-${n}\\)`),
      )
      const outline = rule(`.vsidian-sidebar .vsidian-outline-item.vsidian-outline-level-${n}`)
      expect(outline, `大纲条目 ${n} 级应引用层级色变量`).toMatch(
        new RegExp(`color:\\s*var\\(--vsidian-heading-color-${n}\\)`),
      )
    }
  })

  it('阅读标题块级同引变量族（正文两模式同源）', () => {
    for (let n = 1; n <= 6; n++) {
      const reading = rule(`#app .vsidian-view-reading .vsidian-reading-heading-${n}`)
      expect(reading, `阅读标题 ${n} 级应引用层级色变量`).toMatch(
        new RegExp(`color:\\s*var\\(--vsidian-heading-color-${n}\\)`),
      )
    }
  })
})

describe('常驻高亮横条（#66）', () => {
  it('located 条目半透明背景横条：类切换是唯一差异来源，颜色跟随 VSCode 变量', () => {
    // 用户看到的东西（AGENTS 视觉层断言）：半透明覆盖横条——非 located
    // 条目无背景规则，两态差异唯一来源是本规则；样式失效时无横条可被
    // 集成 computed 断言捕获。回退值为半透明 rgba（无变量主题下仍可见）
    const located = rule('.vsidian-sidebar .vsidian-outline-item.vsidian-outline-located')
    expect(located).toMatch(/background:\s*var\(--vscode-list-hoverBackground,\s*rgba\(/)
    expect(located).toMatch(/border-radius:\s*4px/)
  })

  it('非 located 条目无背景：基础条目规则不含 background（高亮不透底）', () => {
    const item = rule('.vsidian-sidebar .vsidian-outline-item')
    expect(item).not.toMatch(/background/)
  })
})

// ---- #67 折叠滑块与手动折叠：滑块行、圆点串珠、箭头与折叠隐藏 ----

describe('折叠滑块行（#67：结绳记事）', () => {
  it('滑块行显隐唯一开关是侧栏容器的 outline-active 类（默认隐藏，与面板同模式）', () => {
    const hidden = rule('#app .vsidian-sidebar .vsidian-outline-slider')
    expect(hidden).toMatch(/display:\s*none/)
    const shown = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-slider')
    expect(shown).toMatch(/display:\s*flex/)
  })

  it('圆点按钮为正圆小点：border-radius 50% + 固定宽高 + 空心面（透明回退）', () => {
    const dot = rule('.vsidian-sidebar .vsidian-outline-slider-dot')
    expect(dot).toMatch(/border-radius:\s*50%/)
    expect(dot).toMatch(/width:\s*8px/)
    expect(dot).toMatch(/height:\s*8px/)
    // 空闲珠空心（侧栏背景遮线、透明主题回退穿珠可见）——当前档与空闲档
    // 的用户可见差异唯一来源是 active 类规则（实心填充 + 描边跟随）
    expect(dot).toMatch(/background:\s*var\(--vscode-sideBar-background,\s*transparent\)/)
    expect(dot).toMatch(/border:\s*1px solid/)
  })

  it('当前档圆点实心高亮：active 类规则是唯一差异来源（颜色跟随 VSCode 变量）', () => {
    const active = rule(
      '.vsidian-sidebar .vsidian-outline-slider-dot.vsidian-outline-slider-active',
    )
    expect(active).toMatch(/background:\s*var\(--vscode-button-background/)
  })

  it('横线串联（结绳意象）：滑块行 ::before 贯穿横线规则存在', () => {
    expect(css, '滑块行应有 ::before 横线规则').toMatch(
      /\.vsidian-sidebar \.vsidian-outline-slider::before/,
    )
  })
})

describe('折叠箭头与折叠隐藏（#67）', () => {
  it('箭头为条目内图标按钮：inline-flex、透明底、无边框、指针形态', () => {
    const chevron = rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-chevron')
    expect(chevron).toMatch(/display:\s*inline-flex/)
    expect(chevron).toMatch(/background:\s*transparent/)
    expect(chevron).toMatch(/border:\s*none/)
    expect(chevron).toMatch(/cursor:\s*pointer/)
  })

  it('箭头 SVG 尺寸钉住（16px，与侧栏图标口径一致）', () => {
    expect(rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-chevron svg'))
      .toMatch(/width:\s*16px/)
  })

  it('折叠态箭头旋转：collapsed 类规则是两态差异唯一来源', () => {
    const rotated = rule(
      '.vsidian-sidebar .vsidian-outline-item.vsidian-outline-collapsed .vsidian-outline-chevron',
    )
    expect(rotated).toMatch(/transform:\s*rotate\(/)
  })

  it('折叠隐藏：hidden 条目 display:none（类切换是唯一显隐开关）', () => {
    const hidden = rule('.vsidian-sidebar .vsidian-outline-item.vsidian-outline-hidden')
    expect(hidden).toMatch(/display:\s*none/)
  })

  it('占位与箭头同宽对齐（无子项条目文字与有子项条目文字左缘对齐）', () => {
    const spacer = rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-chevron-spacer')
    expect(spacer).toMatch(/width:\s*18px/)
    expect(rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-chevron'))
      .toMatch(/width:\s*18px/)
  })
})

// ---- #68 工具条与标题搜索：工具条行、按钮形态、搜索框、片段高亮、无匹配占位 ----

describe('大纲工具条行（#68）', () => {
  it('工具条行显隐唯一开关是侧栏容器的 outline-active 类（默认隐藏，与面板同模式）', () => {
    const hidden = rule('#app .vsidian-sidebar .vsidian-outline-toolbar')
    expect(hidden).toMatch(/display:\s*none/)
    const shown = rule('#app .vsidian-sidebar.vsidian-outline-active .vsidian-outline-toolbar')
    expect(shown).toMatch(/display:\s*flex/)
  })

  it('按钮为透明图标按钮（与侧栏顶栏按钮同形态：透明底、无边框、悬停高亮）', () => {
    const btn = rule('#app .vsidian-sidebar .vsidian-outline-toolbar button')
    expect(btn).toMatch(/background:\s*transparent/)
    expect(btn).toMatch(/border:\s*none/)
    expect(css, '悬停高亮规则应存在').toMatch(
      /#app \.vsidian-sidebar \.vsidian-outline-toolbar button:hover/,
    )
    // 图标尺寸钉住（选择器命中 DOM 实际结构；类名写错时 SVG 回退默认尺寸）
    expect(rule('#app .vsidian-sidebar .vsidian-outline-toolbar button svg'))
      .toMatch(/width:\s*16px/)
  })

  it('搜索输入框占余宽（flex:1）且不撑破侧栏（min-width:0），VSCode 输入变量配色', () => {
    const input = rule('#app .vsidian-sidebar .vsidian-outline-toolbar .vsidian-outline-search')
    expect(input).toMatch(/flex:\s*1\s+1\s+auto/)
    expect(input).toMatch(/min-width:\s*0/)
    expect(input).toMatch(/background:\s*var\(--vscode-input-background/)
    expect(input).toMatch(/color:\s*var\(--vscode-input-foreground/)
  })

  it('搜索框占位文案弱化（placeholder 前景变量）', () => {
    expect(css, 'placeholder 规则应存在').toMatch(
      /\.vsidian-sidebar \.vsidian-outline-toolbar \.vsidian-outline-search::placeholder/,
    )
  })
})

describe('搜索片段高亮与无匹配占位（#68）', () => {
  it('命中片段 mark：查找高亮变量配色的背景规则（样式失效时无背景可被 computed 断言捕获）', () => {
    const mark = rule('.vsidian-sidebar .vsidian-outline-item mark.vsidian-outline-search-hit')
    expect(mark).toMatch(/background:\s*var\(--vscode-editor-findMatchHighlightBackground/)
    expect(mark).toMatch(/color:\s*inherit/)
  })

  it('无匹配占位：弱化文字（用户可读的「无匹配」反馈，与空态同口径）', () => {
    const nomatch = rule('.vsidian-sidebar .vsidian-outline-nomatch')
    expect(nomatch).toMatch(/opacity:\s*0\.7/)
    expect(nomatch).toMatch(/padding:\s*8px 10px/)
  })
})

// ---- #69 右键菜单与重命名：浮层定位、菜单项、级联子菜单、编辑态 ----

describe('右键菜单浮层（#69）', () => {
  it('侧栏 position:relative（菜单 absolute 锚定的前提）', () => {
    // declaration 过滤：@media (reduced-motion) 内同名选择器不参与（只一个主块带 position）
    expect(rule('#app .vsidian-sidebar', /position:\s*relative/))
      .toMatch(/position:\s*relative/)
  })

  it('菜单容器 absolute 浮层：背景跟随 VSCode 菜单变量、边框圆角、z-index 抬升', () => {
    const menu = rule('.vsidian-sidebar .vsidian-outline-menu')
    expect(menu).toMatch(/position:\s*absolute/)
    expect(menu).toMatch(/background:\s*var\(--vscode-menu-background/)
    expect(menu).toMatch(/border:\s*1px solid var\(--vscode-menu-border/)
    expect(menu).toMatch(/z-index:\s*30/)
    expect(menu).toMatch(/min-width:\s*160px/)
  })

  it('菜单项按钮：全宽块状、透明底、指针形态', () => {
    const item = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-item')
    expect(item).toMatch(/display:\s*block/)
    expect(item).toMatch(/width:\s*100%/)
    expect(item).toMatch(/background:\s*transparent/)
    expect(item).toMatch(/border:\s*none/)
    expect(item).toMatch(/cursor:\s*pointer/)
    expect(item).toMatch(/text-align:\s*left/)
  })

  it('菜单项 hover/focus 高亮：两态规则存在（键盘可达的视觉反馈）', () => {
    const hover = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-item:not(:disabled):hover')
    expect(hover).toMatch(/background:\s*var\(--vscode-menu-selectionBackground|list-hoverBackground/)
    expect(css, 'focus-visible 规则应存在').toMatch(
      /\.vsidian-outline-menu-item:not\(:disabled\):focus-visible/,
    )
  })

  it('禁用项弱化（递归展开在无子项条目上）：透明度与默认指针', () => {
    const disabled = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-item:disabled')
    expect(disabled).toMatch(/opacity:\s*0\.4/)
    expect(disabled).toMatch(/cursor:\s*default/)
  })

  it('删除项 danger 红字（破坏性命令的视觉差异锚点）', () => {
    const danger = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-danger')
    expect(danger).toMatch(/color:\s*var\(--vscode-errorForeground/)
  })

  it('级联子菜单默认隐藏，父项 hover/focus-within 展开（CSS 显隐唯一开关）', () => {
    const hidden = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-submenu')
    expect(hidden).toMatch(/display:\s*none/)
    expect(hidden).toMatch(/position:\s*absolute/)
    expect(hidden).toMatch(/left:\s*100%/)
    const hover = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-host:hover .vsidian-outline-menu-submenu')
    expect(hover).toMatch(/display:\s*block/)
    const focus = rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-host:focus-within .vsidian-outline-menu-submenu')
    expect(focus).toMatch(/display:\s*block/)
  })

  it('父项宿主 relative（子菜单 left:100% 的定位锚）', () => {
    expect(rule('.vsidian-sidebar .vsidian-outline-menu .vsidian-outline-menu-host'))
      .toMatch(/position:\s*relative/)
  })

  it('重命名输入框：撑满条目、继承字号、VSCode 输入框边框变量', () => {
    const input = rule('.vsidian-sidebar .vsidian-outline-item .vsidian-outline-rename-input')
    expect(input).toMatch(/width:\s*100%/)
    expect(input).toMatch(/min-width:\s*0/)
    expect(input).toMatch(/font-size:\s*var\(--vsidian-outline-font-size,\s*12px\)/)
    expect(input).toMatch(/background:\s*var\(--vscode-input-background/)
    expect(input).toMatch(/border:\s*1px solid var\(--vscode-input-border/)
    expect(input).toMatch(/color:\s*var\(--vscode-input-foreground/)
  })
})
