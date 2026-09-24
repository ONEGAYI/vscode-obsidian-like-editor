// 文档会话契约：宿主侧每个 TextDocument 一个 DocumentSession，管理多面板的
// ready 握手、edit.request 的校验与写回（seq 去重、baseVersion 过期重定位或
// 拒绝）、自家编辑确认（edit.ack）与外部变更广播（doc.changed）。
// 权威文档通过 HostDocumentPort 注入（vscode 层实现），此处用假文档驱动。
import { describe, it, expect } from 'vitest'
import { DocumentSession, type HostDocumentPort, type SessionNotice } from '../../src/host/documentSession'
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
  holdApply = false
  undoCalls = 0
  redoCalls = 0
  private undoStack: { changes: SerChange[]; before: string }[] = []
  private redoStack: { changes: SerChange[]; before: string }[] = []
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

  /** 下一笔 applyChanges 挂起（测试钩子：构造在途 pending 窗口）。
   *  挂起的调用永不完成（模拟断连/超长在途），测试结束时 release 复位标记 */
  holdNextApply(): { release: () => void } {
    this.holdApply = true
    return {
      release: () => {
        this.holdApply = false
      },
    }
  }

  async applyChanges(changes: SerChange[]): Promise<boolean> {
    this.applyCalls.push(changes)
    if (this.holdApply) {
      await new Promise<void>(() => undefined) // 测试钩子：在途挂起（由测试放弃）
      return false
    }
    if (!this.applyResult) return false
    this.undoStack.push({ changes, before: this.content })
    this.redoStack = []
    this.content = applyToText(this.content, changes)
    this.ver++
    if (this.fireChangeOnApply) {
      this.listener?.(changes, this.ver)
    }
    return true
  }

  /** 对已 pop 的编辑组计算精确逆（组内变更互不重叠时；基于其 before 文本） */
  private invertFor(entry: { changes: SerChange[]; before: string }): SerChange[] {
    const out: SerChange[] = []
    for (const c of entry.changes) {
      let delta = 0
      for (const other of entry.changes) {
        if (other !== c && other.offset + other.length <= c.offset) {
          delta += other.text.length - other.length
        }
      }
      const at = c.offset + delta
      out.push({
        offset: at,
        length: c.text.length,
        text: entry.before.slice(c.offset, c.offset + c.length),
      })
    }
    return out
  }

  async undo(): Promise<boolean> {
    this.undoCalls++
    const top = this.undoStack.pop()
    if (!top) return false
    this.redoStack.push(top)
    const inverse = this.invertFor(top)
    this.content = top.before
    this.ver++
    this.listener?.(inverse, this.ver)
    return true
  }

  async redo(): Promise<boolean> {
    this.redoCalls++
    const top = this.redoStack.pop()
    if (!top) return false
    this.undoStack.push(top)
    this.content = applyToText(this.content, top.changes)
    this.ver++
    this.listener?.(top.changes, this.ver)
    return true
  }
}

function setup(
  text = '# 标题\n正文内容',
  opts?: { onNotice?: (notice: SessionNotice) => void },
) {
  const doc = new FakeDoc(text)
  const session = new DocumentSession(doc, { docUri: DOC_URI, onNotice: opts?.onNotice })
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

  it('baseVersion 过期且区间被覆盖时拒绝并附全文（#4 起进入 conflict 暂停保留）', async () => {
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
    expect(ack2).toMatchObject({ seq: 2, ok: false, reason: 'conflict' })
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

  it('C-4：兜底确认后迟到的回流不作为外部变更重复广播', async () => {
    const s = setup('abcdef')
    const id = s.attach()
    await readyPanel(s, id)
    // 模拟 applyEdit resolve 与回流事件之间的竞态窗口：回流延迟到达
    s.doc.fireChangeOnApply = false
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 0, length: 0, text: 'X' }],
    })
    // 兜底确认路径已发 ok ack
    const ack = s.sent.get(id)!.find((m) => m.kind === 'edit.ack')
    expect(ack).toMatchObject({ seq: 1, ok: true })
    // 迟到的回流到达：识别为自家确认（已记录），不再广播给面板
    s.session.handleDocChanged([{ offset: 0, length: 0, text: 'X' }], 2)
    const broadcasts = s.sent.get(id)!.filter((m) => m.kind === 'doc.changed')
    expect(broadcasts).toHaveLength(0)
  })

  it('多段变更的回流以任意顺序到达均识别为自家确认（VSCode 回流为降序）', async () => {
    // #13 表格结构操作产生多段变更（删两行 + 插一行）；VSCode 对多段
    // WorkspaceEdit 的 onDidChangeTextDocument contentChanges 按偏移降序
    // 回流，而出站请求为升序——确认匹配必须与顺序无关，否则误判为外部
    // 变更广播回发起面板，造成自我冲突暂停
    const s = setup('AAAA\nBBBB\nCCCC\nDDDD\nEEEE\n')
    const id = s.attach()
    await readyPanel(s, id)
    // 回流延迟到达（真实 VSCode：applyEdit resolve 后才发事件），走兜底确认
    s.doc.fireChangeOnApply = false
    // 升序出站：删 [0,10)（两行）+ 在 15 处插入（CM6 合并相邻删除后的形态）
    const outbound = [
      { offset: 0, length: 10, text: '' },
      { offset: 15, length: 0, text: 'XXXX\n' },
    ]
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: outbound,
    })
    const ack = s.sent.get(id)!.find((m) => m.kind === 'edit.ack')
    expect(ack).toMatchObject({ seq: 1, ok: true })
    // 回流以降序到达（真实 VSCode 形态）：不得广播 doc.changed 给发起面板
    const refluxDesc = [...outbound].reverse()
    s.session.handleDocChanged(refluxDesc, 2)
    const broadcasts = s.sent.get(id)!.filter((m) => m.kind === 'doc.changed')
    expect(broadcasts).toHaveLength(0)
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

  it('仅有未提交组合快照时关闭可取回；快照等于权威 LF 文本时正常关闭不误报', async () => {
    const notices: SessionNotice[] = []
    const s = setup('a\r\nb', { onNotice: (notice) => notices.push(notice) })
    const first = s.attach()
    await readyPanel(s, first)
    await s.send(first, { kind: 'conflict.report', sessionId: first, docUri: DOC_URI,
      version: 1, revision: 1, text: 'a\nb候选', compositionPending: true })
    s.session.detachPanel(first)
    expect(notices).toMatchObject([{ type: 'panel-closed-with-input', webviewText: 'a\nb候选' }])

    const second = s.attach()
    await readyPanel(s, second)
    await s.send(second, { kind: 'conflict.report', sessionId: second, docUri: DOC_URI,
      version: 1, revision: 1, text: 'a\nb候选', compositionPending: true })
    await s.send(second, { kind: 'conflict.report', sessionId: second, docUri: DOC_URI,
      version: 1, revision: 2, text: 'a\nb', compositionPending: false })
    s.session.detachPanel(second)
    expect(notices).toHaveLength(1)

    const equalLf = s.attach()
    await readyPanel(s, equalLf)
    await s.send(equalLf, { kind: 'conflict.report', sessionId: equalLf, docUri: DOC_URI,
      version: 1, revision: 1, text: 'a\nb', compositionPending: true })
    s.session.detachPanel(equalLf)
    expect(notices).toHaveLength(1)

    const staleOrdinary = s.attach()
    await readyPanel(s, staleOrdinary)
    await s.send(staleOrdinary, { kind: 'conflict.report', sessionId: staleOrdinary, docUri: DOC_URI,
      version: 1, revision: 1, text: '旧快照' })
    s.session.detachPanel(staleOrdinary)
    expect(notices).toHaveLength(1)
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

  it('C-1：行尾分布变化期间的迟到请求在 LF 空间重定位（LF 形态 no-op 不被当作平移）', async () => {
    // 宿主 "a\nb\nc" v1 → 外部把第一行行尾改为 CRLF（v2，LF 空间是 no-op）
    // → 迟到请求基于 v1 在 LF offset 2（'b' 前）插 X，期望 "a\r\nXb\nc"
    const s = setup('a\nb\nc')
    const id = s.attach()
    await readyPanel(s, id)
    s.doc.content = 'a\r\nb\nc'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 1, length: 1, text: '\r\n' }], 2)
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 2, length: 0, text: 'X' }],
    })
    expect(s.doc.applyCalls).toEqual([[{ offset: 3, length: 0, text: 'X' }]])
    expect(s.doc.content).toBe('a\r\nXb\nc')
    const ack = s.sent.get(id)!.find((m) => m.kind === 'edit.ack')
    expect(ack).toMatchObject({ seq: 1, ok: true })
  })

  it('C-1：CRLF 化行尾期间的非 no-op 变更同样以 LF 空间重定位（多行尾混合场景）', async () => {
    // v1 "a\nb\nc\n"（LF）→ v2 外部把前两个行尾统一为 CRLF → 迟到请求在
    // v1 的 LF offset 5（'c' 后的换行前？即 'c' 与末行尾之间）替换 'c' 为 'Z'
    const s = setup('a\nb\nc\n')
    const id = s.attach()
    await readyPanel(s, id)
    // 宿主 v2 = "a\r\nb\r\nc\n"：两笔替换（\n → \r\n）
    s.doc.content = 'a\r\nb\r\nc\n'
    s.doc.ver++
    s.session.handleDocChanged(
      [
        { offset: 1, length: 1, text: '\r\n' },
        { offset: 3, length: 1, text: '\r\n' },
      ],
      2,
    )
    // v1 LF 坐标：'c' 在 offset 4；替换 [4,5) 'c'→'Z'
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 4, length: 1, text: 'Z' }],
    })
    // 宿主 v2 中 'c' 位于 host offset 6；期望 "a\r\nb\r\nZ\n"
    expect(s.doc.content).toBe('a\r\nb\r\nZ\n')
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

describe('history.request（撤销/重做转发到权威栈）', () => {
  async function editOnce(s: ReturnType<typeof setup>, id: string, seq: number, text: string) {
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq, baseVersion: s.doc.ver,
      changes: [{ offset: s.doc.content.length, length: 0, text }],
    })
  }

  it('undo 请求调用 port.undo，逆变更作为外部变更广播给发起面板', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    await editOnce(s, id, 1, 'X') // 'abcX' v2
    const ackCountBefore = s.sent.get(id)!.filter((m) => m.kind === 'edit.ack').length
    await s.send(id, { kind: 'history.request', op: 'undo' })
    expect(s.doc.undoCalls).toBe(1)
    expect(s.doc.content).toBe('abc')
    const msgs = s.sent.get(id)!
    const changed = msgs.filter((m) => m.kind === 'doc.changed').at(-1)
    expect(changed).toMatchObject({
      kind: 'doc.changed',
      version: 3,
      changes: [{ offset: 3, length: 1, text: '' }],
      origin: 'external',
    })
    // undo 不产生新 ack（不把逆变更误判为本会话编辑确认，防回声）
    expect(msgs.filter((m) => m.kind === 'edit.ack')).toHaveLength(ackCountBefore)
  })

  it('redo 请求调用 port.redo 并把正向变更广播给面板', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    await editOnce(s, id, 1, 'X')
    await s.send(id, { kind: 'history.request', op: 'undo' })
    await s.send(id, { kind: 'history.request', op: 'redo' })
    expect(s.doc.redoCalls).toBe(1)
    expect(s.doc.content).toBe('abcX')
    const changed = s.sent.get(id)!.filter((m) => m.kind === 'doc.changed').at(-1)
    expect(changed).toMatchObject({
      kind: 'doc.changed',
      changes: [{ offset: 3, length: 0, text: 'X' }],
      origin: 'external',
    })
  })

  it('history 请求排在在途 edit.request 之后：编辑先应用再撤销', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    const p1 = editOnce(s, id, 1, 'X')
    const p2 = s.send(id, { kind: 'history.request', op: 'undo' })
    await Promise.all([p1, p2])
    expect(s.doc.undoCalls).toBe(1)
    // 编辑应用后立即被撤销：文本回到原文，且 undo 的逆变更广播出去
    expect(s.doc.content).toBe('abc')
  })

  it('非法 op 的 history.request 被协议校验整体丢弃', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    await s.session.handleWebviewMessage({ kind: 'history.request', op: 'wrong' }, id)
    expect(s.doc.undoCalls + s.doc.redoCalls).toBe(0)
  })

  it('未 ready 面板的 history.request 被忽略', async () => {
    const s = setup('abc')
    const id = s.attach()
    await s.session.handleWebviewMessage({ kind: 'history.request', op: 'undo' }, id)
    expect(s.doc.undoCalls).toBe(0)
  })
})

describe('B-2：暂停面板重载后的冲突快照来源', () => {
  async function suspendPanel(s: ReturnType<typeof setup>, id: string) {
    // 外部覆盖原文区间，使后续基于旧版本的请求不可安全重定位
    s.doc.content = '外部全文'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 0, length: 2, text: '外部全文' }], s.doc.ver)
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 0, length: 1, text: '本' }],
    })
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
  }

  it('ready 重发 init 后 reloaded 置位：宿主快照不被重载冲掉，resume 清除标记', async () => {
    const s = setup('草稿')
    const id = s.attach()
    await readyPanel(s, id)
    await suspendPanel(s, id)
    // webview 重载（retainContextWhenHidden 关闭）：ready → init 重发权威全文
    await s.send(id, { kind: 'ready' })
    const init = s.sent.get(id)!.at(-2)
    expect(init).toMatchObject({ kind: 'init', text: '外部全文' })
    const state = s.session.getConflictState(id)!
    expect(state.reloaded).toBe(true)
    // 冲突留存（fragments/webviewText）仍可用于复制取回
    expect(state.fragments).toContain('本')
    // 恢复：清除标记，面板回归正常
    s.session.resumePanel(id)
    const resumed = s.session.getConflictState(id)!
    expect(resumed.reloaded).toBe(false)
    expect(resumed.suspended).toBe(false)
  })

  it('未暂停面板的 reloaded 不影响常规诊断', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    expect(s.session.getConflictState(id)?.reloaded).toBe(false)
  })
})

describe('sync.request（webview 发起的全文重同步）', () => {
  it('回复 doc.resync：附当前版本与 LF 化全文', async () => {
    const s = setup('# 标题\r\n正文')
    const id = s.attach()
    await readyPanel(s, id)
    s.doc.content = '# 标题\r\n外部改写'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 4, length: 2, text: '外部改写' }], 2)
    await s.send(id, { kind: 'sync.request' })
    const resync = s.sent.get(id)!.at(-1)
    expect(resync).toMatchObject({ kind: 'doc.resync', version: 2, text: '# 标题\n外部改写' })
  })

  it('未 ready 面板的 sync.request 被忽略', async () => {
    const s = setup('abc')
    const id = s.attach()
    await s.session.handleWebviewMessage({ kind: 'sync.request' }, id)
    expect(s.sent.get(id)!.length).toBe(0)
  })
})

describe('perf.report 缓存（#5 性能测量通道）', () => {
  const report: Extract<WebviewToHost, { kind: 'perf.report' }> = {
    kind: 'perf.report',
    firstInputSettledEpochMs: 1760000000000,
    typingRounds: 2,
    scrollRounds: 1,
    docLines: 10,
    baseline: { renderedLines: 5, contentDomCount: 40, headingLineCount: 1, inviewHeadingCount: 1 },
    afterTyping: { renderedLines: 5, contentDomCount: 41, headingLineCount: 1, inviewHeadingCount: 1 },
    afterScroll: { renderedLines: 5, contentDomCount: 40, headingLineCount: 1, inviewHeadingCount: 1 },
    inputDelayMs: { samples: [4, 6], avgMs: 5, maxMs: 6 },
    longTasks: null,
    headingStats: { totalUpdates: 3, lastUpdateScannedLines: 1, fullBuildLines: 10 },
  }

  it('缓存最近一次 perf.report 并可按面板读取', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    expect(s.session.getLastPerfReport(id)).toBeUndefined()
    await s.send(id, report)
    expect(s.session.getLastPerfReport(id)?.docLines).toBe(10)
  })

  it('结构非法的 perf.report 被整体丢弃', async () => {
    const s = setup()
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, { ...report, baseline: null } as unknown as WebviewToHost)
    expect(s.session.getLastPerfReport(id)).toBeUndefined()
  })
})

describe('P3 修复批：B-4 / B-6 / C-6', () => {
  async function suspendById(
    s: ReturnType<typeof setup>,
    id: string,
  ): Promise<void> {
    s.doc.content = '外部全文'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 0, length: 2, text: '外部全文' }], s.doc.ver)
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 0, length: 1, text: '本' }],
    })
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
  }

  it('B-4：暂停面板的 history.request 被忽略（与 edit.request 一致）', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    await suspendById(s, id)
    await s.send(id, { kind: 'history.request', op: 'undo' })
    expect(s.doc.undoCalls).toBe(0)
  })

  it('B-6：CRLF 文档在途 pending（宿主系）留存片段以 LF 形态入库', async () => {
    const notices: SessionNotice[] = []
    const s = setup('# 标题\r\n正文内容\r\n第三行', { onNotice: (n) => notices.push(n) })
    const id = s.attach()
    await readyPanel(s, id)
    const gate = s.doc.holdNextApply() // applyEdit 挂起：pending 处于在途窗口
    void s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI, seq: 1, baseVersion: 1,
      changes: [{ offset: 4, length: 0, text: '第一\n二' }],
    })
    await new Promise((r) => setTimeout(r, 0)) // seq1 已 push pending（宿主系 CRLF 文本）并挂起
    s.session.detachPanel(id) // 关闭面板：未确认输入必须留存通知
    const notice = notices.find((n) => n.type === 'panel-closed-with-input')
    expect(notice).toBeDefined()
    if (notice?.type === 'panel-closed-with-input') {
      // 片段统一 LF 形态（可读、与 webview 输入一致），不得混入 \r\n
      expect(notice.fragments).toEqual(['第一\n二'])
    }
    gate.release()
  })

  it('C-6：docUri 不匹配的 conflict.report 被忽略', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    await s.send(id, {
      kind: 'conflict.report', sessionId: id, docUri: 'file:///other.md', version: 1, revision: 1, text: '他人快照',
    })
    expect(s.session.getConflictState(id)?.webviewText).toBeUndefined()
  })

  it('C-6：docUri 不匹配的 conflict.action 被忽略', async () => {
    const s = setup('abc')
    const id = s.attach()
    await readyPanel(s, id)
    await suspendById(s, id)
    const before = s.session.getConflictState(id)
    expect(before?.suspended).toBe(true)
    await s.send(id, {
      kind: 'conflict.action', sessionId: id, docUri: 'file:///other.md', action: 'resume',
    })
    // 非本文档的恢复请求不得解除暂停
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
  })
})

// ---- 工单 #10：链接跳转与图片解析的会话路由 ----

async function ready10(s: ReturnType<typeof setup>, id: string): Promise<void> {
  await s.send(id, { kind: 'ready' })
}

describe('#10 link.activate：会话校验后交面板端口执行', () => {
  it('ready 面板的合法意图路由到 openLink（携带原始 href 与源位置）', async () => {
    const s = setup()
    const opened: Array<{ href: string; srcStart: number; srcEnd: number }> = []
    const id = s.session.attachPanel({
      send: () => undefined,
      openLink: (intent) => opened.push(intent),
    })
    await ready10(s, id)
    await s.send(id, {
      kind: 'link.activate', sessionId: id, docUri: DOC_URI,
      href: './目标 文档.md', srcStart: 10, srcEnd: 30,
    })
    expect(opened).toEqual([{ href: './目标 文档.md', srcStart: 10, srcEnd: 30 }])
  })

  it('docUri 不匹配或未 ready 的意图被丢弃，不触达 openLink', async () => {
    const s = setup()
    const opened: unknown[] = []
    const id = s.session.attachPanel({
      send: () => undefined,
      openLink: (intent) => opened.push(intent),
    })
    // 未 ready：丢弃
    await s.session.handleWebviewMessage(
      { kind: 'link.activate', sessionId: id, docUri: DOC_URI, href: './a.md', srcStart: 0, srcEnd: 1 },
      id,
    )
    expect(opened).toEqual([])
    await ready10(s, id)
    // docUri 不匹配：丢弃
    await s.send(id, {
      kind: 'link.activate', sessionId: id, docUri: 'file:///other.md', href: './a.md', srcStart: 0, srcEnd: 1,
    })
    expect(opened).toEqual([])
    // 合法：触达
    await s.send(id, { kind: 'link.activate', sessionId: id, docUri: DOC_URI, href: './a.md', srcStart: 0, srcEnd: 1 })
    expect(opened.length).toBe(1)
  })

  it('暂停（冲突）面板的链接意图仍被放行：跳转是只读交互，不受写回暂停影响', async () => {
    const s = setup('abc')
    const opened: unknown[] = []
    const id = s.session.attachPanel({
      send: () => undefined,
      openLink: (intent) => opened.push(intent),
    })
    await ready10(s, id)
    // 触发暂停：不可安全应用的过期请求
    s.doc.content = '外部改写'
    s.doc.ver++
    s.session.handleDocChanged([{ offset: 0, length: 3, text: '外部改写' }], 2)
    await s.send(id, {
      kind: 'edit.request', sessionId: id, docUri: DOC_URI,
      seq: 1, baseVersion: 1, changes: [{ offset: 0, length: 2, text: '未确认' }],
    })
    expect(s.session.getConflictState(id)?.suspended).toBe(true)
    await s.send(id, {
      kind: 'link.activate', sessionId: id, docUri: DOC_URI, href: 'https://example.com', srcStart: 0, srcEnd: 5,
    })
    expect(opened.length).toBe(1)
  })
})

describe('#10 image.request：会话解析、去重与结果回发', () => {
  function imageSetup(resolve: (src: string) => Promise<{ ok: true; src: string } | { ok: false; reason: 'blocked' | 'outside-workspace' | 'not-found' | 'read-error' }>) {
    const s = setup()
    const calls: string[] = []
    const out: HostToWebview[] = []
    const id = s.session.attachPanel({
      send: (m) => out.push(m),
      resolveImage: async (src) => {
        calls.push(src)
        return resolve(src)
      },
    })
    return { s, calls, out, id }
  }

  it('请求经 resolveImage 解析并以 image.result 回发（reqId 对应）', async () => {
    const t = imageSetup(async () => ({ ok: true, src: 'vscode-webview://res/a.png' }))
    await ready10(t.s, t.id)
    await t.s.send(t.id, { kind: 'image.request', sessionId: t.id, docUri: DOC_URI, reqId: 7, src: './a.png' })
    expect(t.calls).toEqual(['./a.png'])
    expect(t.out.filter((m) => m.kind === 'image.result')).toEqual([
      { kind: 'image.result', reqId: 7, ok: true, src: 'vscode-webview://res/a.png' },
    ])
  })

  it('并发同 src 去重为单次解析；成功结果缓存：后续请求不再触达解析器', async () => {
    const t = imageSetup(async () => ({ ok: true, src: 'vscode-webview://res/a.png' }))
    await ready10(t.s, t.id)
    await t.s.send(t.id, { kind: 'image.request', sessionId: t.id, docUri: DOC_URI, reqId: 1, src: './a.png' })
    await t.s.send(t.id, { kind: 'image.request', sessionId: t.id, docUri: DOC_URI, reqId: 2, src: './a.png' })
    expect(t.calls.length).toBe(1)
    expect(t.out.filter((m) => m.kind === 'image.result').length).toBe(2)
    // 缓存命中：第三次请求（如滚动回视口）直接回发缓存结果
    await t.s.send(t.id, { kind: 'image.request', sessionId: t.id, docUri: DOC_URI, reqId: 3, src: './a.png' })
    expect(t.calls.length).toBe(1)
    expect(t.out.filter((m) => m.kind === 'image.result').length).toBe(3)
  })

  it('失败结果不缓存：重试（新请求）重新触达解析器', async () => {
    let fail = true
    const t = imageSetup(async () =>
      fail ? { ok: false as const, reason: 'not-found' as const } : { ok: true as const, src: 'res://x' },
    )
    await ready10(t.s, t.id)
    await t.s.send(t.id, { kind: 'image.request', sessionId: t.id, docUri: DOC_URI, reqId: 1, src: './miss.png' })
    fail = false
    await t.s.send(t.id, { kind: 'image.request', sessionId: t.id, docUri: DOC_URI, reqId: 2, src: './miss.png' })
    expect(t.calls.length).toBe(2)
    const results = t.out.filter((m) => m.kind === 'image.result')
    expect((results[0] as { ok: boolean }).ok).toBe(false)
    expect((results[1] as { ok: boolean }).ok).toBe(true)
  })

  it('未注入解析器的面板与未 ready 面板的请求不解析；前者回发 read-error', async () => {
    const s = setup()
    const out: HostToWebview[] = []
    const id = s.session.attachPanel({ send: (m) => out.push(m) })
    // 未 ready：丢弃
    await s.session.handleWebviewMessage(
      { kind: 'image.request', sessionId: id, docUri: DOC_URI, reqId: 1, src: './a.png' },
      id,
    )
    expect(out.filter((m) => m.kind === 'image.result').length).toBe(0)
    await ready10(s, id)
    await s.send(id, { kind: 'image.request', sessionId: id, docUri: DOC_URI, reqId: 2, src: './a.png' })
    const results = out.filter((m) => m.kind === 'image.result')
    expect(results.length).toBe(1)
    expect((results[0] as { ok: boolean; reason?: string }).ok).toBe(false)
    expect((results[0] as { reason?: string }).reason).toBe('read-error')
  })
})
