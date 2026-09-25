// @vitest-environment jsdom
// 大纲点击跳转与常驻高亮交互契约（#66）：
// - 点击跳转：点击条目文字 → 复用 view.locate 双模式路径（live 落光标至
//   标题行首并居中滚动、reading 滚动到块），全程零写回、零出站、不入撤销历史
// - 常驻高亮：当前控制域条目挂 vsidian-outline-located 类（半透明横条的
//   唯一来源）；跳转即时落位；文档变化重建后重施加；模式切换即时重算
// - 防抖动护栏：跳转引发的程序性滚动不反向改写高亮（首个滚动事件吞掉并
//   释放，或超时释放——QO startJumping 同款语义）
// - 滚动驱动更新：100ms 尾随去抖（连续滚动事件只在停顿后重算一次）
// - outline.test.itemClick 测试钩子驱动与用户点击同一委托处理器
import { describe, it, expect, vi } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：CM6 视口测量的零值 polyfill（与 outlinePanel.test.ts 同款）
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/jump.md'

// 行号刻意清晰（1 基）：跳转断言按行号换算 offset
const DOC = [
  '# 一级开头', // 1
  '正文一。', // 2
  '', // 3
  '## 二级甲', // 4
  '甲正文。', // 5
  '', // 6
  '# 一级乙', // 7
  '乙正文一。', // 8
  '', // 9
  '## 二级乙甲', // 10
  '乙甲正文。', // 11
  '', // 12
].join('\n')

interface BridgeHarness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
}

function makeBridge(): BridgeHarness {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: () => undefined,
    setState: () => {},
  }
  return { bridge, sent }
}

function mountJump(h: BridgeHarness): { c: WebviewSyncController; parent: HTMLElement } {
  const c = new WebviewSyncController(h.bridge)
  const parent = document.createElement('div')
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
  return { c, parent }
}

function openSidebar(c: WebviewSyncController): void {
  c.handleHostMessage({ kind: 'sidebar.test.click' })
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

function items(parent: HTMLElement): HTMLElement[] {
  return [...parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
}

function locatedIndexes(parent: HTMLElement): number[] {
  return items(parent)
    .map((el, i) => (el.classList.contains('vsidian-outline-located') ? i : -1))
    .filter((i) => i >= 0)
}

function dispatchScroll(c: WebviewSyncController): void {
  const dom = c.getView()?.scrollDOM
  if (dom) {
    dom.dispatchEvent(new Event('scroll'))
  }
}

describe('点击跳转：view.locate 双模式路径复用（#66 验收核心）', () => {
  it('live 点击条目：光标落标题行首（doc.line(n).from），零写回零出站', () => {
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    const editsBefore = h.sent.filter((m) => m.kind === 'edit.request').length
    // 点击第 3 个条目「一级乙」（line 7）
    items(parent)[2]!.click()
    const expected = c.getView()!.state.doc.line(7).from
    const state = viewState(c, h)
    expect(state.selectionOffset, '光标应落标题行首').toBe(expected)
    expect(state.text, '跳转不得改动文本').toBe(DOC)
    expect(h.sent.filter((m) => m.kind === 'edit.request').length,
      '跳转是纯视图操作：零 edit.request 出站').toBe(editsBefore)
  })

  it('reading 点击条目：滚动到标题块（锚点 = 标题块 start），零写回', () => {
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    // 点击第 4 个条目「二级乙甲」（line 10）
    items(parent)[3]!.click()
    const expected = c.getView()!.state.doc.line(10).from
    const state = viewState(c, h)
    expect(state.readingAnchorStart, '阅读锚点应为标题块 start').toBe(expected)
    expect(state.text).toBe(DOC)
    expect(h.sent.some((m) => m.kind === 'edit.request'), '阅读跳转零写回').toBe(false)
  })

  it('outline.test.itemClick 测试钩子驱动与用户点击同一委托处理器', () => {
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    c.handleHostMessage({ kind: 'outline.test.itemClick', index: 2 })
    const expected = c.getView()!.state.doc.line(7).from
    expect(viewState(c, h).selectionOffset).toBe(expected)
    // 与直接点击结果一致（同一处理器路径）
    items(parent)[1]!.click()
    expect(viewState(c, h).selectionOffset).toBe(c.getView()!.state.doc.line(4).from)
  })

  it('越界与无标题面板点击：静默无效（不抛错、不动光标）', () => {
    const h = makeBridge()
    const { c } = mountJump(h)
    openSidebar(c)
    const before = viewState(c, h).selectionOffset
    expect(() => c.handleHostMessage({ kind: 'outline.test.itemClick', index: 99 })).not.toThrow()
    expect(() => c.handleHostMessage({ kind: 'outline.test.itemClick', index: -1 })).not.toThrow()
    expect(viewState(c, h).selectionOffset).toBe(before)
  })
})

describe('常驻高亮：当前控制域条目的类切换（#66 验收核心）', () => {
  it('首屏高亮：jsdom 无布局容错为 null（真值断言见浏览器/集成回归）', () => {
    // live 视口顶行经真实布局测量（行矩形扫描）；jsdom 矩形全 0 → null。
    // 首屏真值（视口顶行 = 首行 → 首标题）由 outlineJump.mjs 真浏览器断言
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    const state = viewState(c, h)
    expect(state.outline?.locatedItemIndex).toBeNull()
    expect(state.outline?.locatedText).toBeNull()
    expect(locatedIndexes(parent)).toEqual([])
  })

  it('点击跳转即时落位：高亮条目随目标切换（不等滚动事件）', () => {
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    items(parent)[2]!.click()
    expect(locatedIndexes(parent), '高亮应立即落在被点击条目').toEqual([2])
    const state = viewState(c, h)
    expect(state.outline?.locatedItemIndex).toBe(2)
    expect(state.outline?.locatedText).toBe('一级乙')
  })

  it('locatedPainted 在 jsdom 无布局下容错为 false（真宿主断言见集成）', () => {
    const h = makeBridge()
    const { c } = mountJump(h)
    openSidebar(c)
    expect(viewState(c, h).outline?.locatedPainted).toBe(false)
  })

  it('条目重建后高亮重施加：编辑标题文字触发重建，located 态与 probe 一致', () => {
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    items(parent)[1]!.click()
    expect(locatedIndexes(parent)).toEqual([1])
    // 改名第 2 条（重建 DOM：序列变化）；jsdom 无布局下重建后的重算归
    // null——断言高亮态与 probe 的 locatedItemIndex 一致（类切换与状态
    // 不脱节的回归锚点；真值重算见浏览器/集成）
    const from = DOC.indexOf('二级甲')
    c.getView()!.dispatch({ changes: { from, to: from + 3, insert: '改名甲' } })
    const state = viewState(c, h)
    if (state.outline?.locatedItemIndex === null) {
      expect(locatedIndexes(parent)).toEqual([])
    } else {
      expect(locatedIndexes(parent)).toEqual([state.outline?.locatedItemIndex])
    }
    expect(items(parent)[1]!.textContent).toBe('改名甲')
  })

  it('模式切换即时重算：reading 以视口顶块锚点换算（jsdom 回退首块）', () => {
    const h = makeBridge()
    const { c, parent } = mountJump(h)
    openSidebar(c)
    items(parent)[2]!.click()
    expect(viewState(c, h).outline?.locatedItemIndex).toBe(2)
    // 切 reading：即时重算——jsdom 无布局下 currentAnchor 回退首块（line 1）
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(viewState(c, h).outline?.locatedItemIndex).toBe(0)
  })
})

describe('防抖动护栏：程序性滚动不反向改写高亮（#66 验收核心）', () => {
  it('跳转后的首个滚动事件被吞掉且释放护栏：高亮不被中间态改写', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeBridge()
      const { c, parent } = mountJump(h)
      openSidebar(c)
      items(parent)[2]!.click()
      expect(locatedIndexes(parent)).toEqual([2])
      // 跳转引发的程序性滚动（首个 scroll 事件）：吞掉并释放，不重算
      dispatchScroll(c)
      vi.advanceTimersByTime(500)
      expect(locatedIndexes(parent), '首个滚动事件不得改写跳转高亮').toEqual([2])
      // 护栏已释放：后续滚动正常驱动（去抖后重算——jsdom 无布局下重算
      // 结果为 null，从 2 变空即重算已发生的证据）
      dispatchScroll(c)
      vi.advanceTimersByTime(99)
      expect(locatedIndexes(parent), '去抖窗口内不重算').toEqual([2])
      vi.advanceTimersByTime(2)
      expect(locatedIndexes(parent), '释放后滚动应恢复联动').toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('无滚动事件时护栏超时释放（1 秒），之后滚动恢复联动', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeBridge()
      const { c, parent } = mountJump(h)
      openSidebar(c)
      items(parent)[3]!.click()
      vi.advanceTimersByTime(1100)
      // 护栏超时释放：随后用户滚动正常驱动重算（jsdom 无布局 → null）
      dispatchScroll(c)
      vi.advanceTimersByTime(110)
      expect(locatedIndexes(parent)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('滚动驱动更新：100ms 尾随去抖（轻于 250ms 数据刷新链路）', () => {
  it('连续滚动事件只在停顿 100ms 后重算一次（定时器随事件重置）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = makeBridge()
      const { c, parent } = mountJump(h)
      openSidebar(c)
      items(parent)[2]!.click()
      dispatchScroll(c) // 吞首个事件并释放护栏
      // 连续滚动：每次间隔 50ms（小于 100ms 去抖窗口），期间高亮不变
      for (let i = 1; i <= 4; i++) {
        dispatchScroll(c)
        vi.advanceTimersByTime(50)
        expect(locatedIndexes(parent), `第 ${i} 次滚动事件后仍在去抖窗口内`).toEqual([2])
      }
      // 停顿超过 100ms：尾随触发一次重算（jsdom 无布局 → located 清空）
      vi.advanceTimersByTime(60)
      expect(locatedIndexes(parent), '停顿后应重算一次').toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
