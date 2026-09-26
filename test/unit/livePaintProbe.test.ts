// @vitest-environment jsdom
// #105/#106 live 计数探针与消息校验契约（syncController 直驱）：
// - liveSyntax.taskGlyphs 只数任务 checkbox widget——#106 起分割线渲染
//   widget（HorizontalRuleWidget）同为 replace 装饰，按「有 widget 即计数」
//   会把渲染态分割线误计入任务字形（集成实测：2 任务 + 1 分割线 → 3/1）
// - 含 highlight span 的大纲数据经 view.state 发出后必须仍被 isWebviewToHost
//   接受——运行时白名单漏登 highlight 时宿主丢弃整条 view.state 消息，
//   集成表现为 viewState 轮询超时（highlight.md 两条用例的根因）
// - paint.hr / paint.highlight 的可见口径 = 任一候选真实命中（rect 有面积 +
//   elementFromPoint 命中）：取首个候选时，首条分割线滚出视口的场景会把
//   「新分割线已绘制」误判为不可见（hr.md 插入用例的根因）；此处以
//   firstPaintedOf 纯函数钉住「遍历候选取首个命中、全不命中回退首条」
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { firstPaintedOf } from '../../src/webview/syncController'
import { isWebviewToHost, type WebviewToHost } from '../../src/shared/protocol'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

// #94 起文案经 t() 取词：装配生产中文包，与真宿主同链路
installLocale('zh-cn', zhCn)

const DOC_URI = 'file:///d%3A/notes/probe.md'

// 光标在文档头（init 默认选区 0）：不触及任务标记与分割线行，分割线处于
// 渲染态（widget 在场）——正是 taskGlyphs 误计的发生条件
const DOC = [
  '# 探针样例标题',
  '',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '分割线前段落。',
  '',
  '---',
  '',
  '正文 ==高亮文字== 段落。',
  '',
  '## 嵌套 ==**粗亮**== 标题',
  '',
].join('\n')

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

function mountProbe(h: BridgeHarness): WebviewSyncController {
  const c = new WebviewSyncController(h.bridge)
  parent = document.createElement('div')
  document.body.appendChild(parent)
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
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

beforeEach(() => {
  parent = undefined
})

afterEach(() => {
  parent?.remove()
  parent = undefined
})

describe('live 计数探针（#105/#106 误计钉住）', () => {
  it('taskGlyphs 只数任务 checkbox：渲染态分割线 widget 不计入任务字形', () => {
    const h = makeBridge()
    const c = mountProbe(h)
    const st = viewState(c, h)
    expect(st.liveSyntax).toBeDefined()
    // 2 个任务（1 勾选）+ 1 条渲染态分割线：分割线 widget 不得混入计数
    expect(st.liveSyntax!.taskGlyphs).toBe(2)
    expect(st.liveSyntax!.taskChecked).toBe(1)
    // 分割线行级类与水平线计数本身不受影响（#106 语义）
    expect(st.liveSyntax!.hrLines).toBe(1)
  })

  it('含 highlight span 的大纲数据：view.state 消息整体仍被协议校验接受', () => {
    const h = makeBridge()
    const c = mountProbe(h)
    const st = viewState(c, h)
    // 前置：嵌套标题透传确实带出了 highlight span（保证本用例测的是该路径）
    const nested = st.outline?.items.find((item) => item.text.includes('嵌套'))
    expect(nested?.spans.some((span) => span.kind === 'highlight')).toBe(true)
    // 宿主侧对 webview 消息先过 isWebviewToHost：outline 校验失败会整条丢弃
    // （集成 viewState 超时的根因路径）
    expect(isWebviewToHost(st)).toBe(true)
  })
})

describe('绘制探针候选选择（firstPaintedOf：任一命中即代表绘制）', () => {
  /** 构造带可控 rect 的元素；visible=true 时中心点命中自身 */
  function fakeEl(tag: 'span' | 'hr', visible: boolean, label: string): HTMLElement {
    const el = document.createElement(tag)
    el.setAttribute('data-label', label)
    el.getBoundingClientRect = () =>
      visible ? new DOMRect(0, 10, 100, 2) : new DOMRect(0, -50, 100, 2)
    return el
  }

  it('首个候选未命中时取后续命中者：视口外首条不再误伤可见性', () => {
    // 场景对应 hr.md 插入用例：首条分割线滚出视口（rect 在视口上方），
    // 新分割线真实绘制。elementFromPoint 只命中第二条
    const offscreen = fakeEl('span', false, 'offscreen')
    const painted = fakeEl('span', true, 'painted')
    const original = document.elementFromPoint
    document.elementFromPoint = (_x: number, y: number): Element | null =>
      y >= 10 && y <= 12 ? painted : null
    try {
      const hit = firstPaintedOf([offscreen, painted])
      expect(hit).toBe(painted)
    } finally {
      document.elementFromPoint = original
    }
  })

  it('全不命中时回退首条：display/borderTopWidth 等字段仍可观测（jsdom 同形态）', () => {
    const first = fakeEl('span', false, 'first')
    const second = fakeEl('span', false, 'second')
    expect(firstPaintedOf([first, second])).toBe(first)
  })

  it('空候选返回 null（无分割线时 paint.hr 整体缺省）', () => {
    expect(firstPaintedOf([])).toBeNull()
  })
})
