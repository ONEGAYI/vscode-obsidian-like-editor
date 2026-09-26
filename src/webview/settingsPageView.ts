// 设置页分页容器：宿主快照为权威，全局搜索只负责设置入口定位。
// #93 i18n 起：框架文案经 t() 取词（语言包由 localeBoot 首帧从数据岛
// 装配、locale.changed 换包，本视图订阅换包事件重渲染常驻文本）；string
// 枚举定义渲染为下拉控件（boolean 仍为开关）。#95 起设置项定义文案同样
// 键化（def.titleKey/descriptionKey → t() 取词），搜索按取词后的显示
// 文本匹配。
import { t, onLocaleChanged } from '../shared/i18n'
import { isHostToWebview } from '../shared/protocol'
import type { SettingDefinition, SettingsPayload, SettingsPayloadValue } from '../shared/settings'

export interface SettingsPageBridge { postMessage(message: unknown): void }

/** 已实现的附加分页才注册；分页自己的搜索不占用全局搜索框。 */
export interface SettingsPageSection {
  id: string
  title: string
  description: string
  icon: 'keyboard' | 'editor'
  entries: readonly { id: string; title: string; description?: string }[]
  /** 返回清理函数；focusEntry 为全局搜索定位到的入口。 */
  mount(parent: HTMLElement, focusEntry?: string): void | (() => void)
}

export const SETTINGS_PAGE_CLASS_NAMES = {
  root: 'vsidian-settings', title: 'vsidian-settings-title',
  subtitle: 'vsidian-settings-subtitle', list: 'vsidian-settings-list',
  item: 'vsidian-settings-item', itemTitle: 'vsidian-settings-item-title',
  itemDescription: 'vsidian-settings-item-description', checkbox: 'vsidian-settings-checkbox',
  select: 'vsidian-settings-select',
  empty: 'vsidian-settings-empty',
} as const

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = cls
  if (text) el.textContent = text
  return el
}
function icon(kind: 'editor' | 'keyboard' | 'search'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', kind === 'search' ? 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0' : kind === 'keyboard' ? 'M3 5h18v14H3zM6 9h1m3 0h1m3 0h1m3 0h1M6 12h1m3 0h1m3 0h1m3 0h1M7 16h10' : 'M14 4l6 6M3 21l5-1L21 7a2 2 0 0 0-4-4L4 16z')
  svg.append(path)
  return svg
}

export class SettingsPageView {
  private values: SettingsPayload | undefined
  private listEl: HTMLElement | undefined
  private search: HTMLInputElement | undefined
  private nav: HTMLElement | undefined
  private status: HTMLElement | undefined
  private titleEl: HTMLElement | undefined
  private active = 'editor'
  private pending = 0
  private saveFailed = false
  private disposeSection: (() => void) | undefined
  private offLocale: (() => void) | undefined

  constructor(private readonly bridge: SettingsPageBridge,
    private readonly defs: readonly SettingDefinition[],
    private readonly sections: readonly SettingsPageSection[] = []) {}

  mount(parent: HTMLElement): void {
    const root = element('div', SETTINGS_PAGE_CLASS_NAMES.root)
    const sidebar = element('aside', 'vsidian-settings-sidebar')
    this.titleEl = element('h1', SETTINGS_PAGE_CLASS_NAMES.title, t('settings.pageTitle'))
    sidebar.append(this.titleEl)
    if (this.defs.length || this.sections.length) {
      const searchWrap = element('div', 'vsidian-settings-search-wrap')
      this.search = element('input', 'vsidian-settings-search')
      this.search.type = 'search'
      this.search.placeholder = t('settings.searchPlaceholder')
      this.search.setAttribute('aria-label', t('settings.searchAriaLabel'))
      this.search.addEventListener('input', () => this.render())
      this.search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { this.search!.value = ''; this.render() }
      })
      searchWrap.append(icon('search'), this.search)
      sidebar.append(searchWrap, element('p', 'vsidian-settings-nav-label', t('settings.navLabel')))
      this.nav = element('nav', 'vsidian-settings-nav')
      this.nav.setAttribute('aria-label', t('settings.navAriaLabel'))
      sidebar.append(this.nav)
    }
    const main = element('main', 'vsidian-settings-main')
    this.status = element('p', 'vsidian-settings-status')
    this.status.setAttribute('role', 'status')
    this.listEl = element('div', SETTINGS_PAGE_CLASS_NAMES.list)
    main.append(this.status, this.listEl)
    root.append(sidebar, main)
    parent.append(root)
    // 语言切换重渲染（#93）：常驻文本节点（框架标题与列表内容）随换包更新；
    // 按需创建的控件自然取新词。搜索输入框为持久元素，重渲染不重建不夺焦。
    this.offLocale = onLocaleChanged(() => this.applyLocale())
    this.render()
  }

  /** 语言换包后的常驻文本重渲染：框架标题就地更新 + 列表整体重建 */
  private applyLocale(): void {
    if (this.titleEl) {
      this.titleEl.textContent = t('settings.pageTitle')
    }
    this.render()
  }

  /**
   * 释放视图资源（取消语言换包订阅）。生产路径的视图寿命 = 页面寿命
   * （页面卸载即整体销毁），无需调用；同一模块状态反复挂载视图的场景
   * （单测）用它防监听器累积。
   */
  dispose(): void {
    this.offLocale?.()
    this.offLocale = undefined
  }

  handleHostMessage(message: unknown): void {
    if (!isHostToWebview(message)) return
    if (message.kind === 'settings.snapshot' || message.kind === 'settings.changed') {
      this.values = message.values
      if (this.pending > 0) {
        this.pending--
        this.saveFailed ||= message.kind === 'settings.snapshot'
        if (this.status) this.status.textContent = this.pending ? t('settings.saving')
          : this.saveFailed ? t('settings.saveFailed') : t('settings.saveDone')
      }
      // 同步值不重建分页，也不夺走搜索框和开关的键盘焦点。
      for (const box of this.listEl?.querySelectorAll<HTMLInputElement>('input[data-setting-key]') ?? []) {
        const def = this.defs.find((d) => d.key === box.dataset.settingKey)!
        box.checked = this.value(def) === true
      }
      for (const select of this.listEl?.querySelectorAll<HTMLSelectElement>('select[data-setting-key]') ?? []) {
        const def = this.defs.find((d) => d.key === select.dataset.settingKey)
        if (def) {
          select.value = String(this.value(def))
        }
      }
    }
  }
  getValues(): SettingsPayload | undefined { return this.values }
  private value(def: SettingDefinition): SettingsPayloadValue {
    const raw = this.values?.[def.key]
    if (def.type === 'boolean') {
      return typeof raw === 'boolean' ? raw : def.default
    }
    return typeof raw === 'string' && def.enum.includes(raw) ? raw : def.default
  }
  private categories() {
    return [{ id: 'editor', title: t('settings.editorCategory'), icon: 'editor' as const }, ...this.sections]
  }
  private render(focusEntry?: string): void {
    if (!this.listEl) return
    this.disposeSection?.()
    this.disposeSection = undefined
    const query = this.search?.value.trim().toLocaleLowerCase() ?? ''
    this.nav?.replaceChildren()
    for (const category of this.categories()) {
      const button = element('button', 'vsidian-settings-nav-item')
      button.type = 'button'
      button.setAttribute('aria-current', !query && this.active === category.id ? 'page' : 'false')
      button.append(icon(category.icon), document.createTextNode(category.title))
      button.addEventListener('click', () => {
        this.active = category.id
        if (this.search) this.search.value = ''
        this.render()
        this.nav?.querySelector<HTMLButtonElement>('[aria-current=page]')?.focus()
      })
      this.nav?.append(button)
    }
    const list = this.listEl
    list.replaceChildren()
    if (query) {
      list.append(element('h2', 'vsidian-settings-heading', t('settings.searchResults')))
      // 搜索按用户看到的显示文本匹配：设置项定义经 t() 取词后参与过滤
      // （titleKey/descriptionKey → 当前语言文本，#95 键化迁移）
      const groups = [{
        id: 'editor',
        title: t('settings.editorCategory'),
        entries: this.defs.map((d) => ({
          id: d.key,
          title: t(d.titleKey),
          ...(d.descriptionKey ? { description: t(d.descriptionKey) } : {}),
        })),
      }, ...this.sections]
      let count = 0
      for (const group of groups) for (const entry of group.entries) {
        if (!`${entry.title} ${entry.description ?? ''}`.toLocaleLowerCase().includes(query)) continue
        count++
        const result = element('button', 'vsidian-settings-result')
        result.type = 'button'
        result.append(element('span', 'vsidian-settings-result-category', group.title),
          element('strong', '', entry.title), element('span', SETTINGS_PAGE_CLASS_NAMES.itemDescription, entry.description))
        result.addEventListener('click', () => {
          this.active = group.id
          this.search!.value = ''
          this.render(entry.id)
        })
        list.append(result)
      }
      const summary = element('p', SETTINGS_PAGE_CLASS_NAMES.subtitle,
        count ? t('settings.searchCount', { count }) : t('settings.searchEmpty'))
      summary.setAttribute('role', 'status')
      list.insertBefore(summary, list.children[1] ?? null)
      return
    }
    const section = this.sections.find((s) => s.id === this.active)
    list.append(element('h2', 'vsidian-settings-heading', section?.title ?? t('settings.editorCategory')),
      element('p', SETTINGS_PAGE_CLASS_NAMES.subtitle, section?.description ?? t('settings.editorSubtitle')))
    if (section) {
      const content = element('div', 'vsidian-settings-section-content')
      list.append(content)
      this.disposeSection = section.mount(content, focusEntry) ?? undefined
      return
    }
    if (!this.defs.length) {
      list.append(element('p', SETTINGS_PAGE_CLASS_NAMES.empty, t('settings.empty')))
      return
    }
    list.append(element('h3', 'vsidian-settings-group-title', t('settings.groupDisplay')))
    for (const def of this.defs) {
      const item = element('div', SETTINGS_PAGE_CLASS_NAMES.item)
      const label = element('label', 'vsidian-settings-item-label')
      const text = element('span', 'vsidian-settings-item-copy')
      text.append(element('span', SETTINGS_PAGE_CLASS_NAMES.itemTitle, t(def.titleKey)))
      // #93 控件分流：boolean → 复选开关；string 枚举 → 下拉（enum 顺序即
      // 选项顺序，optionLabels 缺省显示原值）
      const control: HTMLInputElement | HTMLSelectElement = def.type === 'string'
        ? this.buildSelect(def)
        : this.buildCheckbox(def)
      if (def.descriptionKey) {
        const desc = element('span', SETTINGS_PAGE_CLASS_NAMES.itemDescription, t(def.descriptionKey))
        desc.id = `description-${def.key}`
        text.append(desc)
        control.setAttribute('aria-describedby', desc.id)
      }
      control.dataset.settingKey = def.key
      control.setAttribute('aria-label', t(def.titleKey))
      label.append(text, control)
      item.append(label)
      list.append(item)
      if (focusEntry === def.key) {
        item.classList.add('vsidian-settings-item-located')
        control.focus()
        item.scrollIntoView?.({ block: 'nearest' })
      }
    }
  }

  private buildCheckbox(def: BooleanSettingDefinitionLike): HTMLInputElement {
    const box = element('input', SETTINGS_PAGE_CLASS_NAMES.checkbox)
    box.type = 'checkbox'
    box.checked = this.value(def) === true
    box.addEventListener('change', () => {
      if (!this.pending) this.saveFailed = false
      this.pending++
      if (this.status) this.status.textContent = t('settings.saving')
      this.bridge.postMessage({ kind: 'settings.set', values: { [def.key]: box.checked } })
    })
    return box
  }

  private buildSelect(def: StringEnumSettingDefinitionLike): HTMLSelectElement {
    const select = element('select', SETTINGS_PAGE_CLASS_NAMES.select)
    const current = String(this.value(def))
    for (const value of def.enum) {
      const option = element('option', '', def.optionLabels?.[value] ?? value)
      option.value = value
      if (value === current) {
        option.selected = true
      }
      select.append(option)
    }
    select.value = current
    select.addEventListener('change', () => {
      if (!this.pending) this.saveFailed = false
      this.pending++
      if (this.status) this.status.textContent = t('settings.saving')
      this.bridge.postMessage({ kind: 'settings.set', values: { [def.key]: select.value } })
    })
    return select
  }
}

/** 渲染层对两类定义的结构收窄（避免在分流点反复判 type） */
type BooleanSettingDefinitionLike = Extract<SettingDefinition, { type: 'boolean' }>
type StringEnumSettingDefinitionLike = Extract<SettingDefinition, { type: 'string' }>
