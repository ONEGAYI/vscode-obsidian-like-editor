// 大纲右键菜单（#69）：菜单结构模型、结构命令（消费折叠状态机的展开集
// 合操作）、菜单 DOM 装配与定位纯函数。控制器装配（contextmenu 委托、
// 命令分派到写回管线）在 syncController；写操作的文本变换在 outlineSection。
//
// 语义单一事实源（供契约测试 outlineMenu.test.ts 对拍）：
//
// 1. 菜单结构（票面清单）：结构命令三（递归展开/折叠同级/展开同级）+
//    复制子菜单五（标题/标题和兄弟标题/标题和子标题/标题链接/该段内容）+
//    调级子菜单四（增加/递归增加/减少/递归减少）+ 重命名 + 删除。
//    无子项条目的「递归展开」disabled（空子树无可展开）。
//
// 2. 结构命令作用于展开集合（outlineExpanded，父节点索引集合——与
//    outlineCollapse 状态机同一载体）：
//    - 递归展开 = 子树内全部父节点键并入（QO 的子树父节点批量增）
//    - 折叠同级 = 同级组（同父直接子级，跨级挂靠语义与折叠树一致）内
//      全部父节点键删除（含自身）
//    - 展开同级 = 同级组内全部父节点键加入
//    无变化返回原集合引用（调用方零成本判无变化）。
//
// 3. DOM：菜单项一律 button（键盘 Tab/Enter/空格原生可达）；级联子菜单
//    嵌套于父项的 itemHost 内，显隐由 CSS 的 :hover/:focus-within 控制
//    （无 JS 展开状态——jsdom 无法 hover 的部分由 CSS 契约与浏览器回归
//    钉住）；命令 id 落 data-vsidian-command（测试钩子与断言锚点）。
//
// 4. 定位：侧栏坐标系内 clamp（右缘贴齐、底部上翻），点击点落在目标
//    条目内时垂直让位到条目下方（条目保持可见——菜单不遮挡目标）；
//    下方放不下翻到条目上方，再放不下 clamp 到侧栏内。
import type { OutlineMenuCommand } from '../shared/protocol'
import type { MessageKey } from '../shared/locales/en'
import { t } from '../shared/i18n'
import { outlineSiblingIndices, outlineSubtreeIndices } from './outlineSection'

export type { OutlineMenuCommand }

/** 大纲菜单的稳定类名（样式与断言的公共锚点） */
export const OUTLINE_MENU_CLASS_NAMES = {
  /** 菜单容器（侧栏内 absolute 定位） */
  menu: 'vsidian-outline-menu',
  /** 菜单项宿主（顶级项与子菜单项共用；含子菜单的父项内嵌 submenu） */
  itemHost: 'vsidian-outline-menu-host',
  /** 菜单项按钮（键盘可达的激活目标） */
  item: 'vsidian-outline-menu-item',
  /** 级联子菜单容器（CSS :hover/:focus-within 显隐） */
  submenu: 'vsidian-outline-menu-submenu',
  /** 破坏性命令（删除）的视觉差异锚点 */
  danger: 'vsidian-outline-menu-danger',
  /** 子菜单指示箭头（▸） */
  cue: 'vsidian-outline-menu-cue',
  /** #69 重命名编辑态的行内输入框（条目内容区替换；控制器装配） */
  renameInput: 'vsidian-outline-rename-input',
} as const

/** 菜单项描述（一级与子菜单共用；children 存在即级联）。#94 起 labelKey
 *  为字典消息键（outlineMenu.*），渲染层经 t() 取词 */
export interface OutlineMenuItemDef {
  id: OutlineMenuCommand | 'copy' | 'level'
  labelKey: MessageKey
  children?: OutlineMenuItemDef[]
  /** 渲染为 disabled（键盘跳过、点击无回调） */
  disabled?: boolean
}

/** 菜单结构（hasChildren：目标条目是否父节点——决定递归展开可用性） */
export function outlineMenuSpec(hasChildren: boolean): OutlineMenuItemDef[] {
  return [
    { id: 'expandRecursively', labelKey: 'outlineMenu.expandRecursively', disabled: !hasChildren },
    { id: 'collapseSiblings', labelKey: 'outlineMenu.collapseSiblings' },
    { id: 'expandSiblings', labelKey: 'outlineMenu.expandSiblings' },
    {
      id: 'copy',
      labelKey: 'outlineMenu.copy',
      children: [
        { id: 'copyHeading', labelKey: 'outlineMenu.copyHeading' },
        { id: 'copySiblings', labelKey: 'outlineMenu.copySiblings' },
        { id: 'copyChildren', labelKey: 'outlineMenu.copyChildren' },
        { id: 'copyLink', labelKey: 'outlineMenu.copyLink' },
        { id: 'copySection', labelKey: 'outlineMenu.copySection' },
      ],
    },
    {
      id: 'level',
      labelKey: 'outlineMenu.adjustLevel',
      children: [
        { id: 'levelUp', labelKey: 'outlineMenu.levelUp' },
        { id: 'levelUpRecursive', labelKey: 'outlineMenu.levelUpRecursive' },
        { id: 'levelDown', labelKey: 'outlineMenu.levelDown' },
        { id: 'levelDownRecursive', labelKey: 'outlineMenu.levelDownRecursive' },
      ],
    },
    { id: 'rename', labelKey: 'outlineMenu.rename' },
    { id: 'delete', labelKey: 'outlineMenu.delete' },
  ]
}

/** 结构命令消费的条目形状（折叠状态机同款） */
type CollapseLike = { level: number }

/** 结构命令 → 新展开集合：见模块头 2。无变化/未知命令/越界返回原集合引用 */
export function outlineStructuralExpand(
  command: OutlineMenuCommand | string,
  items: readonly CollapseLike[],
  expanded: ReadonlySet<number>,
  index: number,
): ReadonlySet<number> {
  if (index < 0 || index >= items.length) {
    return expanded
  }
  /** 组内全部父节点索引（i 是父 ⟺ 紧邻后一标题层级更深） */
  const parentsIn = (group: readonly number[]): number[] =>
    group.filter((i) => i + 1 < items.length && items[i + 1]!.level > items[i]!.level)
  if (command === 'expandRecursively') {
    const subtree = outlineSubtreeIndices(items, index)
    const add = parentsIn(subtree)
    if (add.every((i) => expanded.has(i))) {
      return expanded
    }
    const next = new Set(expanded)
    for (const i of add) {
      next.add(i)
    }
    return next
  }
  if (command === 'collapseSiblings' || command === 'expandSiblings') {
    const siblings = outlineSiblingIndices(items, index)
    const keys = parentsIn(siblings)
    if (command === 'collapseSiblings') {
      if (!keys.some((i) => expanded.has(i))) {
        return expanded
      }
      const next = new Set(expanded)
      for (const i of keys) {
        next.delete(i)
      }
      return next
    }
    if (keys.every((i) => expanded.has(i))) {
      return expanded
    }
    const next = new Set(expanded)
    for (const i of keys) {
      next.add(i)
    }
    return next
  }
  return expanded
}

/** 菜单 DOM 装配：容器 role=menu；项为 button（data-vsidian-command 携带
 *  命令 id）；子菜单嵌套父项内。onCommand 只接收叶命令（父项容器无回调） */
export function buildOutlineMenu(
  spec: readonly OutlineMenuItemDef[],
  onCommand: (id: OutlineMenuCommand) => void,
): HTMLElement {
  const menu = document.createElement('div')
  menu.className = OUTLINE_MENU_CLASS_NAMES.menu
  menu.setAttribute('role', 'menu')
  const appendItems = (host: HTMLElement, defs: readonly OutlineMenuItemDef[]): void => {
    for (const def of defs) {
      const itemHost = document.createElement('div')
      itemHost.className = OUTLINE_MENU_CLASS_NAMES.itemHost
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = OUTLINE_MENU_CLASS_NAMES.item
      btn.dataset['vsidianCommand'] = def.id
      if (def.disabled === true) {
        btn.disabled = true
      }
      if (def.id === 'delete') {
        btn.classList.add(OUTLINE_MENU_CLASS_NAMES.danger)
      }
      btn.textContent = t(def.labelKey)
      btn.addEventListener('click', () => {
        if (btn.disabled) {
          return
        }
        onCommand(def.id as OutlineMenuCommand)
      })
      itemHost.appendChild(btn)
      if (def.children && def.children.length > 0) {
        const cue = document.createElement('span')
        cue.className = OUTLINE_MENU_CLASS_NAMES.cue
        cue.setAttribute('aria-hidden', 'true')
        cue.textContent = '▸'
        btn.appendChild(cue)
        const submenu = document.createElement('div')
        submenu.className = OUTLINE_MENU_CLASS_NAMES.submenu
        submenu.setAttribute('role', 'menu')
        appendItems(submenu, def.children)
        itemHost.appendChild(submenu)
      }
      host.appendChild(itemHost)
    }
  }
  appendItems(menu, spec)
  return menu
}

/** 菜单定位（视口系 left/top）：见模块头 4。click = 点击点，menu = 菜单
 *  尺寸，bounds = 定位边界（侧栏 rect），target = 目标条目纵向区间 */
export function outlineMenuPosition(
  click: { x: number; y: number },
  menu: { w: number; h: number },
  bounds: { left: number; top: number; width: number; height: number },
  target: { top: number; bottom: number },
): { left: number; top: number } {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  // 水平：点击点起，右缘贴齐 clamp（侧栏比菜单窄时贴左缘）
  const left = Math.max(bounds.left, Math.min(click.x, right - menu.w))
  // 垂直首选：点击点落在目标条目内 → 让位到条目下方（条目保持可见）
  const overTarget = click.y >= target.top && click.y <= target.bottom
  let top = overTarget ? target.bottom : click.y
  if (top + menu.h > bottom) {
    // 底部放不下：优先翻到条目上方（条目是稳定锚且保持可见）；上方也
    // 放不下才整体 clamp 到侧栏底
    const above = target.top - menu.h
    top = above >= bounds.top ? above : Math.max(bounds.top, bottom - menu.h)
  }
  return { left, top }
}
