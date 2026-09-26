// 快捷键设置分页（#91）。#95 i18n：本页文案经 t() 取词（settings./
// keybindingSettings. 前缀）；分页标题/描述与 entries 为 getter——语言
// 换包后由宿主容器重建分页时重新求值。操作名（op.title）暂为注册表
// 存量文案，随编辑器 webview 迁移工单入字典。
import {
  KEYBINDING_OPERATIONS, applyBindingChange,
  formatBindingLabel, getEffectiveBindings, type KeybindingOverrides,
} from '../shared/keybindings'
import { t } from '../shared/i18n'
import type { SettingsPageBridge, SettingsPageSection } from './settingsPageView'
import { keyStep } from './keybindingRouter'
import { isHostToWebview } from '../shared/protocol'

function el(tag: string, cls: string, text = ''): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  node.textContent = text
  return node
}

/** 冲突文案的操作名串接（分隔符随语言：zh 顿号 / en 逗号） */
function joinOpNames(ids: readonly string[]): string {
  return ids
    .map((id) => KEYBINDING_OPERATIONS.find((op) => op.id === id)?.title ?? id)
    .join(t('keybindingSettings.nameSeparator'))
}

export class KeybindingSettingsSection implements SettingsPageSection {
  readonly id = 'keybindings'
  readonly icon = 'keyboard'
  get title(): string { return t('keybindingSettings.title') }
  get description(): string { return t('keybindingSettings.description') }
  get entries() {
    return KEYBINDING_OPERATIONS.map((op) => ({
      id: op.id,
      title: op.title,
      description: `${t(op.mode === 'both' ? 'keybindingSettings.modeBoth'
        : op.mode === 'live' ? 'keybindingSettings.modeLive' : 'keybindingSettings.modeReading')} · ${op.command}`,
    }))
  }

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
      this.status = payload.ok ? t('keybindingSettings.saved')
        : payload.reason === 'storage' ? t('keybindingSettings.saveFailedStorage')
          : payload.reason === 'conflict' ? t('keybindingSettings.conflictInternal', { names: joinOpNames(payload.conflicts ?? []) })
            : t('keybindingSettings.invalid')
      if (payload.ok) this.conflict = undefined
    }
    this.updateStatus()
    this.renderRows()
  }

  private send(message: object): void {
    this.status = t('keybindingSettings.saving')
    this.bridge.postMessage(message)
    this.updateStatus()
    this.renderRows()
  }

  private save(id: string, bindings: string[], replaceConflicts = false): void {
    const check = applyBindingChange(this.overrides, id, bindings, replaceConflicts)
    if (!check.ok) {
      if (check.reason === 'conflict') {
        this.conflict = { id, bindings, ids: check.conflicts }
        this.status = t('keybindingSettings.conflictSave', { names: joinOpNames(check.conflicts) })
      } else this.status = t('keybindingSettings.invalid')
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
        this.status = t('keybindingSettings.conflictReset', { names: joinOpNames(check.conflicts) })
      } else this.status = t('keybindingSettings.resetFailed')
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
    nameSearch.placeholder = t('keybindingSettings.searchNamePlaceholder')
    nameSearch.setAttribute('aria-label', t('keybindingSettings.searchNamePlaceholder'))
    nameSearch.value = this.query
    nameSearch.addEventListener('input', () => { this.query = nameSearch.value; this.renderRows() })
    const keySearch = this.recorder(t('keybindingSettings.searchKeyPlaceholder'), (chord) => {
      this.keyQuery = chord
      this.renderRows()
    })
    keySearch.value = this.keyQuery ? formatBindingLabel(this.keyQuery) : ''
    keySearch.dataset.raw = this.keyQuery.includes(' ') ? '' : this.keyQuery
    const keySearchLabel = el('label', 'vsidian-keybindings-key-search') as HTMLLabelElement
    keySearchLabel.append(el('span', 'vsidian-keybindings-key-search-caption', t('keybindingSettings.searchKeyCaption')), keySearch)
    toolbar.append(nameSearch, keySearchLabel,
      this.button(t('keybindingSettings.resetAll'), () => this.send({ kind: 'keybindings.resetAll', requestId: ++this.requestId })))
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
    if (!filtered.length) parent.append(el('p', 'vsidian-settings-empty', t('keybindingSettings.noMatch')))
    for (const op of filtered) {
      const row = el('section', 'vsidian-keybindings-row')
      row.dataset.operationId = op.id
      if (this.focusEntry === op.id) {
        row.classList.add('vsidian-settings-item-located')
        locatedRow = row
      }
      const heading = el('div', 'vsidian-keybindings-row-heading')
      heading.append(el('strong', '', op.title),
        el('span', 'vsidian-keybindings-mode', t(op.mode === 'both' ? 'keybindingSettings.modeLiveReading'
          : op.mode === 'live' ? 'keybindingSettings.modeLive' : 'keybindingSettings.modeReading')))
      row.append(heading)
      const bindings = getEffectiveBindings(this.overrides, op.id)
      const tags = el('div', 'vsidian-keybindings-tags')
      if (!bindings.length) tags.append(el('span', 'vsidian-keybindings-unbound', t('keybindingSettings.unbound')))
      for (const binding of bindings) {
        const tag = el('span', 'vsidian-keybindings-tag')
        tag.append(el('kbd', '', formatBindingLabel(binding)), this.button('×', () =>
          this.save(op.id, bindings.filter((item) => item !== binding)), 'vsidian-keybindings-remove'))
        tags.append(tag)
      }
      row.append(tags)
      const actions = el('div', 'vsidian-keybindings-actions')
      actions.append(this.button(t('keybindingSettings.addBinding'), () => {
        this.selected = this.selected === op.id ? undefined : op.id
        this.renderRows()
      }), this.button(t('keybindingSettings.clearBindings'), () => this.save(op.id, [])),
      this.button(t('keybindingSettings.resetDefault'), () => this.resetOne(op.id)))
      row.append(actions)
      if (this.selected === op.id) {
        const editor = el('div', 'vsidian-keybindings-editor')
        let draft = ''
        const recorder = this.recorder(t('keybindingSettings.recordPlaceholder'), (chord) => { draft = chord })
        editor.append(recorder, this.button(t('keybindingSettings.saveBinding'), () => {
          if (draft) this.save(op.id, [...bindings, draft])
        }))
        row.append(editor)
      }
      if (this.conflict?.id === op.id) {
        const warning = el('div', 'vsidian-keybindings-conflict',
          t('keybindingSettings.conflictRow', { names: joinOpNames(this.conflict.ids) }))
        warning.setAttribute('role', 'alert')
        warning.append(this.button(t('keybindingSettings.replaceConflicts'), () => this.conflict!.reset
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
