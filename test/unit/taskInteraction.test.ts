// @vitest-environment jsdom
// 任务勾选交互契约（工单 #9）：两种模式的勾选走标准出站链路。
// - live：任务标记 widget（input.vsidian-task-checkbox）可点击/键盘操作；
//   点击派发精确替换事务 → updateListener 出站 edit.request（同一链路）
// - reading：checkbox 启用（不再 disabled）；点击经容器事件委托 → 锚点严格
//   再校验 → 派发同一出站链路；阅读视图乐观重建
// - 重复任务：按源位置定位，绝不按文本查找（改错目标）
// - 过期点击：外部行漂移后校验失败 → 放弃，零 edit.request
// - 无内容变化的重渲染（resync 同文、滚动回收重挂载）不新增历史：零写回
// - 撤销：宿主 undo 广播回流后两种视图的勾选状态同步回退
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：为 CM6 的视口测量提供零值 polyfill（真宿主有真实实现）
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/task.md'

const DOC = [
  '# 任务清单标题',
  '',
  '- [ ] 未完成任务甲',
  '- [ ] 未完成任务甲',
  '- [x] 已完成任务',
  '',
  '结尾段落。',
  '',
].join('\n')

interface Harness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
  controller: WebviewSyncController
  parent: HTMLElement
}

function makeHarness(text = DOC, version = 1): Harness {
  const sent: WebviewToHost[] = []
  let state: Record<string, unknown> | undefined
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as Record<string, unknown>
    },
  }
  const parent = document.createElement('div')
  const controller = new WebviewSyncController(bridge)
  controller.mount(parent)
  controller.handleHostMessage({
    kind: 'init',
    sessionId: 's1',
    docUri: DOC_URI,
    version,
    text,
  })
  return { bridge, sent, controller, parent }
}

function editRequests(h: Harness) {
  return h.sent.filter((m): m is Extract<WebviewToHost, { kind: 'edit.request' }> => m.kind === 'edit.request')
}

function lastEditRequest(h: Harness) {
  return editRequests(h).at(-1)
}

/** live 侧任务 checkbox 元素（非活动行） */
function liveCheckboxes(h: Harness): HTMLInputElement[] {
  return Array.from(h.parent.querySelectorAll<HTMLInputElement>('input.vsidian-task-checkbox'))
}

/** reading 侧任务 checkbox 元素 */
function readingCheckboxes(h: Harness): HTMLInputElement[] {
  return Array.from(
    h.parent.querySelectorAll<HTMLInputElement>('input.vsidian-reading-task-checkbox'),
  )
}

describe('live：任务标记 widget 可交互并走标准出站链路', () => {
  it('点击未勾选任务：派发 [ ]→[x] 精确替换并发出 edit.request', () => {
    const h = makeHarness()
    const boxes = liveCheckboxes(h)
    expect(boxes.length).toBe(3) // 两个未勾选 + 一个已勾选（非活动行）
    const first = boxes[0]!
    const markerStart = DOC.indexOf('[')
    first.click()
    const req = lastEditRequest(h)
    expect(req).toBeDefined()
    expect(req!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    expect(req!.baseVersion).toBe(1)
    expect(req!.seq).toBe(1)
    // 本地乐观回显：CM6 文档立即更新
    expect(h.controller.getView()!.state.doc.toString()).toBe(
      DOC.replace('- [ ] 未完成任务甲', '- [x] 未完成任务甲'),
    )
  })

  it('点击已勾选任务：派发 [x]→[ ] 取消', () => {
    const h = makeHarness()
    const checked = liveCheckboxes(h).find((b) => b.checked)!
    const markerStart = DOC.indexOf('[x]')
    checked.click()
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[ ]' }])
  })

  it('重复任务行：点击第二个相同文本任务只切换第二个（按位置定位）', () => {
    const h = makeHarness()
    const boxes = liveCheckboxes(h)
    // 两个 '- [ ] 未完成任务甲'：点击第二个
    boxes[1]!.click()
    const markerStart = DOC.indexOf('[', DOC.indexOf('[') + 1) // 第二个标记
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    const doc = h.controller.getView()!.state.doc.toString()
    // 行 3（第一个任务）保持未勾选、行 4（第二个任务）已勾选
    const lines = doc.split('\n')
    expect(lines[2]).toBe('- [ ] 未完成任务甲')
    expect(lines[3]).toBe('- [x] 未完成任务甲')
  })

  it('ack 确认后 baseVersion 推进；后续编辑携带新版本', () => {
    const h = makeHarness()
    liveCheckboxes(h)[0]!.click()
    h.controller.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    h.controller.getView()!.dispatch({ changes: { from: 0, insert: 'X' } })
    expect(lastEditRequest(h)!.baseVersion).toBe(2)
  })

  it('键盘操作：Enter 触发切换且不向编辑器插入换行', () => {
    const h = makeHarness()
    const box = liveCheckboxes(h)[0]!
    const markerStart = DOC.indexOf('[')
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    // Enter 不产生换行插入（无额外 edit.request）
    expect(editRequests(h)).toHaveLength(1)
  })

  it('任务正文保留 checkbox；光标进入 [ ] 才显示标记源码', () => {
    const h = makeHarness()
    const view = h.controller.getView()!
    view.dispatch({ selection: { anchor: DOC.indexOf('未完成任务甲') } })
    expect(liveCheckboxes(h)).toHaveLength(3)
    view.dispatch({ selection: { anchor: DOC.indexOf('[') } })
    expect(liveCheckboxes(h)).toHaveLength(2)
  })

  it('真实鼠标事件序列（mousedown 先行）：widget 拦截 mousedown，光标不移入标记，click 完成切换', () => {
    const h = makeHarness()
    const box = liveCheckboxes(h)[0]!
    const markerStart = DOC.indexOf('[')
    // 真实鼠标点击 = mousedown → mouseup → click。mousedown 正是 CM6
    // MouseSelection 同步放置光标的钩子（缺陷二：光标落入 [ ] 区间 →
    // 装饰规则移除 widget → click 永不触发）。契约：checkbox 自身的
    // mousedown 必须在源头终结——不冒泡到 contentDOM（CM6 看不到）、
    // 阻止默认（input 不抢焦点）。
    const content = h.controller.getView()!.contentDOM
    let reachedContent = 0
    content.addEventListener('mousedown', () => {
      reachedContent += 1
    })
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    box.dispatchEvent(mousedown)
    expect(reachedContent).toBe(0) // stopPropagation：CM6 不感知该 mousedown
    expect(mousedown.defaultPrevented).toBe(true) // preventDefault：焦点不被 input 抢走
    expect(h.parent.contains(box)).toBe(true) // widget 存活（未被「光标入标记显源码」移除）
    expect(liveCheckboxes(h)).toHaveLength(3)
    box.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    box.click()
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    expect(editRequests(h)).toHaveLength(1)
  })

  it('外部增量应用后 widget 状态随文档更新（撤销广播回退勾选）', () => {
    const h = makeHarness()
    const markerStart = DOC.indexOf('[')
    liveCheckboxes(h)[0]!.click()
    // 宿主先确认勾选编辑（权威串行管线：确认后才可能发生 undo 广播）
    h.controller.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    // 宿主 undo 广播：外部增量把 [x] 还原为 [ ]
    h.controller.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: markerStart, length: 3, text: '[ ]' }],
    })
    const boxes = liveCheckboxes(h)
    expect(boxes.filter((b) => b.checked)).toHaveLength(1) // 只剩原有 [x] 项
  })
})

describe('reading：checkbox 启用、点击走锚点校验与出站链路', () => {
  function readingMode(h: Harness) {
    h.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
  }

  it('checkbox 不再 disabled，勾选状态映射文档', () => {
    const h = makeHarness()
    readingMode(h)
    const boxes = readingCheckboxes(h)
    expect(boxes).toHaveLength(3)
    expect(boxes.every((b) => !b.disabled)).toBe(true)
    expect(boxes.map((b) => b.checked)).toEqual([false, false, true])
  })

  it('松散任务列表（条目间空行）同样渲染 checkbox 并可点击写回', () => {
    // 松散列表 markdown-it 输出 <li><p>[ ] …</p></li>：首子节点是 <p>
    // 元素而非文本节点。缺陷三：convertTaskItems 只认首子文本节点，
    // 松散列表不渲染复选框、正文显示原文 [ ]。
    const looseDoc = [
      '# 松散清单标题',
      '',
      '- [ ] 松散任务甲',
      '',
      '- [x] 松散任务乙',
      '',
      '结尾段落。',
      '',
    ].join('\n')
    const h = makeHarness(looseDoc)
    readingMode(h)
    const boxes = readingCheckboxes(h)
    expect(boxes).toHaveLength(2)
    expect(boxes.map((b) => b.checked)).toEqual([false, true])
    expect(boxes.every((b) => !b.disabled)).toBe(true)
    // 复选框插在 <p> 内文本之前；正文不再显示 [ ] 原文
    expect(h.parent.querySelector('.vsidian-reading-task')!.textContent).not.toContain('[ ]')
    const markerStart = looseDoc.indexOf('[')
    boxes[0]!.click()
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    // 点击链路（容器委托 → 锚点校验 → 隐藏 dispatch → edit.request）不因
    // 松散结构改变；乐观重建后为勾选
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([true, true])
    // 撤销广播回流（对照紧凑路径写法）：宿主确认后 undo，外部增量把
    // [x] 还原为 [ ]——文档与显示都应回退，松散结构不丢乐观态对账
    h.controller.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    h.controller.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: markerStart, length: 3, text: '[ ]' }],
    })
    expect(h.controller.getView()!.state.doc.toString()).toBe(looseDoc)
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([false, true])
  })

  it('点击未勾选任务：edit.request 精确替换 + 阅读视图乐观重建为勾选', () => {
    const h = makeHarness()
    readingMode(h)
    const markerStart = DOC.indexOf('[')
    readingCheckboxes(h)[0]!.click()
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    // 阅读视图立即显示勾选（乐观，源自本地 CM6 文档）
    const boxes = readingCheckboxes(h)
    expect(boxes.map((b) => b.checked)).toEqual([true, false, true])
  })

  it('重复任务行：点击第二个只切换第二个（按锚点位置定位）', () => {
    const h = makeHarness()
    readingMode(h)
    readingCheckboxes(h)[1]!.click()
    const markerStart = DOC.indexOf('[', DOC.indexOf('[') + 1)
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: markerStart, length: 3, text: '[x]' }])
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([false, true, true])
  })

  it('键盘操作：Enter 在 checkbox 上触发切换', () => {
    const h = makeHarness()
    readingMode(h)
    const box = readingCheckboxes(h)[0]!
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: DOC.indexOf('['), length: 3, text: '[x]' }])
  })

  it('点击后 ack 确认：baseVersion 推进且勾选状态保持', () => {
    const h = makeHarness()
    readingMode(h)
    readingCheckboxes(h)[0]!.click()
    h.controller.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([true, false, true])
  })

  it('过期点击：外部行漂移后旧锚点校验失败 → 放弃（零写回）', () => {
    const h = makeHarness()
    readingMode(h)
    // 外部插入导致行漂移：视图同步重建
    h.controller.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: '头部插入两行\n\n' }],
    })
    // 构造过期点击载体：锚点仍是漂移前的位置（模拟对已替换元素的点击）
    const stale = document.createElement('input')
    stale.type = 'checkbox'
    stale.className = 'vsidian-reading-task-checkbox'
    stale.dataset['vsidianSrcStart'] = String(DOC.indexOf('['))
    stale.dataset['vsidianSrcEnd'] = String(DOC.indexOf('[') + 3)
    stale.dataset['vsidianChecked'] = 'false'
    const reading = h.parent.querySelector<HTMLElement>('.vsidian-view-reading')!
    reading.appendChild(stale)
    const before = editRequests(h).length
    stale.click()
    expect(editRequests(h)).toHaveLength(before) // 校验失败：零写回
    // 正常重挂载的 checkbox 仍可用（新锚点正确）
    readingCheckboxes(h)[0]!.click()
    expect(editRequests(h)).toHaveLength(before + 1)
  })

  it('已是目标态的点击（显示过期）→ 零写回，不新增历史', () => {
    const h = makeHarness()
    readingMode(h)
    // 外部把第一个任务改为 [x]：视图重建后显示勾选
    const markerStart = DOC.indexOf('[')
    h.controller.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: markerStart, length: 3, text: '[x]' }],
    })
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([true, false, true])
    // 携带过期显示态（未勾选）的点击：权威已是目标态 → 无内容变化
    const staleIntent = readingCheckboxes(h)[0]!.cloneNode() as HTMLInputElement
    staleIntent.dataset['vsidianChecked'] = 'false'
    staleIntent.checked = false
    h.parent.querySelector<HTMLElement>('.vsidian-view-reading')!.appendChild(staleIntent)
    const before = editRequests(h).length
    staleIntent.click()
    expect(editRequests(h)).toHaveLength(before)
  })

  it('外部行插入后重建视图：新锚点正确（不因漂移改错目标）', () => {
    const h = makeHarness()
    readingMode(h)
    // 外部在文首插入一行
    h.controller.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: '外部插入行\n\n' }],
    })
    const boxes = readingCheckboxes(h)
    expect(boxes).toHaveLength(3)
    boxes[0]!.click()
    const req = lastEditRequest(h)!
    // 新文档中第一个任务标记的偏移（漂移后仍指向第一个任务）
    const driftedDoc = `外部插入行\n\n${DOC}`
    expect(req.changes).toEqual([
      { offset: driftedDoc.indexOf('['), length: 3, text: '[x]' },
    ])
    expect(req.baseVersion).toBe(2)
  })

  it('撤销广播回流后阅读视图勾选状态回退', () => {
    const h = makeHarness()
    readingMode(h)
    const markerStart = DOC.indexOf('[')
    readingCheckboxes(h)[0]!.click()
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([true, false, true])
    // 宿主确认勾选编辑后 undo：外部增量回退
    h.controller.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    h.controller.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: markerStart, length: 3, text: '[ ]' }],
    })
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([false, false, true])
  })

  it('无内容变化的重渲染不新增历史：resync 同文 → 零新增写回', () => {
    const h = makeHarness()
    readingMode(h)
    readingCheckboxes(h)[0]!.click()
    h.controller.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    const before = editRequests(h).length
    // 同文重同步（重渲染路径）：不产生新的写回
    h.controller.handleHostMessage({ kind: 'doc.resync', version: 2, text: DOC.replace('[ ] 未完成任务甲', '[x] 未完成任务甲') })
    expect(editRequests(h)).toHaveLength(before)
    // 勾选状态不因重渲染丢失
    expect(readingCheckboxes(h).map((b) => b.checked)).toEqual([true, false, true])
  })
})

describe('reading 虚拟化：滚出回收与滚回重挂载后任务状态不丢', () => {
  let heightSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(36)
  })
  afterEach(() => {
    heightSpy.mockRestore()
  })

  function viewState(h: Harness): Extract<WebviewToHost, { kind: 'view.state' }> {
    const before = h.sent.length
    h.controller.handleHostMessage({ kind: 'view.state.request' })
    const msg = h.sent.slice(before).find((m) => m.kind === 'view.state')
    if (!msg) {
      throw new Error('view.state 未回报')
    }
    return msg as Extract<WebviewToHost, { kind: 'view.state' }>
  }

  it('勾选 → 滚出窗口回收 → 滚回重挂载：状态与文档一致且滚动零解析', () => {
    // 长文档：任务在中部，初始窗口外（每块 36px，视口 400 + 缓冲 → 窗口约前 28 块）
    const lines: string[] = []
    for (let i = 0; i < 100; i++) {
      if (i > 0) {
        lines.push('')
      }
      lines.push(i === 50 ? '- [ ] 中部任务' : `第 ${i} 段普通文本`)
    }
    const longDoc = lines.join('\n') + '\n'
    const h = makeHarness(longDoc)
    Object.defineProperty(
      h.parent.querySelector<HTMLElement>('.vsidian-view-reading')!,
      'clientHeight',
      { value: 400, configurable: true },
    )
    h.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(viewState(h).readingVirtualized).toBe(true)
    expect(readingCheckboxes(h)).toHaveLength(0) // 中部任务在初始窗口外：未挂载

    // 定位到任务块（view.locate 公共入口）：重挂载后出现 checkbox，状态未勾选
    h.controller.handleHostMessage({
      kind: 'view.locate',
      offset: longDoc.indexOf('- [ ] 中部任务'),
    })
    const mounted = readingCheckboxes(h)
    expect(mounted).toHaveLength(1)
    expect(mounted[0]!.checked).toBe(false)

    // 勾选：写回 + 视图重建
    mounted[0]!.click()
    expect(lastEditRequest(h)!.changes).toEqual([
      { offset: longDoc.indexOf('['), length: 3, text: '[x]' },
    ])

    // 滚回顶部（任务块回收）再定位回来：状态仍为勾选（源于文档本身）
    h.controller.handleHostMessage({ kind: 'view.locate', offset: 0 })
    expect(readingCheckboxes(h)).toHaveLength(0)
    const parseAtTop = viewState(h).readingParseCount!
    h.controller.handleHostMessage({
      kind: 'view.locate',
      offset: longDoc.indexOf('- [ ] 中部任务'),
    })
    const remounted = readingCheckboxes(h)
    expect(remounted).toHaveLength(1)
    expect(remounted[0]!.checked).toBe(true)
    // 滚动/定位路径零重新解析（挂载与解析分离；勾选重建的解析发生在中间）
    expect(viewState(h).readingParseCount).toBe(parseAtTop)
  })
})

describe('task.test.click 测试钩子（集成宿主的真实点击通道）', () => {
  it('live 视图：按序号点击真实 checkbox', () => {
    const h = makeHarness()
    h.controller.handleHostMessage({ kind: 'task.test.click', view: 'live', index: 0 })
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: DOC.indexOf('['), length: 3, text: '[x]' }])
  })

  it('reading 视图：按序号点击真实 checkbox', () => {
    const h = makeHarness()
    h.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    h.controller.handleHostMessage({ kind: 'task.test.click', view: 'reading', index: 2 })
    expect(lastEditRequest(h)!.changes).toEqual([{ offset: DOC.indexOf('[x]'), length: 3, text: '[ ]' }])
  })

  it('非法消息被协议校验丢弃（index 负数 / view 非法）', () => {
    const h = makeHarness()
    h.controller.handleHostMessage({ kind: 'task.test.click', view: 'live', index: -1 })
    h.controller.handleHostMessage({ kind: 'task.test.click', view: 'preview', index: 0 })
    expect(editRequests(h)).toHaveLength(0)
  })
})
