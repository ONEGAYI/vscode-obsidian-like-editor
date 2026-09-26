// @vitest-environment jsdom
// 大纲右键菜单契约（#69）：菜单结构模型（结构命令/复制/调级/重命名/删除 +
// 两级级联）、结构命令对折叠状态机的作用（递归展开/同级批量两向）、菜单
// DOM 装配（按钮化键盘可达）与定位纯函数（侧栏内 clamp + 不遮挡目标条目）。
// 写操作（调级/重命名/删除的文本变换）语义在 outlineSection.test.ts；
// 菜单开合与控制器装配在 outlineMenuPanel.test.ts。
import { describe, expect, it } from 'vitest'
import {
  buildOutlineMenu,
  OUTLINE_MENU_CLASS_NAMES,
  outlineMenuPosition,
  outlineMenuSpec,
  type OutlineMenuCommand,
  outlineStructuralExpand,
} from '../../src/webview/outlineMenu'

/** 折叠状态机消费形状的最小条目 */
const level = (lv: number) => ({ level: lv })

// 样例：A>B>C 嵌套 + D>E 跨级（E 挂 D）+ 顶层 F
// 索引：0=A(H1) 1=B(H2) 2=C(H3) 3=D(H2) 4=E(H4) 5=F(H1)
const TREE = [level(1), level(2), level(3), level(2), level(4), level(1)]

describe('菜单结构模型（票面命令清单）', () => {
  it('顶级项：结构命令三 + 复制子菜单 + 调级子菜单 + 重命名 + 删除', () => {
    const spec = outlineMenuSpec(true)
    expect(spec.map((s) => s.id)).toEqual([
      'expandRecursively',
      'collapseSiblings',
      'expandSiblings',
      'copy',
      'level',
      'rename',
      'delete',
    ])
    expect(spec.map((s) => s.label)).toEqual([
      '递归展开',
      '折叠同级',
      '展开同级',
      '复制',
      '调整层级',
      '重命名',
      '删除',
    ])
  })

  it('复制子菜单五项（Obsidian 同款清单）', () => {
    const copy = outlineMenuSpec(true).find((s) => s.id === 'copy')
    expect(copy?.children?.map((c) => [c.id, c.label])).toEqual([
      ['copyHeading', '标题'],
      ['copySiblings', '标题和兄弟标题'],
      ['copyChildren', '标题和子标题'],
      ['copyLink', '标题链接'],
      ['copySection', '该段内容'],
    ])
  })

  it('调级子菜单四项（增加/递归增加/减少/递归减少）', () => {
    const lv = outlineMenuSpec(true).find((s) => s.id === 'level')
    expect(lv?.children?.map((c) => [c.id, c.label])).toEqual([
      ['levelUp', '增加一级'],
      ['levelUpRecursive', '递归增加一级'],
      ['levelDown', '减少一级'],
      ['levelDownRecursive', '递归减少一级'],
    ])
  })

  it('无子项条目：递归展开 disabled（其余命令仍可用）', () => {
    const spec = outlineMenuSpec(false)
    expect(spec.find((s) => s.id === 'expandRecursively')?.disabled).toBe(true)
    expect(spec.find((s) => s.id === 'collapseSiblings')?.disabled).not.toBe(true)
    expect(spec.find((s) => s.id === 'delete')?.disabled).toBeUndefined()
  })
})

describe('结构命令 → 展开集合（消费折叠状态机）', () => {
  it('递归展开：子树内全部父节点并入展开集（QO 子树父节点批量增）', () => {
    const expanded = new Set([0]) // 仅 A 展开
    const next = outlineStructuralExpand('expandRecursively', TREE, expanded, 0)
    expect([...next].sort((a, b) => a - b)).toEqual([0, 1, 3]) // A、B、D 全部为父并入
    // E 的父 D 展开后 E 可见；C 的父 B 展开后 C 可见
  })

  it('递归展开叶节点：无变化返回原集合引用', () => {
    const expanded = new Set([0])
    expect(outlineStructuralExpand('expandRecursively', TREE, expanded, 2)).toBe(expanded)
  })

  it('折叠同级：同级组内全部父节点键删除（含自身）', () => {
    const expanded = new Set([0, 1, 3]) // A、B、D 展开
    // B 的同级组 = Alpha 直接子级 = B、D → 键 1、3 删除，A 保留
    const next = outlineStructuralExpand('collapseSiblings', TREE, expanded, 1)
    expect([...next]).toEqual([0])
  })

  it('展开同级：同级组内全部父节点键加入', () => {
    const expanded = new Set<number>()
    const next = outlineStructuralExpand('expandSiblings', TREE, expanded, 3)
    // D 的同级组 = B、D（都是父节点）→ 键 1、3 加入
    expect([...next].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('折叠/展开同级作用顶层组（parent=null 组）', () => {
    const expanded = new Set([0, 1, 3])
    const next = outlineStructuralExpand('collapseSiblings', TREE, expanded, 5) // F 顶层组 = A、F
    // A 是父节点 → 删；F 是叶 → 无键可删；B/D 不在组内保留
    expect([...next].sort((a, b) => a - b)).toEqual([1, 3])
  })

  it('未知命令与越界索引：返回原集合引用（无副作用）', () => {
    const expanded = new Set([0])
    expect(outlineStructuralExpand('rename', TREE, expanded, 0)).toBe(expanded)
    expect(outlineStructuralExpand('expandRecursively', TREE, expanded, 99)).toBe(expanded)
  })
})

describe('菜单 DOM 装配（键盘可达 + 稳定类名锚点）', () => {
  it('容器 role=menu + 稳定类名；菜单项为 button（含子菜单的父项也是 button）', () => {
    const menu = buildOutlineMenu(outlineMenuSpec(true), () => {})
    expect(menu.classList.contains(OUTLINE_MENU_CLASS_NAMES.menu)).toBe(true)
    expect(menu.getAttribute('role')).toBe('menu')
    const buttons = menu.querySelectorAll(`button.${OUTLINE_MENU_CLASS_NAMES.item}`)
    // 顶级 7 + 子菜单 5 + 4 = 16 个可激活按钮
    expect(buttons.length).toBe(16)
  })

  it('菜单项携带命令 id（data-vsidian-command，测试钩子与断言锚点）', () => {
    const menu = buildOutlineMenu(outlineMenuSpec(true), () => {})
    const btn = menu.querySelector<HTMLButtonElement>('button[data-vsidian-command="delete"]')
    expect(btn?.textContent).toBe('删除')
    expect(menu.querySelector('button[data-vsidian-command="copyLink"]')?.textContent).toBe('标题链接')
  })

  it('级联子菜单嵌套于父项内（hover/focus-within CSS 显隐的 DOM 前提）', () => {
    const menu = buildOutlineMenu(outlineMenuSpec(true), () => {})
    const copyItem = menu.querySelector<HTMLButtonElement>('button[data-vsidian-command="copy"]')!
    const submenu = copyItem.closest(`.${OUTLINE_MENU_CLASS_NAMES.itemHost}`)?.querySelector(
      `.${OUTLINE_MENU_CLASS_NAMES.submenu}`,
    )
    expect(submenu, '复制父项内应嵌套子菜单容器').toBeTruthy()
    expect(submenu!.querySelectorAll('button').length).toBe(5)
  })

  it('disabled 项渲染 disabled 属性（键盘跳过、点击无回调）', () => {
    const fired: string[] = []
    const menu = buildOutlineMenu(outlineMenuSpec(false), (id) => fired.push(id))
    const btn = menu.querySelector<HTMLButtonElement>('button[data-vsidian-command="expandRecursively"]')!
    expect(btn.disabled).toBe(true)
    btn.click()
    expect(fired).toEqual([])
  })

  it('点击菜单项回调命令 id（子菜单项同样回调）', () => {
    const fired: OutlineMenuCommand[] = []
    const menu = buildOutlineMenu(outlineMenuSpec(true), (id) => fired.push(id))
    menu.querySelector<HTMLButtonElement>('button[data-vsidian-command="collapseSiblings"]')!.click()
    menu.querySelector<HTMLButtonElement>('button[data-vsidian-command="levelDownRecursive"]')!.click()
    expect(fired).toEqual(['collapseSiblings', 'levelDownRecursive'])
  })

  it('删除项带 danger 类（视觉差异锚点）', () => {
    const menu = buildOutlineMenu(outlineMenuSpec(true), () => {})
    const del = menu.querySelector<HTMLButtonElement>('button[data-vsidian-command="delete"]')!
    expect(del.classList.contains(OUTLINE_MENU_CLASS_NAMES.danger)).toBe(true)
  })
})

describe('菜单定位纯函数（侧栏内 clamp + 不遮挡目标条目）', () => {
  // 侧栏坐标系（left=720 top=0 宽 280 高 560）；菜单 180x240
  const bounds = { left: 720, top: 0, width: 280, height: 560 }
  const menuSize = { w: 180, h: 240 }

  it('常规位置：菜单不碰目标条目时，点击点即菜单左上角', () => {
    // 条目在点击点上方远离（菜单从点击点展开不覆盖它）
    const p = outlineMenuPosition({ x: 730, y: 100 }, menuSize, bounds, { top: 8, bottom: 30 })
    expect(p).toEqual({ left: 730, top: 100 })
  })

  it('点击点落在条目内（常规右键）：菜单让位到条目下方，条目保持可见', () => {
    const p = outlineMenuPosition({ x: 730, y: 100 }, menuSize, bounds, { top: 92, bottom: 114 })
    expect(p.left).toBe(730)
    expect(p.top).toBeGreaterThanOrEqual(114)
  })

  it('右缘溢出：水平 clamp 到侧栏内', () => {
    const p = outlineMenuPosition({ x: 1000, y: 300 }, menuSize, bounds, { top: 8, bottom: 30 })
    expect(p.left).toBe(720 + 280 - 180) // 右缘贴齐
    expect(p.top).toBe(300)
  })

  it('底部溢出：向上翻转（菜单底对齐侧栏底）', () => {
    // 点击点 y=500，条目在上方远离（不触发让位），菜单 240 高放不下 → 上翻
    const p = outlineMenuPosition({ x: 730, y: 500 }, menuSize, bounds, { top: 8, bottom: 30 })
    expect(p.top).toBe(560 - 240)
  })

  it('不遮挡目标条目：点击点在条目内时垂直让位（移到条目下方）', () => {
    // 条目 92-114，点击 y=100（条目内）：菜单从条目下方展开，条目保持可见
    const p = outlineMenuPosition({ x: 730, y: 100 }, menuSize, bounds, { top: 92, bottom: 114 })
    expect(p.top).toBeGreaterThanOrEqual(114)
  })

  it('让位后再溢出侧栏底：向上翻转到条目上方', () => {
    // 条目贴近侧栏底部：下方放不下 → 翻转到条目上方
    const p = outlineMenuPosition({ x: 730, y: 540 }, menuSize, bounds, { top: 532, bottom: 554 })
    expect(p.top + menuSize.h).toBeLessThanOrEqual(532)
  })

  it('侧栏比菜单矮（极端）：clamp 不产生负偏移', () => {
    const tiny = { left: 0, top: 0, width: 100, height: 80 }
    const p = outlineMenuPosition({ x: 50, y: 40 }, menuSize, tiny, { top: 32, bottom: 54 })
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.top).toBeGreaterThanOrEqual(0)
  })
})
