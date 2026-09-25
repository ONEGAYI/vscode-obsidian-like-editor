// @vitest-environment jsdom
// 右侧栏布局与顶栏图标化契约（#53）：
// - 布局结构：#app 下 vsidian-body（水平）> vsidian-main（主编辑区：顶栏 +
//   live/reading 容器）+ vsidian-sidebar（侧栏：自有顶栏 + 空面板容器）
// - 左侧设置入口图标化为齿轮（内联 SVG + aria-label + title），保留
//   settings.open 出站行为；不再有文字「设置」
// - 侧栏切换按钮位于主编辑区顶栏右端（toolbar 最后子元素），两态图标竖线
//   的粗细差异唯一来源是 CSS（vsidian-sidebar-open 类切换），可访问名称
//   随状态变化（收起=「展开右侧栏」，展开=「收起右侧栏」）并同步
//   aria-expanded
// - 侧栏是纯 webview 视图状态：切换零写回（无 edit.request、文本不变）、
//   与 viewMode 正交（切模式不动侧栏，切侧栏不动模式）、经 bridge state
//   持久化（webview 重载恢复）
// - sidebar.test.click 测试钩子驱动与用户点击同一处理器
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：CM6 视口测量的零值 polyfill（与 viewMode.test.ts 同款）
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/sidebar.md'

const DOC = [
  '# 侧栏样例标题',
  '',
  '第一段普通文本。',
  '',
  '- 列表项',
  '',
  '结尾段落。',
  '',
].join('\n')

interface BridgeHarness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
  saved: () => Record<string, unknown> | undefined
}

function makeBridge(saved?: Record<string, unknown>): BridgeHarness {
  const sent: WebviewToHost[] = []
  let state = saved
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as Record<string, unknown>
    },
  }
  return { bridge, sent, saved: () => state }
}

function mountSidebar(h: BridgeHarness, text = DOC): { c: WebviewSyncController; parent: HTMLElement } {
  const c = new WebviewSyncController(h.bridge)
  const parent = document.createElement('div')
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text })
  return { c, parent }
}

function viewState(c: WebviewSyncController, h: BridgeHarness) {
  const before = h.sent.length
  c.handleHostMessage({ kind: 'view.state.request' })
  const msg = h.sent.slice(before).find((m) => m.kind === 'view.state')
  if (!msg) {
    throw new Error('view.state 未回报')
  }
  return msg as Extract<WebviewToHost, { kind: 'view.state' }>
}

function sentEditRequests(h: BridgeHarness): number {
  return h.sent.filter((m) => m.kind === 'edit.request').length
}

describe('布局结构（#53）', () => {
  it('mount 后构成 body > main + sidebar 的水平布局骨架，正文容器在 main 内', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    const body = parent.querySelector<HTMLElement>('.vsidian-body')
    expect(body, '应有 vsidian-body 水平容器').toBeTruthy()
    expect(parent.firstElementChild === body, 'body 为 #app 首子元素（findPanel 浮层之外）').toBe(true)
    const main = body!.querySelector<HTMLElement>('.vsidian-main')
    expect(main, 'body 内应有 vsidian-main 主编辑区').toBeTruthy()
    // 主编辑区：顶栏 + 横幅 + live + reading（顺序与既有挂载一致）
    const children = [...main!.children].map((el) => el.className)
    expect(children[0]).toContain('vsidian-toolbar')
    expect(children[1]).toContain('vsidian-suspend-banner')
    expect(children[2]).toContain('vsidian-view-live')
    expect(children[3]).toContain('vsidian-view-reading')
    // 侧栏与 main 同级
    const sidebar = body!.querySelector<HTMLElement>('.vsidian-sidebar')
    expect(sidebar, 'body 内应有 vsidian-sidebar 侧栏').toBeTruthy()
    expect(sidebar!.parentElement === body).toBe(true)
  })

  it('侧栏自有顶栏按钮容器与面板容器就位（#54 起接入大纲；结构由 outlinePanel 测试细断言）', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    const sidebar = parent.querySelector<HTMLElement>('.vsidian-sidebar')!
    const bar = sidebar.querySelector<HTMLElement>('.vsidian-sidebar-toolbar')
    expect(bar, '侧栏应有 vsidian-sidebar-toolbar 自有顶栏').toBeTruthy()
    const actions = bar!.querySelector<HTMLElement>('.vsidian-sidebar-toolbar-actions')
    expect(actions, '侧栏顶栏应有按钮容器 vsidian-sidebar-toolbar-actions').toBeTruthy()
    // #54 起：容器内为「大纲」按钮（当前唯一一项）
    expect(actions!.children.length).toBe(1)
    expect(actions!.firstElementChild!.classList.contains('vsidian-outline-toggle')).toBe(true)
    const panel = sidebar.querySelector<HTMLElement>('.vsidian-sidebar-panel')
    expect(panel, '侧栏应有 vsidian-sidebar-panel 面板容器').toBeTruthy()
    // #54 起：面板区域内为大纲面板容器
    expect(panel!.children.length).toBe(1)
    expect(panel!.firstElementChild!.classList.contains('vsidian-outline-panel')).toBe(true)
  })

  it('侧栏 DOM 不随模式显隐（布局为两模式共用，显隐只由侧栏状态控制）', () => {
    const h = makeBridge()
    const { c, parent } = mountSidebar(h)
    const sidebar = parent.querySelector<HTMLElement>('.vsidian-sidebar')!
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(parent.contains(sidebar)).toBe(true)
    expect(sidebar.style.display).toBe('')
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    expect(parent.contains(sidebar)).toBe(true)
  })
})

describe('左侧设置入口齿轮图标化（#53）', () => {
  it('工具栏含齿轮设置按钮：内联 SVG + aria-label + title，无文字「设置」', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    const btn = parent.querySelector<HTMLButtonElement>(
      '.vsidian-toolbar button.vsidian-settings-toggle',
    )
    expect(btn, '工具栏应含 vsidian-settings-toggle 按钮').toBeTruthy()
    expect(btn!.querySelector('svg'), '设置按钮应为内联 SVG 齿轮图标').toBeTruthy()
    expect(btn!.textContent, '图标化后按钮不再承载文字').not.toContain('设置')
    expect(btn!.getAttribute('aria-label')).toBe('打开 Vsidian 设置')
    expect(btn!.getAttribute('title')).toBe('打开 Vsidian 设置')
    expect(btn!.closest('.vsidian-main'), '设置按钮位于主编辑区顶栏（左侧）').toBeTruthy()
  })

  it('点击齿轮按钮仍发送 settings.open（行为保留）', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    h.sent.length = 0
    const btn = parent.querySelector<HTMLButtonElement>(
      '.vsidian-toolbar button.vsidian-settings-toggle',
    )!
    btn.click()
    expect(h.sent).toContainEqual({ kind: 'settings.open' })
  })
})

describe('侧栏切换按钮（#53）', () => {
  it('切换按钮位于主编辑区顶栏右端（toolbar 最后子元素）且含两态图标 SVG', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    const toolbar = parent.querySelector<HTMLElement>('.vsidian-main .vsidian-toolbar')!
    const btn = toolbar.querySelector<HTMLButtonElement>('button.vsidian-sidebar-toggle')
    expect(btn, '顶栏应含 vsidian-sidebar-toggle 按钮').toBeTruthy()
    expect(toolbar.lastElementChild === btn, '切换按钮应为顶栏最后一个子元素（右端）').toBe(true)
    const bar = btn!.querySelector<SVGElement>('.vsidian-sidebar-icon-bar')
    const frame = btn!.querySelector<SVGElement>('.vsidian-sidebar-icon-frame')
    expect(bar, '图标应含竖线 vsidian-sidebar-icon-bar').toBeTruthy()
    expect(frame, '图标应含外框 vsidian-sidebar-icon-frame').toBeTruthy()
    // 线宽差异唯一来源是样式表：SVG 属性上不写 stroke-width
    expect(bar!.getAttribute('stroke-width')).toBeNull()
    expect(frame!.getAttribute('stroke-width')).toBeNull()
  })

  it('默认收起：无 open 类、可访问名称为「展开右侧栏」、aria-expanded false', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    const body = parent.querySelector<HTMLElement>('.vsidian-body')!
    const btn = parent.querySelector<HTMLButtonElement>('button.vsidian-sidebar-toggle')!
    expect(body.classList.contains('vsidian-sidebar-open')).toBe(false)
    expect(btn.getAttribute('aria-label')).toBe('展开右侧栏')
    expect(btn.getAttribute('title')).toBe('展开右侧栏')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('点击展开：open 类挂上、名称变「收起右侧栏」、aria-expanded true；再点击收起', () => {
    const h = makeBridge()
    const { parent } = mountSidebar(h)
    const body = parent.querySelector<HTMLElement>('.vsidian-body')!
    const btn = parent.querySelector<HTMLButtonElement>('button.vsidian-sidebar-toggle')!
    btn.click()
    expect(body.classList.contains('vsidian-sidebar-open')).toBe(true)
    expect(btn.getAttribute('aria-label')).toBe('收起右侧栏')
    expect(btn.getAttribute('title')).toBe('收起右侧栏')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    btn.click()
    expect(body.classList.contains('vsidian-sidebar-open')).toBe(false)
    expect(btn.getAttribute('aria-label')).toBe('展开右侧栏')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('sidebar.test.click 测试钩子驱动与用户点击同一处理器', () => {
    const h = makeBridge()
    const { c, parent } = mountSidebar(h)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    const body = parent.querySelector<HTMLElement>('.vsidian-body')!
    expect(body.classList.contains('vsidian-sidebar-open')).toBe(true)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    expect(body.classList.contains('vsidian-sidebar-open')).toBe(false)
  })
})

describe('切换不产生文本编辑历史（核心契约）', () => {
  it('来回切换全程零 edit.request、文本不变', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    const before = sentEditRequests(h)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    const state = viewState(c, h)
    expect(sentEditRequests(h)).toBe(before)
    expect(state.text).toBe(DOC)
    expect(state.docLength).toBe(DOC.length)
  })

  it('本地未确认输入在切换后保留', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    c.getView()!.dispatch({ changes: { from: 0, insert: '未保存前缀' } })
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    expect(viewState(c, h).text.startsWith('未保存前缀')).toBe(true)
  })
})

describe('侧栏状态与模式正交（两模式共用布局）', () => {
  it('切模式不动侧栏：展开态切到 reading 再回 live 仍展开', () => {
    const h = makeBridge()
    const { c, parent } = mountSidebar(h)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    let state = viewState(c, h)
    expect(state.viewMode).toBe('reading')
    expect(state.sidebar?.open).toBe(true)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    state = viewState(c, h)
    expect(state.viewMode).toBe('live')
    expect(state.sidebar?.open).toBe(true)
    const body = parent.querySelector<HTMLElement>('.vsidian-body')!
    expect(body.classList.contains('vsidian-sidebar-open')).toBe(true)
  })

  it('切侧栏不动模式：reading 态展开/收起侧栏后仍是 reading', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    const state = viewState(c, h)
    expect(state.viewMode).toBe('reading')
    expect(state.sidebar?.open).toBe(true)
    expect(state.readingBlockCount).toBeGreaterThan(0)
  })
})

describe('持久化与 webview 重载恢复', () => {
  it('sidebarOpen 写入 bridge state，与 viewMode/seq 合并互不覆盖', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    c.getView()!.dispatch({ changes: { from: 0, insert: 'X' } })
    const saved = h.saved() as { seq?: number; viewMode?: string; sidebarOpen?: boolean }
    expect(saved.sidebarOpen).toBe(true)
    expect(saved.seq).toBe(1)
    // 切模式不覆盖 sidebarOpen
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const saved2 = h.saved() as { viewMode?: string; sidebarOpen?: boolean }
    expect(saved2.viewMode).toBe('reading')
    expect(saved2.sidebarOpen).toBe(true)
  })

  it('重载后（新 controller 同一 state）恢复展开态', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    const parent2 = document.createElement('div')
    const c2 = new WebviewSyncController(h.bridge)
    c2.mount(parent2)
    c2.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    const state = viewState(c2, h)
    expect(state.sidebar?.open).toBe(true)
    expect(parent2.querySelector('.vsidian-body')!.classList.contains('vsidian-sidebar-open')).toBe(true)
  })

  it('无历史时默认收起', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    expect(viewState(c, h).sidebar?.open).toBe(false)
  })
})

describe('view.state 的 sidebar 观测（jsdom 无布局的容错口径）', () => {
  it('sidebar 字段回报：open 布尔、名称字符串、绘制字段容错（null/false 不抛错）', () => {
    const h = makeBridge()
    const { c } = mountSidebar(h)
    const state = viewState(c, h)
    const probe = state.sidebar
    expect(probe).toBeDefined()
    expect(probe!.open).toBe(false)
    expect(probe!.toggleAriaLabel).toBe('展开右侧栏')
    expect(probe!.settingsAriaLabel).toBe('打开 Vsidian 设置')
    // jsdom 无布局/无 CSS 引擎：绘制命中与线宽读取容错为 false/null（真宿主断言见集成）
    expect(probe!.toggleBarStrokeWidth === null || typeof probe!.toggleBarStrokeWidth === 'string').toBe(true)
    expect(probe!.mainWidthPx === null || probe!.mainWidthPx === 0).toBe(true)
  })
})
