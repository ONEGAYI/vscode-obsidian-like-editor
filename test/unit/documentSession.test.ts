// 文档会话契约：宿主侧每个 TextDocument 一个 DocumentSession，管理多面板的
// ready 握手、edit.request 的校验与写回（seq 去重、baseVersion 过期重定位或
// 拒绝）、自家编辑确认（edit.ack）与外部变更广播（doc.changed）。
// 权威文档通过 HostDocumentPort 注入（vscode 层实现），此处用假文档驱动。
import { describe, it, expect } from 'vitest'
import { DocumentSession, type HostDocumentPort } from '../../src/host/documentSession'
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
    if (!this.applyResult) return false
    this.content = applyToText(this.content, changes)
    this.ver++
    if (this.fireChangeOnApply) {
      this.listener?.(changes, this.ver)
    }
    return true
  }
}

function setup(text = '# 标题\n正文内容') {
  const doc = new FakeDoc(text)
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

const DOC_URI = 'file:///d%3A/notes/a.md'

async function readyPanel(s: ReturnType<typeof setup>, sessionId: string): Promise<HostToWebview> {
  await s.send(sessionId, { kind: 'ready' })
  const init = s.sent.get(sessionId)!.at(-1)!
  expect(init.kind).toBe('init')
  return init
}

describe('ready 握手与 init', () => {
  it('ready 后发送 init：sessionId、docUri、全文与版本', async () => {
    const s = setup('# 你好\n')
    const id = s.attach()
    const init = await readyPanel(s, id)
    expect(init).toMatchObject({ kind: 'init', sessionId: id, version: 1, text: '# 你好\n' })
    if (init.kind === 'init') {
      expect(init.docUri).toBe(DOC_URI)
    }
  })

  it('init 的 docUri 取自构造时传入的文档 uri', async () => {
    const doc = new FakeDoc('x')
    const session = new DocumentSession(doc, { docUri: 'file:///b.md' })
    const out: HostToWebview[] = []
    const id = session.attachPanel({ send: (m) => out.push(m) })
    await session.handleWebviewMessage({ kind: 'ready' }, id)
    expect(out[0]).toMatchObject({ kind: 'init', docUri: 'file:///b.md' })
  })

  it('ready 重复到达（webview 重载）时重发最新 init', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    // 模拟外部变更推进文档
    s.doc.content = '新文本'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 0, length: 4, text: '新文本' }], 2)
    await s.send(id, { kind: 'ready' })
    const init = s.sent.get(id)!.at(-1)!
    expect(init).toMatchObject({ kind: 'init', version: 2, text: '新文本', sessionId: id })
  })

  it('未 ready 的面板不接收 doc.changed 广播（后续 init 自带最新文本）', async () => {
    const s = setup()
    const id = s.attach()
    s.doc.content = '外部改写'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 0, length: 6, text: '外部改写' }], 2)
    const msgs = s.sent.get(id)!
    expect(msgs).toHaveLength(0)
    const init = await readyPanel(s, id)
    expect(init).toMatchObject({ version: 2, text: '外部改写' })
  })
})

describe('edit.request 校验与写回', () => {
  it('baseVersion 匹配时应用变更并发 ack；其他面板收到 doc.changed', async () => {
    const s = setup()
    const idA = s.attach()
    const idB = s.attach()
    await readyPanel(s, idA)
    await readyPanel(s, idB)

    const change = { offset: 4, length: 0, text: '插入' }
    await s.send(idA, {
      kind: 'edit.request',
      sessionId: idA,
      docUri: DOC_URI,
      seq: 1,
      baseVersion: 1,
      changes: [change],
    })

    expect(s.doc.applyCalls).toEqual([[change]])
    // offset 4 是 '\n' 的位置：插入发生在换行符之前
    expect(s.doc.content).toBe('# 标题插入\n正文内容')
    const ack = s.sent.get(idA)!.find((m) => m.kind === 'edit.ack')
    expect(ack).toMatchObject({ kind: 'edit.ack', seq: 1, ok: true, version: 2 })
    const broadcast = s.sent.get(idB)!.find((m) => m.kind === 'doc.changed')
    expect(broadcast).toMatchObject({
      kind: 'doc.changed',
      version: 2,
      changes: [change],
      origin: 'external',
    })
  })

  it('重复 seq 不重复应用，但重发相同的 ack（幂等去重）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    const req = {
      kind: 'edit.request' as const,
      sessionId: id,
      docUri: DOC_URI,
      seq: 1,
      baseVersion: 1,
      changes: [{ offset: 0, length: 0, text: 'X' }],
    }
    await s.send(id, req)
    await s.send(id, req)
    expect(s.doc.applyCalls).toHaveLength(1)
    const acks = s.sent.get(id)!.filter((m) => m.kind === 'edit.ack')
    expect(acks).toHaveLength(2)
  })

  it('baseVersion 落后但区间未受影响时平移后应用', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    // 第一个编辑在 offset 4 插入（版本 1→2），第二个请求仍基于版本 1，
    // 其编辑位置在插入点之后，应平移 +2 应用
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 4, length: 0, text: 'AB' }],
    })
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 2, baseVersion: 1,
      changes: [{ offset: 7, length: 2, text: '替换' }],
    })
    expect(s.doc.applyCalls[1]).toEqual([{ offset: 9, length: 2, text: '替换' }])
    const ack2 = s.sent.get(id)!.filter((m) => m.kind === 'edit.ack')[1]
    expect(ack2).toMatchObject({ seq: 2, ok: true, version: 3 })
  })

  it('baseVersion 过期且区间被覆盖时拒绝并附全文', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 0, length: 3, text: '整段替换文案' }],
    })
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 2, baseVersion: 1,
      changes: [{ offset: 1, length: 1, text: 'Y' }], // 落入第一个编辑的旧区间 [0,3)
    })
    expect(s.doc.applyCalls).toHaveLength(1)
    const ack2 = s.sent.get(id)!.filter((m) => m.kind === 'edit.ack')[1]
    expect(ack2).toMatchObject({ seq: 2, ok: false, reason: 'stale' })
    if (ack2?.kind === 'edit.ack' && !ack2.ok) {
      expect(ack2.text).toBe(s.doc.content)
    }
  })

  it('applyChanges 失败时发 error ack', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    s.doc.applyResult = false
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 0, length: 0, text: 'x' }],
    })
    const ack = s.sent.get(id)!.find((m) => m.kind === 'edit.ack')
    expect(ack).toMatchObject({ seq: 1, ok: false, reason: 'error' })
  })

  it('同面板连续两个请求串行处理：第二个基于第一个应用后的版本正确重定位', async () => {
    const s = setup('abcdef')
    const id = s.attach()
    await readyPanel(s, id)
    // 模拟 webview 乐观输入：两个请求几乎同时到达且 baseVersion 相同
    const p1 = s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 0, length: 0, text: '一' }],
    })
    const p2 = s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 2, baseVersion: 1,
      changes: [{ offset: 6, length: 0, text: '尾' }],
    })
    await Promise.all([p1, p2])
    expect(s.doc.content).toBe('一abcdef尾')
    const acks = s.sent.get(id)!.filter((m) => m.kind === 'edit.ack')
    expect(acks).toHaveLength(2)
  })

  it('未知 sessionId 的消息被丢弃：不应用、不回应', async () => {
    const s = setup()
    s.attach()
    await s.session.handleWebviewMessage(
      {
        kind: 'edit.request', sessionId: '不存在', docUri: DOC_URI,
        seq: 1, baseVersion: 1, changes: [{ offset: 0, length: 0, text: 'x' }],
      },
      '不存在',
    )
    expect(s.doc.applyCalls).toHaveLength(0)
  })

  it('结构非法的消息被静默丢弃', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.session.handleWebviewMessage({ kind: 'edit.request', seq: 1 }, id) // 缺字段
    await s.session.handleWebviewMessage('垃圾', id)
    await s.session.handleWebviewMessage(null, id)
    expect(s.doc.applyCalls).toHaveLength(0)
    const acks = s.sent.get(id)!.filter((m) => m.kind === 'edit.ack')
    expect(acks).toHaveLength(0)
  })
})

describe('外部变更广播与不写回保证', () => {
  it('无 pending 时文档事件广播给全部已 ready 面板', async () => {
    const s = setup()
    const idA = s.attach()
    const idB = s.attach()
    await readyPanel(s, idA)
    await readyPanel(s, idB)
    const changes = [{ offset: 0, length: 2, text: '改' }]
    s.doc.content = '改标题\n正文内容'
    s.doc.ver++
    s.session.handleDocChanged(changes, 2)
    for (const id of [idA, idB]) {
      const msg = s.sent.get(id)!.find((m) => m.kind === 'doc.changed')
      expect(msg).toMatchObject({ kind: 'doc.changed', version: 2, changes, origin: 'external' })
    }
  })

  it('只发生 ready/init 期间从不写回文档（未编辑不产生内容变化）', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    expect(s.doc.applyCalls).toHaveLength(0)
  })

  it('detach 后的面板不再收到任何消息', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    s.session.detachPanel(id)
    s.doc.ver++
    s.session.handleDocChanged([], 2)
    const after = s.sent.get(id)!.length
    await s.send(id, { kind: 'ready' }).catch(() => undefined)
    expect(s.sent.get(id)!.length).toBe(after)
  })
})

describe('CRLF 文档的换行协调（CM6 端统一 LF）', () => {
  function setupCrlf() {
    const s = setup('# 标题\r\n正文内容\r\n第三行')
    return s
  }

  it('init 发送 LF 化全文', async () => {
    const s = setupCrlf()
    const id = s.attach()
    const init = await readyPanel(s, id)
    expect(init).toMatchObject({ kind: 'init', text: '# 标题\n正文内容\n第三行' })
  })

  it('webview 的 LF 编辑转换为宿主坐标与 CRLF 文本后应用', async () => {
    const s = setupCrlf()
    const id = s.attach()
    await readyPanel(s, id)
    // LF 文档 '# 标题\n正文内容\n第三行'：在第二行行首（LF offset 5）插入
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 5, length: 0, text: '新行\n' }],
    })
    // 宿主坐标：第二行行首 = 5 + 1（越过首个 CRLF）= 6；文本换行还原 CRLF
    expect(s.doc.applyCalls).toEqual([[{ offset: 6, length: 0, text: '新行\r\n' }]])
    expect(s.doc.content).toBe('# 标题\r\n新行\r\n正文内容\r\n第三行')
  })

  it('外部变更广播给 webview 前转换为 LF 坐标与文本', async () => {
    const s = setupCrlf()
    const id = s.attach()
    await readyPanel(s, id)
    // 宿主侧变更：在宿主 offset 5 插入 'X\r\nY'（LF 侧应为 offset 4、text 'X\nY'）
    const applied = [{ offset: 5, length: 0, text: 'X\r\nY' }]
    s.doc.content = applyToText(s.doc.content, applied)
    s.doc.ver++
    s.session.handleDocChanged(applied, s.doc.ver)
    const msg = s.sent.get(id)!.find((m) => m.kind === 'doc.changed')
    expect(msg).toMatchObject({
      kind: 'doc.changed',
      changes: [{ offset: 4, length: 0, text: 'X\nY' }],
      origin: 'external',
    })
  })
})

describe('view.state 诊断缓存', () => {
  it('缓存最近一次 view.state 并可按面板读取', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, {
      kind: 'view.state', text: '# t', docLength: 4, lineCount: 1, renderedLines: 12,
    })
    expect(s.session.getViewState(id)).toMatchObject({ renderedLines: 12, text: '# t' })
    expect(s.session.getViewState('other')).toBeUndefined()
  })
})
