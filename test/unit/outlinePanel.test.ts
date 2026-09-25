// @vitest-environment jsdom
// 大纲面板交互契约（#54）：侧栏顶栏「大纲」按钮与面板的显隐状态机、
// 大纲随当前文档文本更新（含未保存编辑）、面板切换零写回零出站。
// - 数据源：CM6 全文（webview 文本模型，含未确认输入），与视口渲染无关，
//   与 live/reading 模式无关（reading 下 CM6 doc 仍是权威文本模型）
// - 更新时机：可见时去抖刷新 + view.state.request 前即时校准（与 #14 查找
//   会话的 findEnsureFresh 同模式）；数据未变不重建 DOM
// - 面板切换是纯视图状态：零 edit.request、文本不变、经 bridge state 持久化
// - outline.test.click 测试钩子驱动与用户点击同一处理器
import { describe, it, expect, vi } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：CM6 视口测量的零值 polyfill（与 sidebarLayout.test.ts 同款）
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/outline.md'

const DOC = [
  '# 文档主标题',
  '',
  '## 同名标题',
  '',
  '### 三级标题',
  '',
  '## 同名标题',
  '',
  'Setext 一级',
  '===',
  '',
  '```text',
  '# 围栏内伪标题',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')

/** 期望大纲（级别 + 文字）：同名不合并、跨级保留、伪标题排除 */
const EXPECTED_ITEMS: Array<[number, string]> = [
  [1, '文档主标题'],
  [2, '同名标题'],
  [3, '三级标题'],
  [2, '同名标题'],
  [1, 'Setext 一级'],
]

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

function mountOutline(h: BridgeHarness, text = DOC): { c: WebviewSyncController; parent: HTMLElement } {
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

function openSidebar(c: WebviewSyncController): void {
  c.handleHostMessage({ kind: 'sidebar.test.click' })
}

function outlineDom(parent: HTMLElement) {
  const sidebar = parent.querySelector<HTMLElement>('.vsidian-sidebar')!
  return {
    sidebar,
    toggle: sidebar.querySelector<HTMLButtonElement>(
      '.vsidian-sidebar-toolbar-actions button.vsidian-outline-toggle',
    ),
    panel: sidebar.querySelector<HTMLElement>('.vsidian-outline-panel'),
    itemTexts: () =>
      [...sidebar.querySelectorAll<HTMLElement>('.vsidian-outline-item')].map((el) => el.textContent ?? ''),
    itemLevels: () =>
      [...sidebar.querySelectorAll<HTMLElement>('.vsidian-outline-item')].map((el) =>
        Number(el.dataset['vsidianLevel']),
      ),
  }
}

describe('大纲按钮与面板 DOM（#54）', () => {
  it('侧栏顶栏按钮容器含「大纲」按钮：aria-label/title/aria-controls 齐备', () => {
    const h = makeBridge()
    const { parent } = mountOutline(h)
    const d = outlineDom(parent)
    expect(d.toggle, '侧栏顶栏应有 vsidian-outline-toggle 按钮').toBeTruthy()
    expect(d.toggle!.getAttribute('aria-label')).toBe('大纲')
    expect(d.toggle!.getAttribute('title')).toBe('大纲')
    expect(d.toggle!.getAttribute('aria-controls')).toBe('vsidian-outline-panel')
  })

  it('大纲面板容器存在且有可访问名称（role=region + aria-label），id 与按钮 aria-controls 对应', () => {
    const h = makeBridge()
    const { parent } = mountOutline(h)
    const d = outlineDom(parent)
    expect(d.panel, '侧栏应有 vsidian-outline-panel 面板容器').toBeTruthy()
    expect(d.panel!.id).toBe('vsidian-outline-panel')
    expect(d.panel!.getAttribute('role')).toBe('region')
    expect(d.panel!.getAttribute('aria-label')).toBe('大纲')
  })

  it('默认 active：展开侧栏即见大纲（面板显隐唯一开关是侧栏容器类）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    const d = outlineDom(parent)
    // 收起态侧栏整体 display:none，active 类仍表达「面板将显示」
    expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(true)
    expect(d.toggle!.getAttribute('aria-expanded')).toBe('true')
    openSidebar(c)
    expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(true)
  })
})

describe('大纲内容：全文标题序列（验收核心）', () => {
  it('展开侧栏后，大纲面板条目 = 全文标题的级别与文字序列（同名不合并、跨级保留）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    const d = outlineDom(parent)
    expect(d.itemTexts()).toEqual(EXPECTED_ITEMS.map(([, text]) => text))
    expect(d.itemLevels()).toEqual(EXPECTED_ITEMS.map(([level]) => level))
  })

  it('条目携带级别类名（level-1..6）与 data-level，供 CSS 缩进与断言', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    const items = [...parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
    expect(items[0]!.className).toContain('vsidian-outline-level-1')
    expect(items[1]!.className).toContain('vsidian-outline-level-2')
    expect(items[2]!.className).toContain('vsidian-outline-level-3')
    expect(items.map((el) => el.dataset['vsidianLevel'])).toEqual(['1', '2', '3', '2', '1'])
  })

  it('大纲覆盖全文：屏外标题同样纳入（不依赖视口渲染）', () => {
    // 长文档：CM6 视口只渲染少量行，大纲仍取全文标题
    const lines: string[] = []
    for (let i = 1; i <= 400; i++) {
      lines.push(`# 第 ${i} 个标题`, '', `第 ${i} 段正文。`, '')
    }
    const h = makeBridge()
    const { c } = mountOutline(h, lines.join('\n'))
    openSidebar(c)
    const state = viewState(c, h)
    expect(state.outline?.items.length).toBe(400)
    expect(state.outline?.items[0]!.text).toBe('第 1 个标题')
    expect(state.outline?.items[399]!.text).toBe('第 400 个标题')
    // renderedLines 受视口限制，远小于全文标题数（大纲与视口渲染解耦的旁证）
    expect(state.renderedLines).toBeLessThan(400)
  })

  it('无标题文档显示空态占位（面板有可见内容与高度语义）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, '只有正文\n没有标题\n')
    openSidebar(c)
    const d = outlineDom(parent)
    expect(d.itemTexts()).toEqual([])
    expect(
      parent.querySelector('.vsidian-outline-empty')?.textContent,
      '空态占位应存在且可读',
    ).toBeTruthy()
  })
})

describe('编辑后大纲随当前文本更新（含未保存编辑）', () => {
  it('live 输入新标题后，view.state 的大纲序列即时反映（request 前校准）', async () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    // 在文档末尾追加一个新二级标题（未保存：无 ack 前本地已是新文本）
    const doc = c.getView()!.state.doc
    c.getView()!.dispatch({ changes: { from: doc.length, insert: '## 新增标题\n' } })
    const state = viewState(c, h)
    expect(state.outline?.items.map((i) => [i.level, i.text])).toEqual([
      ...EXPECTED_ITEMS,
      [2, '新增标题'],
    ])
    const d = outlineDom(parent)
    expect(d.itemTexts()).toContain('新增标题')
  })

  it('连续输入期间不重算，停顿 250ms 后解析一次（真尾随去抖：定时器随按键重置）', () => {
    // 定时器路径契约（P1-3 回归）：此前实现是节流（定时器不随按键重置），
    // 连续输入每 250ms 触发一次解析——注释声称的「停顿后解析一次」失守。
    // 现有测试全走 view.state 校准路径，定时器路径零覆盖故未暴露。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeBridge()
      const { c, parent } = mountOutline(h)
      openSidebar(c)
      const d = outlineDom(parent)
      expect(d.itemTexts()).toEqual(EXPECTED_ITEMS.map(([, text]) => text))
      // 连续输入：每次按键间隔 100ms（小于 250ms 去抖窗口），期间推进
      // 时钟模拟真实时间流逝——尾随去抖须每次重置定时器，一直不触发
      for (let i = 1; i <= 5; i++) {
        const doc = c.getView()!.state.doc
        c.getView()!.dispatch({ changes: { from: doc.length, insert: `## 连续输入标题${i}\n` } })
        vi.advanceTimersByTime(100)
        expect(d.itemTexts(), `第 ${i} 次按键后仍在连续输入窗口内，面板不得重算`)
          .toEqual(EXPECTED_ITEMS.map(([, text]) => text))
      }
      // 停顿超过 250ms：尾随触发一次解析，最后一次输入的内容入大纲
      vi.advanceTimersByTime(250)
      expect(d.itemTexts()).toContain('连续输入标题5')
    } finally {
      vi.useRealTimers()
    }
  })

  it('去抖窗口内关闭大纲面板：pending 回调被取消，不刷新隐藏面板', () => {
    // 面板隐藏路径契约：toggleOutline 关闭分支取消未决定时器——此前迟到
    // 回调会在 display:none 面板上做无谓解析与 DOM 重建（重开有校准兜底）。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeBridge()
      const { c, parent } = mountOutline(h)
      openSidebar(c)
      const d = outlineDom(parent)
      // 可见面板输入新标题，进入去抖窗口（100ms < 250ms 未触发）
      const doc = c.getView()!.state.doc
      c.getView()!.dispatch({ changes: { from: doc.length, insert: '## 关闭后标题\n' } })
      vi.advanceTimersByTime(100)
      expect(d.itemTexts()).not.toContain('关闭后标题')
      // 关闭面板 → pending 回调取消 → 推进超窗也不刷新
      d.toggle!.click()
      expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(false)
      vi.advanceTimersByTime(400)
      expect(d.itemTexts(), '回调应被取消，隐藏面板不得重建').not.toContain('关闭后标题')
      // 重开面板：展开校准兜底，数据回到新鲜
      d.toggle!.click()
      expect(d.itemTexts()).toContain('关闭后标题')
    } finally {
      vi.useRealTimers()
    }
  })

  it('去抖窗口内收起侧栏：pending 回调同样被取消', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeBridge()
      const { c, parent } = mountOutline(h)
      openSidebar(c)
      const d = outlineDom(parent)
      const doc = c.getView()!.state.doc
      c.getView()!.dispatch({ changes: { from: doc.length, insert: '## 收起后标题\n' } })
      vi.advanceTimersByTime(100)
      expect(d.itemTexts()).not.toContain('收起后标题')
      // 收起侧栏（面板随侧栏不可见）→ pending 回调取消
      c.handleHostMessage({ kind: 'sidebar.test.click' })
      vi.advanceTimersByTime(400)
      expect(d.itemTexts(), '回调应被取消，隐藏面板不得重建').not.toContain('收起后标题')
      // 重新展开：校准兜底刷新
      openSidebar(c)
      expect(d.itemTexts()).toContain('收起后标题')
    } finally {
      vi.useRealTimers()
    }
  })

  it('修改既有标题文字后，大纲对应条目更新', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    const from = DOC.indexOf('文档主标题')
    c.getView()!.dispatch({ changes: { from, to: from + '文档主标题'.length, insert: '改名后的主标题' } })
    const state = viewState(c, h)
    expect(state.outline?.items[0]!.text).toBe('改名后的主标题')
    expect(outlineDom(parent).itemTexts()[0]).toBe('改名后的主标题')
  })

  it('删除全部标题后大纲清空、显示空态', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, '# 唯一标题\n正文\n')
    openSidebar(c)
    c.getView()!.dispatch({ changes: { from: 0, to: '# 唯一标题'.length, insert: '普通行' } })
    const state = viewState(c, h)
    expect(state.outline?.items).toEqual([])
    expect(outlineDom(parent).itemTexts()).toEqual([])
    expect(parent.querySelector('.vsidian-outline-empty')).toBeTruthy()
  })

  it('非标题正文编辑不重建条目 DOM（数据未变跳过重建）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    const first = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[0]!
    const marker = Object.freeze({ tag: 'keep' })
    ;(first as unknown as Record<string, unknown>)['__marker'] = marker
    const from = DOC.indexOf('结尾段落')
    c.getView()!.dispatch({ changes: { from, to: from + 2, insert: '开篇' } })
    viewState(c, h) // 触发即时校准
    const after = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[0]!
    expect((after as unknown as Record<string, unknown>)['__marker']).toBe(marker)
  })
})

describe('面板切换状态机与零写回（验收核心）', () => {
  it('点击大纲按钮：active 翻转、aria-expanded 同步、面板条目 DOM 隐藏但保留', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    const d = outlineDom(parent)
    d.toggle!.click()
    expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(false)
    expect(d.toggle!.getAttribute('aria-expanded')).toBe('false')
    expect(d.itemTexts()).toEqual(EXPECTED_ITEMS.map(([, text]) => text))
    d.toggle!.click()
    expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(true)
    expect(d.toggle!.getAttribute('aria-expanded')).toBe('true')
  })

  it('outline.test.click 测试钩子驱动与用户点击同一处理器', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h)
    openSidebar(c)
    const d = outlineDom(parent)
    c.handleHostMessage({ kind: 'outline.test.click' })
    expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(false)
    c.handleHostMessage({ kind: 'outline.test.click' })
    expect(d.sidebar.classList.contains('vsidian-outline-active')).toBe(true)
  })

  it('面板切换与大纲展示全程零 edit.request、文本不变（不写回、不入撤销历史）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    openSidebar(c)
    const editsBefore = h.sent.filter((m) => m.kind === 'edit.request').length
    const textBefore = viewState(c, h).text
    c.handleHostMessage({ kind: 'outline.test.click' })
    c.handleHostMessage({ kind: 'outline.test.click' })
    expect(h.sent.filter((m) => m.kind === 'edit.request').length).toBe(editsBefore)
    expect(viewState(c, h).text).toBe(textBefore)
    expect(viewState(c, h).outline?.active).toBe(true)
  })

  it('本地未确认输入在面板切换后保留', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    openSidebar(c)
    c.getView()!.dispatch({ changes: { from: 0, insert: '未保存前缀' } })
    c.handleHostMessage({ kind: 'outline.test.click' })
    c.handleHostMessage({ kind: 'outline.test.click' })
    expect(viewState(c, h).text.startsWith('未保存前缀')).toBe(true)
  })
})

describe('大纲与模式切换正交（两模式共用侧栏）', () => {
  it('切到 reading 再切回 live：大纲序列不变（数据源是 CM6 全文，非阅读渲染）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    openSidebar(c)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    let state = viewState(c, h)
    expect(state.viewMode).toBe('reading')
    expect(state.outline?.items.map((i) => [i.level, i.text])).toEqual(EXPECTED_ITEMS)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    state = viewState(c, h)
    expect(state.viewMode).toBe('live')
    expect(state.outline?.items.map((i) => [i.level, i.text])).toEqual(EXPECTED_ITEMS)
  })
})

describe('持久化与重载恢复', () => {
  it('outlineActive 写入 bridge state（与 sidebarOpen 合并互不覆盖）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    c.handleHostMessage({ kind: 'outline.test.click' })
    const saved = h.saved() as { sidebarOpen?: boolean; outlineActive?: boolean; viewMode?: string }
    expect(saved.outlineActive).toBe(false)
    expect(saved.sidebarOpen).toBe(false)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const saved2 = h.saved() as { outlineActive?: boolean; viewMode?: string }
    expect(saved2.viewMode).toBe('reading')
    expect(saved2.outlineActive).toBe(false)
  })

  it('重载后恢复非默认 active 态（新 controller 同一 state）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    c.handleHostMessage({ kind: 'outline.test.click' })
    openSidebar(c) // 展开但 active=false
    const parent2 = document.createElement('div')
    const c2 = new WebviewSyncController(h.bridge)
    c2.mount(parent2)
    c2.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    const state = viewState(c2, h)
    expect(state.sidebar?.open).toBe(true)
    expect(state.outline?.active).toBe(false)
  })
})

// ---- #67 折叠滑块与手动折叠：装配契约（jsdom） ----

/** #67 折叠样例：嵌套（A>B>C、D>E）+ 顶层 F，E 跨级挂 D 下 */
const COLLAPSE_DOC = [
  '# A',
  '## B',
  '### C',
  '## D',
  '#### E',
  '# F',
  '',
].join('\n')
// 条目索引：0=A(H1,父) 1=B(H2,父) 2=C(H3,叶) 3=D(H2,父) 4=E(H4,叶) 5=F(H1,叶)

function collapseDom(parent: HTMLElement) {
  const sidebar = parent.querySelector<HTMLElement>('.vsidian-sidebar')!
  const panel = sidebar.querySelector<HTMLElement>('.vsidian-outline-panel')!
  const itemEls = () => [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
  return {
    sidebar,
    panel,
    slider: sidebar.querySelector<HTMLElement>('.vsidian-outline-slider'),
    dots: () => [...sidebar.querySelectorAll<HTMLButtonElement>('.vsidian-outline-slider-dot')],
    itemEls,
    hiddenIndices: () =>
      itemEls()
        .map((el, i) => (el.classList.contains('vsidian-outline-hidden') ? i : -1))
        .filter((i) => i >= 0),
    chevrons: () => [...panel.querySelectorAll<HTMLButtonElement>('.vsidian-outline-chevron')],
    locatedIndex: () =>
      itemEls().findIndex((el) => el.classList.contains('vsidian-outline-located')),
  }
}

describe('折叠滑块装配（#67）', () => {
  it('滑块行位于侧栏顶栏与条目面板之间：role=group、六档圆点按钮、各档可访问名称', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    const c = collapseDom(parent)
    expect(c.slider, '应有 vsidian-outline-slider 滑块行').toBeTruthy()
    expect(c.slider!.getAttribute('role')).toBe('group')
    expect(c.slider!.getAttribute('aria-label')).toBe('大纲展开层级')
    const dots = c.dots()
    expect(dots).toHaveLength(6)
    expect(dots.map((d) => d.getAttribute('aria-label'))).toEqual([
      '全部折叠',
      '展开到一级标题',
      '展开到二级标题',
      '展开到三级标题',
      '展开到四级标题',
      '展开到五级标题',
    ])
    // 位于顶栏与面板之间（DOM 序：toolbar < slider < panelHost）
    const toolbar = c.sidebar.querySelector('.vsidian-sidebar-toolbar')!
    const panelHost = c.sidebar.querySelector('.vsidian-sidebar-panel')!
    expect(toolbar.compareDocumentPosition(c.slider!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(c.slider!.compareDocumentPosition(panelHost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('默认档 5 全展开：当前档圆点 active 类 + aria-pressed，条目无折叠隐藏', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    const d = collapseDom(parent)
    expect(d.dots()[5]!.classList.contains('vsidian-outline-slider-active')).toBe(true)
    expect(d.dots()[5]!.getAttribute('aria-pressed')).toBe('true')
    expect(d.dots()[0]!.getAttribute('aria-pressed')).toBe('false')
    expect(d.hiddenIndices()).toEqual([])
    const state = viewState(controller, h)
    expect(state.outline?.expandLevel).toBe(5)
    expect(state.outline?.visibleIndices).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('outline.test.expandClick 点击真实圆点选档：档 1 下深层标题折叠隐藏', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.expandClick', level: 1 })
    const d = collapseDom(parent)
    expect(d.hiddenIndices()).toEqual([2, 4]) // C、E 折叠隐藏
    expect(d.dots()[1]!.classList.contains('vsidian-outline-slider-active')).toBe(true)
    const state = viewState(controller, h)
    expect(state.outline?.expandLevel).toBe(1)
    expect(state.outline?.visibleIndices).toEqual([0, 1, 3, 5])
  })

  it('滑块切换整体替换展开集：档内手动展开不保留（切档 0 后回到精确集）', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 })
    // 手动展开 A（chevronClick 折叠→展开）
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 0 })
    let d = collapseDom(parent)
    expect(d.hiddenIndices()).toEqual([2, 4]) // A 展开后 B/D 可见（B 折叠遮 C、D 折叠遮 E）
    // 切档 1：整体替换，A 的手动展开被丢弃（按档 1 精确集：A 展开、B/D 折叠）
    controller.handleHostMessage({ kind: 'outline.test.expandClick', level: 1 })
    d = collapseDom(parent)
    expect(d.hiddenIndices()).toEqual([2, 4])
    const state = viewState(controller, h)
    expect(state.outline?.visibleIndices).toEqual([0, 1, 3, 5])
  })
})

describe('手动折叠箭头（#67）', () => {
  it('有子项条目渲染箭头按钮、无子项条目渲染占位（文字对齐），aria-expanded 随折叠态', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    const d = collapseDom(parent)
    expect(d.chevrons()).toHaveLength(3) // A、B、D
    const els = d.itemEls()
    expect(els[0]!.querySelector('.vsidian-outline-chevron')).toBeTruthy()
    expect(els[2]!.querySelector('.vsidian-outline-chevron')).toBeNull()
    expect(els[2]!.querySelector('.vsidian-outline-chevron-spacer')).toBeTruthy()
    // 折叠 B：条目加 collapsed 类、箭头 aria-expanded=false
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 1 })
    expect(els[1]!.classList.contains('vsidian-outline-collapsed')).toBe(true)
    expect(els[1]!.querySelector<HTMLButtonElement>('.vsidian-outline-chevron')!
      .getAttribute('aria-expanded')).toBe('false')
    expect(collapseDom(parent).hiddenIndices()).toEqual([2])
  })

  it('点箭头折叠/展开单条生效：子级隐藏与恢复，其余区域不受影响', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 3 }) // 折叠 D
    expect(collapseDom(parent).hiddenIndices()).toEqual([4])
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 3 }) // 展开 D
    expect(collapseDom(parent).hiddenIndices()).toEqual([])
  })

  it('点箭头不触发跳转（点击目标区分：箭头折叠、文字跳转）', () => {
    const h = makeBridge()
    const { c: controller } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    const before = controller.getView()!.state.selection.main.from
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 0 })
    expect(controller.getView()!.state.selection.main.from).toBe(before)
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })

  it('嵌套折叠：折叠 A 时其子树整体隐藏（子级 B 的展开态保留在集合中）', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 0 }) // 折叠 A
    expect(collapseDom(parent).hiddenIndices()).toEqual([1, 2, 3, 4])
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 0 }) // 展开 A
    // B 仍处于展开（档 5 集合未被动过）→ 全部恢复可见
    expect(collapseDom(parent).hiddenIndices()).toEqual([])
  })
})

describe('滚动动态展开与高亮回退（#67，jsdom 可测路径）', () => {
  it('跳转（itemClick）到折叠遮蔽的标题：自动展开祖先链，高亮落位自身', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.expandClick', level: 1 })
    expect(collapseDom(parent).hiddenIndices()).toEqual([2, 4])
    // 点击 C（index 2，此刻隐藏——消息驱动等价于宿主 view.locate 落进折叠区）
    controller.handleHostMessage({ kind: 'outline.test.itemClick', index: 2 })
    const d = collapseDom(parent)
    expect(d.hiddenIndices()).toEqual([4]) // 祖先链 B 已展开（C 可见）；D 仍折叠遮 E
    expect(d.locatedIndex()).toBe(2) // 高亮在目标自身（展开后无需回退）
  })

  it('手动折叠当前高亮的祖先：高亮回退到第一个可见祖先（不自动展开）', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    // 高亮定位到 C
    controller.handleHostMessage({ kind: 'outline.test.itemClick', index: 2 })
    expect(collapseDom(parent).locatedIndex()).toBe(2)
    // 折叠 B：C 隐藏，高亮回退到 B（B 可见）
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 1 })
    const d = collapseDom(parent)
    expect(d.hiddenIndices()).toEqual([2])
    expect(d.locatedIndex()).toBe(1)
    // probe 的 locatedItemIndex 仍回报真实控制域（C），visibleIndices 表达可见性
    const state = viewState(controller, h)
    expect(state.outline?.locatedItemIndex).toBe(2)
    expect(state.outline?.visibleIndices).toEqual([0, 1, 3, 4, 5])
  })
})

describe('档位持久化与手动折叠存活（#67）', () => {
  it('档位写入 bridge state（与 sidebarOpen/outlineActive 合并互不覆盖），重载恢复非默认档', () => {
    const h = makeBridge()
    const { c: controller } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.expandClick', level: 2 })
    const saved = h.saved() as { outlineExpandLevel?: number; sidebarOpen?: boolean }
    expect(saved.outlineExpandLevel).toBe(2)
    expect(saved.sidebarOpen).toBe(true)
    // 重载：新 controller 同一 bridge state，档 2 恢复（条目按档 2 可见）
    const parent2 = document.createElement('div')
    const c2 = new WebviewSyncController(h.bridge)
    c2.mount(parent2)
    c2.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: COLLAPSE_DOC })
    openSidebar(c2)
    const state = viewState(c2, h)
    expect(state.outline?.expandLevel).toBe(2)
    expect(collapseDom(parent2).dots()[2]!.classList.contains('vsidian-outline-slider-active'))
      .toBe(true)
  })

  it('无效持久化档位回退默认 5（脏 state 防御）', () => {
    const h = makeBridge({ outlineExpandLevel: 9 })
    const { c: controller } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    expect(viewState(controller, h).outline?.expandLevel).toBe(5)
  })

  it('手动折叠不持久化：重载后回到档位精确展开集', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 0 })
    expect(collapseDom(parent).hiddenIndices()).toEqual([1, 2, 3, 4])
    const parent2 = document.createElement('div')
    const c2 = new WebviewSyncController(h.bridge)
    c2.mount(parent2)
    c2.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: COLLAPSE_DOC })
    openSidebar(c2)
    expect(collapseDom(parent2).hiddenIndices()).toEqual([]) // 档 5 精确集 = 全展开
  })

  it('编辑标题后手动折叠存活：重命名不扰动折叠视图', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    // 手动折叠 B（C 隐藏）
    controller.handleHostMessage({ kind: 'outline.test.chevronClick', index: 1 })
    expect(collapseDom(parent).hiddenIndices()).toEqual([2])
    // 重命名 A（首标题文字变化触发序列重建）
    const doc = controller.getView()!.state.doc
    controller.getView()!.dispatch({
      changes: { from: doc.line(1).from + 2, to: doc.line(1).to, insert: '改名' },
    })
    const state = viewState(controller, h) // 触发即时校准与迁移
    expect(state.outline?.items[0]!.text).toBe('改名')
    const d = collapseDom(parent)
    expect(d.itemEls()[0]!.textContent).toBe('改名')
    expect(d.hiddenIndices()).toEqual([2]) // B 的折叠（C 隐藏）存活
  })

  it('删除子标题后父降格为叶：箭头消失、展开键清除', () => {
    const h = makeBridge()
    const { c: controller, parent } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    expect(collapseDom(parent).chevrons()).toHaveLength(3)
    // 删除 E（### 之后……直接改 D 下的 #### E 行为普通行）
    const doc = controller.getView()!.state.doc
    controller.getView()!.dispatch({
      changes: { from: doc.line(5).from, to: doc.line(5).to, insert: '普通段落' },
    })
    viewState(controller, h)
    const d = collapseDom(parent)
    expect(d.itemEls()).toHaveLength(5) // E 不再是标题
    expect(d.itemEls()[3]!.querySelector('.vsidian-outline-chevron')).toBeNull() // D 降格叶
    expect(d.hiddenIndices()).toEqual([])
  })

  it('空文档与无子项文档边界：滑块仍可操作，条目恒可见', () => {
    const h = makeBridge()
    const { c: controller } = mountOutline(h, '只有正文\n')
    openSidebar(controller)
    controller.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 })
    const state = viewState(controller, h)
    expect(state.outline?.expandLevel).toBe(0)
    expect(state.outline?.visibleIndices).toEqual([])
    const flat = '## 甲\n## 乙\n'
    const h2 = makeBridge()
    const { c: c2, parent: p2 } = mountOutline(h2, flat)
    openSidebar(c2)
    c2.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 })
    expect(viewState(c2, h2).outline?.visibleIndices).toEqual([0, 1])
    expect(collapseDom(p2).chevrons()).toHaveLength(0)
  })

  it('probe 绘制证据字段随 view.state 回报（jsdom 无布局容错为 false）', () => {
    const h = makeBridge()
    const { c: controller } = mountOutline(h, COLLAPSE_DOC)
    openSidebar(controller)
    const state = viewState(controller, h)
    expect(state.outline?.sliderPainted).toBe(false)
    expect(state.outline?.sliderActiveDotPainted).toBe(false)
    expect(state.outline?.chevronPainted).toBe(false)
  })
})

describe('view.state 的 outline 观测（jsdom 无布局的容错口径）', () => {
  it('面板收起（active=false）时 items 仍回报数据（计算基于文档而非面板可见性）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    openSidebar(c)
    c.handleHostMessage({ kind: 'outline.test.click' })
    const state = viewState(c, h)
    expect(state.outline?.active).toBe(false)
    expect(state.outline?.items.map((i) => i.text)).toEqual(EXPECTED_ITEMS.map(([, t]) => t))
  })

  it('侧栏收起时 outline 字段仍回报（open=false、绘制字段容错）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h)
    const state = viewState(c, h)
    const probe = state.outline
    expect(probe).toBeDefined()
    expect(probe!.active).toBe(true)
    expect(probe!.toggleAriaLabel).toBe('大纲')
    expect(probe!.panelAriaLabel).toBe('大纲')
    // jsdom 无布局/无 CSS 引擎：绘制命中容错为 false（真宿主断言见集成）
    expect(probe!.togglePainted).toBe(false)
    expect(probe!.panelPainted).toBe(false)
  })
})

// ---- #65 行内样式透传：渲染与探针 ----

/** #65 样式透传样例：白名单标记 + 双链/链接纯文本降级 */
const STYLE_DOC = [
  '# **重点** 结论',
  '## *斜体* 与 `代码`',
  '### ~~删除线~~ 与 [[目标|别名]]',
  '#### [链接文字](https://example.com) 尾注',
  '##### ***粗斜*** 混排',
  '',
].join('\n')

describe('大纲条目行内样式渲染（#65）', () => {
  it('标记按语义元素渲染：strong/em/code/del 各自带稳定类名', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, STYLE_DOC)
    openSidebar(c)
    const item0 = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[0]!
    const strong = item0.querySelector('strong.vsidian-outline-strong')
    expect(strong, '粗体应为 strong.vsidian-outline-strong').toBeTruthy()
    expect(strong!.textContent).toBe('重点')
    const item1 = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[1]!
    expect(item1.querySelector('em.vsidian-outline-emphasis')?.textContent).toBe('斜体')
    expect(item1.querySelector('code.vsidian-outline-code')?.textContent).toBe('代码')
    const item2 = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[2]!
    expect(item2.querySelector('del.vsidian-outline-strike')?.textContent).toBe('删除线')
  })

  it('条目可见文本 = plainText（标记字符不透出）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, STYLE_DOC)
    openSidebar(c)
    const d = outlineDom(parent)
    expect(d.itemTexts()).toEqual([
      '重点 结论',
      '斜体 与 代码',
      '删除线 与 别名',
      '链接文字 尾注',
      '粗斜 混排',
    ])
  })

  it('wikilink/链接为纯文本：面板内无 a 元素（不可点、不触发跳转）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, STYLE_DOC)
    openSidebar(c)
    expect(parent.querySelectorAll('.vsidian-outline-item a')).toHaveLength(0)
    const item3 = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[3]!
    expect(item3.textContent).toBe('链接文字 尾注')
    expect(item3.querySelector('.vsidian-link, .vsidian-wikilink')).toBeNull()
  })

  it('嵌套标记渲染为嵌套语义元素（***粗斜*** → em > strong）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, STYLE_DOC)
    openSidebar(c)
    const item4 = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[4]!
    const em = item4.querySelector('em.vsidian-outline-emphasis')
    expect(em?.querySelector('strong.vsidian-outline-strong')?.textContent).toBe('粗斜')
  })

  it('标记结构变化触发条目 DOM 重建（编辑加标记后语义元素出现）', () => {
    const h = makeBridge()
    const { c, parent } = mountOutline(h, '# 甲\n\n## 乙\n')
    openSidebar(c)
    const d = outlineDom(parent)
    expect(d.itemTexts()).toEqual(['甲', '乙'])
    const doc = c.getView()!.state.doc
    c.getView()!.dispatch({ changes: { from: doc.line(1).from + 2, to: doc.line(1).to, insert: '*甲*' } })
    const state = viewState(c, h) // 触发即时校准与渲染
    expect(state.outline?.items[0]!.plainText).toBe('甲')
    const item0 = parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')[0]!
    expect(item0.querySelector('em.vsidian-outline-emphasis')?.textContent).toBe('甲')
  })

  it('view.state 的 outline.items 携带 plainText 与 spans（透传信息）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h, STYLE_DOC)
    openSidebar(c)
    const state = viewState(c, h)
    expect(state.outline?.items[0]).toMatchObject({
      level: 1,
      text: '**重点** 结论',
      plainText: '重点 结论',
    })
    expect(state.outline?.items[0]!.spans).toEqual([{ kind: 'strong', start: 0, end: 2 }])
    expect(state.outline?.items[3]!.plainText).toBe('链接文字 尾注')
    expect(state.outline?.items[3]!.spans).toEqual([])
  })

  it('outline.style 绘制证据字段随 view.state 回报（jsdom 无 CSS 引错为 null）', () => {
    const h = makeBridge()
    const { c } = mountOutline(h, STYLE_DOC)
    openSidebar(c)
    const state = viewState(c, h)
    const style = state.outline?.style
    expect(style, 'style 观测应随 outline 回报').toBeDefined()
    // jsdom 无 CSS 引擎：字符串容错（真宿主的字重/颜色断言见集成用例）
    for (const key of ['itemFontWeight', 'strongFontWeight', 'codeFontFamily', 'itemFontFamily', 'itemColor', 'headingColor'] as const) {
      expect(style![key] === null || typeof style![key] === 'string', `${key} 应为字符串或 null`).toBe(true)
    }
  })
})
