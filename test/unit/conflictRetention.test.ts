// 工单 #4 契约：冲突时保留未确认输入并暂停写回（宿主侧）。
// - 不可安全应用（重定位失败 / 版本超前 / versionLog 缺口 / applyEdit 失败）
//   时：不覆盖权威文本、面板进入暂停（suspended）、记录未确认输入片段、
//   发 conflict/error ack 附权威全文、触发通知回调
// - 暂停面板的后续 edit.request 一律拒绝，不再写入权威文档
// - conflict.report 更新 webview 本地全文快照；resumePanel 发 doc.resync 恢复
// - 面板关闭（含 SSH 断连触发的 dispose）时存在未确认输入必须通知，
//   不得静默丢弃（不得误报已保存）
import { describe, it, expect } from 'vitest'
import {
  DocumentSession,
  type HostDocumentPort,
  type SessionNotice,
} from '../../src/host/documentSession'
import type { HostToWebview, SerChange, WebviewToHost } from '../../src/shared/protocol'

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

class FakeDoc implements HostDocumentPort {
  content: string
  ver: number
  applyCalls: SerChange[][] = []
  applyResult = true
  fireChangeOnApply = true
  /** 挂起 applyChanges（构造在途未确认窗口）；resolve 后继续 */
  applyGate: Promise<void> | undefined
  private listener: ((changes: SerChange[], version: number) => void) | undefined

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

  async applyChanges(changes: SerChange[]): Promise<boolean> {
    this.applyCalls.push(changes)
    if (this.applyGate) {
      await this.applyGate
    }
    if (!this.applyResult) return false
    this.content = applyToText(this.content, changes)
    this.ver++
    if (this.fireChangeOnApply) {
      this.listener?.(changes, this.ver)
    }
    return true
  }

  async undo(): Promise<boolean> {
    return false
  }

  async redo(): Promise<boolean> {
    return false
  }
}

const DOC_URI = 'file:///d%3A/notes/conflict.md'

function setup(text = '# 标题\n正文内容') {
  const doc = new FakeDoc(text)
  const notices: SessionNotice[] = []
  const session = new DocumentSession(doc, {
    docUri: DOC_URI,
    onNotice: (n) => notices.push(n),
  })
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
  return { doc, session, attach, send, sent, notices }
}

async function readyPanel(s: ReturnType<typeof setup>, sessionId: string): Promise<void> {
  await s.send(sessionId, { kind: 'ready' })
  expect(s.sent.get(sessionId)!.at(-1)?.kind).toBe('init')
}

function editRequest(
  sessionId: string,
  seq: number,
  baseVersion: number,
  changes: SerChange[],
): WebviewToHost {
  return { kind: 'edit.request', sessionId, docUri: DOC_URI, seq, baseVersion, changes }
}

function acksOf(s: ReturnType<typeof setup>, sessionId: string) {
  return s.sent
    .get(sessionId)!
    .filter((m): m is Extract<HostToWebview, { kind: 'edit.ack' }> => m.kind === 'edit.ack')
}

describe('不可安全应用时保留输入并暂停写回', () => {
  it('重定位失败：发 conflict ack 附权威全文、面板暂停、记录输入片段并通知', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    // 第一笔编辑替换 [0,3)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '整段替换文案' }]))
    // 第二笔基于旧版本、区间落入被替换区 → 不可安全重定位
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: '我的未确认输入' }]))

    expect(s.doc.applyCalls).toHaveLength(1) // 权威文档不被第二次写入污染
    const ack2 = acksOf(s, id)[1]
    expect(ack2).toMatchObject({ seq: 2, ok: false, reason: 'conflict' })
    if (ack2 && !ack2.ok) {
      expect(ack2.text).toBe(s.doc.content) // 附权威全文，供 webview 对账而非覆盖
    }
    const state = s.session.getConflictState(id)
    expect(state?.suspended).toBe(true)
    expect(state?.fragments).toEqual(['我的未确认输入'])
    expect(s.notices).toContainEqual(expect.objectContaining({ type: 'conflict', sessionId: id }))
  })

  it('暂停面板的后续 edit.request 被拒绝且不 applyEdit', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '外部段落' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'X' }]))
    const applyCount = s.doc.applyCalls.length
    // 暂停后的正常请求（版本匹配）也必须拒绝：面板状态已不可信
    await s.send(id, editRequest(id, 3, s.doc.ver, [{ offset: 0, length: 0, text: 'Y' }]))
    expect(s.doc.applyCalls).toHaveLength(applyCount)
    const ack3 = acksOf(s, id).at(-1)
    expect(ack3).toMatchObject({ seq: 3, ok: false, reason: 'conflict' })
    // 新的未确认输入继续累积进快照（不丢字）
    expect(s.session.getConflictState(id)?.fragments).toEqual(['X', 'Y'])
  })

  it('baseVersion 超前（迟到异常）同样 conflict 保留', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 99, [{ offset: 0, length: 0, text: '未来输入' }]))
    expect(s.doc.applyCalls).toHaveLength(0)
    expect(acksOf(s, id)[0]).toMatchObject({ ok: false, reason: 'conflict' })
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
  })

  it('versionLog 超限截断后：基于缺口版本的请求 conflict，不静默错位应用', async () => {
    const s = setup('0123456789')
    const id = s.attach()
    await readyPanel(s, id)
    // 灌入 260 组外部变更，仅保留最近 256 组 → 对 baseVersion=1 存在缺口
    for (let i = 0; i < 260; i++) {
      s.doc.content = applyToText(s.doc.content, [{ offset: 0, length: 0, text: 'X' }])
      s.doc.ver++
      s.session.handleDocChanged([{ offset: 0, length: 0, text: 'X' }], s.doc.ver)
    }
    // 基于最初版本的请求：既有组不完整，重定位必然不可信
    await s.send(id, editRequest(id, 1, 1, [{ offset: 5, length: 1, text: '迟到输入' }]))
    expect(s.doc.applyCalls).toHaveLength(0)
    expect(acksOf(s, id)[0]).toMatchObject({ ok: false, reason: 'conflict' })
    expect(s.session.getConflictState(id)?.fragments).toEqual(['迟到输入'])
  })

  it('applyChanges 失败：error ack 附权威全文、面板暂停并通知（不虚报成功）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    s.doc.applyResult = false
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 0, text: '写不进去的输入' }]))
    const ack = acksOf(s, id)[0]
    expect(ack).toMatchObject({ seq: 1, ok: false, reason: 'error' })
    if (ack && !ack.ok) {
      expect(ack.text).toBe(s.doc.content)
    }
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
    expect(s.session.getConflictState(id)?.fragments).toEqual(['写不进去的输入'])
    expect(s.notices.some((n) => n.type === 'conflict')).toBe(true)
  })

  it('同一面板重复冲突只通知一次（避免通知风暴）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))
    await s.send(id, editRequest(id, 3, 1, [{ offset: 1, length: 1, text: 'B' }]))
    expect(s.notices.filter((n) => n.type === 'conflict')).toHaveLength(1)
  })
})

describe('conflict.report 与快照取回', () => {
  it('webview 上报的本地全文更新快照，供复制取回', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))
    await s.send(id, {
      kind: 'conflict.report',
      sessionId: id,
      docUri: DOC_URI,
      version: 1,
      text: '# 标题\n正文内容 + A',
    })
    const state = s.session.getConflictState(id)
    expect(state?.webviewText).toBe('# 标题\n正文内容 + A')
    expect(state?.webviewVersion).toBe(1)
    // fragments 不被 report 覆盖（两种取回形态并存）
    expect(state?.fragments).toEqual(['A'])
  })

  it('conflict.action copy 触发复制请求回调；resume 恢复面板', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))

    await s.send(id, { kind: 'conflict.action', sessionId: id, docUri: DOC_URI, action: 'copy' })
    expect(s.notices.some((n) => n.type === 'copy-request' && n.sessionId === id)).toBe(true)

    await s.send(id, { kind: 'conflict.action', sessionId: id, docUri: DOC_URI, action: 'resume' })
    const resync = s.sent.get(id)!.at(-1)
    expect(resync).toMatchObject({ kind: 'doc.resync', version: s.doc.ver, text: s.doc.getText() })
    expect(s.session.getConflictState(id)?.suspended).toBe(false)
  })
})

describe('resumePanel：恢复写回', () => {
  it('resume 后清快照、后续 edit.request 正常应用', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))
    s.session.resumePanel(id)
    expect(s.session.getConflictState(id)?.suspended).toBe(false)
    expect(s.session.getConflictState(id)?.fragments).toEqual([])

    await s.send(id, editRequest(id, 3, s.doc.ver, [{ offset: 0, length: 0, text: '恢复后输入' }]))
    expect(s.doc.applyCalls.at(-1)).toEqual([{ offset: 0, length: 0, text: '恢复后输入' }])
    expect(acksOf(s, id).at(-1)).toMatchObject({ seq: 3, ok: true })
  })
})

describe('隐藏恢复（webview 重载）与暂停生命周期', () => {
  it('suspended 面板重新 ready：init 后跟随 session.suspended，快照保留', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))

    // 模拟 retainContextWhenHidden 关闭导致的 webview 重载：重新 ready
    await s.send(id, { kind: 'ready' })
    const msgs = s.sent.get(id)!
    const initIdx = msgs.map((m) => m.kind).lastIndexOf('init')
    const afterInit = msgs[initIdx + 1]
    expect(afterInit).toMatchObject({ kind: 'session.suspended', reason: 'conflict' })
    expect(s.session.getConflictState(id)?.fragments).toEqual(['A'])
  })

  it('宿主错误（applyEdit 失败）导致的暂停：重载后 session.suspended 透传真实原因', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    s.doc.applyResult = false // 写回通道失败 → 暂停原因是 host-error 而非 conflict
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
    await s.send(id, { kind: 'ready' })
    const msgs = s.sent.get(id)!
    const initIdx = msgs.map((m) => m.kind).lastIndexOf('init')
    expect(msgs[initIdx + 1]).toMatchObject({ kind: 'session.suspended', reason: 'host-error' })
  })

  it('未暂停面板 ready 重发普通 init，不携带 session.suspended', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, { kind: 'ready' })
    const kinds = s.sent.get(id)!.map((m) => m.kind)
    expect(kinds).not.toContain('session.suspended')
  })
})

describe('面板关闭 / SSH 断连：未确认输入不静默丢弃', () => {
  it('存在未确认 pending 时 detach 触发关闭通知并携带输入片段', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    // 构造在途未确认：applyChanges 挂起（真实 vscode.applyEdit 的异步窗口）
    let release!: () => void
    s.doc.applyGate = new Promise((r) => {
      release = r
    })
    const pending = s.send(id, editRequest(id, 1, 1, [{ offset: 3, length: 0, text: '在途输入' }]))
    await new Promise((r) => setTimeout(r, 0)) // 让请求进入 applyChanges 等待
    s.session.detachPanel(id)
    release()
    await pending
    const notice = s.notices.find((n) => n.type === 'panel-closed-with-input')
    expect(notice).toBeDefined()
    if (notice?.type === 'panel-closed-with-input') {
      expect(notice.fragments).toEqual(['在途输入'])
    }
  })

  it('suspended 面板 detach 也触发关闭通知（快照片段随通知带走）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))
    s.session.detachPanel(id)
    const notice = s.notices.find((n) => n.type === 'panel-closed-with-input')
    expect(notice).toBeDefined()
    if (notice?.type === 'panel-closed-with-input') {
      expect(notice.fragments).toEqual(['A'])
    }
  })

  it('无未确认输入的 detach 保持静默（不误报）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    s.session.detachPanel(id)
    expect(s.notices).toHaveLength(0)
  })
})

describe('第二视图（split）：冲突暂停只影响冲突面板', () => {
  it('面板 A 冲突暂停后面板 B 的正常编辑仍可应用', async () => {
    const s = setup()
    const idA = s.attach()
    const idB = s.attach()
    await readyPanel(s, idA)
    await readyPanel(s, idB)
    await s.send(idA, editRequest(idA, 1, 1, [{ offset: 0, length: 3, text: '替换' }]))
    await s.send(idA, editRequest(idA, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))
    expect(s.session.getConflictState(idA)?.suspended).toBe(true)

    await s.send(idB, editRequest(idB, 1, s.doc.ver, [{ offset: 0, length: 0, text: 'B 输入' }]))
    expect(acksOf(s, idB).at(-1)).toMatchObject({ seq: 1, ok: true })
    expect(s.session.getConflictState(idB)?.suspended).toBe(false)
  })
})

describe('R-1：暂停/暂缓输入经 conflict.report 刷新后的关闭取回', () => {
  // 场景：暂停后继续输入只存在于 webview 本地（不发 edit.request），
  // 面板关闭后 fetchPanelText 超时、fragments 只含暂停时刻片段——完整
  // 取回依赖 webview 防抖重报的 conflict.report 全文快照随通知带走。
  it('暂停面板关闭：通知携带最新快照全文（含暂停后新输入）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    // 制造暂停（不可安全应用路径）
    await s.send(id, editRequest(id, 1, 1, [{ offset: 0, length: 3, text: '整段替换' }]))
    await s.send(id, editRequest(id, 2, 1, [{ offset: 1, length: 1, text: 'A' }]))
    // webview 防抖重报：全文含暂停后新输入
    await s.send(id, {
      kind: 'conflict.report',
      sessionId: id,
      docUri: DOC_URI,
      version: 1,
      text: '暂停后新输入+整段替换内容',
    })
    s.session.detachPanel(id)
    const notice = s.notices.find((n) => n.type === 'panel-closed-with-input')
    expect(notice).toBeDefined()
    if (notice?.type === 'panel-closed-with-input') {
      expect(notice.fragments).toEqual(['A'])
      expect(notice.webviewText).toBe('暂停后新输入+整段替换内容')
    }
  })

  it('暂缓集场景（未暂停）：conflict.report 快照同样随关闭通知带走', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    // 在途未确认（applyGate 挂起）+ webview 暂缓集上报全文
    let release!: () => void
    s.doc.applyGate = new Promise((r) => {
      release = r
    })
    const pending = s.send(id, editRequest(id, 1, 1, [{ offset: 3, length: 0, text: '在途A' }]))
    await new Promise((r) => setTimeout(r, 0))
    await s.send(id, {
      kind: 'conflict.report',
      sessionId: id,
      docUri: DOC_URI,
      version: 1,
      text: 'abc在途A暂缓B',
    })
    s.session.detachPanel(id)
    release()
    await pending
    const notice = s.notices.find((n) => n.type === 'panel-closed-with-input')
    expect(notice).toBeDefined()
    if (notice?.type === 'panel-closed-with-input') {
      expect(notice.webviewText).toBe('abc在途A暂缓B')
    }
  })
})
