// @vitest-environment jsdom
// 大纲拖拽排序交互契约（#70）：面板 pointerdown 委托启动拖拽（锚点快照 +
// 数据校准）、超阈值进入拖拽态（源条目弱化）、三态落点指示（插入线/包裹
// 高亮类切换）、drop 单事务写回（一笔 edit.request + 即时大纲刷新）、
// 无效落点拒绝（拖入自身子树无指示无写回）、Esc/pointercancel/blur/面板关闭
// 取消与越界释放残留清理（残留会话不得把后续普通点击判为 drop）、拖拽后补发
// click 吞噬、非主键（和弦按键）不写回（仅主键释放执行 drop）、锚点过期防御、
// 不可见条目（折叠/搜索过滤）
// 不可拖也不构成落点、outline.test.drag 测试钩子全链路、probe 拖拽观测
// 字段。移动计划语义在 outlineDrag.test.ts。
// review-loops 第 3 轮补：按键门控只按 button/buttons 位掩码、不限指针类型
// （笔 barrel/eraser 同守）、面板委托的主指针（isPrimary）守卫、drop 锚点判据
// 与重命名同为「实例或内容等价」（resync 重发同内容不丢弃）、重命名编辑态随
// 条目重建放弃时留日志、写回兜底分支重建条目重放搜索高亮（mark 不丢）。
// review-loops 第 4 轮补：drop 锚点判据加入「条目序列的派生来源」（中间态
// 刷新把 items 换成平移行号后不得写回）、主指针判据收窄为只排除触屏次指针
// （合成 PointerEvent 的默认 isPrimary=false 不再静默失效）、折叠滑块行入口
// 与面板同口径（去掉 pointerType==='mouse' 前缀）。
import { describe, it, expect, vi } from 'vitest'
import type { Text } from '@codemirror/state'
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
 *  坐标、buttons、button、pointerType、pointerId 与 isPrimary；bubbles 到
 *  document 级拖拽监听，target 链供落点命中）。buttons 缺省 1（真实拖拽期间
 *  按键恒为按下态），显式传 0 模拟已释放；init 补和弦/笔/触屏场景所需的
 *  非主键 button、指针类型、指针 id 与主指针标志（MouseEventInit 无这些
 *  字段，实例上补——按键掩码判据之外的观测面靠它们） */
function firePointer(
  el: Element | Document,
  type: string,
  x: number,
  y: number,
  buttons = 1,
  init: { button?: number; pointerType?: string; pointerId?: number; isPrimary?: boolean } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons,
    button: init.button ?? 0,
  })
  if (init.pointerType !== undefined) {
    Object.defineProperty(event, 'pointerType', { value: init.pointerType })
  }
  if (init.pointerId !== undefined) {
    Object.defineProperty(event, 'pointerId', { value: init.pointerId })
  }
  if (init.isPrimary !== undefined) {
    Object.defineProperty(event, 'isPrimary', { value: init.isPrimary })
  }
  el.dispatchEvent(event)
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

  it('拖拽期间文档被外部改写：drop 放弃（锚点过期防御）且留 console.warn 诊断', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      dragTo(parent, 1, 4, 'before')
      c.handleHostMessage({
        kind: 'doc.changed',
        version: 2,
        origin: 'external',
        changes: [{ offset: 0, length: 0, text: '外部批注\n\n' }],
      })
      firePointer(items(parent)[4]!, 'pointerup', 240, 500)
      expect(editRequests(h), '锚点过期后 drop 不得写回（外部变更坐标已失效）').toHaveLength(0)
      // 放弃必须留痕（与重命名提交路径同口径）：否则用户只看到「拖了没反应」
      expect(
        warn.mock.calls.map((args) => String(args[0])).some((t) => t.includes('大纲拖拽放弃')),
        `放弃路径应留 console.warn（实际 ${JSON.stringify(warn.mock.calls)}）`,
      ).toBe(true)
    } finally {
      warn.mockRestore()
      c.dispose()
      document.body.removeChild(parent)
    }
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

describe('非主键（和弦按键）防写回：仅主键释放执行 drop', () => {
  it('拖拽中非主键按下（和弦）：移动路径结束会话、指示清空、零写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before') // 起拖并悬停到有效落点
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    // 和弦按键（左键仍按住时再按右键）不投递 pointerdown——第二个按键只报
    // pointermove(button=2, buttons=3)，故「非主键按下即结束」必须在移动路径上
    const toEl = items(parent)[4]!
    const rect = toEl.getBoundingClientRect()
    firePointer(toEl, 'pointermove', rect.left + 40, rect.top + 5, 3,
      { button: 2, pointerType: 'mouse' })
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex, '非主键按下应结束会话').toBeNull()
    expect(state.outline?.dropTargetIndex).toBeNull()
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-dragging') &&
      !el.className.includes('vsidian-outline-drop-')), '指示类应清空').toBe(true)
    // 随后陆续释放两个按键：都不得落成 drop 写回
    firePointer(document, 'pointerup', rect.left + 40, rect.top + 5, 2,
      { button: 0, pointerType: 'mouse' }) // 松左键（右键仍按住）
    firePointer(document, 'pointerup', rect.left + 40, rect.top + 5, 0,
      { button: 2, pointerType: 'mouse' }) // 松右键（最后一个按键）
    expect(editRequests(h), '和弦手势不得写回').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('会话进行中的非主键 pointerup：不收尾、零写回（纵深防线）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before') // 有效落点（若被当作 drop 即写回）
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    // 合成事件或平台差异可能送来非主键 pointerup（如右键抬起是最后一个按键：
    // pointerup button=2, buttons=0，pointerId 与起始指针相同）——它不是主键
    // 释放，不得收尾会话、不得按残留落点写回
    const toEl = items(parent)[4]!
    firePointer(toEl, 'pointerup', 240, 500, 0, { button: 2, pointerType: 'mouse' })
    expect(editRequests(h), '非主键释放不得写回').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    expect(viewState(c, h).outline?.draggingIndex,
      '非主键释放不得收尾会话（主键释放仍应执行 drop）').toBe(1)
    // 主键释放才收尾：会话未被非主键释放破坏，落点照常兑现一笔写回
    firePointer(toEl, 'pointerup', 240, 500)
    expect(editRequests(h), '主键释放应照常写回').toHaveLength(1)
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

// review-loops 第 3 轮：按键门控原以 pointerType==='mouse' 为前提，笔（pen）的
// barrel 键据此绕过全部三处守卫——与第 2 轮修掉的鼠标和弦缺陷同一失效模式。
// 判据改为只按 button/buttons 位掩码：接触态（触屏实测 button=0/buttons=1；
// 笔按 W3C 位掩码同值）照常可用，eraser/barrel（按 W3C 位掩码 button=2/5）
// 不启动，接触期间的侧键（buttons 含非 bit0 位）结束会话。合成事件按这些
// 取值构造（按键语义的事实源是 W3C Pointer Events；触屏取值由浏览器回归
// 场景 K 实测钉住）。
describe('按键门控只按 button/buttons 位掩码、不限指针类型（笔同守）', () => {
  it('笔 barrel 按下（button=2/buttons=2）不启动会话：无指示、零写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const fromRect = els[1]!.getBoundingClientRect()
    const toRect = els[4]!.getBoundingClientRect()
    // 笔悬停按侧键：button=2、buttons=2（W3C Pointer Events 的笔按键语义）
    firePointer(els[1]!, 'pointerdown', fromRect.left + 20, fromRect.top + 20, 2,
      { button: 2, pointerType: 'pen' })
    firePointer(els[1]!, 'pointermove', fromRect.left + 20, fromRect.top + 30, 2,
      { button: -1, pointerType: 'pen' })
    firePointer(els[4]!, 'pointermove', toRect.left + 40, toRect.top + 5, 2,
      { button: -1, pointerType: 'pen' })
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex, 'barrel 按下不得启动拖拽会话').toBeNull()
    expect(state.outline?.dropTargetIndex).toBeNull()
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-dragging') &&
      !el.className.includes('vsidian-outline-drop-')), '不得出现拖拽/落点指示类').toBe(true)
    // 释放（barrel 抬起：button=2、buttons=0）同样不得落成写回
    firePointer(document, 'pointerup', toRect.left + 40, toRect.top + 5, 0,
      { button: 2, pointerType: 'pen' })
    expect(editRequests(h), 'barrel 手势零写回').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('拖拽中笔 barrel 落下（接触+侧键 buttons=3）结束会话：指示清空、零写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const fromRect = els[1]!.getBoundingClientRect()
    const toRect = els[4]!.getBoundingClientRect()
    // 笔接触起拖（button=0/buttons=1）：与鼠标同路，照常进入拖拽态并悬停到有效落点
    firePointer(els[1]!, 'pointerdown', fromRect.left + 20, fromRect.top + 20, 1,
      { button: 0, pointerType: 'pen' })
    firePointer(els[1]!, 'pointermove', fromRect.left + 20, fromRect.top + 30, 1,
      { button: -1, pointerType: 'pen' })
    firePointer(els[4]!, 'pointermove', toRect.left + 40, toRect.top + 5, 1,
      { button: -1, pointerType: 'pen' })
    const hovered = viewState(c, h)
    expect(hovered.outline?.draggingIndex, '前置条件：笔接触拖拽应在拖拽态').toBe(1)
    expect(hovered.outline?.dropTargetIndex).toBe(4)
    // 侧键在接触期间落下：buttons=3（bit0 接触 + bit1 侧键）——非接触按键的
    // 位落下即证明手势意图已变，会话按移动路径守卫结束（与鼠标和弦同口径）
    firePointer(els[4]!, 'pointermove', toRect.left + 40, toRect.top + 5, 3,
      { button: -1, pointerType: 'pen' })
    const state = viewState(c, h)
    expect(state.outline?.draggingIndex, 'barrel 落下应结束会话').toBeNull()
    expect(state.outline?.dropTargetIndex).toBeNull()
    expect(items(parent).every((el) => !el.className.includes('vsidian-outline-dragging') &&
      !el.className.includes('vsidian-outline-drop-')), '指示类应清空').toBe(true)
    firePointer(document, 'pointerup', toRect.left + 40, toRect.top + 5, 0,
      { button: 2, pointerType: 'pen' })
    expect(editRequests(h), 'barrel 落下后不得按残留落点写回').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('笔接触拖拽（button=0/buttons=1）照常写回一笔（掩码判据不误伤笔）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const fromRect = els[2]!.getBoundingClientRect()
    const toRect = els[4]!.getBoundingClientRect()
    firePointer(els[2]!, 'pointerdown', fromRect.left + 20, fromRect.top + 20, 1,
      { button: 0, pointerType: 'pen' })
    firePointer(els[2]!, 'pointermove', fromRect.left + 20, fromRect.top + 30, 1,
      { button: -1, pointerType: 'pen' })
    firePointer(els[4]!, 'pointermove', toRect.left + 40, toRect.top + 5, 1,
      { button: -1, pointerType: 'pen' })
    expect(viewState(c, h).outline?.draggingIndex).toBe(2)
    firePointer(els[4]!, 'pointerup', toRect.left + 40, toRect.top + 5, 0,
      { button: 0, pointerType: 'pen' })
    expect(editRequests(h), '笔接触拖拽应与鼠标同路写回一笔').toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe(
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
    )
    c.dispose()
    document.body.removeChild(parent)
  })

  it('会话进行中笔 barrel 释放（pointerup button=2）：不收尾、零写回（纵深防线）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const fromRect = els[1]!.getBoundingClientRect()
    const toRect = els[4]!.getBoundingClientRect()
    firePointer(els[1]!, 'pointerdown', fromRect.left + 20, fromRect.top + 20, 1,
      { button: 0, pointerType: 'pen' })
    firePointer(els[1]!, 'pointermove', fromRect.left + 20, fromRect.top + 30, 1,
      { button: -1, pointerType: 'pen' })
    firePointer(els[4]!, 'pointermove', toRect.left + 40, toRect.top + 5, 1,
      { button: -1, pointerType: 'pen' })
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    // barrel 抬起是最后一个按键的释放：真实 pointerup(button=2, buttons=0)，
    // pointerId 与起始指针相同——它不是主键释放，不得收尾会话/不得写回
    firePointer(els[4]!, 'pointerup', toRect.left + 40, toRect.top + 5, 0,
      { button: 2, pointerType: 'pen' })
    expect(editRequests(h), '非主键（barrel）释放不得写回').toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe(DRAG_DOC)
    expect(viewState(c, h).outline?.draggingIndex,
      'barrel 释放不得收尾会话（主键释放仍应执行 drop）').toBe(1)
    firePointer(els[4]!, 'pointerup', toRect.left + 40, toRect.top + 5, 0,
      { button: 0, pointerType: 'pen' })
    expect(editRequests(h), '主键释放应照常写回').toHaveLength(1)
    c.dispose()
    document.body.removeChild(parent)
  })
})

// review-loops 第 3 轮：面板 pointerdown 委托缺 isPrimary 守卫——触屏第二指
// 落在条目上会直接新建会话、覆盖起始指针的会话（document capture 层的残留
// 清理早有同口径守卫，面板委托没有）。口径：次指针不启动、不推进、不收尾。
describe('面板委托的主指针守卫：次指针不启动、不覆盖进行中的会话', () => {
  it('次指针（isPrimary=false）落在条目上：会话不被覆盖、零写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const fromRect = els[2]!.getBoundingClientRect()
    const toRect = els[4]!.getBoundingClientRect()
    // 第一指（pointerId 1）：丁(2) 起拖 → 悬停 戊(4) 上缘
    firePointer(els[2]!, 'pointerdown', fromRect.left + 20, fromRect.top + 20, 1,
      { button: 0, pointerType: 'touch', pointerId: 1 })
    firePointer(els[2]!, 'pointermove', fromRect.left + 20, fromRect.top + 30, 1,
      { button: -1, pointerType: 'touch', pointerId: 1 })
    firePointer(els[4]!, 'pointermove', toRect.left + 40, toRect.top + 5, 1,
      { button: -1, pointerType: 'touch', pointerId: 1 })
    const started = viewState(c, h)
    expect(started.outline?.draggingIndex, '前置条件：第一指拖拽应在拖拽态').toBe(2)
    expect(started.outline?.dropPosition).toBe('before')
    // 第二指（pointerId 2，isPrimary=false）落在另一条目（甲）上：不得新建
    // 会话覆盖第一指——否则落点与源条目全部改属第二指，第一指的悬停指示脱挂
    firePointer(els[0]!, 'pointerdown', fromRect.left + 20, 100, 1,
      { button: 0, pointerType: 'touch', pointerId: 2, isPrimary: false })
    const afterSecondDown = viewState(c, h)
    expect(afterSecondDown.outline?.draggingIndex, '次指针不得覆盖进行中的会话').toBe(2)
    expect(afterSecondDown.outline?.dropTargetIndex, '落点仍归第一指').toBe(4)
    expect(afterSecondDown.outline?.dropPosition).toBe('before')
    // 次指针的移动与释放既不推进也不收尾（pointerId 不同，非本会话指针）
    firePointer(els[3]!, 'pointermove', 240, 320, 1,
      { button: -1, pointerType: 'touch', pointerId: 2, isPrimary: false })
    firePointer(document, 'pointerup', 240, 320, 0,
      { button: 0, pointerType: 'touch', pointerId: 2, isPrimary: false })
    const afterSecondUp = viewState(c, h)
    expect(afterSecondUp.outline?.draggingIndex).toBe(2)
    expect(afterSecondUp.outline?.dropTargetIndex).toBe(4)
    expect(editRequests(h), '次指针的移动/释放不得写回').toHaveLength(0)
    // 第一指释放才收尾：写回须以第一指的源（丁 → 戊 前）兑现一笔
    firePointer(document, 'pointerup', toRect.left + 40, toRect.top + 5, 0,
      { button: 0, pointerType: 'touch', pointerId: 1 })
    expect(editRequests(h), '第一指释放应兑现一笔写回').toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe(
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
    )
    c.dispose()
    document.body.removeChild(parent)
  })

  it('主指针（isPrimary=true）与缺省（undefined）都照常启动会话', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const els = items(parent)
    const rect = els[1]!.getBoundingClientRect()
    firePointer(els[1]!, 'pointerdown', rect.left + 20, rect.top + 20, 1,
      { button: 0, pointerType: 'touch', pointerId: 3, isPrimary: true })
    firePointer(els[1]!, 'pointermove', rect.left + 20, rect.top + 30, 1,
      { button: -1, pointerType: 'touch', pointerId: 3, isPrimary: true })
    expect(viewState(c, h).outline?.draggingIndex, '主指针照常启动会话').toBe(1)
    firePointer(document, 'pointerup', rect.left + 20, rect.top + 30, 0,
      { button: 0, pointerType: 'touch', pointerId: 3, isPrimary: true })
    // 缺省（MouseEvent 合成路径没有 isPrimary，undefined !== false）：既有
    // 全部用例同路，此处显式钉一次「判据只排除显式 false」
    firePointer(els[1]!, 'pointerdown', rect.left + 20, rect.top + 20)
    firePointer(els[1]!, 'pointermove', rect.left + 20, rect.top + 30)
    expect(viewState(c, h).outline?.draggingIndex, 'isPrimary 缺省照常启动会话').toBe(1)
    firePointer(document, 'pointerup', rect.left + 20, rect.top + 30)
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('drop 锚点判据与重命名同口径（内容等价的重发实例不丢弃拖拽）', () => {
  it('宿主 resync 重发同一内容（新 Text 实例）：drop 照常写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 2, 4, 'before') // 丁 → 戊 前（落点有效）
    const before = c.getView()!.state.doc
    // 宿主 resync 全文重发：内容逐字相同而 Text 实例换代（第 2 轮 commit
    // 记载的真实路径：行号未过期，旧判据却会静默丢弃用户拖拽）
    c.handleHostMessage({ kind: 'doc.resync', version: 7, text: DRAG_DOC })
    const after = c.getView()!.state.doc
    expect(after === before, '前置条件：resync 应换 Text 实例').toBe(false)
    expect(after.eq(before), '前置条件：resync 内容应等价').toBe(true)
    firePointer(items(parent)[4]!, 'pointerup', 240, 500)
    expect(editRequests(h), '实例换代但内容等价：drop 不得被静默丢弃').toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe(
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
    )
    c.dispose()
    document.body.removeChild(parent)
  })
})

describe('重命名编辑态随条目重建被放弃时留日志（放弃行为不变）', () => {
  it('外部改写触发条目重建：编辑态退出且留 console.warn', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.contextMenu', index: 1 })
    c.handleHostMessage({ kind: 'outline.test.menuClick', command: 'rename' })
    expect(
      parent.querySelector('.vsidian-outline-rename-input'),
      '前置条件：重命名输入框应进入编辑态',
    ).not.toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      // 外部改写插入新标题：序列变化 → 去抖 250ms 到期后条目重建
      c.handleHostMessage({
        kind: 'doc.changed',
        version: 9,
        origin: 'external',
        changes: [{ offset: 0, length: 0, text: '# 新增\n' }],
      })
      vi.advanceTimersByTime(300)
      expect(viewState(c, h).outline?.renamingIndex, '放弃行为不变：编辑态退出').toBeNull()
      expect(parent.querySelector('.vsidian-outline-rename-input'), '输入框随重建消失').toBeNull()
      // 输入被丢弃且零写回：无诊断时用户无从判断为何没生效（提交路径同口径）
      expect(
        warn.mock.calls.map((args) => String(args[0])).some((t) => t.includes('重命名编辑态')),
        `编辑态被放弃应留 console.warn（实际 ${JSON.stringify(warn.mock.calls)}）`,
      ).toBe(true)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      c.dispose()
      document.body.removeChild(parent)
    }
  })
})

// review-loops 第 3 轮：applyOutlineEdits 的两个兜底分支（顺序断言失败 /
// dispatch 异常）原先调不带 hits 的 rebuildOutlineItemsDom——过滤仍在（hidden
// 按搜索态施加）而 mark 高亮消失，与搜索态重建路径（applyOutlineSearch 带
// ranges）不同口径。两分支都只由防御性断言触发（「升序互不重叠」是全部计划
// 生成端的约定，公开链路产不出违例变更段），故此处白盒直调写回入口驱动。
describe('写回兜底分支重建条目须重放搜索高亮（#68 mark 不丢）', () => {
  const HIT_CLASS = 'vsidian-outline-search-hit'
  const hitsIn = (parent: HTMLElement): number => parent.querySelectorAll(`.${HIT_CLASS}`).length

  /** 白盒直调私有写回入口（类型上以结构断言表达——这些分支公开 API 不可达） */
  function driveFallbackEdits(
    c: WebviewSyncController,
    changes: ReadonlyArray<{ offset: number; length: number; text: string }>,
  ): void {
    ;(c as unknown as {
      applyOutlineEdits(ch: ReadonlyArray<{ offset: number; length: number; text: string }>): void
    }).applyOutlineEdits(changes)
  }

  it('顺序断言失败分支：条目重建后 mark 与过滤态一并保持', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '戊' })
    expect(hitsIn(parent), '前置条件：搜索态应有命中高亮').toBe(1)
    expect(items(parent)[1]!.classList.contains('vsidian-outline-hidden'),
      '前置条件：非命中条目被过滤').toBe(true)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      driveFallbackEdits(c, [
        { offset: 20, length: 0, text: 'X' }, // 乱序（offset 递减）：顺序断言拒绝
        { offset: 5, length: 0, text: 'Y' },
      ])
      expect(
        errors.mock.calls.map((args) => String(args[0])).some((t) => t.includes('变更段违例')),
        '前置条件：应走顺序断言放弃分支',
      ).toBe(true)
      expect(hitsIn(parent), '兜底重建后搜索高亮应重放（mark 不丢）').toBe(1)
      expect(items(parent)[1]!.classList.contains('vsidian-outline-hidden'), '过滤态保持').toBe(true)
      expect(items(parent)[4]!.classList.contains('vsidian-outline-hidden')).toBe(false)
      expect(c.getView()!.state.doc.toString(), '放弃分支零写回').toBe(DRAG_DOC)
    } finally {
      errors.mockRestore()
      c.dispose()
      document.body.removeChild(parent)
    }
  })

  it('dispatch 异常兜底分支：越界坐标重建后 mark 与过滤态一并保持', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '戊' })
    expect(hitsIn(parent), '前置条件：搜索态应有命中高亮').toBe(1)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // 越界坐标（单段升序，过顺序断言）：CM6 ChangeSet 构造抛错 → 兜底重建
      driveFallbackEdits(c, [{ offset: DRAG_DOC.length + 50, length: 0, text: 'X' }])
      expect(
        errors.mock.calls.map((args) => String(args[0])).some((t) => t.includes('dispatch 失败')),
        '前置条件：应走 dispatch 异常兜底分支',
      ).toBe(true)
      expect(hitsIn(parent), '兜底重建后搜索高亮应重放（mark 不丢）').toBe(1)
      expect(items(parent)[1]!.classList.contains('vsidian-outline-hidden'), '过滤态保持').toBe(true)
      expect(c.getView()!.state.doc.toString(), '异常分支不得改写文档').toBe(DRAG_DOC)
    } finally {
      errors.mockRestore()
      c.dispose()
      document.body.removeChild(parent)
    }
  })
})

// review-loops 第 4 轮（P2，实测复现）：drop 锚点只比「当前 doc 与起始快照
// 内容等价」，而**条目序列（outlineItems）的坐标**可能在拖拽期间被去抖刷新
// 换成中间态行号——outlineEnsureFresh 只在序列变化（outlineItemsEqual 为假）
// 时取消拖拽；序列逐字相同而行号平移（外部插入空行/增删正文行）时它照样替换
// items。释放前文档若回到原文（实例换代、eq 通过），写回就拿中间态行号算搬移
// 计划，把错坐标写进权威文档（内容错位并丢失）。
// 修法见 syncController.onOutlineDragEnd：drop 时除比 doc 与起始快照内容等价
// 外，还要求**当前 items 的派生来源**（this.outlineDoc，outlineItems 的唯一
// 赋值点即 outlineEnsureFresh，二者恒同源）与起始快照内容等价——「items 是快照
// 内容的派生物」成为判据的一部分。正常 resync（内容等价、实例换代且条目未换、
// 或换了仍派生自等价内容）照常写回，不由本轮收紧误伤。
describe('drop 锚点须含条目派生来源（review-loops 第 4 轮：中间态刷新）', () => {
  it('中间态刷新（序列相同、行号平移）+ 释放前回到原文：不得按平移行号写回', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      dragTo(parent, 2, 4, 'before') // 丁(H4) → 戊(H1) 前
      expect(viewState(c, h).outline?.draggingIndex).toBe(2)
      // 外部改写：文首插入空行。条目序列逐字不变（级别/原文/可见文本/标记），
      // 行号整体 +1 → itemsEqual 为真，条目 DOM 不重建，拖拽会话不被取消
      c.handleHostMessage({
        kind: 'doc.changed',
        version: 2,
        origin: 'external',
        changes: [{ offset: 0, length: 0, text: '\n' }],
      })
      vi.advanceTimersByTime(300) // 250ms 去抖到期：items 换成平移后的行号
      expect(
        viewState(c, h).outline?.draggingIndex,
        '前置条件：序列相同，会话未被过期行号刷新取消（缺陷窗口）',
      ).toBe(2)
      // 宿主 resync 发回原文：Text 实例换代、内容与起始快照等价
      c.handleHostMessage({ kind: 'doc.resync', version: 9, text: DRAG_DOC })
      firePointer(items(parent)[4]!, 'pointerup', 240, 500)
      expect(editRequests(h), '条目坐标非起始快照派生：零写回（否则错位写入）').toHaveLength(0)
      expect(c.getView()!.state.doc.toString(), '文档须保持原文').toBe(DRAG_DOC)
      expect(
        warn.mock.calls.map((args) => String(args[0])).some((t) => t.includes('大纲拖拽放弃')),
        `放弃路径应留 console.warn（实际 ${JSON.stringify(warn.mock.calls)}）`,
      ).toBe(true)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      c.dispose()
      document.body.removeChild(parent)
    }
  })

  it('内容等价 resync（实例换代）后条目随去抖刷新重算：照常写回正确结果', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      dragTo(parent, 2, 4, 'before') // 丁 → 戊 前
      const before = c.getView()!.state.doc
      c.handleHostMessage({ kind: 'doc.resync', version: 7, text: DRAG_DOC })
      const after = c.getView()!.state.doc
      expect(after === before, '前置条件：resync 应换 Text 实例').toBe(false)
      expect(after.eq(before), '前置条件：resync 内容应等价').toBe(true)
      vi.advanceTimersByTime(300) // 去抖到期：items 从新实例重算（行号不变）
      const itemsDoc = (c as unknown as { outlineDoc: Text | null }).outlineDoc
      expect(itemsDoc === after, '前置条件：条目派生来源已换代（本轮判据必须容忍）').toBe(true)
      firePointer(items(parent)[4]!, 'pointerup', 240, 500)
      expect(editRequests(h), '内容等价换代的 resync 不得丢弃拖拽').toHaveLength(1)
      expect(c.getView()!.state.doc.toString()).toBe(
        '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
      )
    } finally {
      vi.useRealTimers()
      c.dispose()
      document.body.removeChild(parent)
    }
  })

  it('中间态刷新后文档仍为平移态（未回到原文）：drop 同样放弃（零写回）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      dragTo(parent, 2, 4, 'before')
      c.handleHostMessage({
        kind: 'doc.changed',
        version: 2,
        origin: 'external',
        changes: [{ offset: 0, length: 0, text: '\n' }],
      })
      vi.advanceTimersByTime(300)
      firePointer(items(parent)[4]!, 'pointerup', 240, 500)
      expect(editRequests(h), '文档已改（内容不等价）：零写回').toHaveLength(0)
      expect(c.getView()!.state.doc.toString(), '文档须保持外部改写后的内容').toBe(`\n${DRAG_DOC}`)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      c.dispose()
      document.body.removeChild(parent)
    }
  })
})

// review-loops 第 4 轮：主指针守卫原为「isPrimary === false 即拒」——对
// **合成 PointerEvent** 是陷阱：`new PointerEvent('pointerdown', {…})` 未显式
// 赋 isPrimary 时引擎默认 false（pointerType 默认空串），会话静默不启动
// （真机鼠标/笔恒 isPrimary=true，现网不受影响；但未来任何用 PointerEvent
// 构造拖拽钩子的代码会静默失效）。判据收窄为只排除**触屏次指针**（多点触控
// 第二指起），面板委托与 document capture 清理层同口径。
describe('主指针判据只排除触屏次指针（合成 PointerEvent 默认值不再静默失效）', () => {
  /** start = 该组合下会话是否应启动；pointerType/isPrimary 缺省表示属性不存在
   *  （MouseEvent 合成路径没有这两个字段，读作 undefined） */
  const MATRIX: Array<{ label: string; pointerType?: string; isPrimary?: boolean; start: boolean }> = [
    { label: '合成 MouseEvent（两字段均缺省）', start: true },
    { label: "pointerType='' × isPrimary 缺省", pointerType: '', start: true },
    { label: "pointerType='' × isPrimary=false（PointerEvent 缺省构造）", pointerType: '', isPrimary: false, start: true },
    { label: "pointerType='' × isPrimary=true", pointerType: '', isPrimary: true, start: true },
    { label: "pointerType='mouse' × isPrimary 缺省", pointerType: 'mouse', start: true },
    { label: "pointerType='mouse' × isPrimary=false", pointerType: 'mouse', isPrimary: false, start: true },
    { label: "pointerType='mouse' × isPrimary=true", pointerType: 'mouse', isPrimary: true, start: true },
    { label: "pointerType='touch' × isPrimary 缺省", pointerType: 'touch', start: true },
    { label: "pointerType='touch' × isPrimary=true", pointerType: 'touch', isPrimary: true, start: true },
    { label: "pointerType='touch' × isPrimary=false（多点触控第二指）", pointerType: 'touch', isPrimary: false, start: false },
  ]

  for (const kase of MATRIX) {
    it(`${kase.label}：${kase.start ? '照常启动会话' : '不启动会话'}`, () => {
      const h = makeBridge()
      const { c, parent } = mountDrag(h)
      stubRects(parent)
      const el = items(parent)[1]!
      const rect = el.getBoundingClientRect()
      const init: { pointerType?: string; isPrimary?: boolean } = {}
      if (kase.pointerType !== undefined) {
        init.pointerType = kase.pointerType
      }
      if (kase.isPrimary !== undefined) {
        init.isPrimary = kase.isPrimary
      }
      firePointer(el, 'pointerdown', rect.left + 20, rect.top + 20, 1, init)
      firePointer(el, 'pointermove', rect.left + 20, rect.top + 30, 1, init)
      expect(
        viewState(c, h).outline?.draggingIndex,
        kase.start ? '应启动拖拽会话' : '触屏次指针不得启动会话',
      ).toBe(kase.start ? 1 : null)
      c.dispose()
      document.body.removeChild(parent)
    })
  }

  it('真实 PointerEvent 缺省构造（pointerType 空串 + isPrimary 默认 false）：照常启动会话', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    const el = items(parent)[1]!
    const rect = el.getBoundingClientRect()
    // 真实构造路径（本轮缺陷的现实形态）：不显式赋 isPrimary → 引擎默认 false
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 20,
      clientY: rect.top + 20,
      buttons: 1,
      button: 0,
    })
    expect(down.pointerType, '前置条件：合成 PointerEvent 的 pointerType 默认空串').toBe('')
    expect(down.isPrimary, '前置条件：合成 PointerEvent 的 isPrimary 默认 false').toBe(false)
    el.dispatchEvent(down)
    el.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 20,
      clientY: rect.top + 30,
      buttons: 1,
      button: 0,
    }))
    expect(viewState(c, h).outline?.draggingIndex, '合成 PointerEvent 不得静默失效').toBe(1)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('残留会话清理层同口径：面板外合成 PointerEvent 按下仍清残留（零写回）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    stubRects(parent)
    dragTo(parent, 1, 4, 'before') // 起拖并悬停到有效落点（越界释放前的残留会话）
    expect(viewState(c, h).outline?.draggingIndex).toBe(1)
    const editor = document.createElement('div')
    document.body.appendChild(editor)
    // capture 层清理判据若沿用 isPrimary===false 即拒，合成 PointerEvent
    // （pointerType ''、isPrimary 默认 false）会让残留会话存活、随后误判 drop
    editor.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: 500,
      clientY: 500,
      buttons: 1,
      button: 0,
    }))
    expect(viewState(c, h).outline?.draggingIndex, '残留会话应被清理').toBeNull()
    expect(editRequests(h)).toHaveLength(0)
    document.body.removeChild(editor)
    c.dispose()
    document.body.removeChild(parent)
  })
})

// review-loops 第 4 轮：折叠滑块行的 pointerdown 入口仍带 pointerType==='mouse'
// 前缀，与面板委托/移动/释放三处已统一的「只按按键判据」口径不一致——笔
// barrel（button=2/buttons=2）在滑块行上会武装拖拽起点（实害有限：移动路径的
// (buttons & 1) === 0 兜住后续推进）。此处对齐为面板入口同款判据（button !== 0
// 不武装，不设指针类型前提）：既有左键拖拽选档不受影响。
describe('折叠滑块行入口判据与面板同口径（只按按键，不设指针类型前提）', () => {
  const dotCenter = (n: number): number => 100 + n * 40 + 10

  /** 圆点 stub 布局：left = 100 + n*40、宽 20 → 圆心 110/150/190/230/270/310
   *  （outlineSliderLevelAt 取最近圆心；jsdom 无指针捕获实现，补空实现） */
  function stubSliderRects(parent: HTMLElement): HTMLElement {
    const row = parent.querySelector<HTMLElement>('.vsidian-outline-slider')!
    ;(row as unknown as { setPointerCapture(pointerId: number): void }).setPointerCapture = () => {}
    row.querySelectorAll<HTMLElement>('.vsidian-outline-slider-dot').forEach((dot, n) => {
      dot.getBoundingClientRect = () => new DOMRect(100 + n * 40, 0, 20, 8)
    })
    return row
  }

  it('笔 barrel 按下（button=2/buttons=2）不武装滑块拖拽：随后左键移动不改档位', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    const row = stubSliderRects(parent)
    const before = viewState(c, h).outline?.expandLevel
    firePointer(row, 'pointerdown', dotCenter(5), 4, 2, { button: 2, pointerType: 'pen' })
    firePointer(row, 'pointermove', dotCenter(0), 4, 1, { button: -1, pointerType: 'pen' })
    expect(viewState(c, h).outline?.expandLevel, '非主键按下不得武装拖拽：档位不变').toBe(before)
    c.dispose()
    document.body.removeChild(parent)
  })

  it('鼠标右键按下不武装；左键拖拽选档照常（既有交互不回退）', () => {
    const h = makeBridge()
    const { c, parent } = mountDrag(h)
    const row = stubSliderRects(parent)
    const before = viewState(c, h).outline?.expandLevel
    firePointer(row, 'pointerdown', dotCenter(5), 4, 2, { button: 2, pointerType: 'mouse' })
    firePointer(row, 'pointermove', dotCenter(0), 4, 1, { button: -1, pointerType: 'mouse' })
    expect(viewState(c, h).outline?.expandLevel, '右键按下不得武装拖拽').toBe(before)
    firePointer(row, 'pointerdown', dotCenter(5), 4, 1, { button: 0, pointerType: 'mouse' })
    firePointer(row, 'pointermove', dotCenter(0), 4, 1, { button: -1, pointerType: 'mouse' })
    expect(viewState(c, h).outline?.expandLevel, '左键拖到档 0 圆心应选档 0').toBe(0)
    c.dispose()
    document.body.removeChild(parent)
  })
})
