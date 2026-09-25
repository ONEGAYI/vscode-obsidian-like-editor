// @vitest-environment jsdom
// 工单 #48 契约：外部增量与「宿主已应用、ack 未回」本地编辑的竞态。
// - 竞态窗口：applyEdit 的文本变更已完成，但回流事件与 promise resolve
//   尚未返回；外部来源（另一窗口同文件、磁盘热更新）的变更回流先被
//   handleDocChanged 处理——此时外部增量 X 的坐标基于已含 E 的权威文本，
//   而 webview 逆穿用的 ackedChain/unconfirmed 不含 E
// - 未修复行为：doc.changed(X) 先于 ack(E) 广播，webview 把 X 当 base 系
//   穿 unconfirmed，E 的偏移被计算两次 → 外部文本落点偏移 len(E)，ack(E)
//   到达后错位固化，无暂停信号；重叠场景被误判为冲突暂停（保守但错失
//   正确合并机会）
// - 修复契约（宿主侧顺序收口）：面板存在「已应用未确认」pending 条目时，
//   外部增量暂存不广播；pending 确认（回流 / 兜底）后按 version 序补发，
//   保证 webview 收到的序列是 ack(E) → doc.changed(X)，其既有状态机在
//   正确序列下自然正确
// - 不放宽冲突判定：真冲突（外部增量与「宿主尚未应用」的在途本地编辑
//   真实重叠）仍走冲突暂停（见「真冲突守卫」用例）
import { describe, it, expect } from 'vitest'
import { DocumentSession, type HostDocumentPort } from '../../src/host/documentSession'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { HostToWebview, SerChange, WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/race.md'

// DOM 输入用例会经过 CM6 的异步测量；jsdom 没有布局，提供空测量结果。
if (Range.prototype.getClientRects === undefined) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

function applyToText(text: string, changes: SerChange[]): string {
  const sorted = [...changes].sort((a, b) => a.offset - b.offset)
  let out = text
  let shift = 0
  for (const c of sorted) {
    out = out.slice(0, c.offset + shift) + c.text + out.slice(c.offset + shift + c.length)
    shift += c.text.length - c.length
  }
  return out
}

/**
 * 可控时序的权威文档：holdNext 让下一笔 applyChanges 完成文本变更与版本
 * 推进（模拟 applyEdit 已写入 TextDocument），但回流事件与 promise resolve
 * 由测试手动触发——这正是 #48 的竞态窗口（外部回流可插在此窗口内先行）。
 */
class GatedDoc implements HostDocumentPort {
  content: string
  ver: number
  applyCalls: SerChange[][] = []
  holdNext = false
  private listener: ((changes: SerChange[], version: number) => void) | undefined
  private releaseFn: (() => void) | undefined

  constructor(text: string) {
    this.content = text
    this.ver = 1
  }

  get version(): number {
    return this.ver
  }

  getText(): string {
    return this.content
  }

  onDocChanged(cb: (changes: SerChange[], version: number) => void): void {
    this.listener = cb
  }

  applyChanges(changes: SerChange[]): Promise<boolean> {
    this.applyCalls.push(changes)
    this.content = applyToText(this.content, changes)
    this.ver++
    if (this.holdNext) {
      this.holdNext = false
      return new Promise<boolean>((resolve) => {
        this.releaseFn = () => resolve(true)
      })
    }
    this.listener?.(changes, this.ver)
    return Promise.resolve(true)
  }

  /** 结束挂起：applyChanges resolve，宿主兜底确认路径继续 */
  release(): void {
    const fn = this.releaseFn
    this.releaseFn = undefined
    fn?.()
  }

  /** 手动触发挂起编辑的迟到回流（version 用回流到达时的真实版本） */
  fireHeldEcho(changes: SerChange[], version: number): void {
    this.listener?.(changes, version)
  }

  /** 测试直接模拟外部来源变更（另一窗口 / 磁盘），立即走回流广播 */
  externalChange(changes: SerChange[]): void {
    this.content = applyToText(this.content, changes)
    this.ver++
    this.listener?.(changes, this.ver)
  }

  async undo(): Promise<boolean> {
    return false
  }

  async redo(): Promise<boolean> {
    return false
  }
}

function setupHost(text = 'abcdef') {
  const doc = new GatedDoc(text)
  const session = new DocumentSession(doc, { docUri: DOC_URI })
  doc.onDocChanged((changes, version) => session.handleDocChanged(changes, version))
  const sent = new Map<string, HostToWebview[]>()
  const attach = (): string => {
    const out: HostToWebview[] = []
    const sessionId = session.attachPanel({ send: (m) => out.push(m) })
    sent.set(sessionId, out)
    return sessionId
  }
  const send = async (sessionId: string, msg: WebviewToHost) =>
    session.handleWebviewMessage(msg, sessionId)
  return { doc, session, attach, send, sent }
}

async function readyPanel(s: ReturnType<typeof setupHost>, sessionId: string): Promise<void> {
  await s.send(sessionId, { kind: 'ready' })
  expect(s.sent.get(sessionId)!.at(-1)?.kind).toBe('init')
  s.sent.get(sessionId)!.length = 0
}

function editRequest(
  sessionId: string,
  seq: number,
  baseVersion: number,
  changes: SerChange[],
): WebviewToHost {
  return { kind: 'edit.request', sessionId, docUri: DOC_URI, seq, baseVersion, changes }
}

/** Controller ↔ DocumentSession 桥接装配（端到端落点断言用） */
function setupPair(text = 'abcdef') {
  const doc = new GatedDoc(text)
  const toWebview: HostToWebview[] = []
  const session = new DocumentSession(doc, { docUri: DOC_URI })
  doc.onDocChanged((changes, version) => session.handleDocChanged(changes, version))
  const sessionId = session.attachPanel({ send: (m) => toWebview.push(m) })
  const bridge: VsCodeBridge = {
    postMessage: (m) => {
      void session.handleWebviewMessage(m, sessionId)
    },
    getState: <T,>() => undefined as T | undefined,
    setState: () => undefined,
  }
  const controller = new WebviewSyncController(bridge)
  controller.mount(document.createElement('div'))
  void session.handleWebviewMessage({ kind: 'ready' }, sessionId)
  controller.handleHostMessage(toWebview.at(-1)!)
  toWebview.length = 0
  const settle = async () => {
    let idle = 0
    for (let i = 0; i < 20 && idle < 2; i++) {
      await new Promise((r) => setTimeout(r, 0))
      const messages = toWebview.splice(0)
      for (const message of messages) controller.handleHostMessage(message)
      idle = messages.length === 0 ? idle + 1 : 0
    }
  }
  return { doc, session, controller, sessionId, settle, toWebview }
}

describe('宿主侧：已应用未确认窗口内外部增量暂存与有序补发', () => {
  it('pending 未确认时外部增量不广播，兜底确认后 ack 先于补发', async () => {
    const s = setupHost()
    const id = s.attach()
    await readyPanel(s, id)
    const eChange = { offset: 0, length: 0, text: 'ZZ' }
    s.doc.holdNext = true
    void s.send(id, editRequest(id, 1, 1, [eChange])) // E 已应用（v2）、pending 未确认
    await new Promise((r) => setTimeout(r, 0))
    expect(s.doc.content).toBe('ZZabcdef')

    // 竞态窗口内：外部回流先于 E 的回流被处理
    s.doc.externalChange([{ offset: 8, length: 0, text: 'X' }]) // v3

    // 契约：ack(E) 未发前不得广播 X（webview 的 ackedChain 尚不含 E）
    expect(s.sent.get(id)!.filter((m) => m.kind === 'doc.changed')).toEqual([])

    s.doc.release() // applyEdit resolve → 兜底确认 → ack(E) → 补发 X
    await new Promise((r) => setTimeout(r, 0))
    const msgs = s.sent.get(id)!
    const ackIndex = msgs.findIndex((m) => m.kind === 'edit.ack')
    const changedIndex = msgs.findIndex((m) => m.kind === 'doc.changed')
    expect(ackIndex).toBeGreaterThanOrEqual(0)
    expect(changedIndex).toBeGreaterThan(ackIndex)
    expect(msgs[changedIndex]).toMatchObject({
      kind: 'doc.changed',
      version: 3,
      changes: [{ offset: 8, length: 0, text: 'X' }],
      origin: 'external',
    })
  })

  it('回流确认路径同样保证顺序：ack(E) 先于外部增量广播', async () => {
    const s = setupHost()
    const id = s.attach()
    await readyPanel(s, id)
    const eChange = { offset: 0, length: 0, text: 'ZZ' }
    s.doc.holdNext = true
    void s.send(id, editRequest(id, 1, 1, [eChange]))
    await new Promise((r) => setTimeout(r, 0))

    s.doc.externalChange([{ offset: 8, length: 0, text: 'X' }]) // v3，先到达
    expect(s.sent.get(id)!.filter((m) => m.kind === 'doc.changed')).toEqual([])

    // E 的回流迟到（在 X 之后被处理）：匹配 pending head → 确认 → 补发
    s.doc.fireHeldEcho([eChange], 2)
    await new Promise((r) => setTimeout(r, 0))
    const msgs = s.sent.get(id)!
    const ack = msgs.find((m) => m.kind === 'edit.ack')
    expect(ack).toMatchObject({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    const ackIndex = msgs.findIndex((m) => m.kind === 'edit.ack')
    const changedIndex = msgs.findIndex((m) => m.kind === 'doc.changed')
    expect(changedIndex).toBeGreaterThan(ackIndex)
    expect(msgs[changedIndex]).toMatchObject({ version: 3 })

    // 收尾：applyEdit resolve（entry 已确认，幂等跳过）
    s.doc.release()
    await new Promise((r) => setTimeout(r, 0))
  })

  it('多笔外部增量按 version 有序补发', async () => {
    const s = setupHost()
    const id = s.attach()
    await readyPanel(s, id)
    s.doc.holdNext = true
    void s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 0, text: 'ZZ' }]))
    await new Promise((r) => setTimeout(r, 0))

    s.doc.externalChange([{ offset: 8, length: 0, text: 'X' }]) // v3
    s.doc.externalChange([{ offset: 9, length: 0, text: 'Y' }]) // v4
    expect(s.sent.get(id)!.filter((m) => m.kind === 'doc.changed')).toEqual([])

    s.doc.release()
    await new Promise((r) => setTimeout(r, 0))
    const versions = s.sent
      .get(id)!
      .filter((m): m is Extract<HostToWebview, { kind: 'doc.changed' }> => m.kind === 'doc.changed')
      .map((m) => m.version)
    expect(versions).toEqual([3, 4])
  })

  it('旁观面板先收到 E 的广播再收到补发的 X（参考系按序对齐）', async () => {
    const s = setupHost()
    const idA = s.attach()
    const idB = s.attach()
    await readyPanel(s, idA)
    await readyPanel(s, idB)
    const eChange = { offset: 0, length: 0, text: 'ZZ' }
    s.doc.holdNext = true
    void s.send(idA, editRequest(idA, 1, 1, [eChange]))
    await new Promise((r) => setTimeout(r, 0))

    s.doc.externalChange([{ offset: 8, length: 0, text: 'X' }]) // v3
    // 旁观面板 B 尚未见到 E（其广播在确认时才发），X 也不得先行
    expect(s.sent.get(idB)!.filter((m) => m.kind === 'doc.changed')).toEqual([])

    s.doc.fireHeldEcho([eChange], 2) // 确认：B 收到 doc.changed(E)，随后补发 X
    await new Promise((r) => setTimeout(r, 0))
    s.doc.release()
    await new Promise((r) => setTimeout(r, 0))
    const bChanges = s.sent
      .get(idB)!
      .filter((m): m is Extract<HostToWebview, { kind: 'doc.changed' }> => m.kind === 'doc.changed')
    expect(bChanges.map((m) => m.version)).toEqual([2, 3])
    expect(bChanges[0]!.changes).toEqual([eChange])
    expect(bChanges[1]!.changes).toEqual([{ offset: 8, length: 0, text: 'X' }])
  })
})

describe('桥接端到端：已应用未确认窗口的外部增量落点（#48 核心回归）', () => {
  it('不重叠外部增量落点正确，不再偏移 len(E)', async () => {
    const { doc, controller, session, sessionId, settle } = setupPair('abcdef')
    const view = controller.getView()!
    doc.holdNext = true
    view.dispatch({ changes: { from: 0, insert: 'ZZ' } }) // E：权威 v2，pending 未确认
    await new Promise((r) => setTimeout(r, 0)) // 等微任务：applyChanges 已提交文本、挂起 resolve
    expect(doc.content).toBe('ZZabcdef')

    // 竞态窗口内：另一窗口在权威 offset 8（含 ZZ 的坐标系）插入 'X'
    doc.externalChange([{ offset: 8, length: 0, text: 'X' }]) // v3
    doc.release() // 兜底确认 → ack(E) → 补发 X
    await settle()

    // 未修复时 doc.changed(X) 先于 ack(E) 到达 webview，穿 unconfirmed 多算
    // 一次 ZZ 的偏移 → 'ZZabcdXef'；修复后正确落点
    expect(view.state.doc.toString()).toBe('ZZabcdefX')
    expect(doc.content).toBe('ZZabcdefX')
    expect(session.getConflictState(sessionId)?.suspended).toBe(false)
    controller.dispose()
  })

  it('与已应用 E 重叠的外部增量：ack 先行后正确合并，不再误判冲突暂停', async () => {
    const { doc, controller, session, sessionId, settle } = setupPair('abcdef')
    const view = controller.getView()!
    doc.holdNext = true
    view.dispatch({ changes: { from: 0, to: 4, insert: 'ZZ' } }) // E：权威 'ZZef' v2
    await new Promise((r) => setTimeout(r, 0))
    doc.externalChange([{ offset: 0, length: 2, text: 'Q' }]) // X：权威 'Qef' v3，与 E 重叠
    doc.release()
    await settle()

    // 未修复时 X 与 unconfirmed 重叠 → 冲突暂停（保守）；权威已含两者合并
    // 结果（先 E 后 X），正确语义是 ack 后直接应用
    expect(view.state.doc.toString()).toBe('Qef')
    expect(doc.content).toBe('Qef')
    expect(session.getConflictState(sessionId)?.suspended).toBe(false)
    controller.dispose()
  })

  it('真冲突守卫：外部增量与宿主尚未应用的本地编辑重叠仍暂停', async () => {
    const { doc, controller, session, sessionId, settle } = setupPair('abcdef')
    const view = controller.getView()!
    // 本地编辑刚发出（请求仍在微任务队列，宿主尚未 push pending），
    // 外部变更同步到达并立即广播——此时 X 的参考系不含本地编辑，
    // 真实重叠无法安全合并，必须走冲突暂停保留本地输入
    view.dispatch({ changes: { from: 2, to: 4, insert: 'ZZ' } })
    doc.externalChange([{ offset: 2, length: 2, text: 'Q' }])
    await settle()

    expect(session.getConflictState(sessionId)?.suspended).toBe(true)
    expect(doc.content).toBe('abQef') // 权威：X 已应用，被拒的 E 不写入
    expect(view.state.doc.toString()).toBe('abZZef') // 本地输入保留
    controller.dispose()
  })

  it('补发后继续输入：新编辑写回与权威保持一致', async () => {
    const { doc, controller, settle } = setupPair('abcdef')
    const view = controller.getView()!
    doc.holdNext = true
    view.dispatch({ changes: { from: 0, insert: 'ZZ' } })
    await new Promise((r) => setTimeout(r, 0))
    doc.externalChange([{ offset: 8, length: 0, text: 'X' }])
    doc.release()
    await settle()
    expect(view.state.doc.toString()).toBe('ZZabcdefX')

    view.dispatch({ changes: { from: 9, insert: '!' } })
    await settle()
    expect(doc.content).toBe('ZZabcdefX!')
    expect(view.state.doc.toString()).toBe('ZZabcdefX!')
    controller.dispose()
  })
})
