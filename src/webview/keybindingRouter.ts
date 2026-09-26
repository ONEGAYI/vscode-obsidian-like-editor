import { normalizeChord, resolveKeybinding, type KeybindingOverrides } from '../shared/keybindings'

/** KeyboardEvent → 平台无关的键位文字；修饰键自身及组合输入不参与路由。 */
export function keyStep(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>): string | null {
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead') return null
  const aliases: Record<string, string> = {
    ' ': 'space', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down',
    ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pageup', PageDown: 'pagedown',
    '+': 'equal', '-': 'minus', ',': 'comma', '.': 'period', '/': 'slash',
    '\\': 'backslash', ';': 'semicolon', "'": 'quote', '[': 'bracketleft', ']': 'bracketright',
  }
  const key = aliases[event.key] ?? event.key.toLowerCase()
  return normalizeChord(`${event.ctrlKey ? 'ctrl+' : ''}${event.altKey ? 'alt+' : ''}${event.shiftKey ? 'shift+' : ''}${event.metaKey ? 'meta+' : ''}${key}`)
}

export class KeybindingRouter {
  private prefix: string | null = null
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private overrides: KeybindingOverrides, private readonly execute: (id: string) => void) {}

  update(overrides: KeybindingOverrides): void { this.overrides = overrides; this.cancel() }
  cancel(): void {
    this.prefix = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  handle(event: KeyboardEvent, mode: 'live' | 'reading', inScope: boolean, allowWrites = true): boolean {
    if (!inScope) { this.cancel(); return false }
    if (event.key === 'Escape' && this.prefix) { this.cancel(); event.preventDefault(); event.stopPropagation(); return true }
    const step = keyStep(event)
    if (!step) return false
    let result = resolveKeybinding(this.overrides, mode, this.prefix ? `${this.prefix} ${step}` : step, allowWrites)
    if (this.prefix && result.kind === 'none') {
      this.cancel()
      result = resolveKeybinding(this.overrides, mode, step, allowWrites)
    }
    if (result.kind === 'none') return false
    event.preventDefault()
    // VS Code 1.86 的 webview 预加载脚本在 window 冒泡阶段将 keydown 转发
    // 至工作台；preventDefault 不阻止转发，document 捕获层需截断传播。
    event.stopPropagation()
    if (result.kind === 'prefix') {
      this.prefix = step
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.cancel(), 1200)
    } else {
      this.cancel()
      this.execute(result.id)
    }
    return true
  }
}
