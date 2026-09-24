// @vitest-environment jsdom
// 编辑器 webview 与设置的交互契约（#33）：
// - init 后主动发送 settings.get 拉取当前设置快照（webview 不持久化设置，
//   权威在宿主——每次装载都拉取，不依赖本地缓存）
// - settings.snapshot / settings.changed 到达后缓存，view.state 回报携带
//   settings 字段（#34 行号等设置的观测面）
// - 工具栏「设置」按钮：点击发送 settings.open（打开宿主级设置页面板）
// - 宿主侧 documentSession 对 settings.open/get 的处理（PanelPort 注入，
//   与 link.activate 同模式：真实 webview 消息与测试注入共用同一入口）
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { DocumentSession, type HostDocumentPort, type PanelPort } from '../../src/host/documentSession'
import type { HostToWebview, SettingsPayload, WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/a.md'

function makeBridge() {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => undefined as T | undefined,
    setState: () => undefined,
  }
  return { bridge, sent }
}

function mount(bridge: VsCodeBridge): WebviewSyncController {
  const controller = new WebviewSyncController(bridge)
  const parent = document.createElement('div')
  controller.mount(parent)
  return controller
}

function init(c: WebviewSyncController): void {
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: '# 标题' })
}

describe('设置快照拉取与缓存（#33）', () => {
  it('init 后主动发送 settings.get（每次装载都拉取，重载后同样）', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c)
    expect(sent).toContainEqual({ kind: 'settings.get' })
    // webview 重载（宿主在重复 ready 后重发 init）后再次拉取
    init(c)
    expect(sent.filter((m) => m.kind === 'settings.get')).toHaveLength(2)
  })

  it('settings.snapshot 与 settings.changed 都更新缓存的 settings', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c)
    sent.length = 0
    c.handleHostMessage({ kind: 'settings.snapshot', values: { 'editor.lineNumbers': true } })
    c.handleHostMessage({ kind: 'view.state.request' })
    let state = sent.find((m) => m.kind === 'view.state') as Extract<WebviewToHost, { kind: 'view.state' }>
    expect(state.settings).toEqual({ 'editor.lineNumbers': true })

    c.handleHostMessage({ kind: 'settings.changed', values: { 'editor.lineNumbers': false } })
    c.handleHostMessage({ kind: 'view.state.request' })
    const states = sent.filter((m) => m.kind === 'view.state') as Extract<WebviewToHost, { kind: 'view.state' }>[]
    state = states.at(-1)!
    expect(state.settings).toEqual({ 'editor.lineNumbers': false })
  })

  it('未收到任何设置消息时 view.state 的 settings 缺省（向后兼容）', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c)
    sent.length = 0
    c.handleHostMessage({ kind: 'view.state.request' })
    const state = sent.find((m) => m.kind === 'view.state') as Extract<WebviewToHost, { kind: 'view.state' }>
    expect(state.settings).toBeUndefined()
  })

  it('设置消息不触碰文档内容与编辑状态（纯缓存）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c)
    const before = c.getView()!.state.doc.toString()
    c.handleHostMessage({ kind: 'settings.changed', values: { 'a.b': true } })
    expect(c.getView()!.state.doc.toString()).toBe(before)
  })
})

describe('工具栏设置入口（#33）', () => {
  it('工具栏含「设置」按钮，点击发送 settings.open', () => {
    const { bridge, sent } = makeBridge()
    const parent = document.createElement('div')
    const c = new WebviewSyncController(bridge)
    c.mount(parent)
    const btn = parent.querySelector<HTMLButtonElement>(
      '.vsidian-toolbar button.vsidian-settings-toggle',
    )
    expect(btn, '工具栏应含 vsidian-settings-toggle 按钮').toBeTruthy()
    expect(btn!.textContent).toContain('设置')
    btn!.click()
    expect(sent).toContainEqual({ kind: 'settings.open' })
  })

  it('模式按钮仍在（工具栏并存两个入口）', () => {
    const { bridge } = makeBridge()
    const parent = document.createElement('div')
    const c = new WebviewSyncController(bridge)
    c.mount(parent)
    expect(parent.querySelector('.vsidian-toolbar button.vsidian-mode-toggle')).toBeTruthy()
  })
})

describe('宿主侧 documentSession 的设置消息处理（#33，与注入路径同构）', () => {
  const doc: HostDocumentPort = {
    version: 1,
    getText: () => '# 标题',
    applyChanges: async () => true,
    undo: async () => true,
    redo: async () => true,
  }

  function makeSession(settings: { snapshot: SettingsPayload }) {
    const sent: HostToWebview[] = []
    const opened: boolean[] = []
    const port: PanelPort = {
      send: (m) => sent.push(m),
      openSettings: () => {
        opened.push(true)
      },
      requestSettings: () => settings.snapshot,
    }
    const session = new DocumentSession(doc, { docUri: DOC_URI })
    const sessionId = session.attachPanel(port)
    session.handleWebviewMessage({ kind: 'ready' }, sessionId)
    return { session, sessionId, sent, opened }
  }

  it('settings.open 经 PanelPort.openSettings 执行（打开设置页不依赖文档状态）', async () => {
    const { session, sessionId, opened } = makeSession({ snapshot: {} })
    await session.handleWebviewMessage({ kind: 'settings.open' }, sessionId)
    expect(opened).toHaveLength(1)
  })

  it('settings.get 响应当前快照（settings.snapshot 回发）', async () => {
    const { session, sessionId, sent } = makeSession({ snapshot: { 'editor.lineNumbers': true } })
    sent.length = 0
    await session.handleWebviewMessage({ kind: 'settings.get' }, sessionId)
    expect(sent).toContainEqual({
      kind: 'settings.snapshot',
      values: { 'editor.lineNumbers': true },
    })
  })

  it('未注入端口（openSettings 缺省）时消息被安全忽略', async () => {
    const sent: HostToWebview[] = []
    const session = new DocumentSession(doc, { docUri: DOC_URI })
    const sessionId = session.attachPanel({ send: (m) => sent.push(m) })
    await session.handleWebviewMessage({ kind: 'ready' }, sessionId)
    await session.handleWebviewMessage({ kind: 'settings.open' }, sessionId)
    await session.handleWebviewMessage({ kind: 'settings.get' }, sessionId)
    // 无 snapshot 回发、无异常
    expect(sent.filter((m) => m.kind === 'settings.snapshot')).toHaveLength(0)
  })

  it('settings.set 不经 documentSession（设置页链路独立，无副作用）', async () => {
    const { session, sessionId, sent, opened } = makeSession({ snapshot: {} })
    await session.handleWebviewMessage(
      { kind: 'settings.set', values: { 'a.b': true } },
      sessionId,
    )
    expect(opened).toHaveLength(0)
    expect(sent.filter((m) => m.kind === 'settings.snapshot')).toHaveLength(0)
  })
})
