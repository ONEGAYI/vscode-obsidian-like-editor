// 右侧栏布局 CSS 契约（#53）：钉住 main.css 的布局与图标线宽关键规则，
// 防止样式表被误删或只剩 DOM 类名而集成探针失效。断言对象对应用户可见
// 效果的样式来源：侧栏占位/收起、主编辑区收缩、图标竖线两态粗细。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')
const controllerSrc = readFileSync(
  path.resolve(process.cwd(), 'src/webview/syncController.ts'),
  'utf8',
)

function rule(selector: string, declaration?: RegExp): string {
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? []
  const found = blocks.filter((block) => block.split('{')[0]?.trim().endsWith(selector) &&
    (declaration === undefined || declaration.test(block.split('{')[1] ?? '')))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!
}

describe('侧栏布局骨架 CSS 契约（#53）', () => {
  it('body 容器为水平 flex，主编辑区弹性收缩', () => {
    const body = rule('#app .vsidian-body')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/height:\s*100%/)
    const main = rule('#app .vsidian-main')
    expect(main).toMatch(/flex:\s*1 1 auto/)
    expect(main).toMatch(/min-width:\s*0/)
    expect(main).toMatch(/flex-direction:\s*column/)
  })

  it('侧栏默认收起零宽不占位，open 类以宽度过渡展开（过渡动画）', () => {
    // declaration 过滤区分主规则与 prefers-reduced-motion 媒体块内的同选择器规则
    const collapsed = rule('#app .vsidian-sidebar', /width:\s*0/)
    // 常驻 flex + 零宽表达收起：display 二值切换不可过渡，宽度可
    expect(collapsed).toMatch(/display:\s*flex/)
    expect(collapsed).toMatch(/width:\s*0/)
    // 过渡期间内层内容（固定宽）由外层裁切，不随宽度挤压变形
    expect(collapsed).toMatch(/overflow:\s*hidden/)
    // 展开动画：宽度与边框一起过渡（ease-out，150ms）
    expect(collapsed).toMatch(/transition:[^;]*width[^;]*0\.15s/)
    // border-box 下收起态边框必须归零，否则残留 1px 占位竖线
    expect(collapsed).toMatch(/border-left-width:\s*0/)
    const opened = rule('#app .vsidian-body.vsidian-sidebar-open .vsidian-sidebar')
    expect(opened).toMatch(/width:\s*var\(--vsidian-sidebar-width,\s*280px\)/)
    // 侧栏与主编辑区的视觉分界（用户可见的分隔线，展开态恢复）
    expect(opened).toMatch(/border-left-width:\s*1px/)
  })

  it('侧栏内层子容器固定宽：宽度动画期间内容不被挤压', () => {
    // 外层宽度 0↔280 过渡时，内层 toolbar/面板宿主保持目标宽——否则
    // 内容随外层逐帧 reflow 挤压变形（展开动画的可视前提）
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-toolbar'))
      .toMatch(/width:\s*var\(--vsidian-sidebar-width,\s*280px\)/)
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-panel'))
      .toMatch(/width:\s*var\(--vsidian-sidebar-width,\s*280px\)/)
  })

  it('尊重系统减弱动画设置（prefers-reduced-motion 下禁用过渡）', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?\.vsidian-sidebar[\s\S]{0,120}?transition:\s*none/)
  })

  it('侧栏自有顶栏与主顶栏同高（对齐），面板区域弹性填充', () => {
    const bar = rule('#app .vsidian-sidebar .vsidian-sidebar-toolbar')
    expect(bar).toMatch(/height:\s*var\(--vsidian-toolbar-height,\s*30px\)/)
    // 顶栏按钮与面板内容左对齐（同一左右内边距，侧栏观感统一）
    expect(bar).toMatch(/padding:\s*0 12px/)
    const mainBar = rule('#app .vsidian-toolbar')
    expect(mainBar).toMatch(/height:\s*var\(--vsidian-toolbar-height,\s*30px\)/)
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-panel')).toMatch(/flex:\s*1 1 auto/)
  })

  it('切换按钮推到主编辑区顶栏右端', () => {
    expect(rule('.vsidian-toolbar .vsidian-sidebar-toggle')).toMatch(/margin-left:\s*auto/)
  })

  it('拖宽句柄热区就位：左缘定位、col-resize 光标、触屏不被滚动劫持', () => {
    const handle = rule('#app .vsidian-sidebar .vsidian-sidebar-resizer')
    expect(handle).toMatch(/position:\s*absolute/)
    expect(handle).toMatch(/cursor:\s*col-resize/)
    expect(handle).toMatch(/touch-action:\s*none/)
    expect(handle).toMatch(/width:\s*10px/)
    expect(handle).toMatch(/left:\s*0/)
    // hover/拖拽中的 2px 高亮竖条（VSCode sash 风格，颜色跟随主题变量；
    // 多选择器列表以末项锚定，与 tablePaintCssContract 的 control-hover 同口径）
    expect(rule('#app .vsidian-sidebar.vsidian-sidebar-resizing .vsidian-sidebar-resizer::before'))
      .toMatch(/background:\s*var\(--vscode-sash-hoverBorder/)
    // 键盘微调可达的聚焦轮廓（focus-visible，非鼠标点击态）
    expect(rule('#app .vsidian-sidebar .vsidian-sidebar-resizer:focus-visible'))
      .toMatch(/outline:/)
    // 收起态句柄不可聚焦：width:0 + overflow:hidden 只裁掉视觉与命中，tab 序
    // 仍可达——visibility:hidden 让真实浏览器把句柄移出 tab 序（JS 侧 keydown
    // 另有 sidebarOpen 语义守卫双保险）
    expect(rule('#app .vsidian-body:not(.vsidian-sidebar-open) .vsidian-sidebar-resizer'))
      .toMatch(/visibility:\s*hidden/)
  })

  it('拖拽期间禁用宽度过渡（resizing 类），侧栏全域锁定调整光标', () => {
    // 0.15s 宽度过渡是展开/收起动画；拖宽逐帧写变量时必须旁路，否则滞后不跟手
    expect(rule('#app .vsidian-sidebar.vsidian-sidebar-resizing')).toMatch(/transition:\s*none/)
    expect(css, '拖拽全域光标规则应存在')
      .toMatch(/\.vsidian-sidebar-resizing[\s\S]{0,120}?cursor:\s*col-resize/)
  })

  it('正文容器成为主编辑区 flex 成员（顶栏扣减由 flex 分配取代）', () => {
    expect(rule('#app .vsidian-view-live')).toMatch(/flex:\s*1 1 auto/)
    expect(rule('#app .vsidian-view-live')).toMatch(/min-height:\s*0/)
    const reading = rule('#app .vsidian-view-reading')
    expect(reading).toMatch(/flex:\s*1 1 auto/)
    // 旧的 calc(100% - 30px) 高度补偿随 flex 布局移除
    expect(reading).not.toMatch(/calc\(100% - 30px\)/)
  })
})

describe('两态图标线宽差异的样式来源（#53）', () => {
  it('收起态竖线细线 1.5px，展开态竖线粗线 3px，差异唯一来源是类切换规则', () => {
    // 细线以 declaration 区分（粗线规则的选择器同以细线选择器文本结尾）
    const thin = rule(
      '.vsidian-toolbar .vsidian-sidebar-toggle .vsidian-sidebar-icon-bar',
      /stroke-width:\s*1\.5px/,
    )
    expect(thin).toMatch(/stroke-width:\s*1\.5px/)
    const thick = rule(
      '#app .vsidian-body.vsidian-sidebar-open .vsidian-toolbar .vsidian-sidebar-toggle .vsidian-sidebar-icon-bar',
    )
    expect(thick).toMatch(/stroke-width:\s*3px/)
    // 外框线宽恒定（对照：两态不变的视觉锚）
    expect(rule('.vsidian-toolbar .vsidian-sidebar-toggle .vsidian-sidebar-icon-frame'))
      .toMatch(/stroke-width:\s*1\.5px/)
  })

  it('SVG 构建不在属性上写 stroke-width（computed 差异只能来自样式表）', () => {
    // 侧栏图标构建函数不携带 stroke-width 属性——若在属性上写死，
    // 样式表失效时两态线宽仍可能相同，集成绘制断言失去意义
    const start = controllerSrc.indexOf('function createSidebarToggleIcon')
    expect(start, '图标构建函数应存在于 syncController').toBeGreaterThan(0)
    const next = controllerSrc.indexOf('\nfunction ', start + 1)
    const zone = controllerSrc.slice(start, next < 0 ? undefined : next)
    expect(zone).not.toMatch(/stroke-width/i)
  })
})

describe('顶栏图标按钮样式（#53）', () => {
  it('工具栏按钮为透明图标按钮（悬停高亮跟随 VSCode 变量）', () => {
    const btn = rule('.vsidian-toolbar button')
    expect(btn).toMatch(/background:\s*transparent/)
    expect(btn).toMatch(/border:\s*none/)
    // 悬停/聚焦高亮跟随 VSCode 工具栏变量（多选择器列表以末项锚定，
    // 与 tablePaintCssContract 的 control-hover 同口径）
    expect(rule('.vsidian-toolbar button:focus-visible')).toMatch(/background:\s*var\(--vscode-toolbar-hoverBackground/)
    expect(css, '悬停高亮规则应存在').toMatch(/\.vsidian-toolbar button:hover/)
    // 图标尺寸与颜色跟随前景变量（currentColor 继承）
    expect(rule('.vsidian-toolbar button svg')).toMatch(/width:\s*16px/)
  })
})
