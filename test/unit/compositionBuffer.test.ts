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
import { selectTableRegion } from '../../src/webview/tableRegionSelection'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：为 CM6 的视口测量（measureTextSize → Range.getClientRects）
// 提供零值 polyfill，真宿主 Chromium 有真实实现
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

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

describe('矩形格区 IME 写回', () => {
  it('零宽首格开始组合后取消，不清区域内容且不写回', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    const source = '|H1|H2|\n|---|---|\n||B2|\n|C1|C2|'
    init(c, source)
    const view = c.getView()!
    selectTableRegion(view, { tableFrom: 0, rowFrom: 1, rowTo: 1, columnFrom: 0, columnTo: 1 })
    startComposition(c)
    endComposition(c)
    await waitFlush()
    expect(view.state.doc.toString()).toBe(source)
    expect(sent.filter((message) => message.kind === 'edit.request')).toHaveLength(0)
  })
  it('组合候选与清除区域合并为一次宿主 edit.request', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    const source = '| H1 | H2 |\n| --- | --- |\n| B1 | B2 |\n| C1 | C2 |'
    init(c, source)
    const view = c.getView()!
    const from = source.indexOf('B1')
    view.dispatch({ selection: { anchor: from } })
    selectTableRegion(view, { tableFrom: 0, rowFrom: 1, rowTo: 2, columnFrom: 0, columnTo: 1 })
    startComposition(c)
    view.dispatch({ changes: { from, insert: 'ni' }, userEvent: 'input.type.compose' })
    expect(sent.filter((message) => message.kind === 'edit.request')).toHaveLength(0)
    const candidateAt = view.state.doc.toString().indexOf('ni')
    view.dispatch({ changes: { from: candidateAt, to: candidateAt + 2, insert: '你好' },
      userEvent: 'input.type.compose' })
    endComposition(c)
    await waitFlush()
    expect(view.state.doc.toString()).toContain('| 你好 |  |\n|  |  |')
    expect(sent.filter((message) => message.kind === 'edit.request')).toHaveLength(1)
  })
})

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

  it('外部区间与组合编辑重叠时保留组合输入并暂停（#4：不再全文覆盖丢字）', async () => {
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
    // 插入点重合：两侧插入顺序二义，无法安全映射 → 保留组合输入并暂停写回，
    // 上报冲突快照（不再发送 sync.request 全文覆盖——那是 #3 的保守最小实现）
    expect(sent.filter((m) => m.kind === 'sync.request')).toHaveLength(0)
    expect(c.getView()!.state.doc.toString()).toBe('abc中文def')
    const report = sent.find((m) => m.kind === 'conflict.report') as Extract<
      WebviewToHost,
      { kind: 'conflict.report' }
    >
    expect(report).toMatchObject({ text: 'abc中文def' })
    // 宿主恢复（doc.resync）：装载后与宿主一致，baseVersion 推进
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

  it('组合中全文之后的较新增量在 flush 时仍应用', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    startComposition(c)
    c.handleHostMessage({ kind: 'doc.resync', version: 2, text: 'Xabc' })
    c.handleHostMessage({
      kind: 'doc.changed', version: 3, origin: 'external',
      changes: [{ offset: 4, length: 0, text: 'Y' }],
    })
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('XabcY')
  })

  it('组合缓冲全文落地后丢弃低版本迟到增量', async () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    startComposition(c)
    c.handleHostMessage({ kind: 'doc.resync', version: 5, text: 'Xabc' })
    endComposition(c)
    await waitFlush()
    c.handleHostMessage({
      kind: 'doc.changed', version: 4, origin: 'external',
      changes: [{ offset: 0, length: 0, text: '旧' }],
    })
    expect(c.getView()!.state.doc.toString()).toBe('Xabc')
  })

  it('待发本地编辑与组合中外部增量并存时保留输入并暂停', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    const view = c.getView()!
    view.dispatch({ changes: { from: 0, insert: 'ZZ' } })
    view.dispatch({ changes: { from: 2, insert: 'X' } })
    startComposition(c)
    c.handleHostMessage({
      kind: 'doc.changed', version: 2, origin: 'external',
      changes: [{ offset: 6, length: 0, text: 'Y' }],
    })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 3 })
    endComposition(c)
    await waitFlush()
    expect(view.state.doc.toString()).toBe('ZZXabcdef')
    expect(sent.find((m) => m.kind === 'conflict.report')).toMatchObject({ text: 'ZZXabcdef' })
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
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
      reason: 'conflict',
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

describe('B-1：暂停 + 组合中收到 doc.resync 的恢复', () => {
  it('flush 后解除暂停并装载全文（resync 兼作恢复信号）', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '草稿', 1)
    // 进入暂停（无未确认输入：ack 失败附全文重置 + 暂停）
    c.handleHostMessage({ kind: 'edit.ack', seq: 9, ok: false, reason: 'conflict', version: 2, text: '权威' })
    // 组合中收到 doc.resync（协议明文：resync 对暂停面板兼作恢复信号）
    startComposition(c)
    c.handleHostMessage({ kind: 'doc.resync', version: 5, text: '恢复全文' })
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('恢复全文')
    c.handleHostMessage({
      kind: 'doc.changed', version: 4, origin: 'external',
      changes: [{ offset: 0, length: 0, text: '旧' }],
    })
    expect(c.getView()!.state.doc.toString()).toBe('恢复全文')
    // 暂停解除：后续输入恢复发送（baseVersion 已推进）
    c.getView()!.dispatch({ changes: { from: 0, insert: '新' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.kind).toBe('edit.request')
    expect(req.baseVersion).toBe(5)
  })

  it('对照：暂停前组合中缓冲的 ack 失败附文不解除暂停（仅 resync 来源恢复）', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '草稿', 1)
    startComposition(c)
    // 组合中 ack 失败附全文：缓冲为全文形态（来源非 resync），并进入暂停
    c.handleHostMessage({ kind: 'edit.ack', seq: 9, ok: false, reason: 'conflict', version: 2, text: '权威' })
    endComposition(c)
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('权威')
    // 仍处暂停：输入不发送（ack 附文不兼作恢复信号）
    const before = sent.filter((m) => m.kind === 'edit.request').length
    c.getView()!.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(sent.filter((m) => m.kind === 'edit.request').length).toBe(before)
  })
})

describe('#49：组合期间暂缓输入不逐笔上报全文快照', () => {
  // 契约：IME 候选更新从第二笔起必然触碰未确认区间进入暂缓分支（deferredLocal），
  // 旧实现每笔立即 reportConflictSnapshot——1 MB 文档组合输入时每个候选
  // 更新触发一次全文 postMessage 与序列化，大文档下开销放大。放宽为：
  // 组合期间（composing）暂缓集累积不上报；组合结束 flush 后经
  // sendDeferredLocal 以单笔 edit.request 出站，文本进入宿主权威文档，
  // 取回语义由 VSCode 文本管线兜底。丢失窗口仅限组合进行中（候选未上屏）
  // 快速关闭/断连，与 VSCode 原生编辑器同类行为一致。非组合暂缓态
  // （冲突触碰、暂停态）保持逐笔快照不放宽（守卫见 suspendResume.test.ts）。
  it('组合中触碰未确认区间的多笔候选更新不发 conflict.report，flush 滞留时也不补发', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    const view = c.getView()!
    // 在途未确认 A（seq=1 已发未 ack）：组合候选将落在其插入内容内
    view.dispatch({ changes: { from: 0, insert: 'ZZ' } })
    startComposition(c)
    // 组合候选第一笔：插入点落在 A 的未确认插入内容内 → 暂缓分支
    view.dispatch({ changes: { from: 1, insert: '拼' }, userEvent: 'input.type.compose' })
    expect(view.state.doc.toString()).toBe('Z拼Zabcdef')
    // 候选更新（替换上一候选）：仍暂缓累积，不逐笔上报全文
    view.dispatch({ changes: { from: 1, to: 2, insert: '拼音' }, userEvent: 'input.type.compose' })
    expect(view.state.doc.toString()).toBe('Z拼音Zabcdef')
    expect(sent.filter((m) => m.kind === 'conflict.report')).toHaveLength(0)
    endComposition(c)
    await waitFlush()
    // flush 后 deferredLocal 因在途 A 未 ack 滞留：无暂停、无新输入，不补发快照
    expect(sent.filter((m) => m.kind === 'conflict.report')).toHaveLength(0)
  })

  it('组合结束后 deferredLocal 经 edit.request 单笔发出（ack 后无快照，取回语义恢复）', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    const view = c.getView()!
    view.dispatch({ changes: { from: 0, insert: 'ZZ' } })
    startComposition(c)
    view.dispatch({ changes: { from: 1, insert: '拼' }, userEvent: 'input.type.compose' })
    endComposition(c)
    await waitFlush()
    // 在途 A ack：flush 滞留的暂缓集以单笔 edit.request 发出（净变更进入
    // 宿主权威文档，VSCode 文本管线兜底），全程无 conflict.report
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    const reqs = sent.filter((m): m is Extract<WebviewToHost, { kind: 'edit.request' }> =>
      m.kind === 'edit.request')
    expect(reqs).toHaveLength(2)
    expect(reqs[1]).toMatchObject({
      baseVersion: 2,
      changes: [{ offset: 1, length: 0, text: '拼' }],
    })
    expect(sent.filter((m) => m.kind === 'conflict.report')).toHaveLength(0)
  })
})

describe('组合中收到模式切换指令（view.mode.set，#38 标题栏三态）', () => {
  // 契约：IME 组合未上屏时点击标题栏按钮切换视图——切换是纯视图操作
  // （不 dispatch 文本变更），不得打断组合缓冲链路：组合结束后组合文本
  // 照常提交（edit.request 携带组合前版本）、缓冲的外部增量照常 flush，
  // 切回 live 后输入原地保留。jsdom 无法真实模拟 IME 与容器隐藏时浏览器
  // 取消组合的行为，未上屏拼音在真实宿主的表现由人工清单 A21 验证
  it('切换指令不打断组合缓冲：提交与 flush 照常，切回 live 输入保留', async () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    startComposition(c)
    // 组合中先缓冲一条外部增量，再收到宿主切换指令（标题栏按钮路径）
    c.handleHostMessage({
      kind: 'doc.changed', version: 2, origin: 'external',
      changes: [{ offset: 0, length: 0, text: 'Z' }],
    })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const viewStates = () =>
      sent.filter((m): m is Extract<WebviewToHost, { kind: 'view.state' }> => m.kind === 'view.state')
    expect(viewStates().at(-1)).toMatchObject({ viewMode: 'reading' })
    // 组合结束：组合文本上屏，edit.request 照发且携带组合前版本（缓冲不推进）
    endComposition(c)
    commitCompositionText(c, 3, '中文')
    const req = sent.find((m) => m.kind === 'edit.request') as Extract<
      WebviewToHost,
      { kind: 'edit.request' }
    >
    expect(req.baseVersion).toBe(1)
    expect(req.changes).toEqual([{ offset: 3, length: 0, text: '中文' }])
    // flush：缓冲的外部增量照常应用（切换指令不清缓冲）
    await waitFlush()
    expect(c.getView()!.state.doc.toString()).toBe('Zabc中文def')
    // 切回实时预览（同一 CM6 实例）：文本原地保留
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    expect(viewStates().at(-1)).toMatchObject({ viewMode: 'live' })
    expect(c.getView()!.state.doc.toString()).toBe('Zabc中文def')
  })
})
