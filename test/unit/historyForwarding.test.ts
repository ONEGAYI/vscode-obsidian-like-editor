// @vitest-environment jsdom
// 撤销/重做转发契约（工单 #3）：
// - webview 键盘 Mod-Z / Mod-Shift-Z / Mod-Y 经 keymap 转发为 history.request，
//   不落入未装 CM6 history 扩展时的本地 no-op undo/redo（撤销栈归宿主）
// - 宿主 undo/redo 的回流增量（external）应用后光标折叠到合理位置
// - doc.resync（全文重同步）装载全文并推进 baseVersion
// - 转发与回流的组合不产生回声：external 增量应用后不回发 edit.request
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/h.md'

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

/** 模拟 webview 键盘事件（jsdom 的 KeyboardEvent 经 CM6 keymap 处理链路）。
 * keyCode 必须显式传入：CM6 匹配 Shift+字母 时依赖 w3c-keyname 的
 * base[keyCode] 表回退小写键名（jsdom 默认 keyCode=0 会导致误判） */
const KEY_CODES: Record<string, number> = { z: 90, Z: 90, y: 89 }
function pressKey(view: EditorView, key: string, opts: { ctrl?: boolean; shift?: boolean }) {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    keyCode: KEY_CODES[key] ?? key.charCodeAt(0),
    bubbles: true,
    cancelable: true,
  })
  view.contentDOM.dispatchEvent(event)
}

function sentHistoryRequests(sent: WebviewToHost[]) {
  return sent.filter((m) => m.kind === 'history.request')
}

describe('撤销/重做键盘转发到宿主权威栈', () => {
  it('Ctrl+Z 经 keymap 转发为 history.request undo', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '# 中文标题\n正文')
    const view = c.getView()!
    view.focus()
    pressKey(view, 'z', { ctrl: true })
    const reqs = sentHistoryRequests(sent)
    expect(reqs).toEqual([{ kind: 'history.request', op: 'undo' }])
  })

  it('Ctrl+Shift+Z 与 Ctrl+Y 转发为 redo', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc')
    const view = c.getView()!
    view.focus()
    pressKey(view, 'Z', { ctrl: true, shift: true })
    pressKey(view, 'y', { ctrl: true })
    expect(sentHistoryRequests(sent)).toEqual([
      { kind: 'history.request', op: 'redo' },
      { kind: 'history.request', op: 'redo' },
    ])
  })

  it('普通按键不被劫持：Ctrl+B 等不产生 history.request', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'abc')
    const view = c.getView()!
    view.focus()
    pressKey(view, 'b', { ctrl: true })
    pressKey(view, 'x', {})
    expect(sentHistoryRequests(sent)).toHaveLength(0)
  })

  it('未收到 init（无会话）时不转发', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    const view = c.getView()!
    view.focus()
    pressKey(view, 'z', { ctrl: true })
    expect(sentHistoryRequests(sent)).toHaveLength(0)
  })
})

describe('undo/redo 回流增量的光标行为', () => {
  it('撤销插入的外部删除增量应用后光标折叠到删除区间起点', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '你好世界', 1)
    const view = c.getView()!
    // 用户在末尾输入 '！'（本地乐观回显 + edit.request）
    view.dispatch({ changes: { from: 4, insert: '！' }, selection: { anchor: 5 } })
    expect(view.state.doc.toString()).toBe('你好世界！')
    // 宿主确认
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    // 宿主 undo 的逆增量回流：删除插入的 '！'
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: 4, length: 1, text: '' }],
    })
    expect(view.state.doc.toString()).toBe('你好世界')
    expect(view.state.selection.main.head).toBe(4)
    // 回声防护：undo 回流应用后不回发 edit.request
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
  })

  it('跨块（多行）删除的编辑以单事务描述且撤销后文本与光标恢复', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '# 标题\n\n- 列表一\n- 列表二\n\n正文段落', 1)
    const view = c.getView()!
    // 跨块选择删除：从标题行首到列表第二行行尾（跨标题、空行与列表）
    const from = 0
    const to = '# 标题\n\n- 列表一\n- 列表二'.length
    view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.changes).toEqual([{ offset: 0, length: to, text: '' }])
    expect(view.state.doc.toString()).toBe('\n\n正文段落')
    // 撤销回流：恢复被删文本
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 3,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: '# 标题\n\n- 列表一\n- 列表二' }],
    })
    expect(view.state.doc.toString()).toBe('# 标题\n\n- 列表一\n- 列表二\n\n正文段落')
    // 光标映射到恢复文本起点附近（合理位置：插入点 0）
    expect(view.state.selection.main.head).toBe(0)
  })
})

describe('doc.resync（全文重同步）', () => {
  it('装载全文并推进 baseVersion，后续编辑携带新版本', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '旧文本', 1)
    c.handleHostMessage({ kind: 'doc.resync', version: 8, text: '宿主权威文本' })
    expect(c.getView()!.state.doc.toString()).toBe('宿主权威文本')
    c.getView()!.dispatch({ changes: { from: 0, insert: '前缀' } })
    const req = sent.at(-1) as Extract<WebviewToHost, { kind: 'edit.request' }>
    expect(req.baseVersion).toBe(8)
  })

  it('resync 全文重置后不回发 edit.request（不是用户编辑）', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, 'a', 1)
    c.handleHostMessage({ kind: 'doc.resync', version: 2, text: 'b' })
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })
})
