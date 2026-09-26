import {
  applyBindingChange, getEffectiveBindings, sanitizeStoredOverrides,
  type KeybindingOverrides,
} from '../shared/keybindings'

export interface KeybindingStorage {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void> | Promise<void>
}

type SaveResult = { ok: true; overrides: KeybindingOverrides } |
  { ok: false; reason: 'invalid' | 'conflict' | 'storage'; conflicts: string[] }

export class KeybindingService {
  private readonly listeners = new Set<(overrides: KeybindingOverrides) => void>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: KeybindingStorage,
    private readonly storageKey = 'vsidian.keybindings') {}

  getSnapshot(): KeybindingOverrides {
    return sanitizeStoredOverrides(this.storage.get(this.storageKey))
  }

  onChange(listener: (overrides: KeybindingOverrides) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private async persist(overrides: KeybindingOverrides): Promise<SaveResult> {
    try {
      await this.storage.update(this.storageKey, overrides)
    } catch {
      return { ok: false, reason: 'storage', conflicts: [] }
    }
    for (const listener of this.listeners) listener(overrides)
    return { ok: true, overrides }
  }

  private serialize(action: () => Promise<SaveResult>): Promise<SaveResult> {
    const result = this.queue.then(action)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  set(id: string, bindings: readonly string[], replaceConflicts: boolean): Promise<SaveResult> {
    return this.serialize(async () => {
      const result = applyBindingChange(this.getSnapshot(), id, bindings, replaceConflicts)
      return result.ok ? this.persist(result.overrides) : result
    })
  }

  reset(id: string, replaceConflicts = false): Promise<SaveResult> {
    return this.serialize(async () => {
      const current = this.getSnapshot()
      const without = { ...current }
      delete without[id]
      const defaults = getEffectiveBindings(without, id)
      const checked = applyBindingChange(current, id, defaults, replaceConflicts)
      if (!checked.ok) return checked
      delete checked.overrides[id]
      return this.persist(checked.overrides)
    })
  }

  resetAll(): Promise<SaveResult> {
    return this.serialize(() => this.persist({}))
  }
}
