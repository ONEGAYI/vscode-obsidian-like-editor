// @vitest-environment jsdom
// webview 同步控制器契约：CM6 EditorView 与宿主消息的桥接。
// - mount 后发 ready；init 后装载全文
// - 本地用户事务 → edit.request（seq 递增、baseVersion 为最近权威版本）
// - 外部 doc.changed → 单事务应用且不再回发 edit.request（防回环）
// - edit.ack ok 推进 baseVersion；fail 附全文时重置文档
// - seq 经 bridge.setState 持久化，webview 重载后继续编号（宿主按 seq 去重）
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { HostToWebview, WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/a.md'

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
  return { bridge, sent, getSavedState: () => state }
}

function mount(bridge: VsCodeBridge): WebviewSyncController {
  const controller = new WebviewSyncController(bridge)
  controller.mount(document.createElement('div'))
  return controller
}

function init(c: WebviewSyncController, text = '# 你好\n世界', version = 1, sessionId = 's1') {
  c.handleHostMessage({ kind: 'init', sessionId, docUri: DOC_URI, version, text })
}

describe('ready 握手与 init', () => {
  it('mount 后发送 ready，此时不发送其他消息', () => {
    const { bridge, sent } = makeBridge()
    mount(bridge)
    expect(sent).toEqual([{ kind: 'ready' }])
  })

  it('init 后 CM6 装载全文（UTF-16 坐标，含中文与换行）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '# 标题\n正文\r\nCRLF 行')
    expect(c.getView()!.state.doc.toString()).toBe('# 标题\n正文\r\nCRLF 行')
  })
})

describe('本地编辑 → edit.request', () => {
  it('本地插入产生精确的 edit.request，seq 从 1 开始', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 3)
    const view = c.getView()!
    view.dispatch({ changes: { from: 3, insert: '中文' } })
    expect(sent.at(-1)).toEqual({
      kind: 'edit.request',
      sessionId: 's1',
      docUri: DOC_URI,
      seq: 1,
      baseVersion: 3,
      changes: [{ offset: 3, length: 0, text: '中文' }],
    })
  })

  it('替换与删除都以 offset/length 描述', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    const view = c.getView()!
    view.dispatch({ changes: { from: 1, to: 3, insert: 'X' } })
    expect(sent.at(-1)!.kind).toBe('edit.request')
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.changes).toEqual([{ offset: 1, length: 2, text: 'X' }])

    view.dispatch({ changes: { from: 0, to: 1 } })
    const req2 = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req2.changes).toEqual([{ offset: 0, length: 1, text: '' }])
    expect(req2.seq).toBe(2)
  })

  it('一个事务包含多个变更时合并为一条消息', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '0123456789', 1)
    c.getView()!.dispatch({
      changes: [
        { from: 0, to: 1, insert: '甲' },
        { from: 5, to: 6, insert: '乙' },
      ],
    })
    expect(sent).toHaveLength(2) // ready + 一条 edit.request
    const req = sent[1] as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.changes).toEqual([
      { offset: 0, length: 1, text: '甲' },
      { offset: 5, length: 1, text: '乙' },
    ])
  })

  it('ack 成功后 baseVersion 推进', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    const view = c.getView()!
    view.dispatch({ changes: { from: 3, insert: 'x' } })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    view.dispatch({ changes: { from: 3, insert: 'y' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.baseVersion).toBe(2)
  })

  it('连续输入不等 ack：两条请求 baseVersion 相同、seq 递增', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    const view = c.getView()!
    view.dispatch({ changes: { from: 0, insert: '一' } })
    view.dispatch({ changes: { from: 4, insert: '二' } })
    const reqs = sent.filter((m) => m.kind === 'edit.request')
    expect(reqs).toHaveLength(2)
    expect((reqs[0] as { seq: number }).seq).toBe(1)
    expect((reqs[1] as { seq: number }).seq).toBe(2)
    expect((reqs[1] as { baseVersion: number }).baseVersion).toBe(1)
  })
})

describe('外部变更与重同步', () => {
  it('doc.changed 单事务应用且不回发 edit.request（防回环）', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abcdef', 1)
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [
        { offset: 0, length: 1, text: '首' },
        { offset: 5, length: 1, text: '尾' },
      ],
    })
    expect(c.getView()!.state.doc.toString()).toBe('首bcde尾')
    const requests = sent.filter((m) => m.kind === 'edit.request')
    expect(requests).toHaveLength(0)
  })

  it('doc.changed 后 baseVersion 更新，后续本地编辑携带新版本', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    c.handleHostMessage({ kind: 'doc.changed', version: 5, origin: 'external', changes: [] })
    c.getView()!.dispatch({ changes: { from: 0, insert: 'x' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.baseVersion).toBe(5)
  })

  it('ack 失败携带全文时重置文档为宿主文本', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '本地草稿', 1)
    c.getView()!.dispatch({ changes: { from: 4, insert: '更多' } })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: false, reason: 'stale', version: 9, text: '权威文本' })
    expect(c.getView()!.state.doc.toString()).toBe('权威文本')
  })

  it('非法宿主消息被忽略且不抛错', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    expect(() => {
      c.handleHostMessage('垃圾')
      c.handleHostMessage({ kind: '未知' })
      c.handleHostMessage(null)
    }).not.toThrow()
    expect(c.getView()!.state.doc.toString()).toBe('abc')
  })
})

describe('seq 持久化', () => {
  it('每次发送后通过 setState 保存 seq', () => {
    const { bridge, getSavedState } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc', 1)
    c.getView()!.dispatch({ changes: { from: 0, insert: 'x' } })
    expect(getSavedState()).toMatchObject({ seq: 1 })
  })

  it('webview 重载后（同 state 恢复）seq 继续编号', () => {
    const { bridge, getSavedState } = makeBridge()
    const first = mount(bridge)
    init(first, 'abc', 1)
    first.getView()!.dispatch({ changes: { from: 0, insert: 'x' } })
    const saved = getSavedState()

    // 模拟重载：新 bridge 恢复同一 state
    const sent2: WebviewToHost[] = []
    let state2 = saved
    const bridge2: VsCodeBridge = {
      postMessage: (m) => sent2.push(m as WebviewToHost),
      getState: <T,>() => state2 as T | undefined,
      setState: (s) => {
        state2 = s as Record<string, unknown>
      },
    }
    const second = mount(bridge2)
    init(second, 'abc', 1)
    second.getView()!.dispatch({ changes: { from: 0, insert: 'y' } })
    const req = sent2.find((m) => m.kind === 'edit.request') as { seq: number }
    expect(req.seq).toBe(2)
  })
})

describe('view.state 诊断', () => {
  it('收到请求后回报文本与统计', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '# 标题\n正文', 1)
    c.handleHostMessage({ kind: 'view.state.request' })
    const msg = sent.find((m) => m.kind === 'view.state') as Extract<WebviewToHost, { kind: 'view.state' }>
    expect(msg.text).toBe('# 标题\n正文')
    expect(msg.docLength).toBe('# 标题\n正文'.length)
    expect(msg.lineCount).toBe(2)
    expect(Number.isInteger(msg.renderedLines)).toBe(true)
  })
})
