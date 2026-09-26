// @vitest-environment jsdom
// 侧栏拖拽调宽契约：左缘句柄（role=separator + 键盘微调）驱动宽度，
// 写 --vsidian-sidebar-width CSS 变量（main.css 五处消费点跟随），钳制
// [200, 720]；拖拽照折叠滑块模式（pointerdown 武装 → 超 4px 进拖拽态 →
// move 换算 → up 落定），拖拽期间挂 resizing 类禁用宽度过渡；
// Escape/pointercancel 回滚到拖前宽度且不持久化；未超阈值的轻点不落状态。
// 持久化与 sidebarOpen/outlineExpandLevel 同链路（bridge state 合并写入，
// webview 重载恢复）；恢复值越界钳制、非数值忽略（走 CSS 280px 回退）。
// 默认宽度不写变量：保持 --vsidian-sidebar-width 的公开覆盖入口，回到
// 默认即移除变量。宽度是纯视图状态：全程零写回（无 edit.request）。
// sidebar.test.resize 测试钩子经真实句柄 pointer 序列驱动同一处理器。
// 残留会话兜底照大纲拖拽先例（#70）四层防线：句柄 pointerdown 清残留再
// 武装、document 常驻 capture 入口回收、move 和弦/已释放守卫回滚、
// window blur 兜底——up/cancel 在 webview 外丢失时不留陈旧会话。
import { describe, it, expect } from 'vitest'
import {
  WebviewSyncController,
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  type VsCodeBridge,
} from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

installLocale('zh-cn', zhCn)

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/resize.md'
const DOC = '# 调宽样例\n\n正文段落。\n'

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

function mountResize(
  h: BridgeHarness,
  text = DOC,
  openSidebar = true,
): { c: WebviewSyncController; parent: HTMLElement } {
  const c = new WebviewSyncController(h.bridge)
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text })
  if (openSidebar) {
    c.handleHostMessage({ kind: 'sidebar.test.click' })
  }
  return { c, parent }
}

function sidebarEl(parent: HTMLElement): HTMLElement {
  return parent.querySelector<HTMLElement>('.vsidian-sidebar')!
}

function resizerEl(parent: HTMLElement): HTMLElement {
  return parent.querySelector<HTMLElement>('.vsidian-sidebar-resizer')!
}

/** 当前生效宽度（px）：优先读侧栏内联 CSS 变量，未写时为 CSS 回退 280 */
function widthVar(parent: HTMLElement): number {
  const value = sidebarEl(parent).style.getPropertyValue('--vsidian-sidebar-width')
  return value === '' ? SIDEBAR_WIDTH_DEFAULT : Number.parseFloat(value)
}

/** 在句柄或 document 上派发 pointer 事件（MouseEvent 构造，同
 *  outlineDragPanel 口径：处理器只读坐标/buttons/button；buttons 缺省
 *  按下态 1，释放事件传 0；document 用于常驻捕获入口的直派） */
function firePointer(el: Element | Document, type: string, x: number, buttons = 1): void {
  el.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: 100, buttons, button: 0,
  }))
}

/** 拖拽会话：句柄 x=800 处按下 → 左移 6px（超阈值进拖拽态）→ 左移 delta。
 *  收尾方式：默认 pointerup 落定；escape/cancel 走取消路径；hold 不收尾
 *  （模拟 up/cancel 在 webview 外丢失的残留会话） */
function dragBy(
  parent: HTMLElement,
  delta: number,
  end: 'up' | 'escape' | 'cancel' | 'hold' = 'up',
): void {
  const r = resizerEl(parent)
  const x0 = 800
  firePointer(r, 'pointerdown', x0)
  firePointer(r, 'pointermove', x0 - 6)
  firePointer(r, 'pointermove', x0 - delta)
  if (end === 'up') {
    firePointer(r, 'pointerup', x0 - delta, 0)
  } else if (end === 'escape') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  } else if (end === 'cancel') {
    firePointer(r, 'pointercancel', x0 - delta, 0)
  }
}

function keyAt(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('clampSidebarWidth 纯函数', () => {
  it('区间内取整放行，越界钳到 [200, 720]，非有限数回默认', () => {
    expect(clampSidebarWidth(280)).toBe(280)
    expect(clampSidebarWidth(200)).toBe(200)
    expect(clampSidebarWidth(720)).toBe(720)
    expect(clampSidebarWidth(199)).toBe(200)
    expect(clampSidebarWidth(721)).toBe(720)
    expect(clampSidebarWidth(-50)).toBe(200)
    expect(clampSidebarWidth(300.4)).toBe(300)
    expect(clampSidebarWidth(300.6)).toBe(301)
    expect(clampSidebarWidth(Number.NaN)).toBe(280)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(280)
    expect(clampSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(280)
  })
})

describe('拖宽句柄 DOM 契约', () => {
  it('侧栏内含左缘拖宽句柄：separator 语义、键盘可达、aria 值域同步', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    expect(r.parentElement === sidebarEl(parent), '句柄应为侧栏子元素（左缘定位锚）').toBe(true)
    expect(r.getAttribute('role')).toBe('separator')
    expect(r.getAttribute('aria-orientation')).toBe('vertical')
    expect(r.getAttribute('aria-label')).toBe(zhCn['sidebar.resize'])
    expect(r.tabIndex).toBe(0)
    expect(r.getAttribute('aria-valuemin')).toBe('200')
    expect(r.getAttribute('aria-valuemax')).toBe('720')
    expect(r.getAttribute('aria-valuenow')).toBe('280')
  })
})

describe('拖拽调宽（指针路径）', () => {
  it('向左拖 100px：宽度经 CSS 变量生效、落定持久化、全程零写回', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const editsBefore = h.sent.filter((m) => m.kind === 'edit.request').length
    dragBy(parent, 100)
    expect(widthVar(parent)).toBe(380)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(380)
    expect(h.sent.filter((m) => m.kind === 'edit.request').length).toBe(editsBefore)
  })

  it('向右拖收窄，位移取负；双向都受区间钳制', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, -50)
    expect(widthVar(parent)).toBe(230)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(230)
  })

  it('拖拽期间挂 resizing 类（禁宽度过渡），up 后移除', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    firePointer(r, 'pointerdown', 800)
    firePointer(r, 'pointermove', 794)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(true)
    firePointer(r, 'pointerup', 794, 0)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(false)
  })

  it('上界 720：大力左拖钳到上限', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, 5000)
    expect(widthVar(parent)).toBe(720)
  })

  it('下界 200：大力右拖钳到下限', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, -5000)
    expect(widthVar(parent)).toBe(200)
  })

  it('未超 4px 阈值的轻点：不写变量、不持久化', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    firePointer(r, 'pointerdown', 800)
    firePointer(r, 'pointermove', 797)
    firePointer(r, 'pointerup', 797, 0)
    expect(widthVar(parent)).toBe(280)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })

  it('Escape 回滚到拖前宽度且不持久化（从已保存宽度起拖的回滚目标非默认）', () => {
    const h = makeBridge({ sidebarOpen: true, sidebarWidth: 350 })
    const { parent } = mountResize(h)
    dragBy(parent, 100, 'escape')
    expect(widthVar(parent)).toBe(350)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(350)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(false)
  })

  it('Escape 从默认宽度起拖：回滚即清除变量（恢复公开覆盖入口）', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, 100, 'escape')
    expect(widthVar(parent)).toBe(280)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })

  it('pointercancel 同 Escape：回滚不持久化', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, 100, 'cancel')
    expect(widthVar(parent)).toBe(280)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })

  it('残留会话卫生：hold 残留后的新按下先回滚再以新起点重算', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    dragBy(parent, 100, 'hold')
    expect(widthVar(parent)).toBe(380)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(true)
    // 新按下（起点 600）：残留会话先回滚（380→280）再武装新会话
    firePointer(r, 'pointerdown', 600)
    expect(widthVar(parent)).toBe(280)
    firePointer(r, 'pointermove', 594)
    firePointer(r, 'pointermove', 560)
    expect(widthVar(parent)).toBe(320)
    firePointer(r, 'pointerup', 560, 0)
    // 320 = 新起点重算（280 + 40）；520 是收养陈旧 startX=800 的错误换算
    expect(widthVar(parent)).toBe(320)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(320)
  })
})

describe('残留会话兜底（照大纲拖拽 #70 四层防线）', () => {
  it('document 捕获层清理：hold 残留后的任意新按下先回收（回滚 + 摘 resizing 类）', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, 100, 'hold')
    expect(widthVar(parent)).toBe(380)
    // 按住移出窗口释放后再任意按下：证明上一手势已结束，残留会话回收
    firePointer(document, 'pointerdown', 300)
    expect(widthVar(parent)).toBe(280)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(false)
  })

  it('触屏次指针不清理进行中的拖宽会话（capture 入口豁免，对齐大纲先例）', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    dragBy(parent, 100, 'hold')
    // 触屏第二指（isPrimary=false）落在任意位置：不误杀首指进行中的拖宽
    const secondTouch = new MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 300, clientY: 50, buttons: 1, button: 0,
    })
    Object.defineProperty(secondTouch, 'pointerType', { value: 'touch' })
    Object.defineProperty(secondTouch, 'isPrimary', { value: false })
    document.dispatchEvent(secondTouch)
    expect(widthVar(parent)).toBe(380)
    // 首指针继续拖动仍有效（会话未被回收）
    firePointer(r, 'pointermove', 640)
    expect(widthVar(parent)).toBe(440)
  })

  it('window blur 清理：焦点离开窗口（alt-tab 等）时回收残留会话', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    dragBy(parent, 100, 'hold')
    window.dispatchEvent(new Event('blur'))
    expect(widthVar(parent)).toBe(280)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(false)
  })

  it('和弦与已释放 move 都回滚：buttons 含非主键位或全零即取消会话', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    // buttons=0：释放发生在 webview 之外，纯悬停 move 不推进会话
    dragBy(parent, 100, 'hold')
    firePointer(r, 'pointermove', 700, 0)
    expect(widthVar(parent)).toBe(280)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(false)
    // buttons=3：左键按住时再按右键（和弦），第二个按键只报 move
    dragBy(parent, 100, 'hold')
    firePointer(r, 'pointermove', 700, 3)
    expect(widthVar(parent)).toBe(280)
    expect(sidebarEl(parent).classList.contains('vsidian-sidebar-resizing')).toBe(false)
  })

  it('dispose 清理：残留会话随卸载退出（resizing 类摘除）', () => {
    const h = makeBridge()
    const { c, parent } = mountResize(h)
    const el = sidebarEl(parent)
    dragBy(parent, 100, 'hold')
    c.dispose()
    expect(el.classList.contains('vsidian-sidebar-resizing')).toBe(false)
  })

  it('拖拽起点从渲染宽校准：外部注入变量宽度后从当前渲染宽连续拖宽', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    // jsdom 无布局：stub 侧栏渲染宽 340（模拟外部片段注入 --vsidian-sidebar-width，
    // 内部 sidebarWidth 仍是缺省 280）——拖宽应从 340 连续开始而非跳回 280
    sidebarEl(parent).getBoundingClientRect = () => new DOMRect(0, 0, 340, 600)
    dragBy(parent, 100)
    expect(widthVar(parent)).toBe(440)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(440)
  })
})

describe('键盘微调与双击重置', () => {
  it('句柄聚焦时 ArrowLeft/ArrowRight 每次 ±16px，钳制同区间，即时持久化', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    const r = resizerEl(parent)
    keyAt(r, 'ArrowLeft')
    expect(widthVar(parent)).toBe(296)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(296)
    keyAt(r, 'ArrowRight')
    expect(widthVar(parent)).toBe(280)
    // 回到默认：变量移除（CSS 回退接管）、持久化状态清键
    expect(sidebarEl(parent).style.getPropertyValue('--vsidian-sidebar-width')).toBe('')
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })

  it('微调到边界停住（不越界）', () => {
    const h = makeBridge({ sidebarOpen: true, sidebarWidth: 712 })
    // saved 已恢复展开态：不再点击切换（再点一次会把侧栏收起，keydown
    // 守卫随之拒绝微调）
    const { parent } = mountResize(h, DOC, false)
    const r = resizerEl(parent)
    keyAt(r, 'ArrowLeft')
    keyAt(r, 'ArrowLeft')
    expect(widthVar(parent)).toBe(720)
    expect(r.getAttribute('aria-valuenow')).toBe('720')
  })

  it('无关按键不改变宽度', () => {
    const h = makeBridge()
    const { parent } = mountResize(h)
    keyAt(resizerEl(parent), 'ArrowUp')
    keyAt(resizerEl(parent), 'Enter')
    expect(widthVar(parent)).toBe(280)
  })

  it('收起态句柄键盘微调拒绝：宽度不变、不持久化（句柄不可见不可聚焦）', () => {
    const h = makeBridge()
    const { parent } = mountResize(h, DOC, false)
    keyAt(resizerEl(parent), 'ArrowLeft')
    expect(widthVar(parent)).toBe(280)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })

  it('双击句柄恢复默认宽度并清除持久化', () => {
    const h = makeBridge({ sidebarOpen: true, sidebarWidth: 350 })
    const { parent } = mountResize(h)
    resizerEl(parent).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(widthVar(parent)).toBe(280)
    expect(sidebarEl(parent).style.getPropertyValue('--vsidian-sidebar-width')).toBe('')
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })
})

describe('持久化与 webview 重载恢复', () => {
  it('重载后（新 controller 同一 state）恢复已保存宽度', () => {
    const h = makeBridge({ sidebarOpen: true, sidebarWidth: 350 })
    const { c } = mountResize(h)
    expect(c).toBeDefined()
    const parent2 = document.createElement('div')
    document.body.appendChild(parent2)
    const c2 = new WebviewSyncController(h.bridge)
    c2.mount(parent2)
    c2.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    expect(widthVar(parent2)).toBe(350)
    // 恢复不产生额外持久化写（bridge state 原样）
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(350)
  })

  it('恢复值越界钳制，非数值忽略（走 CSS 280px 回退）', () => {
    const hHigh = makeBridge({ sidebarOpen: true, sidebarWidth: 9999 })
    const { parent: pHigh } = mountResize(hHigh)
    expect(widthVar(pHigh)).toBe(720)
    const hBad = makeBridge({ sidebarOpen: true, sidebarWidth: 'abc' })
    const { parent: pBad } = mountResize(hBad)
    expect(widthVar(pBad)).toBe(280)
    expect(sidebarEl(pBad).style.getPropertyValue('--vsidian-sidebar-width')).toBe('')
  })

  it('拖宽与侧栏开合正交：收起再展开宽度保持', () => {
    const h = makeBridge()
    const { c, parent } = mountResize(h)
    dragBy(parent, 70)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    expect(widthVar(parent)).toBe(350)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(350)
  })
})

describe('sidebar.test.resize 测试钩子（宿主注入通道，真实事件序列）', () => {
  it('经真实句柄 pointer 序列拖宽并持久化（delta 正 = 增宽）', () => {
    const h = makeBridge()
    const { c, parent } = mountResize(h)
    // jsdom 无布局：stub 句柄矩形（左缘 700，热区宽 10——宽度任意，钩子只取中心）
    resizerEl(parent).getBoundingClientRect = () => new DOMRect(700, 0, 10, 400)
    c.handleHostMessage({ kind: 'sidebar.test.resize', delta: 100 })
    expect(widthVar(parent)).toBe(380)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(380)
  })

  it('delta 负值收窄，同链路钳制', () => {
    const h = makeBridge()
    const { c, parent } = mountResize(h)
    resizerEl(parent).getBoundingClientRect = () => new DOMRect(700, 0, 10, 400)
    c.handleHostMessage({ kind: 'sidebar.test.resize', delta: -40 })
    expect(widthVar(parent)).toBe(240)
  })

  it('连续驱动两段：各段独立起算，宽度接续持久化', () => {
    const h = makeBridge()
    const { c, parent } = mountResize(h)
    resizerEl(parent).getBoundingClientRect = () => new DOMRect(700, 0, 10, 400)
    c.handleHostMessage({ kind: 'sidebar.test.resize', delta: 100 })
    expect(widthVar(parent)).toBe(380)
    c.handleHostMessage({ kind: 'sidebar.test.resize', delta: 100 })
    expect(widthVar(parent)).toBe(480)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBe(480)
  })

  it('收起态钩子拒绝：句柄不可交互，宽度与持久化都不变', () => {
    const h = makeBridge()
    const { c, parent } = mountResize(h, DOC, false)
    resizerEl(parent).getBoundingClientRect = () => new DOMRect(700, 0, 10, 400)
    c.handleHostMessage({ kind: 'sidebar.test.resize', delta: 100 })
    expect(widthVar(parent)).toBe(280)
    expect((h.saved() as { sidebarWidth?: number }).sidebarWidth).toBeUndefined()
  })
})
