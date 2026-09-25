// 消息协议结构校验契约：宿主与 webview 两侧收到的每条消息都必须先通过
// isWebviewToHost / isHostToWebview 校验，非法消息整体丢弃（不抛错、不部分读取字段）。
import { describe, it, expect } from 'vitest'
import {
  isHostToWebview,
  isWebviewToHost,
  type SerChange,
} from '../../src/shared/protocol'

const validChange: SerChange = { offset: 3, length: 0, text: '中文' }

it('DOM 组合测试钩子只接受明确阶段和字符串候选', () => {
  for (const phase of ['start', 'update', 'end']) {
    expect(isHostToWebview({ kind: 'sync.test.composition', phase, text: '中文' })).toBe(true)
  }
  expect(isHostToWebview({ kind: 'sync.test.composition', phase: 'unknown', text: '中文' })).toBe(false)
  expect(isHostToWebview({ kind: 'sync.test.composition', phase: 'update', text: null })).toBe(false)
})

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

  it('接受携带未知扩展字段的 view.state（前向兼容）', () => {
    // 校验器只校验已知字段、不拒绝未知字段——这是新观测面可以先行上车、
    // 协议后补正式字段的扩展前提（#32 的 typography 即经此通道先行后于
    // #34 正式入协议）。本用例固化该前向兼容契约，防止未来收紧时静默破坏。
    expect(
      isWebviewToHost({
        kind: 'view.state',
        text: '# t',
        docLength: 4,
        lineCount: 1,
        renderedLines: 40,
        futureExtension: { any: ['payload', 1] },
      }),
    ).toBe(true)
  })

  it('view.state 的 typography 观测（#32）：合法样本接受、字段非法拒绝', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    const validTypography = {
      live: { fontFamily: 'monospace', fontSizePx: 14, lineHeightPx: 19.6, textInsetPx: 24 },
      reading: null,
      liveList: { fontFamily: 'monospace', fontSizePx: 14 },
      readingList: null,
      liveQuote: { fontFamily: 'monospace', fontSizePx: null },
      readingQuote: null,
      liveTable: null,
      readingTable: { fontFamily: null, fontSizePx: null },
    }
    // 合法：八个采样位均可为 null；样本数值非负（亚像素小数常态）
    expect(isWebviewToHost({ ...base, typography: validTypography })).toBe(true)
    expect(
      isWebviewToHost({
        ...base,
        typography: {
          live: null, reading: null, liveList: null, readingList: null,
          liveQuote: null, readingQuote: null, liveTable: null, readingTable: null,
        },
      }),
    ).toBe(true)
    // 非法：fontSizePx 负数 / fontFamily 非字符串非 null / textInsetPx 非数
    expect(
      isWebviewToHost({ ...base, typography: { ...validTypography, live: { ...validTypography.live!, fontSizePx: -1 } } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, typography: { ...validTypography, live: { ...validTypography.live!, fontFamily: 14 } } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, typography: { ...validTypography, live: { ...validTypography.live!, textInsetPx: '24' } } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, typography: { ...validTypography, liveList: { fontFamily: 'x', fontSizePx: 1.5 } } }),
    ).toBe(true) // 继承样本字号允许小数
    expect(isWebviewToHost({ ...base, typography: { ...validTypography, liveTable: 42 } })).toBe(false)
    expect(isWebviewToHost({ ...base, typography: null })).toBe(false)
    // 缺省合法（向后兼容：#32 之前的旧 webview 不回报该字段）
    expect(isWebviewToHost(base)).toBe(true)
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
    const base = { kind: 'conflict.report', sessionId: 's1', docUri: 'file:///a.md', version: 3, revision: 1, text: '本地全文' }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, compositionPending: true })).toBe(true)
    expect(isWebviewToHost({ ...base, compositionPending: false })).toBe(true)
    expect(isWebviewToHost({ ...base, compositionPending: 'yes' })).toBe(false)
    expect(isWebviewToHost({ ...base, sessionId: 1 })).toBe(false)
    expect(isWebviewToHost({ ...base, docUri: null })).toBe(false)
    expect(isWebviewToHost({ ...base, version: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, revision: 0 })).toBe(false)
    expect(isWebviewToHost({ ...base, text: 42 })).toBe(false)
    expect(isWebviewToHost({ kind: 'conflict.report', sessionId: 's1', docUri: 'u', version: 1 })).toBe(false)
  })

  it('组合候选增量须含合法序号和源坐标变更', () => {
    const base = { kind: 'composition.changed', sessionId: 's1', docUri: 'file:///a.md',
      revision: 2, changes: [{ offset: 3, length: 1, text: '你' }] }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, revision: 0 })).toBe(false)
    expect(isWebviewToHost({ ...base, changes: [{ offset: -1, length: 0, text: '你' }] })).toBe(false)
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

  it('view.state 的 lineGutter 观测（#34）：合法样本接受、字段非法拒绝', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    // 合法：on 布尔、count 非负整数、first/last 字符串或 null
    expect(
      isWebviewToHost({
        ...base,
        lineGutter: { on: true, count: 12, first: '1', last: '12' },
      }),
    ).toBe(true)
    expect(
      isWebviewToHost({
        ...base,
        lineGutter: { on: false, count: 0, first: null, last: null },
      }),
    ).toBe(true)
    // 非法：on 非布尔 / count 负数或小数 / first 非字符串非 null
    expect(isWebviewToHost({ ...base, lineGutter: { on: 1, count: 1, first: null, last: null } })).toBe(false)
    expect(isWebviewToHost({ ...base, lineGutter: { on: true, count: -1, first: null, last: null } })).toBe(false)
    expect(isWebviewToHost({ ...base, lineGutter: { on: true, count: 1.5, first: null, last: null } })).toBe(false)
    expect(isWebviewToHost({ ...base, lineGutter: { on: true, count: 1, first: 3, last: null } })).toBe(false)
    // 缺省合法（向后兼容：行号扩展未装配的旧 webview）
    expect(isWebviewToHost(base)).toBe(true)
  })

  it('view.state 的 paint 观测（P0 回归）：合法样本接受、字段非法拒绝', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    // 合法：textVisible/darkTheme 布尔；display/userSelect/caretColor 字符串或 null
    expect(
      isWebviewToHost({
        ...base,
        paint: {
          textVisible: true,
          scrollerDisplay: 'flex',
          gutterUserSelect: 'none',
          darkTheme: true,
          caretColor: 'rgb(255, 255, 255)',
        },
      }),
    ).toBe(true)
    expect(
      isWebviewToHost({
        ...base,
        paint: {
          textVisible: false,
          scrollerDisplay: null,
          gutterUserSelect: null,
          darkTheme: false,
          caretColor: null,
        },
      }),
    ).toBe(true)
    // 非法：textVisible 非布尔 / scrollerDisplay 非字符串非 null / darkTheme 非布尔 / caretColor 非字符串非 null
    expect(
      isWebviewToHost({ ...base, paint: { textVisible: 1, scrollerDisplay: 'flex', gutterUserSelect: 'none', darkTheme: false, caretColor: null } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, paint: { textVisible: true, scrollerDisplay: 3, gutterUserSelect: 'none', darkTheme: false, caretColor: null } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, paint: { textVisible: true, scrollerDisplay: 'flex', gutterUserSelect: [], darkTheme: false, caretColor: null } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, paint: { textVisible: true, scrollerDisplay: 'flex', gutterUserSelect: 'none', darkTheme: 'dark', caretColor: null } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, paint: { textVisible: true, scrollerDisplay: 'flex', gutterUserSelect: 'none', darkTheme: false, caretColor: 0 } }),
    ).toBe(false)
    // 缺省合法（向后兼容：探针未装配的旧 webview）
    expect(isWebviewToHost(base)).toBe(true)
  })

  it('view.state 的 sidebar 观测（#53）：合法样本接受、字段非法拒绝', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    // 合法：open 布尔；绘制命中布尔；线宽/名称字符串或 null；宽度非负数或 null
    expect(
      isWebviewToHost({
        ...base,
        sidebar: {
          open: true,
          sidebarToolbarPainted: true,
          togglePainted: true,
          settingsPainted: true,
          toggleBarStrokeWidth: '3px',
          toggleFrameStrokeWidth: '1.5px',
          mainWidthPx: 620,
          sidebarWidthPx: 280,
          toggleAriaLabel: '收起右侧栏',
          settingsAriaLabel: '打开 Vsidian 设置',
        },
      }),
    ).toBe(true)
    expect(
      isWebviewToHost({
        ...base,
        sidebar: {
          open: false,
          sidebarToolbarPainted: false,
          togglePainted: false,
          settingsPainted: false,
          toggleBarStrokeWidth: null,
          toggleFrameStrokeWidth: null,
          mainWidthPx: null,
          sidebarWidthPx: null,
          toggleAriaLabel: null,
          settingsAriaLabel: null,
        },
      }),
    ).toBe(true)
    // 非法：open 非布尔 / 命中字段非布尔 / 线宽非字符串非 null / 宽度负数
    expect(isWebviewToHost({ ...base, sidebar: { open: 1 } })).toBe(false)
    expect(
      isWebviewToHost({ ...base, sidebar: { open: true, togglePainted: 'yes' } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, sidebar: { open: true, toggleBarStrokeWidth: 3 } }),
    ).toBe(false)
    expect(
      isWebviewToHost({ ...base, sidebar: { open: true, mainWidthPx: -5 } }),
    ).toBe(false)
    // 缺省合法（向后兼容：侧栏观测未装配的旧 webview）
    expect(isWebviewToHost(base)).toBe(true)
  })

  it('sidebar.test.click 测试钩子消息校验（#53）', () => {
    expect(isHostToWebview({ kind: 'sidebar.test.click' })).toBe(true)
    expect(isHostToWebview({ kind: 'sidebar.test.click', extra: 1 })).toBe(true)
    expect(isHostToWebview({ kind: 'sidebar.test.clickx' })).toBe(false)
  })

  it('view.state 的 outline 观测（#54/#65）：合法样本接受、字段非法拒绝', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    // 合法：active 布尔；绘制命中布尔；图标尺寸与滚动几何 null 或非负数
    // （jsdom 无布局时 null）；items 每项 level 1-6 整数 + 字符串文字 +
    // plainText（#65 剥标记可见文本）+ 白名单标记区间数组 + 非负行号；
    // 名称字符串或 null；style（#65 绘制证据）缺省或字段全为字符串或 null
    expect(
      isWebviewToHost({
        ...base,
        outline: {
          active: true,
          togglePainted: true,
          panelPainted: true,
          toggleIconSizePx: 16,
          panelScrollHeightPx: 1328,
          panelClientHeightPx: 570,
          items: [
            { level: 1, text: '**重点** 结论', plainText: '重点 结论', line: 1,
              spans: [{ kind: 'strong', start: 0, end: 2 }] },
            { level: 2, text: '', plainText: '', line: 5, spans: [] },
          ],
          toggleAriaLabel: '大纲',
          panelAriaLabel: '大纲',
          style: {
            itemFontWeight: '400',
            strongFontWeight: '700',
            codeFontFamily: 'monospace',
            itemFontFamily: 'sans-serif',
            itemColor: 'rgb(204, 204, 204)',
            headingColor: 'rgb(204, 204, 204)',
          },
          locatedItemIndex: 1,
          locatedText: '',
          locatedPainted: true,
          // #67 折叠观测（必填：probe 形态演进，旧样本同步补齐）
          expandLevel: 5,
          visibleIndices: [0, 1],
          sliderPainted: true,
          sliderActiveDotPainted: true,
          chevronPainted: true,
        },
      }),
    ).toBe(true)
    expect(
      isWebviewToHost({
        ...base,
        outline: {
          active: false,
          togglePainted: false,
          panelPainted: false,
          toggleIconSizePx: null,
          panelScrollHeightPx: null,
          panelClientHeightPx: null,
          items: [],
          toggleAriaLabel: null,
          panelAriaLabel: null,
          locatedItemIndex: null,
          locatedText: null,
          locatedPainted: false,
          expandLevel: 0,
          visibleIndices: [],
          sliderPainted: false,
          sliderActiveDotPainted: false,
          chevronPainted: false,
        },
      }),
    ).toBe(true)
    // 非法：active 非布尔 / 图标尺寸非 null 负数 / level 超界（0、7、
    // 非整数） / text 非字符串 / line 负数
    expect(isWebviewToHost({ ...base, outline: { active: 1 } })).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: {
          active: true,
          toggleIconSizePx: -16,
          panelScrollHeightPx: null,
          panelClientHeightPx: null,
          items: [],
          toggleAriaLabel: null,
          panelAriaLabel: null,
        },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 0, text: 'x', plainText: 'x', spans: [], line: 1 }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 7, text: 'x', plainText: 'x', spans: [], line: 1 }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 3, plainText: 'x', spans: [], line: 1 }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 'x', plainText: 'x', spans: [], line: -1 }] },
      }),
    ).toBe(false)
    // 非法（#65）：缺 plainText / spans 非数组 / 白名单外 kind / 负偏移 /
    // 区间倒置 / style 字段非字符串
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 'x', spans: [], line: 1 }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 'x', plainText: 'x', spans: 'strong', line: 1 }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 'x', plainText: 'x', line: 1,
          spans: [{ kind: 'highlight', start: 0, end: 1 }] }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 'x', plainText: 'x', line: 1,
          spans: [{ kind: 'strong', start: -1, end: 1 }] }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [{ level: 2, text: 'x', plainText: 'x', line: 1,
          spans: [{ kind: 'strong', start: 2, end: 1 }] }] },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...base,
        outline: { active: true, items: [], style: { itemFontWeight: 400 } },
      }),
    ).toBe(false)
    // 缺省合法（向后兼容：大纲观测未装配的旧 webview）
    expect(isWebviewToHost(base)).toBe(true)
  })

  it('view.state 的 outline 观测（#66）：located 字段非法拒绝', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    const legal = {
      active: true,
      togglePainted: false,
      panelPainted: false,
      toggleIconSizePx: null,
      panelScrollHeightPx: null,
      panelClientHeightPx: null,
      items: [] as unknown[],
      toggleAriaLabel: null,
      panelAriaLabel: null,
    }
    // locatedItemIndex：null 或非负整数（负数、小数、字符串拒绝）
    expect(isWebviewToHost({ ...base, outline: { ...legal, locatedItemIndex: -1, locatedText: null, locatedPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, locatedItemIndex: 1.5, locatedText: null, locatedPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, locatedItemIndex: '0', locatedText: null, locatedPainted: false } })).toBe(false)
    // locatedText：字符串或 null；locatedPainted：布尔
    expect(isWebviewToHost({ ...base, outline: { ...legal, locatedItemIndex: 0, locatedText: 7, locatedPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, locatedItemIndex: 0, locatedText: null, locatedPainted: 1 } })).toBe(false)
  })

  it('outline.test.click 测试钩子消息校验（#54）', () => {
    expect(isHostToWebview({ kind: 'outline.test.click' })).toBe(true)
    expect(isHostToWebview({ kind: 'outline.test.click', extra: 1 })).toBe(true)
    expect(isHostToWebview({ kind: 'outline.test.clickx' })).toBe(false)
  })

  it('outline.test.itemClick 测试钩子消息校验（#66）：非负整数 index', () => {
    expect(isHostToWebview({ kind: 'outline.test.itemClick', index: 0 })).toBe(true)
    expect(isHostToWebview({ kind: 'outline.test.itemClick', index: 12, extra: 1 })).toBe(true)
    expect(isHostToWebview({ kind: 'outline.test.itemClick', index: -1 })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.itemClick', index: 1.5 })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.itemClick', index: '0' })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.itemClick' })).toBe(false)
  })

  it('view.state 的 outline 观测（#67）：expandLevel/visibleIndices/滑块与箭头绘制字段校验', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 40 }
    const legal = {
      active: true,
      togglePainted: false,
      panelPainted: false,
      toggleIconSizePx: null,
      panelScrollHeightPx: null,
      panelClientHeightPx: null,
      items: [] as unknown[],
      toggleAriaLabel: null,
      panelAriaLabel: null,
      locatedItemIndex: null,
      locatedText: null,
      locatedPainted: false,
    }
    // 合法：档位 0-5 整数、可见索引非负整数数组、三个绘制命中布尔
    expect(isWebviewToHost({
      ...base,
      outline: { ...legal, expandLevel: 0, visibleIndices: [0, 1, 3],
        sliderPainted: true, sliderActiveDotPainted: true, chevronPainted: false },
    })).toBe(true)
    expect(isWebviewToHost({
      ...base,
      outline: { ...legal, expandLevel: 5, visibleIndices: [], sliderPainted: false,
        sliderActiveDotPainted: false, chevronPainted: false },
    })).toBe(true)
    // 非法：档位越界（-1、6）、小数、字符串
    for (const level of [-1, 6, 2.5, '2']) {
      expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: level,
        visibleIndices: [], sliderPainted: false, sliderActiveDotPainted: false, chevronPainted: false } }))
        .toBe(false)
    }
    // 非法：visibleIndices 非数组 / 含负数 / 含非整数
    expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: 2, visibleIndices: '0',
      sliderPainted: false, sliderActiveDotPainted: false, chevronPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: 2, visibleIndices: [0, -1],
      sliderPainted: false, sliderActiveDotPainted: false, chevronPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: 2, visibleIndices: [0.5],
      sliderPainted: false, sliderActiveDotPainted: false, chevronPainted: false } })).toBe(false)
    // 非法：绘制字段非布尔
    expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: 2, visibleIndices: [],
      sliderPainted: 1, sliderActiveDotPainted: false, chevronPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: 2, visibleIndices: [],
      sliderPainted: false, sliderActiveDotPainted: 'x', chevronPainted: false } })).toBe(false)
    expect(isWebviewToHost({ ...base, outline: { ...legal, expandLevel: 2, visibleIndices: [],
      sliderPainted: false, sliderActiveDotPainted: false, chevronPainted: null } })).toBe(false)
  })

  it('outline.test.expandClick / outline.test.chevronClick 测试钩子消息校验（#67）', () => {
    // expandClick：档位 0-5 整数
    for (const level of [0, 1, 2, 3, 4, 5]) {
      expect(isHostToWebview({ kind: 'outline.test.expandClick', level })).toBe(true)
    }
    expect(isHostToWebview({ kind: 'outline.test.expandClick', level: -1 })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.expandClick', level: 6 })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.expandClick', level: 1.5 })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.expandClick', level: '2' })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.expandClick' })).toBe(false)
    // chevronClick：非负整数 index（与 itemClick 同口径）
    expect(isHostToWebview({ kind: 'outline.test.chevronClick', index: 0 })).toBe(true)
    expect(isHostToWebview({ kind: 'outline.test.chevronClick', index: 3, extra: 1 })).toBe(true)
    expect(isHostToWebview({ kind: 'outline.test.chevronClick', index: -1 })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.chevronClick', index: '0' })).toBe(false)
    expect(isHostToWebview({ kind: 'outline.test.chevronClick' })).toBe(false)
  })

  it('表格绘制样本校验：可见性和边框计算值类型必须可信', () => {
    const base = { kind: 'view.state', text: '| A |', docLength: 5, lineCount: 1, renderedLines: 1 }
    const table = {
      cellVisible: true, gridDisplay: 'grid', cellBorderWidth: '1px',
      rowOutlineColor: null, rowOutlineWidth: null, rowBackgroundColor: null,
      columnBorderColor: null, columnBorderWidth: null, columnRightBorderWidth: null,
      columnTopBorderWidth: null, columnBottomBorderWidth: null, columnBackgroundColor: null,
    }
    const paint = {
      textVisible: true, scrollerDisplay: 'flex', gutterUserSelect: 'none',
      darkTheme: false, caretColor: 'rgb(0, 0, 0)', table,
    }
    expect(isWebviewToHost({ ...base, paint })).toBe(true)
    expect(isWebviewToHost({ ...base, paint: { ...paint, table: { ...table, cellVisible: 'yes' } } })).toBe(false)
    expect(isWebviewToHost({ ...base, paint: { ...paint, table: { ...table, rowOutlineWidth: 2 } } })).toBe(false)
    expect(isWebviewToHost({ ...base, paint: { ...paint, table: { ...table, columnBorderColor: [] } } })).toBe(false)
    expect(isWebviewToHost({ ...base, paint: { ...paint, table: { ...table, columnRightBorderWidth: 2 } } })).toBe(false)
  })

  it('标题绘制样本校验（#55）：计数非负整数、计算值数组元素为字符串', () => {
    const base = { kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 1 }
    const paint = {
      textVisible: true, scrollerDisplay: 'flex', gutterUserSelect: 'none',
      darkTheme: false, caretColor: 'rgb(0, 0, 0)',
      heading: { inviewCount: 2, boxShadowValues: ['none'], borderLeftWidthValues: ['0px'] },
    }
    // 合法：有挂载标题行 / 无挂载标题行（null）/ 字段缺省（旧 webview 兼容）
    expect(isWebviewToHost({ ...base, paint })).toBe(true)
    expect(isWebviewToHost({ ...base, paint: { ...paint, heading: null } })).toBe(true)
    expect(isWebviewToHost({ ...base, paint: { textVisible: true, scrollerDisplay: 'flex', gutterUserSelect: 'none', darkTheme: false, caretColor: null } })).toBe(true)
    // 非法：inviewCount 负数/非整数、计算值数组元素非字符串
    expect(isWebviewToHost({ ...base, paint: { ...paint, heading: { ...paint.heading, inviewCount: -1 } } })).toBe(false)
    expect(isWebviewToHost({ ...base, paint: { ...paint, heading: { ...paint.heading, inviewCount: 1.5 } } })).toBe(false)
    expect(isWebviewToHost({ ...base, paint: { ...paint, heading: { ...paint.heading, boxShadowValues: ['none', 3] } } })).toBe(false)
    expect(isWebviewToHost({ ...base, paint: { ...paint, heading: { ...paint.heading, borderLeftWidthValues: '0px' } } })).toBe(false)
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
  it('表格选中测试钩子只接受行或列的非负索引', () => {
    expect(isHostToWebview({ kind: 'table.test.select', axis: 'row', index: 1 })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.select', axis: 'column', index: 0 })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.select', axis: 'cell', index: 0 })).toBe(false)
    expect(isHostToWebview({ kind: 'table.test.select', axis: 'row', index: -1 })).toBe(false)
  })

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

  it('创建空表格是宿主到 webview 的独立命令消息', () => {
    expect(isHostToWebview({ kind: 'table.create' })).toBe(true)
    expect(isWebviewToHost({ kind: 'table.create' })).toBe(false)
  })

  it('接受合法 table.test.key，拒绝未知键名（#13 测试钩子）', () => {
    expect(isHostToWebview({ kind: 'table.test.key', key: 'tab' })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.key', key: 'shift-tab' })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.key', key: 'enter' })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.key', key: 'unknown' })).toBe(false)
    expect(isHostToWebview({ kind: 'table.test.key' })).toBe(false)
  })

  it('table.test.drag 只接受非负整数行索引与有效目标槽位（#43）', () => {
    expect(isHostToWebview({ kind: 'table.test.drag', sourceIndex: 2, targetSlot: 0 })).toBe(true)
    expect(isHostToWebview({ kind: 'table.test.drag', sourceIndex: -1, targetSlot: 0 })).toBe(false)
    expect(isHostToWebview({ kind: 'table.test.drag', sourceIndex: 2.5, targetSlot: 0 })).toBe(false)
    expect(isHostToWebview({ kind: 'table.test.drag', sourceIndex: 2, targetSlot: -1 })).toBe(false)
  })
})


describe('perf 探针协议（#5）', () => {
  const validReport = {
    kind: 'perf.report',
    typingRounds: 30,
    scrollRounds: 10,
    docLines: 1000,
    firstInputSettledEpochMs: 1760000000000,
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
    expect(isWebviewToHost({ ...validReport, firstInputSettledEpochMs: -1 })).toBe(false)
    const { firstInputSettledEpochMs: _timestamp, ...missingTimestamp } = validReport
    expect(isWebviewToHost(missingTimestamp)).toBe(false)
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

  // #15：快照可选携带 webview JS 堆读数（Chromium performance.memory）
  it('perf.report 快照接受 jsHeapBytes（正整数 / null / 缺省），拒绝非法类型', () => {
    const withHeap = {
      ...validReport,
      baseline: { ...validReport.baseline, jsHeapBytes: 12_345_678 },
    }
    expect(isWebviewToHost(withHeap)).toBe(true)
    expect(
      isWebviewToHost({
        ...validReport,
        afterTyping: { ...validReport.afterTyping, jsHeapBytes: null },
      }),
    ).toBe(true)
    expect(
      isWebviewToHost({
        ...validReport,
        afterScroll: { ...validReport.afterScroll, jsHeapBytes: -5 },
      }),
    ).toBe(false)
    expect(
      isWebviewToHost({
        ...validReport,
        afterScroll: { ...validReport.afterScroll, jsHeapBytes: '12' },
      }),
    ).toBe(false)
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

describe('设置消息协议（#33）', () => {
  const baseViewState = {
    kind: 'view.state' as const,
    text: '# t',
    docLength: 4,
    lineCount: 1,
    renderedLines: 1,
  }

  it('接受合法 settings.open 与 settings.get，拒绝携带多余非法形态', () => {
    expect(isWebviewToHost({ kind: 'settings.open' })).toBe(true)
    expect(isWebviewToHost({ kind: 'settings.get' })).toBe(true)
    // 方向校验：宿主方向不接受
    expect(isHostToWebview({ kind: 'settings.open' })).toBe(false)
    expect(isHostToWebview({ kind: 'settings.get' })).toBe(false)
  })

  it('接受合法 settings.set（标量键值对，含空对象），拒绝非对象 values 与非标量值', () => {
    expect(isWebviewToHost({ kind: 'settings.set', values: {} })).toBe(true)
    expect(isWebviewToHost({ kind: 'settings.set', values: { 'editor.lineNumbers': true } })).toBe(true)
    expect(isWebviewToHost({ kind: 'settings.set', values: { 'a.b': 3, 'c.d': 'x' } })).toBe(true)
    expect(isWebviewToHost({ kind: 'settings.set' })).toBe(false)
    expect(isWebviewToHost({ kind: 'settings.set', values: null })).toBe(false)
    expect(isWebviewToHost({ kind: 'settings.set', values: 'x' })).toBe(false)
    expect(isWebviewToHost({ kind: 'settings.set', values: { nested: { a: 1 } } })).toBe(false)
    expect(isWebviewToHost({ kind: 'settings.set', values: { arr: [true] } })).toBe(false)
    expect(isWebviewToHost({ kind: 'settings.set', values: { nul: null } })).toBe(false)
    // 方向校验
    expect(isHostToWebview({ kind: 'settings.set', values: {} })).toBe(false)
  })

  it('接受合法 settings.snapshot 与 settings.changed，拒绝非法 values', () => {
    expect(isHostToWebview({ kind: 'settings.snapshot', values: {} })).toBe(true)
    expect(isHostToWebview({ kind: 'settings.snapshot', values: { 'editor.lineNumbers': false } })).toBe(true)
    expect(isHostToWebview({ kind: 'settings.changed', values: { 'a.b': true, 'c.d': 2 } })).toBe(true)
    expect(isHostToWebview({ kind: 'settings.snapshot' })).toBe(false)
    expect(isHostToWebview({ kind: 'settings.changed', values: [] })).toBe(false)
    expect(isHostToWebview({ kind: 'settings.changed', values: { bad: undefined } })).toBe(false)
    // 方向校验：webview 方向不接受
    expect(isWebviewToHost({ kind: 'settings.snapshot', values: {} })).toBe(false)
    expect(isWebviewToHost({ kind: 'settings.changed', values: {} })).toBe(false)
  })

  it('view.state 接受 settings 可选快照字段，拒绝类型错误', () => {
    expect(isWebviewToHost({ ...baseViewState, settings: { 'editor.lineNumbers': true } })).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, settings: {} })).toBe(true)
    expect(isWebviewToHost({ ...baseViewState, settings: { bad: { x: 1 } } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, settings: { bad: null } })).toBe(false)
    expect(isWebviewToHost({ ...baseViewState, settings: 'x' })).toBe(false)
  })
})
