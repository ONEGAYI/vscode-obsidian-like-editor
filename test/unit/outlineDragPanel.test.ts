// @vitest-environment jsdom
// 大纲拖拽排序交互契约（#70）：面板 pointerdown 委托启动拖拽（锚点快照 +
// 数据校准）、超阈值进入拖拽态（源条目弱化）、三态落点指示（插入线/包裹
// 高亮类切换）、drop 单事务写回（一笔 edit.request + 即时大纲刷新）、
// 无效落点拒绝（拖入自身子树无指示无写回）、Esc/pointercancel/blur/面板关闭
// 取消与越界释放残留清理（残留会话不得把后续普通点击判为 drop）、拖拽后补发
// click 吞噬、锚点过期防御、不可见条目（折叠/搜索过滤）
// 不可拖也不构成落点、outline.test.drag 测试钩子全链路、probe 拖拽观测
// 字段。移动计划语义在 outlineDrag.test.ts。
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/drag.md'

// 条目索引：0 甲(H1) 1 乙(H2) 2 丁(H4,跨级挂乙) 3 丙(H2) 4 戊(H1)
// 甲的子树 = [甲,乙,丁,丙]（乙丁丙全挂甲下）；乙的子树 = [乙,丁]
const DRAG_DOC = [
  '# 甲',
  '甲内容',
  '## 乙',
  '乙内容',
  '#### 丁',
  '丁内容',
  '## 丙',
  '丙内容',
  '# 戊',
  '戊内容',
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
    setState: () => undefined,
  }
  return { bridge, sent }
}

function mountDrag(h: BridgeHarness, text = DRAG_DOC) {
  const c = new WebviewSyncController(h.bridge)
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text })
  c.handleHostMessage({ kind: 'sidebar.test.click' })
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

function items(parent: HTMLElement): HTMLElement[] {
  return [...parent.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
}

function editRequests(h: BridgeHarness) {
  return h.sent.filter((m) => m.kind === 'edit.request')
}

/** jsdom 无布局：给条目 stub 一个矩形（top = index * 100，高 40） */
function stubRects(parent: HTMLElement, only?: number[]): void {
  items(parent).forEach((el, i) => {
    if (only && !only.includes(i)) {
      return
    }
    const top = 100 + i * 100
    el.getBoundingClientRect = () => new DOMRect(200, top, 240, 40)
  })
}

/** 在元素/document 上派发 pointer 事件（MouseEvent 构造——本仓处理器只读
 *  坐标与 buttons；bubbles 到 document 级拖拽监听，target 链供落点命中）。
 *  buttons 缺省 1（真实拖拽期间按键恒为按下态），显式传 0 模拟已释放 */
function firePointer(
  el: Element | Document,
  type: string,
  x: number,
  y: number,
  buttons = 1,
): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, buttons }))
}

/** 拖拽会话三步：按下 from → 超阈值移动（进入拖拽态）→ 悬停 to 的三态区域。
 *  position 决定落点 Y 分位（与 25% 容差对齐的稳定分位） */
function dragTo(
  parent: HTMLElement,
  from: number,
  to: number,
  position: 'before' | 'after' | 'inside',
): void {
  const els = items(parent)
  const fromEl = els[from]!
  const toEl = els[to]!
  const fromRect = fromEl.getBoundingClientRect()
  const toRect = toEl.getBoundingClientRect()
  firePointer(fromEl, 'pointerdown', fromRect.left + 20, fromRect.top + 20)
  firePointer(fromEl, 'pointermove', fromRect.left + 20, fromRect.top + 30) // >4px 进入拖拽态
  const y = toRect.top + (position === 'before' ? 5 : position === 'after' ? 35 : 20)
  firePointer(toEl, 'pointermove', toRect.left + 40, y)
}

describe('拖拽进入态与源条目提示', () => {
  it('位移超阈值进入拖拽态：源条目挂 dragging 类，probe 回报 draggingIndex', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before')
    expect(items(parent)[1]!.classList.contains('vsidian-outline-dragging')).toBe(true)
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex).toBe(1)
    expect(state.outline?.dropHintPainted).toBe(false) // jsdom 无布局：绘制证据由真宿主断言
    c.dispose()
    document.body.removeChild(parent)
  })

  it('位移未超阈值不进入拖拽态（点击/箭头操作不受扰动）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const el = items(parent)[1]!
    firePointer(el, 'pointerdown', 220, 120)
    firePointer(el, 'pointermove', 222, 121) // 3px < 4px
    firePointer(document, 'pointerup', 222, 121)
    expect(items(parent)[1]!.classList.contains('vsidian-outline-dragging')).toBe(false)
    expect(editRequests(h)).toHaveLength(0)
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('三态落点指示与 probe 观测', () => {
  for (const position of ['before', 'after', 'inside'] as const) {
    it(`目标 ${position} 区域：${position === 'inside' ? '包裹高亮' : '插入线'}类 + probe dropTargetIndex/dropPosition`, () => {
      const h = makeBridge()
      const { c, parent } = mountDrag(h)
      stubRects(parent)
      dragTo(parent, 1, 4, position)
      const target = items(parent)[4]!
      const cls =
        position === 'before' ? 'vsidian-outline-drop-before'
          : position === 'after' ? 'vsidian-outline-drop-after'
            : 'vsidian-outline-drop-inside'
      expect(target.classList.contains(cls), `目标条目应带 ${cls}`).toBe(true)
      const state = viewState(c, h)
      expect(state.outline?.dropTargetIndex).toBe(4)
      expect(state.outline?.dropPosition).toBe(position)
      c.dispose()
      document.body.removeChild(parent)
    })
  }

  it('落点切换只保留一个指示类（拖过多个目标）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before')
    // 继续拖到目标 3 的中部（inside）
    dragTo(parent, 1, 3, 'inside')
    const all = items(parent).map((el) => el.className)
    expect(all[3]).toContain('vsidian-outline-drop-inside')
    expect(all[4]).not.toContain('vsidian-outline-drop-before')
    expect(viewState(c, h).outline?.dropTargetIndex).toBe(3)
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('无效落点（拖入自身控制域内部）', () => {
  it('子树内目标：无落点指示、probe dropTargetIndex null、drop 零写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    // 甲(0) 的子树 = [0,1,2,3]：乙/丁/丙均为无效目标
    for (const to of [0, 1, 2, 3]) {
      dragTo(parent, 0, to, 'inside')
      const state = viewState(c, h)
      expect(state.outline?.draggingIndex, '拖拽态应在（源有效）').toBe(0)
      expect(state.outline?.dropTargetIndex, `目标 ${to} 在自身子树内应无有效落点`).toBeNull()
      expect(state.outline?.dropPosition).toBeNull()
      firePointer(items(parent)[to]!, 'pointerup', 240, 300)
    }
    expect(editRequests(h), '无效落点 drop 不得写回').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    c.dispose()
    document.body.removeChild(parent)
  })

  it('落点不在任何条目上（面板空白区）：无指示', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const fromEl = els[1]!
    firePointer(fromEl, 'pointerdown', 220, 120)
    firePointer(fromEl, 'pointermove', 220, 130)
    // 移到面板（非条目元素）上
    firePointer(parent.querySelector('.vsidian-outline-panel')!, 'pointermove', 50, 500)
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex).toBe(1)
    expect(state.outline?.dropTargetIndex).toBeNull()
    firePointer(document, 'pointerup', 50, 500)
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('drop 写回（单事务 + 即时大纲刷新）', () => {
  it('before 落点：源控制域整段搬到目标前、对齐目标层级；一笔 edit.request', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 2, 4, 'before') // 丁(H4) → 戊(H1) 前：对齐 H1
    firePointer(items(parent)[4]!, 'pointerup', 240, 500)
    const reqs = editRequests(h)
    expect(reqs, '拖拽写回应为一笔 edit.request').toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe(
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
    )
    // 即时刷新：大纲条目序 = 甲乙丙丁戊，丁升 H1
    const state = viewState(c, h)
    expect(state.outline?.items.map((i) => [i.level, i.text])).toEqual([
      [1, '甲'], [2, '乙'], [2, '丙'], [1, '丁'], [1, '戊'],
    ])
    // 写回后指示类全部清除
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-dragging') &&
      !el.className.includes('vsidian-outline-drop-'))).toBe(true)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('inside 落点：成为目标最后子级（level+1 调级随行）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 2, 3, 'inside') // 丁(H4) → 丙(H2) 内部：降 H3 成为丙子级
    firePointer(items(parent)[3]!, 'pointerup', 240, 420)
    expect(editRequests(h)).toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe(
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n### 丁\n丁内容\n# 戊\n戊内容',
    )
    expect(viewState(c, h).outline?.items.map((i) => [i.level, i.text])).toEqual([
      [1, '甲'], [2, '乙'], [2, '丙'], [3, '丁'], [1, '戊'],
    ])
    c.dispose()
    document.body.removeChild(parent)
  })

  it('拖拽后的补发 click 被吞一次（不触发跳转），随后恢复', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const clicksAtDocument: number[] = []
    const listen = (e: Event): void => {
      if (e.type === 'click') {
        clicksAtDocument.push(1)
      }
    }
    document.addEventListener('click', listen)
    try {
      dragTo(parent, 2, 4, 'before')
      firePointer(items(parent)[4]!, 'pointerup', 240, 500)
      expect(editRequests(h)).toHaveLength(1)
      items(parent)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(clicksAtDocument, '拖拽后的补发 click 应被吞（stopPropagation）').toHaveLength(0)
      items(parent)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(clicksAtDocument, '第二次 click 恢复正常传播').toHaveLength(1)
    } finally {
      document.removeEventListener('click', listen)
      c.dispose()
      document.body.removeChild(parent)
    }
  })
})

describe('取消路径（零写回）', () => {
  it('Esc 取消：清指示类、退出拖拽态、不写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'after')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-dragging'))).toBe(true)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('pointercancel 视作取消（零写回）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'after')
    document.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('window blur 取消（review-loops B1：指针越出 webview 释放的兜底，零写回）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'after')
    window.dispatchEvent(new Event('blur'))
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    // 会话清理后拖拽功能不死锁：新拖拽会话可再次进入拖拽态
    const el = items(parent)[1]!
    const rect = el.getBoundingClientRect()
    firePointer(el, 'pointerdown', rect.left + 20, rect.top + 20)
    firePointer(el, 'pointermove', rect.left + 20, rect.top + 30)
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    c.dispose()
    document.body.removeChild(parent)
  })

  it('会话只由起始指针驱动：按键已释放（buttons=0）的移动自取消，不推进落点', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before') // 正常拖拽态：源条目已弱化、落点已指示
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    // 越界释放（up 不送达）后指针回到 webview 内：无按键即证明手势已结束，
    // 不应继续推进会话（否则纯悬停会画出插入线，且释放会被当作 drop）
    const toEl = items(parent)[4]!
    const rect = toEl.getBoundingClientRect()
    firePointer(toEl, 'pointermove', rect.left + 40, rect.top + 35, 0)
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex, '无按键移动应结束会话').toBeNull()
    expect(state.outline?.dropTargetIndex).toBeNull()
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-drop-') &&
      !el.className.includes('vsidian-outline-dragging'))).toBe(true)
    // 非起始指针的移动同样不推进（多指针防御）
    const from = items(parent)[1]!
    const fromRect = from.getBoundingClientRect()
    firePointer(from, 'pointerdown', fromRect.left + 20, fromRect.top + 20)
    firePointer(from, 'pointermove', fromRect.left + 20, fromRect.top + 30)
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('条目 DOM 重建路径取消会话：搜索过滤重建后拖拽不残留（review-loops 第 2 轮）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before')
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    // 搜索输入触发条目整体重渲染：旧条目（含源条目提示与落点指示）被替换，
    // 会话若存活会让 hintEl 指向脱挂节点、状态与画面不一致
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '戊' })
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex, '重建后会话应已取消').toBeNull()
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-dragging') &&
      !el.className.includes('vsidian-outline-drop-'))).toBe(true)
    // 随后的释放不得写回（会话已取消；残留会按旧落点写回）
    firePointer(document, 'pointerup', 240, 500)
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('越界释放残留会话：面板外（编辑器区）普通点击不得被误判为 drop', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before') // 起拖并悬停到有效落点
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    // 越界释放：指针在 webview 之外松开，webview 文档收不到这次 pointerup
    // （真宿主对应窗口原生 chrome／另一窗口释放；浏览器隐式捕获只保证同窗口
    // 跨帧送达，见 test/browser/outlineDragBoundary.mjs）——会话就此残留
    // 用户回到 webview，在编辑器区（不在大纲面板内）点一下
    const editor = document.createElement('div')
    document.body.appendChild(editor)
    firePointer(editor, 'pointerdown', 500, 500)
    firePointer(editor, 'pointerup', 500, 500)
    expect(viewState(c, h).outline?.draggingIndex, '面板外按下应清残留').toBeNull()
    expect(editRequests(h), '面板外点击不得被残留会话判为 drop').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    document.body.removeChild(editor)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('拖拽期间文档被外部改写：drop 放弃（锚点过期防御）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before')
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: '外部批注\n\n' }],
    })
    firePointer(items(parent)[4]!, 'pointerup', 240, 500)
    expect(editRequests(h), '锚点过期后 drop 不得写回（外部变更坐标已失效）').toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('侧栏收起时拖拽会话退出（面板不可见，落点失去意义）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before')
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('不可见条目：不可拖、不构成落点（折叠/搜索过滤同口径）', () => {
  it('折叠遮蔽的条目 pointerdown 不启动拖拽', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 }) // No-Expand：乙丁丙隐藏
    const hidden = items(parent)[1]!
    expect(hidden.classList.contains('vsidian-outline-hidden')).toBe(true)
    firePointer(hidden, 'pointerdown', 220, 120)
    firePointer(hidden, 'pointermove', 220, 140)
    firePointer(document, 'pointerup', 220, 140)
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('折叠遮蔽的条目不作为落点（悬停其上无指示）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 })
    dragTo(parent, 4, 1, 'inside') // 戊 → 乙（被折叠遮蔽）
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex).toBe(4)
    expect(state.outline?.dropTargetIndex, '折叠遮蔽条目不是合法落点').toBeNull()
    firePointer(items(parent)[1]!, 'pointerup', 240, 320)
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('搜索过滤隐藏的条目同样不是落点', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '戊' }) // 只保留 戊
    dragTo(parent, 4, 1, 'before') // 戊 → 乙（被搜索过滤）
    const state = viewState(c, h)
    expect(state.outline?.dropTargetIndex, '搜索过滤条目不是合法落点').toBeNull()
    firePointer(items(parent)[1]!, 'pointerup', 240, 320)
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('outline.test.drag 测试钩子（宿主注入通道，真实事件序列）', () => {
  it('action=drop 全链路：与手动拖拽同一处理器，写回一笔', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.drag', from: 2, to: 4, position: 'before', action: 'drop' })
    expect(editRequests(h)).toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe(
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
    )
    c.dispose()
    document.body.removeChild(parent)
  })

  it('action=hover 停在悬停态：probe 可观测拖拽与落点', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.drag', from: 1, to: 4, position: 'inside', action: 'hover' })
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex).toBe(1)
    expect(state.outline?.dropTargetIndex).toBe(4)
    expect(state.outline?.dropPosition).toBe('inside')
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('action=escape 取消：零写回、状态清空', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.drag', from: 1, to: 4, position: 'after', action: 'escape' })
    expect(viewState(c, h).outline?.draggingIndex).toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    c.dispose()
    document.body.removeChild(parent)
  })
})
