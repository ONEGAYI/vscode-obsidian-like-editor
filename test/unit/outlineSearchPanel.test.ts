// @vitest-environment jsdom
// 大纲工具条与标题搜索交互契约（#68）：侧栏顶栏与滑块之间插入工具条行
// （跳转到末尾、重置、搜索输入框），搜索过滤与片段级高亮、清空回放展开
// 快照、重置三合一、跳转末尾双模式零写回。
// - 工具条与搜索全部是纯视图状态：零 edit.request、文本不变、不入撤销栈
// - 搜索匹配口径 = plainText（剥标记可见文本，`**粗体**` 输「粗体」命中）
// - 可见口径 = 折叠可见 ∩ 搜索过滤；located 高亮在搜索态下回退到组合
//   可见代表（链上无可见代表则高亮消失）
// - outline.test.searchInput / outline.test.toolbarClick 测试钩子驱动与
//   用户输入同一处理器链路
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

// #94 起文案经 t() 取词：装配生产中文包，断言与字典同源
installLocale('zh-cn', zhCn)

// jsdom 无布局：CM6 视口测量的零值 polyfill（与 outlinePanel.test.ts 同款）
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/outline-search.md'

/** 搜索样例（与 outlineSearch.test.ts 的纯函数样例同构）：
 *  0=Alpha(H1,父) 1=Bold 标题(H2,父,粗体标记) 2=Gamma(H3,叶)
 *  3=Delta(H2,父) 4=Epsilon(H4,叶) 5=Zeta(H1,叶) + 尾部正文 */
const DOC = [
  '# Alpha',
  '',
  '## **Bold** 标题',
  '正文甲。',
  '### Gamma',
  '正文乙。',
  '## Delta',
  '### Epsilon',
  '正文丙。',
  '# Zeta',
  '结尾正文，撑出末尾控制域。',
  '',
].join('\n')

interface BridgeHarness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
  saved: () => Record<string, unknown> | undefined
}

function makeBridge(saved?: Record<string, unknown>): BridgeHarness {
  const sent: WebviewToHost[] = []
  let state = saved
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as Record<string, unknown>
    },
  }
  return { bridge, sent, saved: () => state }
}

function mountPanel(h: BridgeHarness, text = DOC) {
  const c = new WebviewSyncController(h.bridge)
  const parent = document.createElement('div')
  c.mount(parent)
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text })
  c.handleHostMessage({ kind: 'sidebar.test.click' })
  return { c, parent }
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

function searchDom(parent: HTMLElement) {
  const sidebar = parent.querySelector<HTMLElement>('.vsidian-sidebar')!
  const panel = sidebar.querySelector<HTMLElement>('.vsidian-outline-panel')!
  const itemEls = () => [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')]
  return {
    sidebar,
    panel,
    toolbar: sidebar.querySelector<HTMLElement>('.vsidian-outline-toolbar'),
    jumpBottom: sidebar.querySelector<HTMLButtonElement>('.vsidian-outline-jump-bottom'),
    reset: sidebar.querySelector<HTMLButtonElement>('.vsidian-outline-reset'),
    search: sidebar.querySelector<HTMLInputElement>('.vsidian-outline-search'),
    slider: sidebar.querySelector<HTMLElement>('.vsidian-outline-slider'),
    itemEls,
    texts: () => itemEls().map((el) => el.textContent ?? ''),
    hiddenIndices: () =>
      itemEls()
        .map((el, i) => (el.classList.contains('vsidian-outline-hidden') ? i : -1))
        .filter((i) => i >= 0),
    marksOf: (index: number) =>
      [...itemEls()[index]!.querySelectorAll<HTMLElement>('.vsidian-outline-search-hit')]
        .map((el) => el.textContent ?? ''),
    nomatch: () => panel.querySelector<HTMLElement>('.vsidian-outline-nomatch'),
    locatedIndex: () =>
      itemEls().findIndex((el) => el.classList.contains('vsidian-outline-located')),
  }
}

describe('工具条装配（#68：布局与可访问性）', () => {
  it('工具条行位于侧栏顶栏与滑块行之间：三控件顺序 = 跳转末尾、重置、搜索框', () => {
    const h = makeBridge()
    const { parent } = mountPanel(h)
    const d = searchDom(parent)
    expect(d.toolbar, '应有 vsidian-outline-toolbar 工具条行').toBeTruthy()
    const toolbar = d.toolbar!
    expect(d.jumpBottom).toBeTruthy()
    expect(d.reset).toBeTruthy()
    expect(d.search).toBeTruthy()
    // 顺序：按钮、按钮、搜索框
    const controls = [...toolbar.children].filter((el) =>
      el === d.jumpBottom || el === d.reset || el === d.search)
    expect(controls).toEqual([d.jumpBottom, d.reset, d.search])
    // 位置：顶栏 < 工具条 < 滑块 < 面板宿主
    const bar = d.sidebar.querySelector('.vsidian-sidebar-toolbar')!
    const panelHost = d.sidebar.querySelector('.vsidian-sidebar-panel')!
    expect(bar.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(toolbar.compareDocumentPosition(d.slider!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(d.slider!.compareDocumentPosition(panelHost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('按钮有可访问名称；搜索框 placeholder 为「输入以搜索」且有 aria-label', () => {
    const h = makeBridge()
    const { parent } = mountPanel(h)
    const d = searchDom(parent)
    expect(d.jumpBottom!.getAttribute('aria-label')).toBe(zhCn['outline.jumpBottom'])
    expect(d.jumpBottom!.getAttribute('title')).toBe(zhCn['outline.jumpBottom'])
    expect(d.reset!.getAttribute('aria-label')).toBe(zhCn['outline.reset'])
    expect(d.reset!.getAttribute('title')).toBe(zhCn['outline.reset'])
    expect(d.search!.getAttribute('placeholder')).toBe(zhCn['outline.searchPlaceholder'])
    expect(d.search!.getAttribute('aria-label')).toBe(zhCn['outline.searchLabel'])
    expect(d.search!.getAttribute('type')).toBe('search')
  })
})

describe('搜索过滤与片段高亮（#68）', () => {
  it('输入即时生效：无关标题隐藏（hidden 类）、匹配路径祖先保留', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'gamma' })
    const d = searchDom(parent)
    // Gamma(2) 命中：Alpha(0)、Beta(1) 祖先保留；Delta 分支与 Zeta 隐藏
    expect(d.hiddenIndices()).toEqual([3, 4, 5])
    expect(d.texts()).toEqual(['Alpha', 'Bold 标题', 'Gamma', 'Delta', 'Epsilon', 'Zeta'])
    const state = viewState(c, h)
    expect(state.outline?.searchQuery).toBe('gamma')
    expect(state.outline?.searchActive).toBe(true)
    expect(state.outline?.filteredVisibleIndices).toEqual([0, 1, 2])
  })

  it('命中剥标记可见文本：`**Bold** 标题` 输「bold」命中', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'BOLD' })
    const d = searchDom(parent)
    expect(d.hiddenIndices()).toEqual([2, 3, 4, 5]) // Gamma/Epsilon 分支与 Zeta 隐藏
    expect(viewState(c, h).outline?.filteredVisibleIndices).toEqual([0, 1])
  })

  it('片段级高亮：命中子串包 mark（只覆盖命中片段，多处出现多 mark）', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'a' })
    const d = searchDom(parent)
    // Alpha 条目（'Alpha' 内两处 'a'——不区分大小写）两段 mark
    expect(d.marksOf(0)).toEqual(['A', 'a'])
    // Gamma（'Gamma' 内两处）与 Delta（尾部一处）、Zeta（尾部一处）
    expect(d.marksOf(2)).toEqual(['a', 'a'])
    expect(d.marksOf(3)).toEqual(['a'])
    expect(d.marksOf(5)).toEqual(['a'])
    // 祖先保留但不命中：Beta(1) 无 mark
    expect(d.marksOf(1)).toEqual([])
    expect(viewState(c, h).outline?.searchHitPainted).toBe(false) // jsdom 无布局容错
  })

  it('高亮与行内标记正交：mark 只落在文本层，语义元素仍在', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'bold' })
    const d = searchDom(parent)
    const item1 = d.itemEls()[1]!
    const strong = item1.querySelector('strong.vsidian-outline-strong')
    expect(strong, '语义元素不应被搜索破坏').toBeTruthy()
    expect(d.marksOf(1)).toEqual(['Bold'])
    // mark 在 strong 内部（文本层切分，不包裹语义元素外层）
    expect(strong!.querySelector('mark.vsidian-outline-search-hit')).toBeTruthy()
  })

  it('无匹配显示「无匹配」占位；输入清空后占位消失、过滤恢复', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '不存在' })
    const d = searchDom(parent)
    expect(d.hiddenIndices()).toEqual([0, 1, 2, 3, 4, 5])
    expect(d.nomatch()?.textContent).toBe(zhCn['outline.noMatch'])
    const state = viewState(c, h)
    expect(state.outline?.filteredVisibleIndices).toEqual([])
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '' })
    expect(d.nomatch()).toBeNull()
    expect(d.hiddenIndices()).toEqual([])
    expect(viewState(c, h).outline?.searchActive).toBe(false)
  })

  it('搜索全程零写回：无 edit.request、文本不变', () => {
    const h = makeBridge()
    const { c } = mountPanel(h)
    const before = viewState(c, h).text
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'gamma' })
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'zzz' })
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '' })
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
    expect(viewState(c, h).text).toBe(before)
  })
})

describe('搜索与折叠状态组合（#68：QO 快照语义）', () => {
  it('进入搜索时快照展开集：命中路径自动展开；清空回放进入前快照', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    const d = searchDom(parent)
    // 前置：档 1（Beta/Delta 折叠遮蔽深层）
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 1 })
    expect(d.hiddenIndices()).toEqual([2, 4])
    // 搜索 gamma：Gamma 命中 → Beta 展开自动并入（Delta/Epsilon/Zeta 被过滤隐藏）
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'gamma' })
    expect(d.hiddenIndices()).toEqual([3, 4, 5])
    const state = viewState(c, h)
    expect(state.outline?.filteredVisibleIndices).toEqual([0, 1, 2]) // Gamma 可见（路径展开）
    // 清空：回放进入搜索前的档 1 快照（Gamma 重新被 Beta 折叠遮蔽）
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '' })
    expect(d.hiddenIndices()).toEqual([2, 4])
    expect(viewState(c, h).outline?.visibleIndices).toEqual([0, 1, 3, 5])
  })

  it('搜索态切档：档位精确集 ∪ 命中链，清空回放与档位一致', () => {
    const h = makeBridge()
    const { c } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'gamma' })
    // 搜索态切档 0（No-Expand）：Alpha 折叠，但 Gamma 命中链展开 Alpha、Beta
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 })
    expect(viewState(c, h).outline?.expandLevel).toBe(0)
    expect(viewState(c, h).outline?.filteredVisibleIndices).toEqual([0, 1, 2])
    // 清空回放：快照已同步为档 0 精确集（只露顶层）
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: '' })
    expect(viewState(c, h).outline?.visibleIndices).toEqual([0, 5])
  })

  it('搜索态下箭头折叠命中祖先：命中条目随之遮蔽（手动折叠优先）', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    const d = searchDom(parent)
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'gamma' })
    expect(d.hiddenIndices()).toEqual([3, 4, 5])
    // 手动折叠 Beta(1)：Gamma 被遮蔽（组合口径下不可见）
    c.handleHostMessage({ kind: 'outline.test.chevronClick', index: 1 })
    expect(viewState(c, h).outline?.filteredVisibleIndices).toEqual([0, 1])
  })

  it('located 高亮与搜索并存：located 被过滤时回退到可见代表，链上无代表则消失', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    const d = searchDom(parent)
    // 高亮定位到 Gamma（itemClick 即时落位）
    c.handleHostMessage({ kind: 'outline.test.itemClick', index: 2 })
    expect(d.locatedIndex()).toBe(2)
    // 搜索 gamma：Gamma 保留，高亮保持
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'gamma' })
    expect(d.locatedIndex()).toBe(2)
    // 搜索词换成只命中 Zeta：Gamma 与其链全被过滤，高亮消失
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'zeta' })
    expect(d.locatedIndex()).toBe(-1)
    // probe 的 locatedItemIndex 仍回报真实控制域（Gamma）
    expect(viewState(c, h).outline?.locatedItemIndex).toBe(2)
  })
})

describe('跳转到笔记末尾（#68：双模式零写回）', () => {
  it('live 模式：不落光标（选区不动）、零写回，located 落末尾控制域', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    const d = searchDom(parent)
    const before = c.getView()!.state.selection.main.from
    const textBefore = viewState(c, h).text
    c.handleHostMessage({ kind: 'outline.test.toolbarClick', action: 'jump-bottom' })
    expect(c.getView()!.state.selection.main.from).toBe(before)
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
    expect(viewState(c, h).text).toBe(textBefore)
    // 末尾正文所在控制域 = Zeta（最后一个标题）
    expect(viewState(c, h).outline?.locatedItemIndex).toBe(5)
    expect(viewState(c, h).outline?.locatedText).toBe('Zeta')
    expect(d.locatedIndex()).toBe(5)
  })

  it('reading 模式：滚动到末尾块、零写回', () => {
    const h = makeBridge()
    const { c } = mountPanel(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const textBefore = viewState(c, h).text
    c.handleHostMessage({ kind: 'outline.test.toolbarClick', action: 'jump-bottom' })
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
    expect(viewState(c, h).text).toBe(textBefore)
    expect(viewState(c, h).outline?.locatedItemIndex).toBe(5)
  })
})

describe('重置三合一（#68：清搜索词 + 档位回默认 5 + 清手动折叠）', () => {
  it('搜索态 + 手动折叠 + 非默认档的组合场景一键回到初始态', () => {
    const h = makeBridge()
    const { c, parent } = mountPanel(h)
    const d = searchDom(parent)
    // 组合前置：档 1 + 手动折叠 Alpha（子树全遮）+ 搜索词
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 1 })
    c.handleHostMessage({ kind: 'outline.test.chevronClick', index: 0 }) // Alpha 折叠（子树遮蔽）
    expect(d.hiddenIndices()).toEqual([1, 2, 3, 4])
    c.handleHostMessage({ kind: 'outline.test.searchInput', text: 'zeta' })
    // 重置
    c.handleHostMessage({ kind: 'outline.test.toolbarClick', action: 'reset' })
    const state = viewState(c, h)
    expect(state.outline?.searchQuery).toBe('')
    expect(state.outline?.searchActive).toBe(false)
    expect(state.outline?.expandLevel).toBe(5)
    expect(state.outline?.visibleIndices).toEqual([0, 1, 2, 3, 4, 5]) // 全展开（手动折叠清空）
    expect(d.hiddenIndices()).toEqual([])
    expect(d.search!.value).toBe('') // 输入框同步清空
    expect(d.nomatch()).toBeNull()
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })

  it('重置后档位持久化为默认 5（bridge state 同步）', () => {
    const h = makeBridge()
    const { c } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 2 })
    c.handleHostMessage({ kind: 'outline.test.toolbarClick', action: 'reset' })
    expect((h.saved() as { outlineExpandLevel?: number }).outlineExpandLevel).toBe(5)
  })
})

describe('probe 观测字段（#68：jsdom 无布局容错口径）', () => {
  it('工具条绘制证据与名称字段随 view.state 回报', () => {
    const h = makeBridge()
    const { c } = mountPanel(h)
    const state = viewState(c, h)
    expect(state.outline?.toolbarPainted).toBe(false) // jsdom 无布局恒 false
    expect(state.outline?.jumpBottomAriaLabel).toBe(zhCn['outline.jumpBottom'])
    expect(state.outline?.resetAriaLabel).toBe(zhCn['outline.reset'])
    expect(state.outline?.searchPlaceholder).toBe(zhCn['outline.searchPlaceholder'])
    expect(state.outline?.nomatchPainted).toBe(false)
  })

  it('搜索关闭时 filteredVisibleIndices 与折叠口径同值', () => {
    const h = makeBridge()
    const { c } = mountPanel(h)
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 1 })
    const state = viewState(c, h)
    expect(state.outline?.filteredVisibleIndices).toEqual(state.outline?.visibleIndices)
  })
})
