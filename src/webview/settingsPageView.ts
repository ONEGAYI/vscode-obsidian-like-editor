// 设置页分页容器：宿主快照为权威，全局搜索只负责设置入口定位。
import { isHostToWebview } from '../shared/protocol'
import type { SettingDefinition, SettingsPayload } from '../shared/settings'

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
  private active = 'editor'
  private pending = 0
  private saveFailed = false
  private disposeSection: (() => void) | undefined

  constructor(private readonly bridge: SettingsPageBridge,
    private readonly defs: readonly SettingDefinition[],
    private readonly sections: readonly SettingsPageSection[] = []) {}

  mount(parent: HTMLElement): void {
    const root = element('div', SETTINGS_PAGE_CLASS_NAMES.root)
    const sidebar = element('aside', 'vsidian-settings-sidebar')
    sidebar.append(element('h1', SETTINGS_PAGE_CLASS_NAMES.title, 'Vsidian 设置'))
    if (this.defs.length || this.sections.length) {
      const searchWrap = element('div', 'vsidian-settings-search-wrap')
      this.search = element('input', 'vsidian-settings-search')
      this.search.type = 'search'
      this.search.placeholder = '搜索设置…'
      this.search.setAttribute('aria-label', '搜索全部设置')
      this.search.addEventListener('input', () => this.render())
      this.search.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { this.search!.value = ''; this.render() }
      })
      searchWrap.append(icon('search'), this.search)
      sidebar.append(searchWrap, element('p', 'vsidian-settings-nav-label', '选项'))
      this.nav = element('nav', 'vsidian-settings-nav')
      this.nav.setAttribute('aria-label', '设置分类')
      sidebar.append(this.nav)
    }
    const main = element('main', 'vsidian-settings-main')
    this.status = element('p', 'vsidian-settings-status')
    this.status.setAttribute('role', 'status')
    this.listEl = element('div', SETTINGS_PAGE_CLASS_NAMES.list)
    main.append(this.status, this.listEl)
    root.append(sidebar, main)
    parent.append(root)
    this.render()
  }

  handleHostMessage(message: unknown): void {
    if (!isHostToWebview(message)) return
    if (message.kind === 'settings.snapshot' || message.kind === 'settings.changed') {
      this.values = message.values
      if (this.pending > 0) {
        this.pending--
        this.saveFailed ||= message.kind === 'settings.snapshot'
        if (this.status) this.status.textContent = this.pending ? '正在保存…' : this.saveFailed ? '未能保存设置，已恢复当前生效值。请重试。' : '设置已保存'
      }
      // 同步值不重建分页，也不夺走搜索框和开关的键盘焦点。
      for (const box of this.listEl?.querySelectorAll<HTMLInputElement>('input[data-setting-key]') ?? []) {
        const def = this.defs.find((d) => d.key === box.dataset.settingKey)!
        box.checked = this.value(def)
      }
    }
  }
  getValues(): SettingsPayload | undefined { return this.values }
  private value(def: SettingDefinition): boolean {
    const raw = this.values?.[def.key]
    return typeof raw === 'boolean' ? raw : def.default
  }
  private categories() {
    return [{ id: 'editor', title: '编辑器', icon: 'editor' as const }, ...this.sections]
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
      list.append(element('h2', 'vsidian-settings-heading', '搜索结果'))
      const groups = [{ id: 'editor', title: '编辑器', entries: this.defs.map((d) => ({ id: d.key, ...d })) }, ...this.sections]
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
      const summary = element('p', SETTINGS_PAGE_CLASS_NAMES.subtitle, count ? `找到 ${count} 项设置` : '未找到匹配的设置，请尝试其他关键词。')
      summary.setAttribute('role', 'status')
      list.insertBefore(summary, list.children[1] ?? null)
      return
    }
    const section = this.sections.find((s) => s.id === this.active)
    list.append(element('h2', 'vsidian-settings-heading', section?.title ?? '编辑器'),
      element('p', SETTINGS_PAGE_CLASS_NAMES.subtitle, section?.description ?? '调整实时预览的显示方式。更改会自动保存。'))
    if (section) {
      const content = element('div', 'vsidian-settings-section-content')
      list.append(content)
      this.disposeSection = section.mount(content, focusEntry) ?? undefined
      return
    }
    if (!this.defs.length) {
      list.append(element('p', SETTINGS_PAGE_CLASS_NAMES.empty, '暂无可配置项。'))
      return
    }
    list.append(element('h3', 'vsidian-settings-group-title', '显示'))
    for (const def of this.defs) {
      const item = element('div', SETTINGS_PAGE_CLASS_NAMES.item)
      const label = element('label', 'vsidian-settings-item-label')
      const text = element('span', 'vsidian-settings-item-copy')
      text.append(element('span', SETTINGS_PAGE_CLASS_NAMES.itemTitle, def.title))
      const box = element('input', SETTINGS_PAGE_CLASS_NAMES.checkbox)
      box.type = 'checkbox'
      box.dataset.settingKey = def.key
      box.checked = this.value(def)
      box.setAttribute('aria-label', def.title)
      if (def.description) {
        const desc = element('span', SETTINGS_PAGE_CLASS_NAMES.itemDescription, def.description)
        desc.id = `description-${def.key}`
        text.append(desc)
        box.setAttribute('aria-describedby', desc.id)
      }
      box.addEventListener('change', () => {
        if (!this.pending) this.saveFailed = false
        this.pending++
        if (this.status) this.status.textContent = '正在保存…'
        this.bridge.postMessage({ kind: 'settings.set', values: { [def.key]: box.checked } })
      })
      label.append(text, box)
      item.append(label)
      list.append(item)
      if (focusEntry === def.key) {
        item.classList.add('vsidian-settings-item-located')
        box.focus()
        item.scrollIntoView?.({ block: 'nearest' })
      }
    }
  }
}
