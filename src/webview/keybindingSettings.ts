import {
  KEYBINDING_OPERATIONS, applyBindingChange,
  formatBindingLabel, getEffectiveBindings, type KeybindingOverrides,
} from '../shared/keybindings'
import type { SettingsPageBridge, SettingsPageSection } from './settingsPageView'
import { keyStep } from './keybindingRouter'
import { isHostToWebview } from '../shared/protocol'

function el(tag: string, cls: string, text = ''): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}

export class KeybindingSettingsSection implements SettingsPageSection {
  readonly id = 'keybindings'
  readonly title = '快捷键'
  readonly description = '管理 Vsidian 操作的快捷键。冲突检查覆盖 Vsidian 内部；VS Code 和其他扩展的有效键位无法完整查询。'
  readonly icon = 'keyboard'
  readonly entries = KEYBINDING_OPERATIONS.map((op) => ({ id: op.id, title: op.title,
    description: `${op.mode === 'both' ? '实时预览、阅读' : op.mode === 'live' ? '实时预览' : '阅读'} · ${op.command}` }))

  private overrides: KeybindingOverrides = {}
  private parent: HTMLElement | undefined
  private resultsEl: HTMLElement | undefined
  private statusEl: HTMLElement | undefined
  private selected: string | undefined
  private focusEntry: string | undefined
  private query = ''
  private keyQuery = ''
  private status = ''
  private conflict: { id: string; bindings: string[]; ids: string[]; reset?: boolean } | undefined
  private requestId = 0

  constructor(private readonly bridge: SettingsPageBridge) {}

  mount(parent: HTMLElement, focusEntry?: string): () => void {
    this.parent = parent
    if (focusEntry) {
      this.query = ''
      this.keyQuery = ''
      this.focusEntry = focusEntry
    }
    this.selected = focusEntry ?? this.selected ?? KEYBINDING_OPERATIONS[0].id
    this.render()
    return () => {
      this.parent = undefined
      this.resultsEl = undefined
      this.statusEl = undefined
    }
  }

  handleHostMessage(message: unknown): void {
    if (!isHostToWebview(message) ||
      (message.kind !== 'keybindings.snapshot' && message.kind !== 'keybindings.changed')) return
    const payload = message
    this.overrides = payload.overrides
    if (payload.requestId !== undefined && payload.requestId === this.requestId) {
      this.status = payload.ok ? '快捷键已保存并立即生效。'
        : payload.reason === 'storage' ? '保存失败，已恢复当前生效绑定。'
          : payload.reason === 'conflict' ? `Vsidian 内部冲突：${(payload.conflicts ?? []).map((id) =>
            KEYBINDING_OPERATIONS.find((op) => op.id === id)?.title ?? id).join('、')}`
            : '快捷键无效，未保存。'
      if (payload.ok) this.conflict = undefined
    }
    this.updateStatus()
    this.renderRows()
  }

  private send(message: object): void {
    this.status = '正在保存…'
    this.bridge.postMessage(message)
    this.updateStatus()
    this.renderRows()
  }

  private save(id: string, bindings: string[], replaceConflicts = false): void {
    const check = applyBindingChange(this.overrides, id, bindings, replaceConflicts)
    if (!check.ok) {
      if (check.reason === 'conflict') {
        this.conflict = { id, bindings, ids: check.conflicts }
        this.status = `Vsidian 内部冲突：${check.conflicts.map((item) =>
          KEYBINDING_OPERATIONS.find((op) => op.id === item)?.title ?? item).join('、')}。可选择替换原绑定。`
      } else this.status = '快捷键无效，未保存。'
      this.updateStatus()
      this.renderRows()
      return
    }
    this.conflict = undefined
    this.send({ kind: 'keybindings.set', id, bindings, replaceConflicts,
      requestId: ++this.requestId })
  }

  private resetOne(id: string, replaceConflicts = false): void {
    const defaults = [...getEffectiveBindings({}, id)]
    const check = applyBindingChange(this.overrides, id, defaults, replaceConflicts)
    if (!check.ok) {
      if (check.reason === 'conflict') {
        this.conflict = { id, bindings: defaults, ids: check.conflicts, reset: true }
        this.status = `恢复默认与 ${check.conflicts.map((item) =>
          KEYBINDING_OPERATIONS.find((op) => op.id === item)?.title ?? item).join('、')} 冲突。可选择替换原绑定。`
      } else this.status = '恢复默认失败。'
      this.updateStatus()
      this.renderRows()
      return
    }
    this.conflict = undefined
    this.send({ kind: 'keybindings.reset', id, replaceConflicts, requestId: ++this.requestId })
  }

  private button(text: string, action: () => void, cls = ''): HTMLButtonElement {
    const button = el('button', cls, text) as HTMLButtonElement
    button.type = 'button'
    button.addEventListener('click', action)
    return button
  }

  private recorder(label: string, onInput: (chord: string) => void): HTMLInputElement {
    const input = el('input', 'vsidian-keybindings-recorder') as HTMLInputElement
    input.readOnly = true
    input.placeholder = label
    input.setAttribute('aria-label', label)
    input.addEventListener('keydown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        input.value = ''; input.dataset.raw = ''; onInput(''); return
      }
      if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        input.value = ''; input.dataset.raw = ''; onInput(''); return
      }
      const step = keyStep(event)
      if (!step) return
      const previous = input.dataset.raw ?? ''
      const chord = previous ? `${previous} ${step}` : step
      input.dataset.raw = chord.includes(' ') ? '' : chord
      input.value = formatBindingLabel(chord)
      onInput(chord)
    })
    return input
  }

  private render(): void {
    const parent = this.parent
    if (!parent) return
    parent.replaceChildren()
    const toolbar = el('div', 'vsidian-keybindings-toolbar')
    const nameSearch = el('input', 'vsidian-keybindings-search') as HTMLInputElement
    nameSearch.type = 'search'
    nameSearch.placeholder = '搜索操作名'
    nameSearch.setAttribute('aria-label', '搜索操作名')
    nameSearch.value = this.query
    nameSearch.addEventListener('input', () => { this.query = nameSearch.value; this.renderRows() })
    const keySearch = this.recorder('按键搜索绑定', (chord) => {
      this.keyQuery = chord
      this.renderRows()
    })
    keySearch.value = this.keyQuery ? formatBindingLabel(this.keyQuery) : ''
    keySearch.dataset.raw = this.keyQuery.includes(' ') ? '' : this.keyQuery
    toolbar.append(nameSearch, keySearch,
      this.button('全部恢复默认', () => this.send({ kind: 'keybindings.resetAll', requestId: ++this.requestId })))
    parent.append(toolbar)
    const status = el('p', 'vsidian-keybindings-status', this.status)
    status.setAttribute('role', 'status')
    parent.append(status)
    this.statusEl = status
    const results = el('div', 'vsidian-keybindings-results')
    parent.append(results)
    this.resultsEl = results
    this.renderRows()
  }

  private updateStatus(): void {
    if (this.statusEl) this.statusEl.textContent = this.status
  }

  private renderRows(): void {
    const parent = this.resultsEl
    if (!parent) return
    parent.replaceChildren()
    let locatedRow: HTMLElement | undefined
    const filtered = KEYBINDING_OPERATIONS.filter((op) => op.title.toLocaleLowerCase().includes(this.query.toLocaleLowerCase()) &&
      (!this.keyQuery || getEffectiveBindings(this.overrides, op.id).some((binding) =>
        binding === this.keyQuery || binding.startsWith(`${this.keyQuery} `))))
    if (!filtered.length) parent.append(el('p', 'vsidian-settings-empty', '没有匹配的操作。'))
    for (const op of filtered) {
      const row = el('section', 'vsidian-keybindings-row')
      row.dataset.operationId = op.id
      if (this.focusEntry === op.id) {
        row.classList.add('vsidian-settings-item-located')
        locatedRow = row
      }
      const heading = el('div', 'vsidian-keybindings-row-heading')
      heading.append(el('strong', '', op.title),
        el('span', 'vsidian-keybindings-mode', op.mode === 'both' ? '实时预览 · 阅读' : op.mode === 'live' ? '实时预览' : '阅读'))
      row.append(heading)
      const bindings = getEffectiveBindings(this.overrides, op.id)
      const tags = el('div', 'vsidian-keybindings-tags')
      if (!bindings.length) tags.append(el('span', 'vsidian-keybindings-unbound', '未绑定'))
      for (const binding of bindings) {
        const tag = el('span', 'vsidian-keybindings-tag')
        tag.append(el('kbd', '', formatBindingLabel(binding)), this.button('×', () =>
          this.save(op.id, bindings.filter((item) => item !== binding)), 'vsidian-keybindings-remove'))
        tags.append(tag)
      }
      row.append(tags)
      const actions = el('div', 'vsidian-keybindings-actions')
      actions.append(this.button('添加绑定', () => {
        this.selected = this.selected === op.id ? undefined : op.id
        this.renderRows()
      }), this.button('清空绑定', () => this.save(op.id, [])),
      this.button('恢复默认', () => this.resetOne(op.id)))
      row.append(actions)
      if (this.selected === op.id) {
        const editor = el('div', 'vsidian-keybindings-editor')
        let draft = ''
        const recorder = this.recorder('按下单段或连续两段快捷键', (chord) => { draft = chord })
        editor.append(recorder, this.button('保存绑定', () => {
          if (draft) this.save(op.id, [...bindings, draft])
        }))
        row.append(editor)
      }
      if (this.conflict?.id === op.id) {
        const warning = el('div', 'vsidian-keybindings-conflict',
          `与 ${this.conflict.ids.map((id) => KEYBINDING_OPERATIONS.find((item) => item.id === id)?.title ?? id).join('、')} 冲突。`)
        warning.setAttribute('role', 'alert')
        warning.append(this.button('替换原绑定', () => this.conflict!.reset
          ? this.resetOne(op.id, true) : this.save(op.id, this.conflict!.bindings, true)))
        row.append(warning)
      }
      parent.append(row)
    }
    if (locatedRow) {
      locatedRow.querySelector<HTMLInputElement>('.vsidian-keybindings-editor input')?.focus()
      locatedRow.scrollIntoView?.({ block: 'nearest' })
      this.focusEntry = undefined
    }
  }
}
