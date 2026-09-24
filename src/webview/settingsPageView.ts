// 设置页 webview 视图（#33）：渲染设置定义表、空状态、快照回显与变更上送。
// 可在 jsdom 下直测（bridge 注入，同 WebviewSyncController 的测试路径）；
// 装配入口在 settingsMain.ts（acquireVsCodeApi + window message）。
//
// 值语义（工单 #33）：设置持久化权威在宿主——页面只回显宿主下发的快照，
// 用户操作以 settings.set 上送，宿主拒绝时回 settings.snapshot 以权威值
// 恢复显示；空定义表渲染明确空状态，不展示不能生效的占位开关。
import { isHostToWebview } from '../shared/protocol'
import type { SettingDefinition, SettingsPayload } from '../shared/settings'

/** 设置页与宿主的通信通道（由 acquireVsCodeApi 适配） */
export interface SettingsPageBridge {
  postMessage(message: unknown): void
}

/** 稳定类名（样式入口与测试定位共用） */
export const SETTINGS_PAGE_CLASS_NAMES = {
  root: 'vsidian-settings',
  title: 'vsidian-settings-title',
  subtitle: 'vsidian-settings-subtitle',
  list: 'vsidian-settings-list',
  item: 'vsidian-settings-item',
  itemTitle: 'vsidian-settings-item-title',
  itemDescription: 'vsidian-settings-item-description',
  checkbox: 'vsidian-settings-checkbox',
  empty: 'vsidian-settings-empty',
} as const

export class SettingsPageView {
  private values: SettingsPayload | undefined
  private listEl: HTMLElement | undefined

  constructor(
    private readonly bridge: SettingsPageBridge,
    private readonly defs: readonly SettingDefinition[],
  ) {}

  mount(parent: HTMLElement): void {
    const root = document.createElement('div')
    root.className = SETTINGS_PAGE_CLASS_NAMES.root
    const title = document.createElement('h1')
    title.className = SETTINGS_PAGE_CLASS_NAMES.title
    title.textContent = 'Vsidian 设置'
    const subtitle = document.createElement('p')
    subtitle.className = SETTINGS_PAGE_CLASS_NAMES.subtitle
    subtitle.textContent = 'Vsidian 的插件设置在此管理（不进入 VSCode 统一设置中心）。'
    this.listEl = document.createElement('div')
    this.listEl.className = SETTINGS_PAGE_CLASS_NAMES.list
    root.appendChild(title)
    root.appendChild(subtitle)
    root.appendChild(this.listEl)
    parent.appendChild(root)
    this.render()
  }

  /** 宿主消息入口（window message 事件转发）；非法消息整体忽略 */
  handleHostMessage(message: unknown): void {
    if (!isHostToWebview(message)) {
      return
    }
    switch (message.kind) {
      case 'settings.snapshot':
      case 'settings.changed':
        this.values = message.values
        this.render()
        break
      default:
        break // 编辑器方向的宿主消息与本页无关
    }
  }

  /** 当前回显值（宿主下发过的快照；未收到时为 undefined） */
  getValues(): SettingsPayload | undefined {
    return this.values
  }

  private render(): void {
    const list = this.listEl
    if (!list) {
      return
    }
    list.textContent = ''
    if (this.defs.length === 0) {
      // 空状态（#33 交付时无实际设置项，#34 起逐项加入）：明确文案，
      // 不渲染任何不能生效的占位开关
      const empty = document.createElement('p')
      empty.className = SETTINGS_PAGE_CLASS_NAMES.empty
      empty.textContent = '暂无可配置项：首个设置项将在后续版本加入。'
      list.appendChild(empty)
      return
    }
    for (const def of this.defs) {
      const item = document.createElement('div')
      item.className = SETTINGS_PAGE_CLASS_NAMES.item
      const label = document.createElement('label')
      label.className = `${SETTINGS_PAGE_CLASS_NAMES.item}-label`
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = SETTINGS_PAGE_CLASS_NAMES.checkbox
      // 回显宿主快照值；未收到快照或值形态异常时按定义默认值（协议载荷
      // 是宽标量容器，类型语义校验归宿主——渲染层防御性回退）
      const raw = this.values?.[def.key]
      box.checked = typeof raw === 'boolean' ? raw : def.default
      box.setAttribute('aria-label', def.title)
      box.addEventListener('change', () => {
        this.bridge.postMessage({
          kind: 'settings.set',
          values: { [def.key]: box.checked },
        })
      })
      const title = document.createElement('span')
      title.className = SETTINGS_PAGE_CLASS_NAMES.itemTitle
      title.textContent = def.title
      label.appendChild(box)
      label.appendChild(title)
      item.appendChild(label)
      if (def.description) {
        const desc = document.createElement('p')
        desc.className = SETTINGS_PAGE_CLASS_NAMES.itemDescription
        desc.textContent = def.description
        item.appendChild(desc)
      }
      list.appendChild(item)
    }
  }
}
