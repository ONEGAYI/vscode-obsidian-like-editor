// @vitest-environment jsdom
// 链接点击与图片显示的 webview 契约（工单 #10）：
// - 阅读视图单击链接 = 跳转意图上报（preventDefault，不打断为导航）；
//   file://、javascript: 等危险目标在渲染层已无 href，单击不产生意图
// - 实时预览渲染态单击或 Ctrl/Cmd+单击 = 跳转意图上报；源码态普通单击编辑
// - 图片：进入视口（块挂载/widget 创建）才经宿主通道解析并加载；
//   占位/加载/失败可重试；全程零写回（点击与图片不得改文档）
// - 新增协议消息的结构校验
import { describe, it, expect, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import {
  LINK_CLASS_NAMES,
  LiveImageWidget,
  WIDGET_DECO_CACHE_LIMIT,
  activateLinkAtPos,
  buildLinkImageDecorations,
  imageWidgetDeco,
  makeLinkMouseDownHandler,
  wikilinkWidgetDeco,
} from '../../src/webview/liveLinks'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { isHostToWebview, isWebviewToHost, type WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/links.md'

// 说明：CommonMark 中不带尖括号的目标含空格不是合法链接（markdown-it 与
// lezer 一致不解析）——"空格路径"的正确形态是 %20 编码（宿主解码后解析
// 到含空格文件），本样例即用该形态。
const LINK_DOC = [
  '# 链接样例',
  '',
  '段落含 [外部链接](https://example.com/a?b=1) 与 [本地链接](./目标%20文档.md)。',
  '',
  '自动链接 <https://autolink.example.com/x>。',
  '',
  '![图片说明](./assets/图%20片.png)',
  '',
  '危险：[file](file:///d:/x.md) 与 [js](javascript:alert(1))。',
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

function mount(h: Harness, text = LINK_DOC): WebviewSyncController {
  host = document.createElement('div')
  const c = new WebviewSyncController(h.bridge)
  c.mount(host)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text })
  return c
}

function sentOf<T extends WebviewToHost['kind']>(h: Harness, kind: T) {
  return h.sent.filter((m) => m.kind === kind)
}

type LinkActivate = Extract<WebviewToHost, { kind: 'link.activate' }>
type ImageRequest = Extract<WebviewToHost, { kind: 'image.request' }>

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

describe('阅读视图：单击链接 = 跳转意图上报', () => {
  it('单击工作区相对链接：上报 href 与所在块源锚点，零写回', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const anchor = Array.from(readingContainer().querySelectorAll<HTMLAnchorElement>('a')).find((a) =>
      decodeURIComponent(a.getAttribute('href') ?? '').includes('目标 文档.md'),
    )
    expect(anchor).toBeDefined()
    anchor!.click()
    const intents = sentOf(h, 'link.activate') as LinkActivate[]
    expect(intents.length).toBe(1)
    expect(decodeURIComponent(intents[0]!.href)).toBe('./目标 文档.md')
    expect(intents[0]!.sessionId).toBe('s1')
    expect(intents[0]!.docUri).toBe(DOC_URI)
    // 源位置：包含该链接的块锚点（段落块 start）
    expect(intents[0]!.srcStart).toBe(LINK_DOC.indexOf('段落含'))
    expect(intents[0]!.srcEnd).toBeGreaterThan(intents[0]!.srcStart)
    expect(sentOf(h, 'edit.request').length).toBe(0)
  })

  it('单击外链与自动链接同样上报原始 URI', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    for (const match of ['https://example.com', 'autolink.example.com']) {
      const anchor = Array.from(readingContainer().querySelectorAll<HTMLAnchorElement>('a')).find((a) =>
        (a.getAttribute('href') ?? '').includes(match),
      )!
      anchor.click()
    }
    const intents = (sentOf(h, 'link.activate') as LinkActivate[]).map((m) => m.href)
    expect(intents.sort()).toEqual(['https://autolink.example.com/x', 'https://example.com/a?b=1'].sort())
  })

  it('危险目标（file://、javascript:）渲染层无 href：单击不产生意图', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const anchors = Array.from(readingContainer().querySelectorAll<HTMLAnchorElement>('a'))
    // markdown-it validateLink 拦截：危险链接不渲染为 <a>（原文保留）；
    // 可点击的只有外链/本地/自动链接三处
    expect(anchors.length).toBe(3)
    for (const a of anchors) {
      expect(a.getAttribute('href')).not.toBeNull()
      expect(/^(file|js)$/.test(a.textContent ?? '')).toBe(false)
    }
    expect(readingContainer().textContent).toContain('[file](file:///d:/x.md)')
  })
})

describe('实时预览：渲染态单击跳转，源码态普通单击编辑', () => {
  it('非活动行已渲染的普通链接单击上报跳转，活动行源码态普通单击可编辑', () => {
    const h = makeBridge()
    const text = '普通行\n\n[目标](./目标.md)\n'
    const c = mount(h, text)
    const view = c.getView()!
    const pos = text.indexOf('目标')
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(pos)
    try {
      const rendered = host.querySelector<HTMLElement>('.vsidian-link')!
      expect(rendered).not.toBeNull()
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      rendered.dispatchEvent(event)
      expect(sentOf(h, 'link.activate')).toHaveLength(0)
      view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      expect(sentOf(h, 'link.activate')).toHaveLength(1)
      h.sent.length = 0
      view.dispatch({ selection: { anchor: pos } })
      const source = host.querySelector<HTMLElement>('.vsidian-link')!
      source.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      expect(sentOf(h, 'link.activate')).toHaveLength(0)
    } finally {
      hit.mockRestore()
      c.dispose()
    }
  })

  it('表格网格中的链接普通单击进入单元格编辑，Ctrl+单击仍跳转', () => {
    const h = makeBridge()
    const text = '前文\n\n| [目标](./目标.md) | 数量 |\n| --- | --- |\n| 甲 | 1 |\n'
    const c = mount(h, text)
    const view = c.getView()!
    const hit = vi.spyOn(view, 'posAtCoords').mockReturnValue(text.indexOf('目标'))
    try {
      const rendered = host.querySelector<HTMLElement>('.vsidian-table-grid-row .vsidian-link')!
      expect(rendered).not.toBeNull()
      rendered.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      expect(sentOf(h, 'link.activate')).toHaveLength(0)
      rendered.dispatchEvent(new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      expect(sentOf(h, 'link.activate')).toHaveLength(1)
      view.dispatch({ selection: { anchor: text.indexOf('目标') } })
      expect(host.querySelectorAll('.vsidian-table-grid-row')).toHaveLength(2)
      expect(host.querySelector('.vsidian-table-grid-row .vsidian-link')).not.toBeNull()
    } finally {
      hit.mockRestore()
      c.dispose()
    }
  })

  function liveWithDoc(): { view: EditorView; parent: HTMLElement } {
    const state = EditorState.create({ doc: LINK_DOC, extensions: [liveDecorationsField] })
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state, parent })
    return { view, parent }
  }

  it('activateLinkAtPos：链接文本位置上报原始 URI 与链接源区间', () => {
    const { view, parent } = liveWithDoc()
    try {
      const posted: Array<{ href: string; from: number; to: number }> = []
      const pos = LINK_DOC.indexOf('外部链接')
      const from = LINK_DOC.indexOf('[外部链接]')
      const to = LINK_DOC.indexOf(')', from) + 1
      expect(activateLinkAtPos(view, pos, (href, f, t) => posted.push({ href, from: f, to: t }))).toBe(true)
      expect(posted).toEqual([{ href: 'https://example.com/a?b=1', from, to }])
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('activateLinkAtPos：URL 文本与自动链接位置可激活；普通文本返回 false', () => {
    const { view, parent } = liveWithDoc()
    try {
      const posted: string[] = []
      const urlPos = LINK_DOC.indexOf('https://autolink.example.com/x')
      expect(activateLinkAtPos(view, urlPos, (href) => posted.push(href))).toBe(true)
      expect(posted).toEqual(['https://autolink.example.com/x'])
      expect(activateLinkAtPos(view, LINK_DOC.indexOf('链接样例'), (href) => posted.push(href))).toBe(false)
      expect(posted.length).toBe(1)
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('mousedown 处理器：Ctrl/Cmd 按下才尝试激活；命中时 preventDefault', () => {
    const { view, parent } = liveWithDoc()
    try {
      const posted: string[] = []
      const handler = makeLinkMouseDownHandler((href) => posted.push(href))
      const linkPos = LINK_DOC.indexOf('本地链接')
      const hitView = {
        posAtCoords: () => linkPos,
        state: view.state,
      } as unknown as EditorView
      expect(handler(new MouseEvent('mousedown', { bubbles: true, cancelable: true }), hitView)).toBe(false)
      const evCtrl = new MouseEvent('mousedown', { ctrlKey: true, bubbles: true, cancelable: true })
      expect(handler(evCtrl, hitView)).toBe(true)
      expect(evCtrl.defaultPrevented).toBe(true)
      expect(posted).toEqual(['./目标%20文档.md']) // 源文原样 URI（%20 编码由宿主解码）
      expect(
        handler(new MouseEvent('mousedown', { metaKey: true, bubbles: true, cancelable: true }), hitView),
      ).toBe(true)
      expect(posted.length).toBe(2)
      const missView = { posAtCoords: () => null } as unknown as EditorView
      expect(handler(new MouseEvent('mousedown', { ctrlKey: true }), missView)).toBe(false)
    } finally {
      view.destroy()
      parent.remove()
    }
  })

  it('buildLinkImageDecorations：链接 span、隐藏尾部标记与图片 widget（视口内、非活动行）', () => {
    const state = EditorState.create({ doc: LINK_DOC, extensions: [liveDecorationsField] })
    const doc = state.doc
    const set = buildLinkImageDecorations(doc, state.field(liveDecorationsField).tree, state.selection, [
      { from: 0, to: doc.length },
    ])
    const items: Array<{ cls: string | null; widget: boolean; from: number; to: number }> = []
    set.between(0, doc.length, (from, to, value) => {
      items.push({
        cls: (value.spec as { class?: string }).class ?? null,
        widget: (value.spec as { widget?: unknown }).widget !== undefined,
        from,
        to,
      })
    })
    // 链接 span：外链/本地/自动链接三处内容（危险链接同样有 span——显示语义
    // 与跳转语义分离，跳转由宿主拦截）
    const linkSpans = items.filter((i) => i.cls === LINK_CLASS_NAMES.link)
    expect(linkSpans.length).toBeGreaterThanOrEqual(4)
    // 图片 widget：非活动图片行整个 Image 节点替换为 LiveImageWidget
    const widgets = items.filter((i) => i.widget)
    expect(widgets.length).toBe(1)
    const imageStart = LINK_DOC.indexOf('![图片说明]')
    expect(widgets[0]!.from).toBe(imageStart)
    expect(widgets[0]!.to).toBe(LINK_DOC.indexOf(')', imageStart) + 1)
  })

  it('活动图片行不生成 widget（源码可编辑）', () => {
    const imageLinePos = LINK_DOC.indexOf('![图片说明]')
    const state = EditorState.create({
      doc: LINK_DOC,
      selection: { anchor: imageLinePos + 2 },
      extensions: [liveDecorationsField],
    })
    const set = buildLinkImageDecorations(
      state.doc,
      state.field(liveDecorationsField).tree,
      state.selection,
      [{ from: 0, to: state.doc.length }],
    )
    let imageWidgets = 0
    set.between(imageLinePos, imageLinePos + 24, (_f, _t, value) => {
      if ((value.spec as { widget?: unknown }).widget instanceof LiveImageWidget) {
        imageWidgets += 1
      }
    })
    expect(imageWidgets).toBe(0)
  })

  it('同一行多个链接只在光标进入对应链接的左端、中间或右端时显形源码', () => {
    const text = '前 [甲](one.md) 中 [乙](two.md) 后'
    const first = text.indexOf('[甲]')
    const second = text.indexOf('[乙]')
    const firstEnd = text.indexOf(')', first) + 1
    const hidden = (anchor: number) => {
      const state = EditorState.create({ doc: text, selection: { anchor }, extensions: [liveDecorationsField] })
      const set = buildLinkImageDecorations(state.doc, state.field(liveDecorationsField).tree, state.selection, [
        { from: 0, to: state.doc.length },
      ])
      const ranges: Array<[number, number]> = []
      set.between(0, state.doc.length, (from, to, value) => {
        if (value.spec['class'] === undefined && value.spec.widget === undefined) ranges.push([from, to])
      })
      return ranges
    }
    for (const pos of [first, text.indexOf('甲'), text.indexOf('one.md'), firstEnd]) {
      expect(hidden(pos)).not.toContainEqual([first, first + 1])
      expect(hidden(pos)).toContainEqual([second, second + 1])
    }
    expect(hidden(text.indexOf('中'))).toContainEqual([first, first + 1])
    expect(hidden(text.indexOf('中'))).toContainEqual([second, second + 1])
  })

  it('同一行图片只在光标进入图片源码时撤销 widget', () => {
    const text = '前 ![甲](one.png) 中 ![乙](two.png) 后'
    const imageWidgets = (anchor: number) => {
      const state = EditorState.create({ doc: text, selection: { anchor }, extensions: [liveDecorationsField] })
      const set = buildLinkImageDecorations(state.doc, state.field(liveDecorationsField).tree, state.selection, [
        { from: 0, to: state.doc.length },
      ])
      const ranges: number[] = []
      set.between(0, state.doc.length, (from, _to, value) => {
        if (value.spec.widget instanceof LiveImageWidget) ranges.push(from)
      })
      return ranges
    }
    const first = text.indexOf('![甲]')
    const second = text.indexOf('![乙]')
    expect(imageWidgets(text.indexOf('中'))).toEqual([first, second])
    expect(imageWidgets(text.indexOf('甲'))).toEqual([second])
  })

  it('光标进入列表项中的链接时，列表 marker 仍保持隐藏', () => {
    const text = '- 正文 [链接](a.md)'
    const state = EditorState.create({
      doc: text,
      selection: { anchor: text.indexOf('链接') },
      extensions: [liveDecorationsField],
    })
    const hidden: Array<[number, number]> = []
    state.field(liveDecorationsField).decos.between(0, text.length, (from, to, value) => {
      if (value.spec['class'] === undefined && value.spec.widget === undefined) hidden.push([from, to])
    })
    expect(hidden).toContainEqual([0, 2])
  })

  it('自动链接的尖括号也按自身范围显形', () => {
    const text = '前 <https://one.example> 中 <https://two.example> 后'
    const first = text.indexOf('<')
    const second = text.indexOf('<', first + 1)
    const hidden = (anchor: number) => {
      const state = EditorState.create({ doc: text, selection: { anchor }, extensions: [liveDecorationsField] })
      const set = buildLinkImageDecorations(state.doc, state.field(liveDecorationsField).tree, state.selection, [
        { from: 0, to: text.length },
      ])
      const ranges: Array<[number, number]> = []
      set.between(0, text.length, (from, to, value) => {
        if (value.spec['class'] === undefined && value.spec.widget === undefined) ranges.push([from, to])
      })
      return ranges
    }
    expect(hidden(text.indexOf('one.example'))).not.toContainEqual([first, first + 1])
    expect(hidden(text.indexOf('one.example'))).toContainEqual([second, second + 1])
    expect(hidden(text.indexOf('中'))).toContainEqual([first, first + 1])
  })
})

describe('图片生命周期（阅读视图，块挂载即装载）', () => {
  it('进入阅读视图：图片剥离 src、进入 loading 并发 image.request（reqId 自增）', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const image = readingContainer().querySelector<HTMLImageElement>('img.vsidian-image')!
    expect(image).not.toBeNull()
    expect(image.getAttribute('src')).toBeNull()
    // markdown-it normalizeLink 产出的编码形态（%20/%E5…）：宿主解码后解析
    expect(decodeURIComponent(image.dataset['vsidianImgSrc'] ?? '')).toBe('./assets/图 片.png')
    expect(image.dataset['vsidianImgState']).toBe('loading')
    expect(image.alt).toBe('图片说明')
    const requests = sentOf(h, 'image.request') as ImageRequest[]
    expect(requests.length).toBe(1)
    expect(decodeURIComponent(requests[0]!.src)).toBe('./assets/图 片.png')
    expect(requests[0]!.sessionId).toBe('s1')
    expect(requests[0]!.docUri).toBe(DOC_URI)
    expect(requests[0]!.reqId).toBeGreaterThan(0)
    expect(sentOf(h, 'edit.request').length).toBe(0)
  })

  it('宿主返回成功：应用 webview 资源 src，load 事件后 loaded；文本不变', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const image = readingContainer().querySelector<HTMLImageElement>('img.vsidian-image')!
    const req = (sentOf(h, 'image.request') as ImageRequest[])[0]!
    c.handleHostMessage({ kind: 'image.result', reqId: req.reqId, ok: true, src: 'https://file+.vscode-resource/x.png' })
    expect(image.getAttribute('src')).toBe('https://file+.vscode-resource/x.png')
    image.dispatchEvent(new Event('load'))
    const state = viewState(c, h)
    expect(state.imageStates).toEqual({ loading: 0, loaded: 1, error: 0 })
    expect(state.readingImageCount).toBe(1)
    expect(state.readingLinkCount).toBeGreaterThanOrEqual(3)
    expect(state.text).toBe(LINK_DOC)
    expect(sentOf(h, 'edit.request').length).toBe(0)
  })

  it('宿主返回失败：进入可重试错误态，点击后重新请求', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const image = readingContainer().querySelector<HTMLImageElement>('img.vsidian-image')!
    const reqId = (sentOf(h, 'image.request') as ImageRequest[])[0]!.reqId
    c.handleHostMessage({ kind: 'image.result', reqId, ok: false, reason: 'not-found' })
    expect(image.dataset['vsidianImgState']).toBe('error')
    image.click()
    expect((sentOf(h, 'image.request') as ImageRequest[]).length).toBe(2)
  })

  it('外部全文重建阅读视图：旧图片槽位释放（src 清空），新块重新装载', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const first = readingContainer().querySelector<HTMLImageElement>('img.vsidian-image')!
    const reqId = (sentOf(h, 'image.request') as ImageRequest[])[0]!.reqId
    c.handleHostMessage({ kind: 'image.result', reqId, ok: true, src: 'https://res/x.png' })
    first.dispatchEvent(new Event('load'))
    c.handleHostMessage({ kind: 'doc.resync', version: 2, text: '# 新文\n\n![另一图](./b.png)\n' })
    expect(first.getAttribute('src')).toBeNull()
    expect(first.dataset['vsidianImgState'] ?? '').toBe('')
    const requests = sentOf(h, 'image.request') as ImageRequest[]
    expect(requests.length).toBe(2)
    expect(requests[1]!.src).toBe('./b.png')
  })
})

describe('实时预览图片（间接装饰 widget）', () => {
  it('live 模式下图片 widget 创建并经宿主通道装载；view.state 观测 liveImageCount', () => {
    const h = makeBridge()
    const c = mount(h)
    const before = viewState(c, h)
    expect(before.liveImageCount ?? 0).toBeGreaterThanOrEqual(1)
    const requests = sentOf(h, 'image.request') as ImageRequest[]
    expect(requests.length).toBe(1)
    expect(decodeURIComponent(requests[0]!.src)).toBe('./assets/图 片.png')
    c.handleHostMessage({ kind: 'image.result', reqId: requests[0]!.reqId, ok: true, src: 'https://res/img.png' })
    const inner = host.querySelector<HTMLElement>('.vsidian-view-live')!.querySelector<HTMLImageElement>('.vsidian-image img')!
    expect(inner).not.toBeNull()
    expect(inner.getAttribute('src')).toBe('https://res/img.png')
    inner.dispatchEvent(new Event('load'))
    const after = viewState(c, h)
    expect(after.imageStates).toEqual({ loading: 0, loaded: 1, error: 0 })
    expect(sentOf(h, 'edit.request').length).toBe(0)
    expect(after.text).toBe(LINK_DOC)
  })

  it('live 模式链接 span 渲染：view.state 观测 liveLinkCount', () => {
    const h = makeBridge()
    const c = mount(h)
    expect(viewState(c, h).liveLinkCount ?? 0).toBeGreaterThanOrEqual(3)
  })
})

describe('新增协议消息结构校验', () => {
  it('link.activate：合法通过；缺字段/类型错误拒绝；空 href 合法（宿主拦截给反馈）', () => {
    const base = { kind: 'link.activate', sessionId: 's1', docUri: DOC_URI, href: './a.md', srcStart: 3, srcEnd: 12 }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, href: 1 })).toBe(false)
    expect(isWebviewToHost({ ...base, srcStart: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, srcEnd: 'x' })).toBe(false)
    expect(isWebviewToHost({ kind: 'link.activate', sessionId: 's1', docUri: DOC_URI, href: 'x', srcStart: 1 })).toBe(false)
    expect(isWebviewToHost({ ...base, href: '' })).toBe(true)
  })

  it('image.request：合法通过；reqId 非正整数或缺 src 拒绝', () => {
    const base = { kind: 'image.request', sessionId: 's1', docUri: DOC_URI, reqId: 1, src: './a.png' }
    expect(isWebviewToHost(base)).toBe(true)
    expect(isWebviewToHost({ ...base, reqId: 0 })).toBe(false)
    expect(isWebviewToHost({ ...base, reqId: -1 })).toBe(false)
    expect(isWebviewToHost({ ...base, src: 5 })).toBe(false)
    expect(isWebviewToHost({ kind: 'image.request', sessionId: 's1', docUri: DOC_URI, reqId: 1 })).toBe(false)
  })

  it('image.result：ok:true 须带 src 字符串；ok:false 须带合法 reason', () => {
    expect(isHostToWebview({ kind: 'image.result', reqId: 1, ok: true, src: 'u' })).toBe(true)
    expect(isHostToWebview({ kind: 'image.result', reqId: 1, ok: true })).toBe(false)
    expect(isHostToWebview({ kind: 'image.result', reqId: 1, ok: true, src: 3 })).toBe(false)
    expect(isHostToWebview({ kind: 'image.result', reqId: 2, ok: false, reason: 'not-found' })).toBe(true)
    for (const reason of ['blocked', 'outside-workspace', 'read-error']) {
      expect(isHostToWebview({ kind: 'image.result', reqId: 2, ok: false, reason })).toBe(true)
    }
    expect(isHostToWebview({ kind: 'image.result', reqId: 2, ok: false, reason: 'whatever' })).toBe(false)
    expect(isHostToWebview({ kind: 'image.result', reqId: 0, ok: false, reason: 'not-found' })).toBe(false)
    expect(isHostToWebview({ kind: 'image.result', reqId: 1, ok: 'yes' })).toBe(false)
  })
})

describe('点击与图片全链路零写回（核心不变量）', () => {
  it('阅读单击、图片装载全程无 edit.request 且文本逐字节不变', () => {
    const h = makeBridge()
    const c = mount(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    for (const a of Array.from(readingContainer().querySelectorAll<HTMLAnchorElement>('a'))) {
      a.click()
    }
    const image = readingContainer().querySelector<HTMLImageElement>('img.vsidian-image')!
    image.click() // loading 态点击不重试
    const req = (sentOf(h, 'image.request') as ImageRequest[])[0]!
    c.handleHostMessage({ kind: 'image.result', reqId: req.reqId, ok: true, src: 'u' })
    image.dispatchEvent(new Event('load'))
    const state = viewState(c, h)
    expect(state.text).toBe(LINK_DOC)
    expect(sentOf(h, 'edit.request').length).toBe(0)
  })
})

describe('装饰实例缓存上限（widget deco cache）', () => {
  // 契约：以用户内容为键的 widget 装饰缓存必须有界——无上限时大文档滚动
  // 会按出现过的双链/图片文本无限累积实例。命中复用 + 超限逐最旧（LRU）
  it('同 display/src+alt 复用同一装饰实例', () => {
    expect(wikilinkWidgetDeco('显示甲')).toBe(wikilinkWidgetDeco('显示甲'))
    expect(imageWidgetDeco('src-a', 'alt', undefined)).toBe(imageWidgetDeco('src-a', 'alt', undefined))
    expect(imageWidgetDeco('src-a', 'alt', undefined)).not.toBe(imageWidgetDeco('src-b', 'alt', undefined))
  })

  it('超限后逐最旧回收：早期键重新获取得到新实例', () => {
    const first = wikilinkWidgetDeco('首个显示')
    for (let i = 0; i < WIDGET_DECO_CACHE_LIMIT + 16; i++) {
      wikilinkWidgetDeco(`批量显示 ${i}`)
    }
    // 「首个显示」已被淘汰：再次获取重建实例（不等于旧引用）
    expect(wikilinkWidgetDeco('首个显示')).not.toBe(first)
  })

  it('近期访问的键不被淘汰（LRU 而非 FIFO）', () => {
    const pinned = wikilinkWidgetDeco('常驻显示')
    for (let i = 0; i < WIDGET_DECO_CACHE_LIMIT + 8; i++) {
      if (i % 64 === 0) {
        wikilinkWidgetDeco('常驻显示') // 周期性命中刷新热度
      }
      wikilinkWidgetDeco(`竞争显示 ${i}`)
    }
    expect(wikilinkWidgetDeco('常驻显示')).toBe(pinned)
  })
})
