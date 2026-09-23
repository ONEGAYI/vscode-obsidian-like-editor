// @vitest-environment jsdom
// IME 组合期间外部变更的缓冲契约（工单 #3，探索笔记 03 §6 / 05 R1）：
// - 组合进行中（compositionstart..compositionend）到达的 doc.changed 不直接
//   dispatch（避免打断输入 / 破坏组合 DOM），缓冲到组合结束后按最新版本对账
// - 缓冲期间 baseVersion 不推进：组合结束产生的 edit.request 携带组合前版本，
//   由宿主重定位（错位会静默破坏坐标，故为关键正确性用例）
// - flush 时外部增量坐标映射穿过组合编辑（CM6 ChangeSet）；区间重叠无法安全
//   映射时保守请求全文重同步（sync.request → doc.resync），不静默丢字
// - 组合取消（无文本变化）时缓冲仍被应用（flush 兜底）
// - 组合期间到达的全文消息（doc.resync / ack 失败附全文）以全文形态缓冲，
//   flush 时直接采用全文
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/c.md'

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

function mount(bridge: VsCodeBridge): WebviewSyncController {
  const controller = new WebviewSyncController(bridge)
  controller.mount(document.createElement('div'))
  return controller
}

function init(c: WebviewSyncController, text: string, version = 1, sessionId = 's1') {
  c.handleHostMessage({ kind: 'init', sessionId, docUri: DOC_URI, version, text })
}

function startComposition(c: WebviewSyncController) {
  c.getView()!.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
}

function endComposition(c: WebviewSyncController) {
  c.getView()!.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
}

/** 模拟 CM6 在 compositionend 后（microtask 中）把组合文本读入状态的最终事务 */
function commitCompositionText(c: WebviewSyncController, from: number, insert: string) {
  c.getView()!.dispatch({
    changes: { from, insert },
    userEvent: 'input.type.compose',
  })
}

/** flush 走 setTimeout(0)（macrotask，晚于 CM6 的 microtask compose flush） */
const waitFlush = () => new Promise<void>((r) => setTimeout(r, 20))

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('组合期间外部增量缓冲', () => {
  it('组合中 doc.changed 不立即应用；compositionend 后 flush 应用且不回发', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef')
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 1, text: '甲' }],
    })
    // 组合中：未应用
    expect(c.getView()!.state.doc.toString()).toBe('abcdef')
    endComposition(c)
    // 组合取消（无 compose 事务）→ 兜底 flush
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('甲bcdef')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })

  it('flush 后 baseVersion 推进到缓冲消息的版本', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 6,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: 'X' }],
    })
    endComposition(c)
    await waitFlush()
    c.getView()!.dispatch({ changes: { from: 4, insert: '尾' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.baseVersion).toBe(6)
  })

  it('compose 事务的 edit.request 携带组合前版本（缓冲不推进 baseVersion）', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    // 组合期间宿主推进到 v2（外部插入在开头）
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: 'Z' }],
    })
    endComposition(c)
    // CM6 microtask：组合文本上屏（基于组合前文档 offset 3 插入 '中文'）
    commitCompositionText(c, 3, '中文')
    const req = sent.find((m) => m.kind === 'edit.request') as Extract<
      WebviewToHost,
      { kind: 'edit.request' }
    >
    // 关键：请求基于 webview 实际状态（未含缓冲增量），版本必须是 1 而非 2，
    // 由宿主重定位穿过外部变更
    expect(req.baseVersion).toBe(1)
    expect(req.changes).toEqual([{ offset: 3, length: 0, text: '中文' }])
    // flush：外部增量映射穿过组合插入 → 位置 0 不受影响
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('Zabc中文def')
  })

  it('外部删除区间在组合插入之后的坐标平移', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    // 外部删除 'a'（offset 0）
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 1, text: '' }],
    })
    endComposition(c)
    // 组合在原 offset 3（'d' 前）插入 '中文'
    commitCompositionText(c, 3, '中文')
    await waitFlush()
    // flush：外部删除 [0,1) 平移后仍删 'a' → 'bc中文def'
    expect(c.getView()!.state.doc.toString()).toBe('bc中文def')
  })

  it('外部区间与组合编辑重叠时请求全文重同步（保守不丢宿主权威文本）', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 3, length: 0, text: 'X' }], // 插入点与组合插入点重合
    })
    endComposition(c)
    commitCompositionText(c, 3, '中文') // 组合文本同样上屏于旧坐标 3
    await waitFlush()
    // 插入点重合：两侧插入顺序二义，无法安全映射 → 请求宿主全文
    expect(sent.filter((m) => m.kind === 'sync.request')).toHaveLength(1)
    // 宿主回复全文：装载后与宿主一致，baseVersion 推进
    c.handleHostMessage({ kind: 'doc.resync', version: 5, text: 'abc中文def' })
    expect(c.getView()!.state.doc.toString()).toBe('abc中文def')
    c.getView()!.dispatch({ changes: { from: 0, insert: '前' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.baseVersion).toBe(5)
  })

  it('组合期间多条外部增量按序缓冲并全部应用', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 1, text: '甲' }],
    })
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: 6, length: 0, text: '尾' }],
    })
    endComposition(c)
    commitCompositionText(c, 3, '中文')
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('甲bc中文def尾')
  })

  it('组合期间收到全文消息以全文形态缓冲，flush 采用全文', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 1, text: '甲' }],
    })
    // 随后宿主主动全文重同步（版本更新，覆盖前一条增量）
    c.handleHostMessage({ kind: 'doc.resync', version: 3, text: '宿主最新全文' })
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('宿主最新全文')
  })

  it('组合中 ack 失败附全文时不打断组合，结束后重置', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '草稿', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'edit.ack',
      seq: 1,
      ok: false,
      reason: 'stale',
      version: 9,
      text: '权威全文',
    })
    expect(c.getView()!.state.doc.toString()).toBe('草稿')
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('权威全文')
  })

  it('组合结束后立即开始下一轮组合时，缓冲推迟到下一轮结束', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: 'Z' }],
    })
    endComposition(c)
    // 第一轮 flush 定时器尚未触发，用户立即开始第二轮组合
    startComposition(c)
    await waitFlush()
    // flush 观察到组合进行中：继续缓冲
    expect(c.getView()!.state.doc.toString()).toBe('abcdef')
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('Zabcdef')
  })

  it('组合结束后正常输入的 edit.request 不受残留缓冲影响', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: 'Z' }],
    })
    endComposition(c)
    commitCompositionText(c, 3, '文')
    await waitFlush()
    // 组合输入已确认（宿主 v3），后续普通输入携带 flush 后的版本
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 3 })
    c.getView()!.dispatch({ changes: { from: 4, insert: 'x' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.baseVersion).toBe(3)
  })
})

describe('组合期间 webview 不发送重复请求', () => {
  it('组合中缓冲的外部增量 flush 时以 external 注解应用，不产生新 edit.request', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 3, length: 0, text: '尾' }],
    })
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('abc尾')
    // 仅 ready，无任何 edit.request / sync.request（无回声）
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
    expect(sent.filter((m) => m.kind === 'sync.request')).toHaveLength(0)
  })

  it('长期组合（sleep 跨多个宏任务）中缓冲持续有效', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 1, text: 'A' }],
    })
    await sleep(30) // 组合持续，无 compositionend
    expect(c.getView()!.state.doc.toString()).toBe('abc') // 仍未应用
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('Abc')
  })
})
