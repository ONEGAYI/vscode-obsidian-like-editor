// @vitest-environment jsdom
// 大纲右键菜单交互契约（#69）：面板 contextmenu 委托弹出菜单、Esc/外点/
// 命令后关闭、结构命令作用折叠状态机、复制五项经宿主剪贴板消息桥出站、
// 调级/删除单事务写回（一笔 edit.request）、重命名行内编辑态（Enter 提交/
// Esc 取消/点击不跳转）、probe 菜单观测字段。控制域几何与文本变换语义在
// outlineSection.test.ts；菜单模型在 outlineMenu.test.ts。
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/menu.md'

// 条目索引：0 主(H1) 1 Alpha(H2) 2 Alpha子(H3) 3 Beta(H2) 4 Beta深(H4,跨级挂 Beta) 5 第二顶(H1)
const MENU_DOC = [
  '# 主标题',
  '主标题内容',
  '## Alpha',
  'Alpha 内容',
  '### Alpha 子',
  '子内容',
  '## Beta',
  'Beta 内容',
  '#### Beta 深',
  '深内容',
  '# 第二顶',
  '内容',
].join('\n')

interface BridgeHarness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
}

function makeBridge(): BridgeHarness {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: () => undefined,
    setState: () => undefined,
  }
  return { bridge, sent }
}

function mountMenu(h: BridgeHarness, text = MENU_DOC) {
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

function menuDom(parent: HTMLElement) {
  const sidebar = parent.querySelector<HTMLElement>('.vsidian-sidebar')!
  const panel = sidebar.querySelector<HTMLElement>('.vsidian-outline-panel')!
  return {
    sidebar,
    panel,
    menu: () => sidebar.querySelector<HTMLElement>('.vsidian-outline-menu'),
    items: () => [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')],
    itemTexts: () =>
      [...panel.querySelectorAll<HTMLElement>('.vsidian-outline-item')].map((el) => el.textContent ?? ''),
    renameInput: () => panel.querySelector<HTMLInputElement>('.vsidian-outline-rename-input'),
  }
}

/** 对第 index 个条目派发真实 contextmenu 事件（与用户右键同一委托链路） */
function contextMenuOn(parent: HTMLElement, index: number): MouseEvent {
  const el = menuDom(parent).items()[index]!
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
  el.dispatchEvent(event)
  return event
}

describe('菜单开合（contextmenu 弹出 / Esc / 外点 / 命令后关闭）', () => {
  it('条目 contextmenu 弹出菜单（preventDefault 阻断浏览器原生菜单）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    const event = contextMenuOn(parent, 1)
    expect(event.defaultPrevented, 'contextmenu 须 preventDefault').toBe(true)
    const d = menuDom(parent)
    expect(d.menu(), '侧栏内应挂载菜单容器').toBeTruthy()
    expect(d.menu()!.getAttribute('role')).toBe('menu')
    const state = viewState(c, h)
    expect(state.outline?.menuOpen).toBe(true)
    expect(state.outline?.menuTargetIndex).toBe(1)
  })

  it('outline.test.contextMenu 测试钩子走同一委托（宿主注入通道）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    c.handleHostMessage({ kind: 'outline.test.contextMenu', index: 3 })
    expect(menuDom(parent).menu()).toBeTruthy()
    expect(viewState(c, h).outline?.menuTargetIndex).toBe(3)
  })

  it('无子项条目：递归展开项 disabled（DOM disabled 属性）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    contextMenuOn(parent, 2) // Alpha 子（叶）
    const btn = menuDom(parent).menu()!.querySelector<HTMLButtonElement>(
      'button[data-vsidian-command="expandRecursively"]',
    )!
    expect(btn.disabled).toBe(true)
  })

  it('Esc 关闭菜单（document keydown）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    contextMenuOn(parent, 1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(menuDom(parent).menu(), 'Esc 后菜单应移除').toBeNull()
    expect(viewState(c, h).outline?.menuOpen).toBe(false)
  })

  it('菜单外 pointerdown 关闭；菜单内点击不关闭（命令后才关）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    contextMenuOn(parent, 1)
    const menu = menuDom(parent).menu()!
    menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(menuDom(parent).menu(), '菜单内按下不得关闭').toBeTruthy()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(menuDom(parent).menu(), '外点应关闭菜单').toBeNull()
    expect(viewState(c, h).outline?.menuOpen).toBe(false)
  })

  it('outline.test.menuClose 测试钩子关闭菜单', () => {
    const h = makeBridge()
    const { parent, c } = mountMenu(h)
    contextMenuOn(parent, 0)
    c.handleHostMessage({ kind: 'outline.test.menuClose' })
    expect(menuDom(parent).menu()).toBeNull()
  })

  it('执行命令后菜单关闭（除重命名：进入编辑态）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    contextMenuOn(parent, 1)
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="copyHeading"]')!
      .click()
    expect(menuDom(parent).menu(), '命令执行后菜单应关闭').toBeNull()
  })

  it('收起侧栏时菜单随之关闭（菜单挂在侧栏内）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    contextMenuOn(parent, 1)
    c.handleHostMessage({ kind: 'sidebar.test.click' })
    expect(menuDom(parent).menu(), '侧栏收起后菜单应移除').toBeNull()
  })
})

describe('结构命令（消费折叠状态机）', () => {
  it('递归展开：折叠态下整棵子树父节点并入展开集', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    c.handleHostMessage({ kind: 'outline.test.expandClick', level: 0 })
    contextMenuOn(parent, 0) // 主标题（含全部后代）
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="expandRecursively"]')!
      .click()
    const state = viewState(c, h)
    // 主标题递归展开 = 主、Alpha、Beta 全部父节点展开 → 全部条目可见
    expect(state.outline?.visibleIndices).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('折叠同级：同父组内父节点键删除（Alpha 与 Beta 折叠，主标题保留）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    contextMenuOn(parent, 1) // Alpha（同级组 = Alpha、Beta）
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="collapseSiblings"]')!
      .click()
    const state = viewState(c, h)
    // Alpha 与 Beta 折叠 → 2（Alpha 子）与 4（Beta 深）隐藏
    expect(state.outline?.visibleIndices).toEqual([0, 1, 3, 5])
  })

  it('展开同级：折叠态下同父组全部父节点展开', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    c.handleHostMessage({ kind: 'outline.test.chevronClick', index: 1 }) // 折叠 Alpha
    c.handleHostMessage({ kind: 'outline.test.chevronClick', index: 3 }) // 折叠 Beta
    contextMenuOn(parent, 1)
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="expandSiblings"]')!
      .click()
    const state = viewState(c, h)
    expect(state.outline?.visibleIndices).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('结构命令零写回（纯视图状态，无 edit.request）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    contextMenuOn(parent, 0)
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="expandRecursively"]')!
      .click()
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })
})

describe('复制五项（经宿主剪贴板消息桥）', () => {
  const openAndClick = (parent: HTMLElement, index: number, command: string): void => {
    contextMenuOn(parent, index)
    const btn = menuDom(parent).menu()!.querySelector<HTMLButtonElement>(
      `button[data-vsidian-command="${command}"]`,
    )
    expect(btn, `菜单项 ${command} 应存在`).toBeTruthy()
    btn!.click()
  }

  it('复制标题：plainText（剥标记）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h, '# **重点** 标题\n\n## 普通\n')
    openAndClick(parent, 0, 'copyHeading')
    expect(h.sent).toContainEqual({ kind: 'clipboard.write', text: '重点 标题' })
  })

  it('复制标题和兄弟标题：同父组全部（含自身）逐行', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    openAndClick(parent, 1, 'copySiblings')
    expect(h.sent).toContainEqual({ kind: 'clipboard.write', text: 'Alpha\nBeta' })
  })

  it('复制标题和子标题：子树全部（含自身；跨级深标题随父）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    openAndClick(parent, 3, 'copyChildren') // Beta（子树含 Beta 深）
    expect(h.sent).toContainEqual({ kind: 'clipboard.write', text: 'Beta\nBeta 深' })
  })

  it('复制标题链接：linkHeading 变体（宿主拼 [[笔记名#标题]]）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h, '# **重点** 标题\n')
    openAndClick(parent, 0, 'copyLink')
    expect(h.sent).toContainEqual({
      kind: 'clipboard.write',
      linkHeading: { docUri: DOC_URI, heading: '重点 标题' },
    })
  })

  it('复制该段内容：整控制域源文（含标题行与正文）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    openAndClick(parent, 1, 'copySection')
    expect(h.sent).toContainEqual({
      kind: 'clipboard.write',
      text: '## Alpha\nAlpha 内容\n### Alpha 子\n子内容',
    })
  })

  it('复制零写回（无 edit.request）', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    openAndClick(parent, 0, 'copyHeading')
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })
})

describe('调整层级（写回 = 单笔 edit.request = 撤销一次）', () => {
  const openAndClick = (parent: HTMLElement, index: number, command: string): void => {
    contextMenuOn(parent, index)
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>(`button[data-vsidian-command="${command}"]`)!
      .click()
  }
  const editRequests = (h: BridgeHarness) => h.sent.filter((m) => m.kind === 'edit.request')

  it('增加一级：重写 # 数量，大纲即时刷新（不等去抖）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    openAndClick(parent, 1, 'levelUp') // Alpha H2→H3
    const text = c.getView()!.state.doc.toString()
    expect(text).toContain('### Alpha')
    expect(text).toContain('Alpha 内容') // 控制域内正文不动
    const state = viewState(c, h)
    expect(state.outline?.items[1]).toMatchObject({ level: 3, text: 'Alpha' })
    expect(editRequests(h)).toHaveLength(1)
    expect(editRequests(h)[0]!.changes).toEqual([
      { offset: MENU_DOC.indexOf('## Alpha'), length: '## Alpha'.length, text: '### Alpha' },
    ])
  })

  it('递归增加：整棵子树逐条 +1，一笔多段单事务', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    openAndClick(parent, 1, 'levelUpRecursive') // Alpha 子树：Alpha H2→H3、Alpha 子 H3→H4
    const text = c.getView()!.state.doc.toString()
    expect(text).toContain('### Alpha\n')
    expect(text).toContain('#### Alpha 子')
    expect(editRequests(h)).toHaveLength(1)
    expect(editRequests(h)[0]!.changes).toHaveLength(2)
  })

  it('H1 减少钳制：无写回、无 edit.request', () => {
    const h = makeBridge()
    const { parent } = mountMenu(h)
    openAndClick(parent, 0, 'levelDown')
    expect(editRequests(h)).toHaveLength(0)
  })

  it('H6 场景与递归减少：深标题同步降级', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    openAndClick(parent, 3, 'levelDownRecursive') // Beta 子树：Beta H2→H1、Beta 深 H4→H3
    const text = c.getView()!.state.doc.toString()
    expect(text).toContain('# Beta\n')
    expect(text).toContain('### Beta 深')
    expect(editRequests(h)[0]!.changes).toHaveLength(2)
    expect(c.getView()!.state.doc.lines).toBe(12) // 控制域外零增删
  })
})

describe('删除整控制域（直接生效，无确认）', () => {
  it('删除中间段：相邻段完整保留，单笔写回', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    contextMenuOn(parent, 1) // Alpha 段（含 Alpha 子）
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="delete"]')!
      .click()
    const text = c.getView()!.state.doc.toString()
    expect(text).not.toContain('Alpha')
    expect(text.startsWith('# 主标题\n主标题内容\n## Beta')).toBe(true)
    expect(text.endsWith('深内容\n# 第二顶\n内容')).toBe(true)
    const state = viewState(c, h)
    expect(state.outline?.items.map((i) => i.text)).toEqual(['主标题', 'Beta', 'Beta 深', '第二顶'])
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
  })

  it('删除文末段与唯一标题段边界', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h, '# 唯一\n内容\n')
    contextMenuOn(parent, 0)
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="delete"]')!
      .click()
    expect(c.getView()!.state.doc.toString()).toBe('')
    const state = viewState(c, h)
    expect(state.outline?.items).toEqual([])
  })
})

describe('重命名（行内编辑态：编辑原文、标记是资产）', () => {
  const startRename = (parent: HTMLElement, index: number): HTMLInputElement => {
    contextMenuOn(parent, index)
    menuDom(parent).menu()!
      .querySelector<HTMLButtonElement>('button[data-vsidian-command="rename"]')!
      .click()
    const input = menuDom(parent).renameInput()
    expect(input, '菜单关闭后条目内应出现重命名输入框').toBeTruthy()
    return input!
  }

  it('重命名进入编辑态：菜单关闭、input 值为原文（含行内标记）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h, '# **重点** 标题\n')
    const input = startRename(parent, 0)
    expect(input.value).toBe('**重点** 标题')
    expect(menuDom(parent).menu(), '重命名态菜单应关闭').toBeNull()
    expect(viewState(c, h).outline?.renamingIndex).toBe(0)
  })

  it('Enter 提交：整标题行替换写回（# 数量保持，原文可含标记）', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    const input = startRename(parent, 1)
    input.value = '*新名* 加粗'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const text = c.getView()!.state.doc.toString()
    expect(text).toContain('## *新名* 加粗')
    const state = viewState(c, h)
    expect(state.outline?.items[1]).toMatchObject({ text: '*新名* 加粗', plainText: '新名 加粗' })
    expect(state.outline?.renamingIndex).toBe(null)
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
  })

  it('Esc 取消：零写回、编辑态退出', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    const input = startRename(parent, 1)
    input.value = '不该出现'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(c.getView()!.state.doc.toString()).toBe(MENU_DOC)
    expect(h.sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
    expect(viewState(c, h).outline?.renamingIndex).toBe(null)
    expect(menuDom(parent).renameInput(), 'Esc 后输入框应移除').toBeNull()
  })

  it('输入框键盘事件不冒泡成正文快捷键、点击不触发跳转', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    const input = startRename(parent, 1)
    const before = c.getView()!.state.selection.main.from
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(c.getView()!.state.selection.main.from, '点击输入框不得触发跳转').toBe(before)
    // keydown 不进 CM6 keymap（input 内 stopPropagation）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    expect(c.getView()!.state.doc.toString()).toBe(MENU_DOC)
  })

  it('outline.test.renameKey 测试钩子：注入文本并 Enter/Escape 收尾', () => {
    const h = makeBridge()
    const { c } = mountMenu(h)
    c.handleHostMessage({ kind: 'outline.test.contextMenu', index: 1 })
    c.handleHostMessage({ kind: 'outline.test.menuClick', command: 'rename' })
    c.handleHostMessage({ kind: 'outline.test.renameKey', text: '钩子改名', key: 'enter' })
    expect(c.getView()!.state.doc.toString()).toContain('## 钩子改名')
  })

  it('重命名 Setext 标题：两行（内容+下划线）替换为 ATX 单行', () => {
    const h = makeBridge()
    const doc = '# 甲\n\nSetext 名\n=========\n\n正文。\n'
    const { c } = mountMenu(h, doc)
    c.handleHostMessage({ kind: 'outline.test.contextMenu', index: 1 })
    c.handleHostMessage({ kind: 'outline.test.menuClick', command: 'rename' })
    c.handleHostMessage({ kind: 'outline.test.renameKey', text: '新名', key: 'enter' })
    const text = c.getView()!.state.doc.toString()
    expect(text).toContain('# 新名\n')
    expect(text).not.toContain('====')
    expect(text).toContain('正文。')
  })
})

describe('菜单期间的数据与状态存活', () => {
  it('写操作后大纲与折叠状态存活（重命名不扰动折叠）', () => {
    const h = makeBridge()
    const { c } = mountMenu(h)
    c.handleHostMessage({ kind: 'outline.test.chevronClick', index: 1 }) // 折叠 Alpha
    c.handleHostMessage({ kind: 'outline.test.contextMenu', index: 3 })
    c.handleHostMessage({ kind: 'outline.test.menuClick', command: 'rename' })
    c.handleHostMessage({ kind: 'outline.test.renameKey', text: 'Beta 改名', key: 'enter' })
    const state = viewState(c, h)
    expect(state.outline?.items[3]!.text).toBe('Beta 改名')
    // 档 5 下折叠 Alpha（chevronClick 1）：仅 Alpha 子（2）被遮；Beta 展开
    // 中（4 可见）——重命名不扰动该折叠视图
    expect(state.outline?.visibleIndices).toEqual([0, 1, 3, 4, 5])
  })

  it('菜单打开时条目 DOM 重建（外部变更）菜单关闭', () => {
    const h = makeBridge()
    const { c, parent } = mountMenu(h)
    contextMenuOn(parent, 1)
    // 模拟外部变更导致的序列重建（菜单锚点过期）
    c.handleHostMessage({ kind: 'doc.changed', version: 2, changes: [{ offset: 0, length: 4, text: '# 新' }], origin: 'external' })
    viewState(c, h) // 触发即时校准（可能重建条目 DOM）
    expect(menuDom(parent).menu(), '条目重建后菜单应关闭（锚点过期）').toBeNull()
  })
})
