// @vitest-environment jsdom
// 双链显示与跳转意图的 webview 契约（工单 #11）：
// - live 视图：光标在双链范围外以显示文字 widget 替换 `[[…]]`，进入范围
//   才显示源码（vsidian-wikilink 稳定类名）；代码上下文不装饰
// - live Ctrl/Cmd+单击 = wikilink.activate 上报（原始 target + 源区间）；
//   普通单击不产生意图；嵌入/块引用形态不上报
// - 阅读视图：合法双链渲染为 a.vsidian-wikilink（href=原文 target，显示别名
//   或链接名）；单击上报意图；嵌入与块引用按原文显示
// - 全程零写回（显示与跳转意图不改文档）
// - 新增协议消息（wikilink.activate）与探针字段的结构校验
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import {
  WIKILINK_CLASS_NAMES,
  LiveWikilinkWidget,
  activateWikilinkAtPos,
  buildWikilinkDecorationRanges,
  makeLinkMouseDownHandler,
} from '../../src/webview/liveLinks'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { isWebviewToHost, type WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/wikilinks.md'

const WIKILINK_DOC = [
  '# 双链样例',
  '',
  '正文含 [[目标笔记]] 与 [[子 目录/目标 二|别名]] 与 [[目标笔记#深处的标题]]。',
  '',
  '降级形态：![[嵌入目标]] 与 [[目标笔记^块]] 与 [[坏#]]。',
  '',
  '`行内代码 [[不装饰]]` 之后的正文。',
  '',
  '```text',
  '[[围栏内不装饰]]',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')

interface Harness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
}

function makeBridge(): Harness {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: () => undefined,
    setState: () => undefined,
  }
  return { bridge, sent }
}

let host: HTMLElement

function mount(h: Harness, text = WIKILINK_DOC): WebviewSyncController {
  host = document.createElement('div')
  const c = new WebviewSyncController(h.bridge)
  c.mount(host)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text })
  return c
}

function sentOf<T extends WebviewToHost['kind']>(h: Harness, kind: T) {
  return h.sent.filter((m) => m.kind === kind)
}

type WikilinkActivate = Extract<WebviewToHost, { kind: 'wikilink.activate' }>

function viewState(c: WebviewSyncController, h: Harness) {
  const before = h.sent.length
  c.handleHostMessage({ kind: 'view.state.request' })
  const msg = h.sent.slice(before).find((m) => m.kind === 'view.state')
  if (!msg) {
    throw new Error('view.state 未回报')
  }
  return msg as Extract<WebviewToHost, { kind: 'view.state' }>
}

function readingContainer(): HTMLElement {
  return host.querySelector<HTMLElement>('.vsidian-view-reading')!
}

describe('实时预览：双链间接装饰（视口内按各自范围切换）', () => {
  function liveRanges(text: string, selection?: { anchor: number }) {
    const state = EditorState.create({
      doc: text,
      selection,
      extensions: [liveDecorationsField],
    })
    return buildWikilinkDecorationRanges(
      state.doc,
      state.field(liveDecorationsField).tree,
      state.selection,
      [{ from: 0, to: state.doc.length }],
      state.field(liveDecorationsField).fm,
    )
  }

  it('光标在双链范围外：`[[…]]` 整体替换为显示文字 widget', () => {
    const ranges = liveRanges(WIKILINK_DOC)
    const widgets = ranges.filter((r) => r.value.spec.widget instanceof LiveWikilinkWidget)
    // 合法双链 3 处（目标笔记 / 别名形态 / 标题形态）；降级与代码内不装饰
    expect(widgets.length).toBe(3)
    const displays = widgets.map(
      (r) => (r.value.spec.widget as LiveWikilinkWidget).displayText,
    )
    expect(displays).toContain('目标笔记')
    expect(displays).toContain('别名')
    expect(displays).toContain('目标笔记#深处的标题')
    // 区间覆盖含括号的完整 `[[…]]` 出现
    const first = widgets.find(
      (r) => (r.value.spec.widget as LiveWikilinkWidget).displayText === '目标笔记',
    )!
    expect(WIKILINK_DOC.slice(first.from, first.to)).toBe('[[目标笔记]]')
  })

  it('光标进入双链范围：不替换（源码可编辑），mark 类标记整个出现', () => {
    const pos = WIKILINK_DOC.indexOf('[[目标笔记]]') + 3
    const ranges = liveRanges(WIKILINK_DOC, { anchor: pos })
    const inLine = ranges.filter((r) => r.from <= pos && r.to >= WIKILINK_DOC.indexOf('[[目标笔记]]'))
    const marks = inLine.filter(
      (r) => r.value.spec['class'] === WIKILINK_CLASS_NAMES.wikilink,
    )
    expect(marks.length).toBe(1)
    expect(WIKILINK_DOC.slice(marks[0]!.from, marks[0]!.to)).toBe('[[目标笔记]]')
    // 同一行不再有替换 widget
    const widgets = inLine.filter((r) => r.value.spec.widget !== undefined)
    expect(widgets.length).toBe(0)
  })

  it('同一行双链按各自范围切换源码与 widget', () => {
    const doc = '前 [[甲]] 中 [[乙|别名]] 后'
    const first = doc.indexOf('[[甲]]')
    const second = doc.indexOf('[[乙|别名]]')
    const widgets = (anchor: number) =>
      liveRanges(doc, { anchor })
        .filter((r) => r.value.spec.widget instanceof LiveWikilinkWidget)
        .map((r) => r.from)
    expect(widgets(doc.indexOf('中'))).toEqual([first, second])
    expect(widgets(doc.indexOf('甲'))).toEqual([second])
    expect(widgets(second + 1)).toEqual([first])
  })

  it('降级形态不装饰：嵌入 ![[…]]、块引用 ^、空标题；代码上下文不装饰', () => {
    const ranges = liveRanges(WIKILINK_DOC)
    for (const r of ranges) {
      const text = WIKILINK_DOC.slice(r.from, r.to)
      expect(text).not.toContain('嵌入目标')
      expect(text).not.toContain('目标笔记^块')
      expect(text).not.toContain('坏#')
      expect(text).not.toContain('不装饰')
    }
  })
})

describe('实时预览：Ctrl/Cmd+单击 = wikilink.activate 上报', () => {
  function liveWithDoc(): { view: EditorView; parent: HTMLElement } {
    const state = EditorState.create({ doc: WIKILINK_DOC, extensions: [liveDecorationsField] })
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state, parent })
    return { view, parent }
  }

  it('activateWikilinkAtPos：区间内位置上报原始 target（| 之前原文）与完整源区间', () => {
    const { view, parent } = liveWithDoc()
    try {
      const posted: Array<{ target: string; from: number; to: number }> = []
      const at = WIKILINK_DOC.indexOf('[[子 目录/目标 二|别名]]')
      const pos = at + 5
      expect(
        activateWikilinkAtPos(view, pos, (target, from, to) => posted.push({ target, from, to })),
      ).toBe(true)
      expect(posted).toEqual([{ target: '子 目录/目标 二', from: at, to: at + '[[子 目录/目标 二|别名]]'.length }])
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('降级形态与普通文本位置不上报', () => {
    const { view, parent } = liveWithDoc()
    try {
      const posted: string[] = []
      const cb = (target: string) => posted.push(target)
      expect(activateWikilinkAtPos(view, WIKILINK_DOC.indexOf('嵌入目标'), cb)).toBe(false)
      expect(activateWikilinkAtPos(view, WIKILINK_DOC.indexOf('目标笔记^块'), cb)).toBe(false)
      expect(activateWikilinkAtPos(view, WIKILINK_DOC.indexOf('围栏内不装饰'), cb)).toBe(false)
      expect(activateWikilinkAtPos(view, WIKILINK_DOC.indexOf('双链样例'), cb)).toBe(false)
      expect(posted).toEqual([])
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('mousedown 处理器：Ctrl+单击命中双链上报并 preventDefault；普通单击不上报', () => {
    const { view, parent } = liveWithDoc()
    try {
      const posted: string[] = []
      const handler = makeLinkMouseDownHandler(
        () => {},
        (target) => posted.push(target),
      )
      const pos = WIKILINK_DOC.indexOf('目标笔记') // 首个合法双链内容位置
      const hitView = { posAtCoords: () => pos, state: view.state } as unknown as EditorView
      expect(handler(new MouseEvent('mousedown', { bubbles: true, cancelable: true }), hitView)).toBe(false)
      const evCtrl = new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true })
      expect(handler(evCtrl, hitView)).toBe(true)
      expect(evCtrl.defaultPrevented).toBe(true)
      expect(posted).toEqual(['目标笔记'])
    } finally {
      view.destroy()
      parent.remove()
    }
  })
})

describe('阅读视图：双链渲染为 a.vsidian-wikilink 与单击上报', () => {
  it('合法双链渲染为可点击 a：href 为原文 target、显示别名或链接名；数量正确', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const anchors = Array.from(
      readingContainer().querySelectorAll<HTMLAnchorElement>(`a.${WIKILINK_CLASS_NAMES.wikilink}`),
    )
    expect(anchors.length).toBe(3)
    const hrefs = anchors.map((a) => a.getAttribute('href'))
    expect(hrefs).toContain('目标笔记')
    expect(hrefs).toContain('子 目录/目标 二')
    expect(hrefs).toContain('目标笔记#深处的标题')
    const texts = anchors.map((a) => a.textContent)
    expect(texts).toContain('别名')
    expect(texts).toContain('目标笔记#深处的标题')
  })

  it('降级形态按原文显示（源码保真）：嵌入与块引用不是可点击链接', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const text = readingContainer().textContent ?? ''
    expect(text).toContain('![[嵌入目标]]')
    expect(text).toContain('[[目标笔记^块]]')
    expect(text).toContain('[[坏#]]')
    expect(text).toContain('[[围栏内不装饰]]')
    // 行内代码内容按 <code> 呈现（反引号是标记被消费），双链不解析
    expect(text).toContain('行内代码 [[不装饰]]')
    // 全部 a 元素只有 3 个合法双链
    expect(readingContainer().querySelectorAll('a').length).toBe(3)
  })

  it('单击双链：上报 wikilink.activate（原始 target + 所在块源锚点），零写回', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const anchor = Array.from(
      readingContainer().querySelectorAll<HTMLAnchorElement>(`a.${WIKILINK_CLASS_NAMES.wikilink}`),
    ).find((a) => a.getAttribute('href') === '目标笔记#深处的标题')!
    anchor.click()
    const intents = sentOf(h, 'wikilink.activate') as WikilinkActivate[]
    expect(intents.length).toBe(1)
    expect(intents[0]!.target).toBe('目标笔记#深处的标题')
    expect(intents[0]!.sessionId).toBe('s1')
    expect(intents[0]!.docUri).toBe(DOC_URI)
    // 源位置：包含该双链的段落块锚点
    expect(intents[0]!.srcStart).toBe(WIKILINK_DOC.indexOf('正文含'))
    expect(intents[0]!.srcEnd).toBeGreaterThan(intents[0]!.srcStart)
    expect(sentOf(h, 'edit.request').length).toBe(0)
  })

  it('view.state 观测：liveWikilinkCount / readingWikilinkCount；文本逐字节不变', () => {
    const h = makeBridge()
    const c = mount(h)
    const live = viewState(c, h)
    expect(live.liveWikilinkCount).toBe(3)
    expect(live.liveLinkCount ?? 0).toBe(0) // 样例不含普通链接
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const reading = viewState(c, h)
    expect(reading.readingWikilinkCount).toBe(3)
    expect(reading.text).toBe(WIKILINK_DOC)
    expect(sentOf(h, 'edit.request').length).toBe(0)
  })
})

describe('新增协议消息结构校验（#11）', () => {
  it('wikilink.activate：合法通过；缺字段/类型错误拒绝', () => {
    const base = {
      kind: 'wikilink.activate',
      sessionId: 's1',
      docUri: DOC_URI,
      target: '目录/笔记#标题',
      srcStart: 3,
      srcEnd: 20,
    }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, target: 1 })).toBe(false)
    expect(isWebviewToHost({ ...base, target: '' })).toBe(true) // 空 target 合法（宿主给反馈）
    expect(isWebviewToHost({ ...base, srcStart: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, srcEnd: 'x' })).toBe(false)
    expect(isWebviewToHost({ kind: 'wikilink.activate', sessionId: 's1', docUri: DOC_URI, target: 'x' })).toBe(false)
  })

  it('view.state 双链观测字段：合法数值通过；类型错误拒绝', () => {
    const base = {
      kind: 'view.state',
      text: '[[x]]',
      docLength: 5,
      lineCount: 1,
      renderedLines: 10,
    }
    expect(isWebviewToHost({ ...base, liveWikilinkCount: 1, readingWikilinkCount: 0 })).toBe(true)
    expect(isWebviewToHost({ ...base, liveWikilinkCount: 'x' })).toBe(false)
    expect(isWebviewToHost({ ...base, readingWikilinkCount: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, liveWikilinkCount: 1.5 })).toBe(false)
  })
})
