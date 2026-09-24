// @vitest-environment jsdom
// 工单 #4 契约：冲突时保留未确认输入并暂停写回（webview 侧）。
// - 在途未确认编辑存在时收到外部增量：可映射则平移应用（不静默错位）；
//   区间重叠无法安全映射 → 进入暂停：保留本地文本、上报 conflict.report、
//   显示横幅，不再发 edit.request，忽略后续 doc.changed
// - ok:false ack 且本地有未确认输入 → 不重置文本（保留），进入暂停并上报
// - ok:false ack 且本地无未确认输入 → 附全文时重置后进入暂停（干净基线）
// - doc.resync 恢复：重置文本、解除暂停、清未确认集，后续输入正常发送
// - session.suspended 消息：重载后的 webview 恢复暂停态（横幅提示）
// - 横幅提供 copy / resume 按钮 → conflict.action 消息（宿主执行剪贴板与恢复）
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/s.md'

function makeBridge() {
  const sent: WebviewToHost[] = []
  let state: Record<string, unknown> | undefined
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as Record<string, unknown>
    },
  }
  return { bridge, sent }
}

function mount(bridge: VsCodeBridge, parent?: HTMLElement): { c: WebviewSyncController; parent: HTMLElement } {
  const holder = parent ?? document.createElement('div')
  const c = new WebviewSyncController(bridge)
  c.mount(holder)
  return { c, parent: holder }
}

function init(c: WebviewSyncController, text: string, version = 1, sessionId = 's1') {
  c.handleHostMessage({ kind: 'init', sessionId, docUri: DOC_URI, version, text })
}

function editRequests(sent: WebviewToHost[]) {
  return sent.filter((m): m is Extract<WebviewToHost, { kind: 'edit.request' }> => m.kind === 'edit.request')
}

function conflictReports(sent: WebviewToHost[]) {
  return sent.filter((m): m is Extract<WebviewToHost, { kind: 'conflict.report' }> => m.kind === 'conflict.report')
}

const waitFlush = () => new Promise<void>((r) => setTimeout(r, 20))

describe('在途未确认编辑 + 外部增量', () => {
  it('不重叠：外部增量平移穿过本地未确认编辑后应用，不静默错位', () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    // 本地在开头插入 'Z'（乐观回显，发出请求未 ack）
    c.getView()!.dispatch({ changes: { from: 0, insert: 'Z' } })
    expect(editRequests(sent)).toHaveLength(1)
    // 外部基于原文替换 [3,6) 'def'→'XY'（权威此时为 'abcXY'）
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 3, length: 3, text: 'XY' }],
    })
    // 正确结果：本地插入平移不受影响，外部替换落在映射后的 [4,7)
    expect(c.getView()!.state.doc.toString()).toBe('ZabcXY')
  })

  it('重叠：进入暂停，保留本地文本，上报快照，不再回发请求', async () => {
    const { bridge, sent } = makeBridge()
    const { c, parent } = mount(bridge)
    init(c, 'abcdef', 1)
    // 本地替换 [3,6)（与外部区间重叠）
    c.getView()!.dispatch({ changes: { from: 3, to: 6, insert: '我的替换' } })
    const reqCount = editRequests(sent).length
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 4, length: 1, text: 'X' }],
    })
    // 本地文本原样保留（不丢字、不被权威覆盖）
    expect(c.getView()!.state.doc.toString()).toBe('abc我的替换')
    expect(conflictReports(sent)).toHaveLength(1)
    expect(conflictReports(sent)[0]).toMatchObject({
      sessionId: 's1',
      docUri: DOC_URI,
      version: 1,
      text: 'abc我的替换',
    })
    // 暂停后：后续外部增量被忽略（保留本地，等待用户处理）
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: '更多外部' }],
    })
    expect(c.getView()!.state.doc.toString()).toBe('abc我的替换')
    // 暂停后本地输入不再发 edit.request（写回暂停），文本继续保留
    c.getView()!.dispatch({ changes: { from: 0, insert: '继续' } })
    expect(c.getView()!.state.doc.toString()).toBe('继续abc我的替换')
    expect(editRequests(sent)).toHaveLength(reqCount)
    // 横幅可见
    const banner = parent.querySelector('.oile-suspend-banner')
    expect(banner).not.toBeNull()
    expect((banner as HTMLElement).style.display).not.toBe('none')
  })

  it('C-3：外部插入点与在途删除区间端点仅相邻：不暂停且映射正确', () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    // 本地删除 [2,4)（'cd'）在途未确认：本地 'abef'
    c.getView()!.dispatch({ changes: { from: 2, to: 4 } })
    // 外部插入点在原 offset 4（恰为删除区间右端，相邻不相交）
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 4, length: 0, text: 'X' }],
    })
    // 相邻不算真重叠：正常映射应用（插入点平移到删除点之后），不进入暂停
    expect(c.getView()!.state.doc.toString()).toBe('abXef')
    expect(conflictReports(sent)).toHaveLength(0)
    c.handleHostMessage({ kind: 'view.state.request' })
    const state = sent.find((m) => m.kind === 'view.state') as { suspended?: boolean }
    expect(state.suspended).toBeFalsy()
  })

  it('C-3：外部区间跨过在途插入点（归属二义）仍暂停', () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    // 本地在 offset 2 插入 'ZZ' 在途：本地 'abZZcdef'
    c.getView()!.dispatch({ changes: { from: 2, insert: 'ZZ' } })
    // 外部替换 [1,3)（跨过插入点）：本地插入内容归属二义
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 1, length: 2, text: 'Y' }],
    })
    expect(conflictReports(sent)).toHaveLength(1)
    expect(c.getView()!.state.doc.toString()).toBe('abZZcdef')
  })

  it('映射失败后 ack ok 到达也不推进版本（暂停态忽略一切写回结果）', async () => {
    const { bridge } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    c.getView()!.dispatch({ changes: { from: 3, to: 6, insert: '本地' } })
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 4, length: 1, text: 'X' }],
    })
    // 迟到的确认（宿主侧已应用该请求）
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 3 })
    // 暂停态忽略：文本保留
    expect(c.getView()!.state.doc.toString()).toBe('abc本地')
  })

  it('ack ok 全部确认后未确认集清空：外部增量恢复直接应用', () => {
    const { bridge } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abc', 1)
    c.getView()!.dispatch({ changes: { from: 0, insert: 'Z' } })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    // 外部增量基于权威 v2（'Zabc'）：替换 'a'（offset 1）
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: 1, length: 1, text: '甲' }],
    })
    expect(c.getView()!.state.doc.toString()).toBe('Z甲bc')
  })
})

describe('ok:false ack 的保留与重置', () => {
  it('有未确认输入时 conflict ack 保留本地文本并进入暂停（不覆盖）', async () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, '草稿', 1)
    c.getView()!.dispatch({ changes: { from: 2, insert: '我的未确认内容' } })
    c.handleHostMessage({
      kind: 'edit.ack',
      seq: 1,
      ok: false,
      reason: 'conflict',
      version: 9,
      text: '权威全文',
    })
    // 关键：本地输入保留，不被权威全文覆盖
    expect(c.getView()!.state.doc.toString()).toBe('草稿我的未确认内容')
    expect(conflictReports(sent).at(-1)).toMatchObject({ text: '草稿我的未确认内容' })
  })

  it('无未确认输入时 conflict ack 以附带的权威全文重置后进入暂停', async () => {
    const { bridge, sent } = makeBridge()
    const { c, parent } = mount(bridge)
    init(c, '旧内容', 1)
    // 无本地编辑：收到冲突（如宿主检测到面板状态可疑）
    c.handleHostMessage({
      kind: 'edit.ack',
      seq: 7,
      ok: false,
      reason: 'conflict',
      version: 4,
      text: '权威全文',
    })
    expect(c.getView()!.state.doc.toString()).toBe('权威全文')
    const banner = parent.querySelector('.oile-suspend-banner') as HTMLElement
    expect(banner).not.toBeNull()
    // 暂停态：后续输入不再发送
    c.getView()!.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(editRequests(sent)).toHaveLength(0)
  })

  it('error ack（applyEdit 失败）同样保留本地输入并暂停', async () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, '草稿', 1)
    c.getView()!.dispatch({ changes: { from: 2, insert: '写不进去' } })
    c.handleHostMessage({
      kind: 'edit.ack',
      seq: 1,
      ok: false,
      reason: 'error',
      version: 9,
      text: '权威全文',
    })
    expect(c.getView()!.state.doc.toString()).toBe('草稿写不进去')
    expect(conflictReports(sent).at(-1)).toMatchObject({ text: '草稿写不进去' })
  })

  it('暂停状态下重复的 ok:false ack 被忽略（不重复上报）', () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, '草稿', 1)
    c.getView()!.dispatch({ changes: { from: 2, insert: 'X' } })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: false, reason: 'conflict', version: 2, text: '权威' })
    c.handleHostMessage({ kind: 'edit.ack', seq: 2, ok: false, reason: 'conflict', version: 2, text: '权威' })
    expect(conflictReports(sent)).toHaveLength(1)
  })
})

describe('doc.resync 恢复与 session.suspended', () => {
  it('doc.resync 解除暂停：重置文本、清横幅，后续输入恢复发送', () => {
    const { bridge, sent } = makeBridge()
    const { c, parent } = mount(bridge)
    init(c, '草稿', 1)
    c.getView()!.dispatch({ changes: { from: 2, insert: 'X' } })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: false, reason: 'conflict', version: 2, text: '权威' })
    // 用户选择放弃本地修改，宿主 resumePanel → doc.resync
    c.handleHostMessage({ kind: 'doc.resync', version: 5, text: '权威' })
    expect(c.getView()!.state.doc.toString()).toBe('权威')
    const banner = parent.querySelector('.oile-suspend-banner') as HTMLElement
    expect(banner.style.display).toBe('none')
    c.getView()!.dispatch({ changes: { from: 2, insert: '新' } })
    const req = editRequests(sent).at(-1)!
    expect(req.baseVersion).toBe(5)
    expect(req.changes).toEqual([{ offset: 2, length: 0, text: '新' }])
  })

  it('session.suspended 消息使重载后的 webview 进入暂停态', () => {
    const { bridge, sent } = makeBridge()
    const { c, parent } = mount(bridge)
    init(c, '权威全文', 3)
    c.handleHostMessage({ kind: 'session.suspended', version: 3, reason: 'conflict' })
    const banner = parent.querySelector('.oile-suspend-banner') as HTMLElement
    expect(banner.style.display).not.toBe('none')
    // 暂停态不发送写回
    c.getView()!.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(editRequests(sent)).toHaveLength(0)
    // 干净 webview 的 session.suspended 不产生 report（本地无未确认输入）
    expect(conflictReports(sent)).toHaveLength(0)
  })
})

describe('横幅按钮 → conflict.action', () => {
  function suspendByAck(c: WebviewSyncController) {
    c.handleHostMessage({ kind: 'edit.ack', seq: 9, ok: false, reason: 'conflict', version: 2, text: '权威' })
  }

  it('复制按钮发送 copy 动作', () => {
    const { bridge, sent } = makeBridge()
    const { c, parent } = mount(bridge)
    init(c, 'a', 1)
    suspendByAck(c)
    ;(parent.querySelector('.oile-suspend-banner button[data-action="copy"]') as HTMLElement).click()
    const action = sent.find((m): m is Extract<WebviewToHost, { kind: 'conflict.action' }> => m.kind === 'conflict.action')
    expect(action).toMatchObject({ sessionId: 's1', docUri: DOC_URI, action: 'copy' })
  })

  it('重新同步按钮发送 resume 动作', () => {
    const { bridge, sent } = makeBridge()
    const { c, parent } = mount(bridge)
    init(c, 'a', 1)
    suspendByAck(c)
    ;(parent.querySelector('.oile-suspend-banner button[data-action="resume"]') as HTMLElement).click()
    const action = sent.find((m): m is Extract<WebviewToHost, { kind: 'conflict.action' }> => m.kind === 'conflict.action')
    expect(action).toMatchObject({ action: 'resume' })
  })
})

describe('组合期冲突的保留（#3 遗留：不再全文覆盖）', () => {
  it('flush 映射失败时保留本地文本并暂停，不再请求全文覆盖', async () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    c.getView()!.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 3, length: 0, text: 'X' }], // 与组合插入点重合
    })
    c.getView()!.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    // CM6 microtask：组合文本上屏于旧坐标 3
    c.getView()!.dispatch({ changes: { from: 3, insert: '中文' }, userEvent: 'input.type.compose' })
    await waitFlush()
    // 保留：不再发送 sync.request（旧实现全文覆盖丢组合输入）
    expect(sent.filter((m) => m.kind === 'sync.request')).toHaveLength(0)
    // 组合文本保留在本地，冲突被上报
    expect(c.getView()!.state.doc.toString()).toBe('abc中文def')
    expect(conflictReports(sent).at(-1)).toMatchObject({ text: 'abc中文def' })
    // 暂停：本地继续输入不发送
    const before = editRequests(sent).length
    c.getView()!.dispatch({ changes: { from: 0, insert: '续' } })
    expect(editRequests(sent)).toHaveLength(before)
  })
})

describe('view.state 暂停标记', () => {
  it('暂停期间 view.state 回报 suspended: true', () => {
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'a', 1)
    c.handleHostMessage({ kind: 'view.state.request' })
    const normal = sent.find((m) => m.kind === 'view.state') as Extract<WebviewToHost, { kind: 'view.state' }>
    expect(normal.suspended).toBeFalsy()

    c.handleHostMessage({ kind: 'edit.ack', seq: 9, ok: false, reason: 'conflict', version: 2, text: '权威' })
    sent.length = 0
    c.handleHostMessage({ kind: 'view.state.request' })
    const suspendedState = sent.find((m) => m.kind === 'view.state') as Extract<WebviewToHost, { kind: 'view.state' }>
    expect(suspendedState.suspended).toBe(true)
  })
})

describe('暂停/暂缓态本地输入的快照刷新（R-1）', () => {
  // 场景：conflict.report 仅在 enterSuspended 时刻上报一次（或暂缓集根本
  // 不上报）；此后暂停态继续输入或暂缓集累积的文本宿主拿不到——面板关闭/
  // 断连后「复制未确认输入」缺这部分内容。修复契约：暂停态与暂缓态的本地
  // 输入变化后 500ms 防抖重发 conflict.report 刷新宿主全文快照。
  afterEach(() => {
    vi.useRealTimers()
  })

  function suspendByOverlap(c: WebviewSyncController): void {
    // 在途未确认替换 + 重叠外部增量 → 冲突暂停（enterSuspended 首报一次）
    c.getView()!.dispatch({ changes: { from: 3, to: 6, insert: '我的替换' } })
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 4, length: 1, text: 'X' }],
    })
  }

  it('暂停后继续输入：防抖重发 conflict.report，快照含新输入全文', async () => {
    vi.useFakeTimers()
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    suspendByOverlap(c)
    expect(conflictReports(sent)).toHaveLength(1)

    c.getView()!.dispatch({ changes: { from: 0, insert: '新增输入' } })
    // 防抖窗口内不重发
    expect(conflictReports(sent)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)
    const reports = conflictReports(sent)
    expect(reports).toHaveLength(2)
    expect(reports[1]).toMatchObject({
      sessionId: 's1',
      docUri: DOC_URI,
      text: '新增输入abc我的替换',
    })
  })

  it('暂停后多次输入合并为一次防抖重发', async () => {
    vi.useFakeTimers()
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    suspendByOverlap(c)
    const before = conflictReports(sent).length
    c.getView()!.dispatch({ changes: { from: 0, insert: '一' } })
    await vi.advanceTimersByTimeAsync(200)
    c.getView()!.dispatch({ changes: { from: 1, insert: '二' } })
    await vi.advanceTimersByTimeAsync(400)
    // 第二次输入落在防抖窗口内：合并到同一次重发
    expect(conflictReports(sent)).toHaveLength(before + 1)
    expect(conflictReports(sent).at(-1)).toMatchObject({ text: '一二abc我的替换' })
  })

  it('恢复（doc.resync）后挂起的防抖不再发 conflict.report', async () => {
    vi.useFakeTimers()
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    suspendByOverlap(c)
    const before = conflictReports(sent).length
    c.getView()!.dispatch({ changes: { from: 0, insert: '新' } })
    // 恢复先于防抖到期：此后不再处于暂停/暂缓态，重报不发出
    c.handleHostMessage({ kind: 'doc.resync', version: 3, text: '权威全文' })
    await vi.advanceTimersByTimeAsync(600)
    expect(conflictReports(sent)).toHaveLength(before)
  })

  it('暂缓集形成时同样上报：宿主留存含在途+暂缓输入的全文', async () => {
    vi.useFakeTimers()
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    // 输入 A（在途未确认）
    c.getView()!.dispatch({ changes: { from: 0, insert: 'A' } })
    expect(conflictReports(sent)).toHaveLength(0)
    // 输入 B 触及 A（插入点落在未确认内容闭区间）→ 进暂缓集
    c.getView()!.dispatch({ changes: { from: 1, insert: 'B' } })
    expect(editRequests(sent).length).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(600)
    const reports = conflictReports(sent)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ text: 'ABabcdef' })
  })

  it('dispose 清理挂起的防抖定时器：此后不再发出 conflict.report', async () => {
    vi.useFakeTimers()
    const { bridge, sent } = makeBridge()
    const { c } = mount(bridge)
    init(c, 'abcdef', 1)
    suspendByOverlap(c)
    const before = conflictReports(sent).length
    c.getView()!.dispatch({ changes: { from: 0, insert: '尾' } })
    c.dispose()
    await vi.advanceTimersByTimeAsync(600)
    expect(conflictReports(sent)).toHaveLength(before)
  })
})
