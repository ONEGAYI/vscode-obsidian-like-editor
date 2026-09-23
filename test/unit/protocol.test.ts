// 消息协议结构校验契约：宿主与 webview 两侧收到的每条消息都必须先通过
// isWebviewToHost / isHostToWebview 校验，非法消息整体丢弃（不抛错、不部分读取字段）。
import { describe, it, expect } from 'vitest'
import {
  isHostToWebview,
  isWebviewToHost,
  type SerChange,
} from '../../src/shared/protocol'

const validChange: SerChange = { offset: 3, length: 0, text: '中文' }

describe('isWebviewToHost', () => {
  it('接受合法 ready', () => {
    expect(isWebviewToHost({ kind: 'ready' })).toBe(true)
  })

  it('接受合法 edit.request', () => {
    expect(
      isWebviewToHost({
        kind: 'edit.request',
        sessionId: 's1',
        docUri: 'file:///a.md',
        seq: 1,
        baseVersion: 3,
        changes: [validChange],
      }),
    ).toBe(true)
  })

  it('接受合法 view.state', () => {
    expect(
      isWebviewToHost({
        kind: 'view.state',
        text: '# t',
        docLength: 4,
        lineCount: 1,
        renderedLines: 40,
      }),
    ).toBe(true)
  })

  it('接受空 changes 的 edit.request', () => {
    expect(
      isWebviewToHost({
        kind: 'edit.request',
        sessionId: 's1',
        docUri: 'file:///a.md',
        seq: 1,
        baseVersion: 1,
        changes: [],
      }),
    ).toBe(true)
  })

  it('接受合法 history.request（undo/redo）', () => {
    expect(isWebviewToHost({ kind: 'history.request', op: 'undo' })).toBe(true)
    expect(isWebviewToHost({ kind: 'history.request', op: 'redo' })).toBe(true)
  })

  it('拒绝非法 op 或缺字段的 history.request', () => {
    expect(isWebviewToHost({ kind: 'history.request' })).toBe(false)
    expect(isWebviewToHost({ kind: 'history.request', op: 'Undo' })).toBe(false)
    expect(isWebviewToHost({ kind: 'history.request', op: 'other' })).toBe(false)
    expect(isWebviewToHost({ kind: 'history.request', op: 1 })).toBe(false)
  })

  it('接受合法 sync.request', () => {
    expect(isWebviewToHost({ kind: 'sync.request' })).toBe(true)
  })

  it('接受合法 conflict.report，拒绝缺字段或类型错误', () => {
    const base = { kind: 'conflict.report', sessionId: 's1', docUri: 'file:///a.md', version: 3, text: '本地全文' }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, sessionId: 1 })).toBe(false)
    expect(isWebviewToHost({ ...base, docUri: null })).toBe(false)
    expect(isWebviewToHost({ ...base, version: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, text: 42 })).toBe(false)
    expect(isWebviewToHost({ kind: 'conflict.report', sessionId: 's1', docUri: 'u', version: 1 })).toBe(false)
  })

  it('接受合法 conflict.action，拒绝非法 action 或缺字段', () => {
    const base = { kind: 'conflict.action', sessionId: 's1', docUri: 'file:///a.md', action: 'copy' as const }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, action: 'resume' })).toBe(true)
    expect(isWebviewToHost({ ...base, action: 'other' })).toBe(false)
    expect(isWebviewToHost({ ...base, action: 1 })).toBe(false)
    expect(isWebviewToHost({ kind: 'conflict.action', sessionId: 's1', docUri: 'u' })).toBe(false)
  })

  it('view.state 的 suspended 为可选布尔', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    expect(isWebviewToHost({ ...base, suspended: true })).toBe(true)
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, suspended: 'yes' })).toBe(false)
  })

  it('拒绝 null、非对象与数组', () => {
    expect(isWebviewToHost(null)).toBe(false)
    expect(isWebviewToHost(undefined)).toBe(false)
    expect(isWebviewToHost('ready')).toBe(false)
    expect(isWebviewToHost(42)).toBe(false)
    expect(isWebviewToHost([{ kind: 'ready' }])).toBe(false)
  })

  it('拒绝缺 kind 与未知 kind', () => {
    expect(isWebviewToHost({})).toBe(false)
    expect(isWebviewToHost({ kind: 'unknown' })).toBe(false)
    expect(isWebviewToHost({ kind: 'init', version: 1, text: '' })).toBe(false)
  })

  it('拒绝字段缺失或类型错误的 edit.request', () => {
    const base = {
      kind: 'edit.request',
      sessionId: 's1',
      docUri: 'file:///a.md',
      seq: 1,
      baseVersion: 1,
      changes: [validChange],
    }
    expect(isWebviewToHost({ ...base, sessionId: 1 })).toBe(false)
    expect(isWebviewToHost({ ...base, docUri: null })).toBe(false)
    expect(isWebviewToHost({ ...base, seq: '1' })).toBe(false)
    expect(isWebviewToHost({ ...base, seq: 0 })).toBe(false) // seq 必须为正整数
    expect(isWebviewToHost({ ...base, seq: 1.5 })).toBe(false)
    expect(isWebviewToHost({ ...base, baseVersion: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, changes: 'x' })).toBe(false)
    expect(isWebviewToHost({ ...base, changes: [{}] })).toBe(false)
  })

  it('拒绝字段非法的 SerChange', () => {
    expect(isWebviewToHost({ kind: 'edit.request', sessionId: 's', docUri: 'u', seq: 1, baseVersion: 1, changes: [{ offset: -1, length: 0, text: '' }] })).toBe(false)
    expect(isWebviewToHost({ kind: 'edit.request', sessionId: 's', docUri: 'u', seq: 1, baseVersion: 1, changes: [{ offset: 1, length: -2, text: '' }] })).toBe(false)
    expect(isWebviewToHost({ kind: 'edit.request', sessionId: 's', docUri: 'u', seq: 1, baseVersion: 1, changes: [{ offset: 1, length: 0, text: 1 }] })).toBe(false)
    expect(isWebviewToHost({ kind: 'edit.request', sessionId: 's', docUri: 'u', seq: 1, baseVersion: 1, changes: [{ offset: 1, length: 0 }] })).toBe(false)
  })

  it('拒绝字段缺失的 view.state', () => {
    expect(isWebviewToHost({ kind: 'view.state', text: 'a' })).toBe(false)
    expect(
      isWebviewToHost({ kind: 'view.state', text: 'a', docLength: 1, lineCount: 1, renderedLines: 'x' }),
    ).toBe(false)
  })
})

describe('isHostToWebview', () => {
  it('接受合法 init', () => {
    expect(
      isHostToWebview({ kind: 'init', sessionId: 's1', docUri: 'file:///a.md', version: 2, text: '# 中文' }),
    ).toBe(true)
  })

  it('接受成功与失败的 edit.ack', () => {
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: true, version: 4 })).toBe(true)
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: false, reason: 'conflict', version: 4, text: '全文' })).toBe(true)
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: false, reason: 'error', version: 4 })).toBe(true)
  })

  it('拒绝已废除的 stale reason 与非法 conflict 字段', () => {
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: false, reason: 'stale', version: 4, text: '全文' })).toBe(false)
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: false, reason: 'conflict', version: -1 })).toBe(false)
  })

  it('接受合法 session.suspended，拒绝非法 reason 或缺字段', () => {
    expect(isHostToWebview({ kind: 'session.suspended', version: 4, reason: 'conflict' })).toBe(true)
    expect(isHostToWebview({ kind: 'session.suspended', version: 4, reason: 'host-error' })).toBe(true)
    expect(isHostToWebview({ kind: 'session.suspended', version: 4, reason: 'other' })).toBe(false)
    expect(isHostToWebview({ kind: 'session.suspended', reason: 'conflict' })).toBe(false)
    expect(isHostToWebview({ kind: 'session.suspended', version: '4', reason: 'conflict' })).toBe(false)
  })

  it('拒绝未知 reason 的失败 ack', () => {
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: false, reason: 'other', version: 4 })).toBe(false)
  })

  it('拒绝 ok 布尔值缺失或字段类型错误', () => {
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, version: 4 })).toBe(false)
    expect(isHostToWebview({ kind: 'edit.ack', seq: 1, ok: 'yes', version: 4 })).toBe(false)
    expect(isHostToWebview({ kind: 'init', sessionId: 's', docUri: 'u', version: '2', text: '' })).toBe(false)
  })

  it('接受合法 doc.changed 与 view.state.request', () => {
    expect(
      isHostToWebview({ kind: 'doc.changed', version: 5, changes: [validChange], origin: 'external' }),
    ).toBe(true)
    expect(isHostToWebview({ kind: 'view.state.request' })).toBe(true)
  })

  it('拒绝 changes 非法的 doc.changed 与未知 origin', () => {
    expect(isHostToWebview({ kind: 'doc.changed', version: 5, changes: null, origin: 'external' })).toBe(false)
    expect(isHostToWebview({ kind: 'doc.changed', version: 5, changes: [], origin: 'other' })).toBe(false)
  })

  it('接受合法 doc.resync，拒绝缺失或非法字段', () => {
    expect(isHostToWebview({ kind: 'doc.resync', version: 7, text: '权威全文' })).toBe(true)
    expect(isHostToWebview({ kind: 'doc.resync', version: 7 })).toBe(false)
    expect(isHostToWebview({ kind: 'doc.resync', version: -1, text: 'x' })).toBe(false)
    expect(isHostToWebview({ kind: 'doc.resync', version: 1.5, text: 'x' })).toBe(false)
    expect(isHostToWebview({ kind: 'doc.resync', version: 7, text: 42 })).toBe(false)
  })

  it('拒绝 null、非对象与 webview 方向的消息', () => {
    expect(isHostToWebview(null)).toBe(false)
    expect(isHostToWebview({ kind: 'ready' })).toBe(false)
    expect(isHostToWebview({ kind: 'edit.request', sessionId: 's', docUri: 'u', seq: 1, baseVersion: 1, changes: [] })).toBe(false)
  })
})


describe('perf 探针协议（#5）', () => {
  const validReport = {
    kind: 'perf.report',
    typingRounds: 30,
    scrollRounds: 10,
    docLines: 1000,
    baseline: { renderedLines: 60, contentDomCount: 500, headingLineCount: 3, inviewHeadingCount: 3 },
    afterTyping: { renderedLines: 60, contentDomCount: 501, headingLineCount: 3, inviewHeadingCount: 3 },
    afterScroll: { renderedLines: 61, contentDomCount: 505, headingLineCount: 3, inviewHeadingCount: 3 },
    inputDelayMs: { samples: [4, 5, 6], avgMs: 5, maxMs: 6 },
    longTasks: { count: 0, maxMs: 0, totalMs: 0 },
    headingStats: { totalUpdates: 31, lastUpdateScannedLines: 1, fullBuildLines: 1000 },
  }

  it('接受合法 perf.probe', () => {
    expect(isHostToWebview({ kind: 'perf.probe', typingRounds: 30, scrollRounds: 10 })).toBe(true)
  })

  it('拒绝缺字段或非正整数的 perf.probe', () => {
    expect(isHostToWebview({ kind: 'perf.probe', typingRounds: 0, scrollRounds: 10 })).toBe(false)
    expect(isHostToWebview({ kind: 'perf.probe', typingRounds: 30 })).toBe(false)
    expect(isHostToWebview({ kind: 'perf.probe' })).toBe(false)
  })

  it('接受合法 perf.report', () => {
    expect(isWebviewToHost(validReport)).toBe(true)
  })

  it('接受 longTasks 为 null 的 perf.report（宿主不支持 longtask 观测）', () => {
    expect(isWebviewToHost({ ...validReport, longTasks: null })).toBe(true)
  })

  it('拒绝缺快照或字段非法的 perf.report', () => {
    const { baseline: _baseline, ...noBaseline } = validReport
    expect(isWebviewToHost(noBaseline)).toBe(false)
    expect(isWebviewToHost({ ...validReport, inputDelayMs: { samples: 'x', avgMs: 1, maxMs: 1 } })).toBe(false)
    expect(isWebviewToHost({ ...validReport, docLines: '1000' })).toBe(false)
  })

  it('view.state 接受新增装饰诊断可选字段，拒绝类型错误', () => {
    expect(
      isWebviewToHost({
        kind: 'view.state',
        text: '# t',
        docLength: 4,
        lineCount: 1,
        renderedLines: 40,
        contentDomCount: 300,
        headingLineCount: 1,
        headingActiveText: '# t',
        headingHiddenText: '二级',
      }),
    ).toBe(true)
    expect(
      isWebviewToHost({
        kind: 'view.state',
        text: '# t',
        docLength: 4,
        lineCount: 1,
        renderedLines: 40,
        contentDomCount: '300',
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        kind: 'view.state',
        text: '# t',
        docLength: 4,
        lineCount: 1,
        renderedLines: 40,
        headingActiveText: 42,
      }),
    ).toBe(false)
  })
})
