// @vitest-environment jsdom
// 编辑区查找会话契约（工单 #14，syncController 直驱）：
// - 查找基于 webview 全文文本模型：屏外（CM6 视口外 / 阅读视图未挂载块）
//   内容同样命中——断言来自文本模型坐标，不用 DOM 遍历冒充全文匹配
// - 查找不修改文本：全程零 edit.request、文本逐字节不变（纯只读契约）
// - 焦点与 Esc：打开聚焦输入框；Esc 关闭并把焦点归还编辑区（live 回 CM6）
// - 定位协同：live 侧选区+滚动；reading 侧源位置锚点映射到块并滚动；
//   模式切换保活查找会话，当前匹配位置经源锚点映射恢复
// - 反馈明确：当前/总数计数；无匹配 0/0；循环导航；大小写语义固定
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { findStateField } from '../../src/webview/findSession'
import type { WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/find.md'

const DOC = [
  '# 查找样例标题',
  '',
  '第一段：这里有一个目标词，后续还有。',
  '',
  '中间段落没有命中内容。',
  '',
  '第二段：又出现目标词了。',
  '',
  '- 列表项包含目标词',
  '',
  '包含 emoji：🎉 与目标词相邻。',
  '',
  '结尾段落。',
  '',
].join('\n')

/** DOC 中 '目标词' 的全部出现位置（UTF-16 offset） */
const HIT_OFFSETS: number[] = (() => {
  const out: number[] = []
  let at = DOC.indexOf('目标词')
  while (at !== -1) {
    out.push(at)
    at = DOC.indexOf('目标词', at + 1)
  }
  return out
})()

interface BridgeHarness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
}

function makeBridge(): BridgeHarness {
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

let parent: HTMLElement | undefined

function mountFind(h: BridgeHarness, text = DOC, version = 1): WebviewSyncController {
  const c = new WebviewSyncController(h.bridge)
  parent = document.createElement('div')
  document.body.appendChild(parent) // 焦点断言需要真实挂载
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version, text })
  return c
}

function viewState(c: WebviewSyncController, h: BridgeHarness) {
  const before = h.sent.length
  c.handleHostMessage({ kind: 'view.state.request' })
  const msg = h.sent.slice(before).find((m) => m.kind === 'view.state')
  if (!msg) {
    throw new Error('view.state 未回报')
  }
  return msg as Extract<WebviewToHost, { kind: 'view.state' }>
}

function editRequestCount(h: BridgeHarness): number {
  return h.sent.filter((m) => m.kind === 'edit.request').length
}

function findPanel(): HTMLElement | null {
  return parent?.querySelector<HTMLElement>('.oile-find') ?? null
}

function findInput(): HTMLInputElement | null {
  return parent?.querySelector<HTMLInputElement>('.oile-find-input') ?? null
}

function key(target: EventTarget, k: string, opts: KeyboardEventInit = {}): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }),
  )
}

beforeEach(() => {
  parent = undefined
})

afterEach(() => {
  parent?.remove()
  parent = undefined
})

describe('打开与关闭（焦点契约）', () => {
  it('view.find.open 打开面板：DOM 存在、可见、输入框获得焦点', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open' })
    const panel = findPanel()
    expect(panel).not.toBeNull()
    expect(panel!.classList.contains('oile-find-open')).toBe(true)
    expect(document.activeElement).toBe(findInput())
    const state = viewState(c, h)
    expect(state.find?.open).toBe(true)
    expect(state.find?.total).toBe(0)
  })

  it('webview 内 Mod-F 打开查找（Ctrl/Cmd+F 拦截），再次按下重新聚焦输入框', () => {
    const h = makeBridge()
    const c = mountFind(h)
    key(document, 'f', { ctrlKey: true })
    expect(viewState(c, h).find?.open).toBe(true)
    expect(document.activeElement).toBe(findInput())
    // 焦点被移走后再按 Mod-F：重新聚焦（VSCode find 同款手感）
    ;(parent!.querySelector('.oile-toolbar button') as HTMLElement).focus()
    expect(document.activeElement).not.toBe(findInput())
    key(document, 'f', { metaKey: true })
    expect(document.activeElement).toBe(findInput())
  })

  it('无修饰的 f 键不触发查找（不打扰正常输入）', () => {
    const h = makeBridge()
    const c = mountFind(h)
    key(document, 'f')
    // 从未打开过：find 观测缺省（首次打开后回报 open:false）
    expect(viewState(c, h).find).toBeUndefined()
  })

  it('view.find.close 关闭：面板隐藏、状态回报关闭、装饰清空', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    c.handleHostMessage({ kind: 'view.find.close' })
    expect(findPanel()!.classList.contains('oile-find-open')).toBe(false)
    expect(viewState(c, h).find?.open).toBe(false)
    expect(c.getView()!.state.field(findStateField).matches.length).toBe(0)
  })

  it('Esc 关闭并把焦点归还编辑区（live 模式回 CM6）', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    const input = findInput()!
    key(input, 'Escape')
    expect(viewState(c, h).find?.open).toBe(false)
    expect(c.getView()!.hasFocus).toBe(true)
    // 关闭后装饰清空
    expect(c.getView()!.state.field(findStateField).matches.length).toBe(0)
  })
})

describe('匹配计算与反馈（基于文本模型，含中文与 emoji）', () => {
  it('open 带 query：total 与文本模型一致（中文+emoji 文档），当前匹配为参考位置后首个', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    const state = viewState(c, h)
    expect(state.find?.total).toBe(HIT_OFFSETS.length)
    expect(state.find?.query).toBe('目标词')
    // 光标在 0：当前 = 第一个匹配
    expect(state.find?.index).toBe(1)
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[0])
    expect(state.find?.currentTo).toBe(HIT_OFFSETS[0]! + '目标词'.length)
  })

  it('计数显示 当前/总数；无匹配显示 0/0 且带空态类', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    const count = parent!.querySelector<HTMLElement>('.oile-find-count')!
    expect(count.textContent).toBe(`1/${HIT_OFFSETS.length}`)
    // 输入不存在的词
    const input = findInput()!
    input.value = '不存在的词'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(count.textContent).toBe('0/0')
    expect(count.classList.contains('oile-find-count-empty')).toBe(true)
    const state = viewState(c, h)
    expect(state.find?.total).toBe(0)
    expect(state.find?.index).toBe(0)
    expect(state.find?.currentFrom).toBeNull()
  })

  it('emoji 查询按码点命中：🎉 查询计数与文本一致', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '🎉' })
    expect(viewState(c, h).find?.total).toBe(1)
    expect(viewState(c, h).find?.currentFrom).toBe(DOC.indexOf('🎉'))
  })

  it('大小写语义：默认区分，切换按钮（忽略大小写，aria 语义一致）翻转后重算', () => {
    const h = makeBridge()
    const text = 'Hello hello HELLO\n中文编辑测试\n'
    const c = mountFind(h, text)
    c.handleHostMessage({ kind: 'view.find.open', query: 'hello' })
    expect(viewState(c, h).find?.total).toBe(1)
    const btn = parent!.querySelector<HTMLButtonElement>('.oile-find-case')!
    // 按钮语义为「忽略大小写」开关：默认区分（未激活、未按下）
    expect(btn.textContent).toBe('忽略大小写')
    expect(btn.classList.contains('oile-find-case-active')).toBe(false)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    btn.click()
    // 激活 = 忽略大小写生效（active 类与 aria-pressed 同步表示）
    expect(btn.classList.contains('oile-find-case-active')).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    const state = viewState(c, h)
    expect(state.find?.caseSensitive).toBe(false)
    expect(state.find?.total).toBe(3)
    // 再点回区分大小写
    btn.click()
    expect(btn.classList.contains('oile-find-case-active')).toBe(false)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(viewState(c, h).find?.total).toBe(1)
  })
})

describe('循环导航（上一项/下一项）', () => {
  it('next 顺序前进，prev 后退，两端循环', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    const total = HIT_OFFSETS.length
    expect(total).toBeGreaterThanOrEqual(3)
    let state = viewState(c, h)
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[0])
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    state = viewState(c, h)
    expect(state.find?.index).toBe(2)
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[1])
    // 从第 1 个连按 total 次 next：回到第 1 个（循环导航）
    for (let i = 2; i <= total; i++) {
      c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    }
    state = viewState(c, h)
    expect(state.find?.index).toBe(1)
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[0])
    c.handleHostMessage({ kind: 'view.find.step', direction: 'prev' })
    state = viewState(c, h) // 从第 1 个 prev：回绕到末个
    expect(state.find?.index).toBe(total)
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[total - 1])
  })

  it('输入框 Enter 下一个、Shift+Enter 上一个', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    const input = findInput()!
    key(input, 'Enter')
    expect(viewState(c, h).find?.currentFrom).toBe(HIT_OFFSETS[1])
    key(input, 'Enter', { shiftKey: true })
    expect(viewState(c, h).find?.currentFrom).toBe(HIT_OFFSETS[0])
  })

  it('无匹配时 next/prev 不动作、不抛错', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '不存在' })
    expect(() =>
      c.handleHostMessage({ kind: 'view.find.step', direction: 'next' }),
    ).not.toThrow()
    expect(viewState(c, h).find?.index).toBe(0)
  })
})

describe('定位协同：live 选区与阅读视图块级定位', () => {
  it('live：next 把选区移到当前匹配并选中（屏外段落同样定位）', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    const view = c.getView()!
    const sel = view.state.selection.main
    expect(sel.from).toBe(HIT_OFFSETS[1])
    expect(sel.to).toBe(HIT_OFFSETS[1]! + '目标词'.length)
    // modeAnchor 同步为当前匹配 from：模式切换映射用（与 view.locate 同语义）
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const state = viewState(c, h)
    expect(state.find?.open).toBe(true) // 会话保活
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[1])
  })

  it('reading：定位到当前匹配所在块并块级高亮；close 清除高亮', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    // 导航到列表项里的匹配：HIT_OFFSETS 中位于 '- 列表项包含目标词' 行的那个
    const listLineStart = DOC.indexOf('- 列表项包含目标词')
    const listHitIdx = HIT_OFFSETS.findIndex((p) => p > listLineStart && p < listLineStart + '- 列表项包含目标词'.length)
    expect(listHitIdx).toBeGreaterThan(0)
    for (let i = 0; i < listHitIdx; i++) {
      c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    }
    const state = viewState(c, h)
    expect(state.find?.currentFrom).toBe(HIT_OFFSETS[listHitIdx])
    expect(state.readingAnchorStart).toBe(listLineStart)
    const hit = parent!.querySelector<HTMLElement>('.oile-reading-block.oile-reading-find-hit')
    expect(hit).not.toBeNull()
    expect(hit!.dataset['oileSrcStart']).toBe(String(listLineStart))
    // 阅读容器在 DOM 中只有当前匹配块带命中类（块级高亮，非全文标注）
    const hits = parent!.querySelectorAll('.oile-reading-find-hit')
    expect(hits.length).toBe(1)
    c.handleHostMessage({ kind: 'view.find.close' })
    expect(parent!.querySelectorAll('.oile-reading-find-hit').length).toBe(0)
  })

  it('模式切换保活：live 导航 → reading 锚点为当前匹配块 → 回 live 选区恢复到当前匹配', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' }) // 第 2 个匹配（第二段）
    const matchFrom = HIT_OFFSETS[1]!
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    let state = viewState(c, h)
    expect(state.find?.open).toBe(true)
    expect(state.readingAnchorStart).toBe(DOC.indexOf('第二段：又出现目标词了。'))
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    state = viewState(c, h)
    expect(state.find?.open).toBe(true)
    expect(state.selectionOffset).toBe(matchFrom)
    expect(state.find?.currentFrom).toBe(matchFrom)
    // live 侧当前匹配装饰仍在
    expect(c.getView()!.state.field(findStateField).matches.length).toBe(HIT_OFFSETS.length)
  })
})

describe('只读契约：查找不修改文本、不产生出站变更', () => {
  it('打开/查询/导航/关闭全程：零 edit.request，文本逐字节不变', () => {
    const h = makeBridge()
    const c = mountFind(h)
    const baseline = viewState(c, h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    for (let i = 0; i < HIT_OFFSETS.length + 2; i++) {
      c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    }
    key(findInput()!, 'Escape')
    c.handleHostMessage({ kind: 'view.find.open', query: '🎉' })
    c.handleHostMessage({ kind: 'view.find.close' })
    const after = viewState(c, h)
    expect(editRequestCount(h)).toBe(0)
    expect(after.text).toBe(baseline.text)
    expect(after.docLength).toBe(baseline.docLength)
    // 除 mount 的 ready 与诊断回报外零出站（查找全程只读）
    const kinds = new Set(h.sent.map((m) => m.kind))
    expect([...kinds].filter((k) => k !== 'view.state' && k !== 'ready')).toEqual([])
  })

  it('查找会话期间的宿主 undo 不受查找影响（无新历史条目产生）', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    // 未做任何编辑：history.request 之前文档没有可撤销条目，查找也不添加
    const state = viewState(c, h)
    expect(state.text).toBe(DOC)
    expect(editRequestCount(h)).toBe(0)
  })
})

describe('文档变化时的匹配失效（重算时机）', () => {
  it('外部 doc.changed 后 total 与新文本一致，当前匹配就近保持', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    expect(viewState(c, h).find?.total).toBe(HIT_OFFSETS.length)
    // 外部增量：把第二段的 '目标词' 改写掉
    const target = DOC.indexOf('又出现目标词了')
    const at = DOC.indexOf('目标词', target)
    const before = DOC.slice(0, at)
    const afterText = `${before}他词了。${DOC.slice(at + '目标词了。'.length)}`
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: at, length: '目标词了。'.length, text: '他词了。' }],
    })
    void afterText
    const state = viewState(c, h)
    expect(state.find?.total).toBe(HIT_OFFSETS.length - 1)
    expect(state.find?.open).toBe(true)
    // 仍零出站
    expect(editRequestCount(h)).toBe(0)
  })
})

describe('短文档锚点权威性（定位锚点不被视口读数覆盖）', () => {
  function stubBox(container: HTMLElement, scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true })
  }

  it('容器不可滚动（scrollHeight ≈ clientHeight）时 scroll 事件不覆盖定位锚点', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    const target = viewState(c, h)
    const targetAnchor = target.readingAnchorStart
    expect(targetAnchor).toBe(DOC.indexOf('第二段：又出现目标词了。'))
    // 短文档：内容不超出视口（真实布局里 maxScroll≈0；此处以数值桩模拟）
    const container = parent!.querySelector<HTMLElement>('.oile-view-reading')!
    stubBox(container, 600, 600)
    container.dispatchEvent(new Event('scroll'))
    expect(viewState(c, h).readingAnchorStart).toBe(targetAnchor)
  })

  it('容器可滚动时 scroll 事件照常以视口顶块更新锚点（既有语义保持）', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    const targetAnchor = viewState(c, h).readingAnchorStart
    expect(targetAnchor).toBe(DOC.indexOf('第二段：又出现目标词了。'))
    // 可滚动容器：视口读数是权威（jsdom 无布局 → 回退到首个可见块 0）
    const container = parent!.querySelector<HTMLElement>('.oile-view-reading')!
    stubBox(container, 2000, 600)
    container.dispatchEvent(new Event('scroll'))
    expect(viewState(c, h).readingAnchorStart).toBe(0)
  })
})

describe('协议校验', () => {
  it('非法 find 消息被丢弃，不改变会话状态', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.open', query: '目标词' })
    // direction 非法
    c.handleHostMessage({ kind: 'view.find.step', direction: 'jump' })
    // query 非字符串
    c.handleHostMessage({ kind: 'view.find.open', query: 123 })
    const state = viewState(c, h)
    expect(state.find?.open).toBe(true)
    expect(state.find?.total).toBe(HIT_OFFSETS.length)
    expect(state.find?.index).toBe(1)
  })

  it('view.find.step 在会话未打开时被忽略', () => {
    const h = makeBridge()
    const c = mountFind(h)
    c.handleHostMessage({ kind: 'view.find.step', direction: 'next' })
    expect(viewState(c, h).find).toBeUndefined()
  })
})
