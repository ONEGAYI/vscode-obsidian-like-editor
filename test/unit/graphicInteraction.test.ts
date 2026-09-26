// 图形化代码块交互契约（工单 #111，控制器级 jsdom）：禁点击进编辑、
// edit 按钮迁移编辑入口、popup 打开/关闭/刷新/导出消息、阅读视图按钮组
// 形态（popup-only）。真实键鼠与观感回归在 test/browser 与集成层。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import {
  __resetMermaidRenderStateForTest,
  __setMermaidApiForTest,
  type MermaidApi,
} from '../../src/webview/mermaidRender'
import { closeDiagramPopup, isDiagramPopupOpen } from '../../src/webview/diagramPopup'
import type { WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/g.md'
const DOC = '```mermaid\nA-->B\n```\n'
const MOCK_SVG =
  '<svg id="mmd-r1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80">' +
  '<g id="n1"><rect width="120" height="80"></rect></g></svg>'

if (Range.prototype.getClientRects === undefined) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

function makeBridge() {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: () => undefined,
    setState: () => undefined,
  }
  return { bridge, sent }
}

function mockMermaid(): MermaidApi & { renders: string[] } {
  const renders: string[] = []
  const api: MermaidApi & { renders: string[] } = {
    renders,
    initialize() {},
    async render(_id, code) {
      renders.push(code)
      return { svg: MOCK_SVG }
    },
  }
  __setMermaidApiForTest(api)
  return api
}

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

function mountDoc(bridge: VsCodeBridge): WebviewSyncController {
  const controller = new WebviewSyncController(bridge)
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  controller.mount(parent)
  controller.handleHostMessage({
    kind: 'init',
    sessionId: 's1',
    docUri: DOC_URI,
    version: 1,
    text: DOC,
  })
  // 光标初始在文档头 = 围栏区间内（源码显形）；移到文末让呈现态 widget 发射
  const view = controller.getView()!
  view.dispatch({ selection: { anchor: view.state.doc.length } })
  return controller
}

afterEach(() => {
  closeDiagramPopup()
  __resetMermaidRenderStateForTest()
  document.body.textContent = ''
})

describe('Live 视图：按钮组与禁点击（契约 1–3）', () => {
  it('渲染成功后 frame 内有 edit+popup 两枚按钮（仅渲染成功态显示由 CSS 承担）', async () => {
    mockMermaid()
    const { bridge } = makeBridge()
    const c = mountDoc(bridge)
    await settle()
    const frame = c.getView()!.dom.querySelector('.vsidian-graphic-frame')
    expect(frame).not.toBeNull()
    const inner = frame!.querySelector('.vsidian-mermaid')
    expect(inner!.getAttribute('data-vsidian-mermaid-state')).toBe('rendered')
    const buttons = frame!.querySelectorAll('.vsidian-graphic-chrome button')
    expect(buttons).toHaveLength(2)
    expect(frame!.querySelector('.vsidian-graphic-chrome-edit')).not.toBeNull()
    expect(frame!.querySelector('.vsidian-graphic-chrome-popup')).not.toBeNull()
  })

  it('点击图形本体：光标不落位、渲染图不退场（禁点击进编辑）', async () => {
    mockMermaid()
    const { bridge } = makeBridge()
    const c = mountDoc(bridge)
    await settle()
    const view = c.getView()!
    const anchorBefore = view.state.selection.main.anchor
    const frame = view.dom.querySelector('.vsidian-graphic-frame')!
    frame.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    frame.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    frame.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    expect(view.state.selection.main.anchor).toBe(anchorBefore)
    expect(view.dom.querySelector('.vsidian-graphic-frame')).not.toBeNull()
  })

  it('点击 edit 按钮：光标落围栏起点、源码显形（编辑入口迁移）', async () => {
    mockMermaid()
    const { bridge } = makeBridge()
    const c = mountDoc(bridge)
    await settle()
    const view = c.getView()!
    const edit = view.dom.querySelector('.vsidian-graphic-chrome-edit') as HTMLButtonElement
    edit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    edit.click()
    await settle()
    // DOC 以围栏开头：fence.from = 0，光标触及区间即源码显形
    expect(view.state.selection.main.anchor).toBe(0)
    expect(view.dom.querySelector('.vsidian-graphic-frame')).toBeNull()
    expect(view.state.doc.toString()).toBe(DOC)
  })
})

describe('图表弹窗（契约 4–6）', () => {
  it('popup 打开装载快照；Esc 关闭并恢复 body overflow', async () => {
    mockMermaid()
    const { bridge } = makeBridge()
    const c = mountDoc(bridge)
    await settle()
    ;(c.getView()!.dom.querySelector('.vsidian-graphic-chrome-popup') as HTMLButtonElement).click()
    await settle()
    expect(isDiagramPopupOpen()).toBe(true)
    const overlay = document.querySelector('.vsidian-diagram-overlay')
    expect(overlay).not.toBeNull()
    expect(overlay!.getAttribute('role')).toBe('dialog')
    expect(overlay!.querySelector('.vsidian-diagram-media svg')).not.toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    overlay!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(isDiagramPopupOpen()).toBe(false)
    expect(document.querySelector('.vsidian-diagram-overlay')).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })

  it('刷新按钮按当前源码重取（同源码命中缓存不重复 render，弹窗保持）', async () => {
    const api = mockMermaid()
    const { bridge } = makeBridge()
    const c = mountDoc(bridge)
    await settle()
    const rendersBefore = api.renders.length
    ;(c.getView()!.dom.querySelector('.vsidian-graphic-chrome-popup') as HTMLButtonElement).click()
    await settle()
    ;(document.querySelector('.vsidian-diagram-refresh') as HTMLButtonElement).click()
    await settle()
    expect(isDiagramPopupOpen()).toBe(true)
    // 弹窗装载与刷新共用 renderSvg——同源码命中渲染缓存，不重复 render
    expect(api.renders.length).toBe(rendersBefore)
    expect(document.querySelector('.vsidian-diagram-media svg')).not.toBeNull()
  })

  it('导出 SVG：经桥发出 diagram.export（含序列化 SVG 文本）', async () => {
    mockMermaid()
    const { bridge, sent } = makeBridge()
    const c = mountDoc(bridge)
    await settle()
    ;(c.getView()!.dom.querySelector('.vsidian-graphic-chrome-popup') as HTMLButtonElement).click()
    await settle()
    ;(document.querySelector('.vsidian-diagram-export-svg') as HTMLButtonElement).click()
    await settle()
    const msg = sent.find((m): m is Extract<WebviewToHost, { kind: 'diagram.export' }> =>
      m.kind === 'diagram.export')
    expect(msg).toBeDefined()
    expect(msg!.format).toBe('svg')
    expect(msg!.fileName).toBe('mermaid-diagram.svg')
    expect(msg!.content).toContain('<svg')
    expect(msg!.sessionId).toBe('s1')
  })

  it('PNG 光栅化不可用（jsdom 无 canvas）：提示降级、不发 diagram.export', async () => {
    const alerts: string[] = []
    const stub = () => alerts.push('called')
    window.alert = stub
    try {
      mockMermaid()
      const { bridge, sent } = makeBridge()
      const c = mountDoc(bridge)
      await settle()
      ;(c.getView()!.dom.querySelector('.vsidian-graphic-chrome-popup') as HTMLButtonElement).click()
      await settle()
      ;(document.querySelector('.vsidian-diagram-export-png') as HTMLButtonElement).click()
      await settle()
      expect(alerts).toHaveLength(1)
      expect(sent.filter((m) => m.kind === 'diagram.export')).toHaveLength(0)
    } finally {
      // jsdom 默认无 alert 实现，测试内替换后无需还原（下轮覆盖）
      delete (window as { alert?: unknown }).alert
    }
  })
})

describe('阅读视图：按钮组形态（契约 1 的阅读侧）', () => {
  it('渲染容器被包进 frame，按钮组仅 popup 一枚（无 edit）', async () => {
    mockMermaid()
    const { bridge } = makeBridge()
    const c = mountDoc(bridge)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    await settle()
    const frames = [...document.querySelectorAll('.vsidian-graphic-frame')].filter(
      (el) => el.closest('.vsidian-reading-block') !== null,
    )
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const frame = frames[0]!
    expect(frame.querySelector('.vsidian-mermaid')!.getAttribute('data-vsidian-mermaid-state'))
      .toBe('rendered')
    const buttons = frame.querySelectorAll('.vsidian-graphic-chrome button')
    expect(buttons).toHaveLength(1)
    expect(frame.querySelector('.vsidian-graphic-chrome-edit')).toBeNull()
    expect(frame.querySelector('.vsidian-graphic-chrome-popup')).not.toBeNull()
  })
})
