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

  it('接受全部合法 table.command 操作码，拒绝未知操作码与缺字段（#13）', () => {
    for (const op of [
      'insertRowAbove',
      'insertRowBelow',
      'deleteRow',
      'insertColumnLeft',
      'insertColumnRight',
      'deleteColumn',
    ]) {
      expect(isHostToWebview({ kind: 'table.command', op })).toBe(true)
    }
    expect(isHostToWebview({ kind: 'table.command', op: 'mergeCells' })).toBe(false)
    expect(isHostToWebview({ kind: 'table.command' })).toBe(false)
    expect(isHostToWebview({ kind: 'table.command', op: 1 })).toBe(false)
  })

  it('接受合法 table.test.key，拒绝未知键名（#13 测试钩子）', () => {
    expect(isHostToWebview({ kind: 'table.test.key', key: 'tab' })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.key', key: 'shift-tab' })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.key', key: 'enter' })).toBe(false)
    expect(isHostToWebview({ kind: 'table.test.key' })).toBe(false)
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

describe('模式切换协议（#6）', () => {
  const baseViewState = {
    kind: 'view.state' as const,
    text: '# t\n正文',
    docLength: 5,
    lineCount: 2,
    renderedLines: 2,
  }

  it('接受合法 view.mode.set（live/reading/toggle）', () => {
    expect(isHostToWebview({ kind: 'view.mode.set', mode: 'live' })).toBe(true)
    expect(isHostToWebview({ kind: 'view.mode.set', mode: 'reading' })).toBe(true)
    expect(isHostToWebview({ kind: 'view.mode.set', mode: 'toggle' })).toBe(true)
  })

  it('拒绝非法 mode、缺字段与方向颠倒', () => {
    expect(isHostToWebview({ kind: 'view.mode.set', mode: 'preview' })).toBe(false)
    expect(isHostToWebview({ kind: 'view.mode.set', mode: 1 })).toBe(false)
    expect(isHostToWebview({ kind: 'view.mode.set' })).toBe(false)
    // view.mode.set 是宿主方向：不得经 webview → 宿主校验
    expect(isWebviewToHost({ kind: 'view.mode.set', mode: 'toggle' })).toBe(false)
  })

  it('接受合法 view.locate，拒绝负数/非整数/缺字段', () => {
    expect(isHostToWebview({ kind: 'view.locate', offset: 12 })).toBe(true)
    expect(isHostToWebview({ kind: 'view.locate', offset: 0 })).toBe(true)
    expect(isHostToWebview({ kind: 'view.locate', offset: -1 })).toBe(false)
    expect(isHostToWebview({ kind: 'view.locate', offset: 1.5 })).toBe(false)
    expect(isHostToWebview({ kind: 'view.locate', offset: '12' })).toBe(false)
    expect(isHostToWebview({ kind: 'view.locate' })).toBe(false)
  })

  it('view.state 接受模式诊断可选字段，拒绝类型错误', () => {
    expect(
      isWebviewToHost({ ...baseViewState, viewMode: 'reading', selectionOffset: 3, readingBlockCount: 5, readingAnchorStart: 0 }),
    ).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, viewMode: 'preview' })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, viewMode: 1 })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, selectionOffset: -1 })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, selectionOffset: '3' })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, readingBlockCount: 1.5 })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, readingAnchorStart: null })).toBe(false)
  })

  it('view.state 接受合法 cssProbe（字段可为 null），拒绝结构错误', () => {
    const probe = {
      liveHeadingDecorationColor: 'rgb(1, 2, 3)',
      readingHeadingDecorationColor: null,
      readingVarProbe: 'contract-ok',
      liveStrongDecorationColor: null,
      liveInlineCodeDecorationColor: 'rgb(7, 8, 9)',
      liveCodeLineDecorationColor: null,
      readingStrongDecorationColor: 'rgb(10, 11, 12)',
      liveTaskCheckboxDecorationColor: null,
      readingTaskCheckboxDecorationColor: 'rgb(19, 20, 21)',
      // #10 链接/图片探针字段
      liveLinkDecorationColor: 'rgb(19, 20, 21)',
      readingLinkDecorationColor: null,
      readingImageDecorationColor: 'rgb(25, 26, 27)',
      // #12 表格探针字段
      liveTablePipeDecorationColor: 'rgb(19, 20, 21)',
      readingTableDecorationColor: null,
      // #11 双链探针字段
      liveWikilinkDecorationColor: 'rgb(28, 29, 30)',
      readingWikilinkDecorationColor: null,
    }
    expect(isWebviewToHost({ ...baseViewState, cssProbe: probe })).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, readingVarProbe: 42 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, liveStrongDecorationColor: 7 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, liveLinkDecorationColor: 3 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, readingImageDecorationColor: [] } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, liveTablePipeDecorationColor: 9 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, liveWikilinkDecorationColor: 9 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: { liveHeadingDecorationColor: 'x' } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: null })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, cssProbe: 'x' })).toBe(false)
  })

  it('view.state 接受 #8 语法统计探针（liveSyntax/readingSyntax），拒绝结构错误', () => {
    const live = {
      headingLines: 2,
      headerSpans: 2,
      strongSpans: 1,
      emphasisSpans: 1,
      inlineCodeSpans: 1,
      quoteLines: 2,
      codeLines: 3,
      listLines: 3,
      hrLines: 1,
      frontmatterLines: 0,
      taskGlyphs: 2,
      taskChecked: 1,
      tableLines: 4,
      tableCells: 6,
    }
    const reading = {
      headings: 2,
      strongCount: 1,
      emphasisCount: 1,
      inlineCodeCount: 1,
      blockquoteBlocks: 1,
      codeBlocks: 1,
      hrCount: 1,
      listItems: 3,
      taskCheckboxes: 2,
      taskChecked: 1,
      tables: 1,
    }
    expect(isWebviewToHost({ ...baseViewState, liveSyntax: live, readingSyntax: reading })).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, liveSyntax: { ...live, strongSpans: -1 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, liveSyntax: { ...live, taskGlyphs: '2' } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, liveSyntax: { ...live, tableCells: -1 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, readingSyntax: { ...reading, tables: '1' } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, readingSyntax: { ...reading, headings: 1.5 } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, liveSyntax: null })).toBe(false)
  })
})

describe('阅读视图按需挂载协议（#7）', () => {
  const baseViewState = {
    kind: 'view.state' as const,
    text: '# t\n正文',
    docLength: 5,
    lineCount: 2,
    renderedLines: 2,
  }
  const emptySnapshot = { mountedBlocks: 0, contentDomCount: 0, scrollTopPx: 0, scrollHeightPx: 0 }
  const validSnapshot = { mountedBlocks: 28, contentDomCount: 30, scrollTopPx: 1200.5, scrollHeightPx: 3700.25 }

  it('接受合法 reading.perf，拒绝非正整数轮数', () => {
    expect(isHostToWebview({ kind: 'reading.perf', scrollRounds: 10 })).toBe(true)
    expect(isHostToWebview({ kind: 'reading.perf', scrollRounds: 0 })).toBe(false)
    expect(isHostToWebview({ kind: 'reading.perf', scrollRounds: 1.5 })).toBe(false)
    expect(isHostToWebview({ kind: 'reading.perf' })).toBe(false)
  })

  it('接受合法 reading.test.image，拒绝负数/缺字段', () => {
    expect(
      isHostToWebview({ kind: 'reading.test.image', srcStart: 12, initialHeightPx: 20, finalHeightPx: 240, delayMs: 300 }),
    ).toBe(true)
    expect(
      isHostToWebview({ kind: 'reading.test.image', srcStart: -1, initialHeightPx: 20, finalHeightPx: 240, delayMs: 300 }),
    ).toBe(false)
    expect(isHostToWebview({ kind: 'reading.test.image', srcStart: 12 })).toBe(false)
  })

  it('接受合法 reading.perf.report（px 允许小数），拒绝结构错误', () => {
    const report = {
      kind: 'reading.perf.report' as const,
      scrollRounds: 10,
      totalBlocks: 1000,
      baseline: validSnapshot,
      afterScroll: validSnapshot,
      parseCount: 1,
      maxMountedBlocks: 46,
      ok: true,
    }
    expect(isWebviewToHost(report)).toBe(true)
    // 滚动位置为亚像素小数是常态：不得因此丢弃整条回报
    expect(isWebviewToHost({ ...report, afterScroll: { ...validSnapshot, scrollTopPx: 1234.75 } })).toBe(true)
    expect(isWebviewToHost({ ...report, parseCount: -1 })).toBe(false)
    expect(isWebviewToHost({ ...report, ok: 'yes' })).toBe(false)
    expect(isWebviewToHost({ ...report, baseline: emptySnapshot, afterScroll: { ...emptySnapshot, mountedBlocks: 1.5 } })).toBe(false)
    // 失败态报告（非 reading 模式）合法
    expect(
      isWebviewToHost({
        kind: 'reading.perf.report',
        scrollRounds: 10,
        totalBlocks: 0,
        baseline: emptySnapshot,
        afterScroll: emptySnapshot,
        parseCount: 0,
        maxMountedBlocks: 0,
        ok: false,
      }),
    ).toBe(true)
  })

  it('view.state 接受 #7 挂载观测可选字段，拒绝类型错误', () => {
    expect(
      isWebviewToHost({
        ...baseViewState,
        viewMode: 'reading',
        readingTotalBlocks: 1000,
        readingMountedBlocks: 46,
        readingContentDomCount: 48,
        readingParseCount: 1,
        readingVirtualized: true,
        readingAnchorTopPx: 1200.5,
        readingScrollTopPx: 1188.25,
        readingScrollHeightPx: 36000,
      }),
    ).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, readingTotalBlocks: 1.5 })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, readingVirtualized: 'yes' })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, readingParseCount: -1 })).toBe(false)
    // px 观测允许小数（亚像素滚动）
    expect(isWebviewToHost({ ...baseViewState, readingScrollTopPx: 12.5 })).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, readingScrollTopPx: -0.1 })).toBe(false)
  })

  it('方向校验：reading.perf 系宿主方向、report 系 webview 方向，互不接受', () => {
    expect(isWebviewToHost({ kind: 'reading.perf', scrollRounds: 10 })).toBe(false)
    expect(isHostToWebview({ kind: 'reading.perf.report', scrollRounds: 10, totalBlocks: 0, baseline: emptySnapshot, afterScroll: emptySnapshot, parseCount: 0, maxMountedBlocks: 0, ok: true })).toBe(false)
  })
})

describe('任务勾选协议（#9）', () => {
  const baseViewState = {
    kind: 'view.state' as const,
    text: '- [ ] 任务',
    docLength: 7,
    lineCount: 1,
    renderedLines: 1,
  }

  it('接受合法 task.test.click（宿主 → webview 测试钩子）', () => {
    expect(isHostToWebview({ kind: 'task.test.click', view: 'live', index: 0 })).toBe(true)
    expect(isHostToWebview({ kind: 'task.test.click', view: 'reading', index: 3 })).toBe(true)
  })

  it('拒绝非法 view / 负数或非整数 index 与 webview 方向伪造', () => {
    expect(isHostToWebview({ kind: 'task.test.click', view: 'preview', index: 0 })).toBe(false)
    expect(isHostToWebview({ kind: 'task.test.click', view: 'live', index: -1 })).toBe(false)
    expect(isHostToWebview({ kind: 'task.test.click', view: 'live', index: 1.5 })).toBe(false)
    expect(isHostToWebview({ kind: 'task.test.click', view: 'live' })).toBe(false)
    expect(isWebviewToHost({ kind: 'task.test.click', view: 'live', index: 0 })).toBe(false)
  })

  it('cssProbe 接受任务勾选新探针字段（可为 null），拒绝类型错误', () => {
    const probe = {
      liveHeadingDecorationColor: null,
      readingHeadingDecorationColor: null,
      readingVarProbe: null,
      liveStrongDecorationColor: null,
      liveInlineCodeDecorationColor: null,
      liveCodeLineDecorationColor: null,
      readingStrongDecorationColor: null,
      liveTaskCheckboxDecorationColor: 'rgb(19, 20, 21)',
      readingTaskCheckboxDecorationColor: null,
      liveLinkDecorationColor: null,
      readingLinkDecorationColor: null,
      readingImageDecorationColor: null,
      liveTablePipeDecorationColor: null,
      readingTableDecorationColor: null,
      liveWikilinkDecorationColor: null,
      readingWikilinkDecorationColor: null,
    }
    expect(isWebviewToHost({ ...baseViewState, cssProbe: probe })).toBe(true)
    expect(
      isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, liveTaskCheckboxDecorationColor: 19 } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, readingTaskCheckboxDecorationColor: 'x' } }),
    ).toBe(true) // 字符串颜色值本身合法
    expect(
      isWebviewToHost({ ...baseViewState, cssProbe: { ...probe, readingTaskCheckboxDecorationColor: undefined } }),
    ).toBe(false) // 缺字段（undefined 违反 isNullOrString）
  })
})
