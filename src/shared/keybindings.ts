/** 用户操作、默认键位和生效模式的单一事实源。字符串采用 ctrl+shift+b / ctrl+k ctrl+b。 */
import { FORMAT_OPERATIONS } from './formatOperations'

export type BindingMode = 'live' | 'reading' | 'both'
export interface KeybindingOperation {
  id: string
  command: string
  title: string
  mode: BindingMode
  writes: boolean
  defaults: readonly string[]
}

const extra: readonly KeybindingOperation[] = [
  { id: 'find', command: 'onegayi.vsidian.find', title: '查找', mode: 'both', writes: false, defaults: ['ctrl+f', 'meta+f'] },
  { id: 'findNext', command: 'onegayi.vsidian.find.next', title: '下一个查找结果', mode: 'both', writes: false, defaults: ['f3'] },
  { id: 'findPrevious', command: 'onegayi.vsidian.find.previous', title: '上一个查找结果', mode: 'both', writes: false, defaults: ['shift+f3'] },
  { id: 'toggleViewMode', command: 'onegayi.vsidian.toggleViewMode', title: '切换视图模式', mode: 'both', writes: false, defaults: [] },
  { id: 'toReading', command: 'onegayi.vsidian.mode.toReading', title: '切换到阅读模式', mode: 'live', writes: false, defaults: [] },
  { id: 'toLive', command: 'onegayi.vsidian.mode.toLive', title: '切换到实时预览', mode: 'reading', writes: false, defaults: [] },
  { id: 'toSource', command: 'onegayi.vsidian.mode.toSource', title: '切换到源码编辑器', mode: 'both', writes: false, defaults: [] },
  { id: 'tableCreate', command: 'onegayi.vsidian.table.create', title: '创建表格', mode: 'live', writes: true, defaults: [] },
  { id: 'insertRowAbove', command: 'onegayi.vsidian.table.insertRowAbove', title: '表格：上方插入行', mode: 'live', writes: true, defaults: [] },
  { id: 'insertRowBelow', command: 'onegayi.vsidian.table.insertRowBelow', title: '表格：下方插入行', mode: 'live', writes: true, defaults: [] },
  { id: 'deleteRow', command: 'onegayi.vsidian.table.deleteRow', title: '表格：删除行', mode: 'live', writes: true, defaults: [] },
  { id: 'insertColumnLeft', command: 'onegayi.vsidian.table.insertColumnLeft', title: '表格：左侧插入列', mode: 'live', writes: true, defaults: [] },
  { id: 'insertColumnRight', command: 'onegayi.vsidian.table.insertColumnRight', title: '表格：右侧插入列', mode: 'live', writes: true, defaults: [] },
  { id: 'deleteColumn', command: 'onegayi.vsidian.table.deleteColumn', title: '表格：删除列', mode: 'live', writes: true, defaults: [] },
  { id: 'openSettings', command: 'onegayi.vsidian.openSettings', title: '打开设置', mode: 'both', writes: false, defaults: [] },
]

/** 视图中已有明确目标的按钮动作：命令面板、快捷键均可调用。 */
export const UI_OPERATIONS = [
  { id: 'sidebarToggle', command: 'onegayi.vsidian.ui.sidebarToggle', title: '展开或收起右侧栏', mode: 'both', writes: false, defaults: [] },
  { id: 'outlineToggle', command: 'onegayi.vsidian.ui.outlineToggle', title: '显示或隐藏大纲', mode: 'both', writes: false, defaults: [] },
  { id: 'outlineSearch', command: 'onegayi.vsidian.ui.outlineSearch', title: '搜索大纲标题', mode: 'both', writes: false, defaults: [] },
  { id: 'outlineJumpBottom', command: 'onegayi.vsidian.ui.outlineJumpBottom', title: '跳转到笔记末尾', mode: 'both', writes: false, defaults: [] },
  { id: 'outlineReset', command: 'onegayi.vsidian.ui.outlineReset', title: '重置大纲', mode: 'both', writes: false, defaults: [] },
  { id: 'outlineCollapseAll', command: 'onegayi.vsidian.ui.outlineCollapseAll', title: '折叠全部大纲', mode: 'both', writes: false, defaults: [] },
  { id: 'outlineExpandAll', command: 'onegayi.vsidian.ui.outlineExpandAll', title: '展开全部大纲', mode: 'both', writes: false, defaults: [] },
] as const satisfies readonly KeybindingOperation[]
export type UiOperationId = (typeof UI_OPERATIONS)[number]['id']
export function isUiOperationId(value: unknown): value is UiOperationId {
  return typeof value === 'string' && UI_OPERATIONS.some((op) => op.id === value)
}

export const KEYBINDING_OPERATIONS: readonly KeybindingOperation[] = [
  ...FORMAT_OPERATIONS.map((op) => ({
    // #94 迁移期：format 源条目的 title 持字典消息键（消费方经 t() 取词，
    // 缺键回退原串）；extra/UI 源的存量字面量仍在白名单在案，待后续键化
    id: op.id, command: op.command, title: op.titleKey,
    mode: op.mode, writes: op.writes,
    defaults: op.defaultKey ? [op.defaultKey] : op.id === 'italic' ? ['ctrl+i'] : [],
  })),
  ...extra,
  ...UI_OPERATIONS,
]

const byId = new Map(KEYBINDING_OPERATIONS.map((op) => [op.id, op]))
export type KeybindingOverrides = Record<string, string[]>

const modifiers = new Set(['ctrl', 'alt', 'shift', 'meta'])
const keyAliases: Record<string, string> = {
  control: 'ctrl', cmd: 'meta', command: 'meta', option: 'alt', esc: 'escape',
  spacebar: 'space', ' ': 'space', arrowup: 'up', arrowdown: 'down',
  arrowleft: 'left', arrowright: 'right',
}
const validKey = /^(?:[a-z0-9]|f(?:[1-9]|1\d|2[0-4])|escape|enter|tab|space|backspace|delete|home|end|pageup|pagedown|up|down|left|right|minus|equal|comma|period|slash|backslash|semicolon|quote|bracketleft|bracketright)$/

export function normalizeChord(value: string): string | null {
  const steps = value.trim().toLowerCase().replace(/\s*\+\s*/g, '+').split(/\s+/)
  if (!steps.length || steps.length > 2) return null
  const normalized: string[] = []
  for (const step of steps) {
    const parts = step.split('+').map((p) => keyAliases[p.trim()] ?? p.trim())
    if (parts.some((p) => !p)) return null
    const keys = parts.filter((p) => !modifiers.has(p))
    if (keys.length !== 1 || !validKey.test(keys[0])) return null
    const mods = parts.filter((p) => modifiers.has(p))
    if (new Set(mods).size !== mods.length) return null
    normalized.push([...['ctrl', 'alt', 'shift', 'meta'].filter((p) => mods.includes(p)), keys[0]].join('+'))
  }
  return normalized.join(' ')
}

export function isKeybindingOperationId(value: unknown): value is string {
  return typeof value === 'string' && byId.has(value)
}

/** 缺键=跟随当前默认；空数组=明确禁用；非空=用户覆盖。 */
export function getEffectiveBindings(overrides: KeybindingOverrides, operationId: string): readonly string[] {
  const op = byId.get(operationId)
  if (!op) return []
  return Object.prototype.hasOwnProperty.call(overrides, operationId)
    ? overrides[operationId] : op.defaults
}

export function sanitizeStoredOverrides(stored: unknown): KeybindingOverrides {
  const result: KeybindingOverrides = {}
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return result
  for (const [id, value] of Object.entries(stored)) {
    if (!byId.has(id) || !Array.isArray(value)) continue
    const bindings = value.map((item) => typeof item === 'string' ? normalizeChord(item) : null)
    if (bindings.some((item) => !item) || new Set(bindings).size !== bindings.length) continue
    result[id] = bindings as string[]
  }
  return result
}

function modesOverlap(a: BindingMode, b: BindingMode): boolean {
  return a === 'both' || b === 'both' || a === b
}
function chordOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)
}

export function findBindingConflicts(overrides: KeybindingOverrides, operationId: string, chord: string): string[] {
  const operation = byId.get(operationId)
  const normalized = normalizeChord(chord)
  if (!operation || !normalized) return []
  return KEYBINDING_OPERATIONS.filter((other) => other.id !== operationId &&
    modesOverlap(operation.mode, other.mode) &&
    getEffectiveBindings(overrides, other.id).some((binding) => chordOverlap(binding, normalized)))
    .map((other) => other.id)
}

export type BindingChangeResult = { ok: true; overrides: KeybindingOverrides } |
  { ok: false; reason: 'invalid' | 'conflict'; conflicts: string[] }

export function applyBindingChange(overrides: KeybindingOverrides, operationId: string,
  bindings: readonly string[], replaceConflicts: boolean): BindingChangeResult {
  if (!byId.has(operationId)) return { ok: false, reason: 'invalid', conflicts: [] }
  const normalized = bindings.map(normalizeChord)
  if (normalized.some((v) => !v) || new Set(normalized).size !== normalized.length ||
    normalized.some((a, index) => normalized.some((b, other) => index !== other && chordOverlap(a!, b!)))) {
    return { ok: false, reason: 'invalid', conflicts: [] }
  }
  const desired = normalized as string[]
  const conflicts = [...new Set(desired.flatMap((chord) => findBindingConflicts(overrides, operationId, chord)))]
  if (conflicts.length && !replaceConflicts) return { ok: false, reason: 'conflict', conflicts }
  const next = { ...overrides, [operationId]: desired }
  for (const id of conflicts) {
    next[id] = getEffectiveBindings(overrides, id).filter((binding) =>
      !desired.some((chord) => chordOverlap(binding, chord)))
  }
  return { ok: true, overrides: next }
}

export function resolveKeybinding(overrides: KeybindingOverrides, mode: 'live' | 'reading',
  chord: string, allowWrites = true): { kind: 'none' } | { kind: 'prefix' } | { kind: 'command'; id: string } {
  const normalized = normalizeChord(chord)
  if (!normalized) return { kind: 'none' }
  // 用户覆盖优先于后来加入/修改的默认值，升级不能让新默认抢走旧自定义。
  for (const custom of [true, false]) {
    for (const op of KEYBINDING_OPERATIONS) {
      if (Object.prototype.hasOwnProperty.call(overrides, op.id) !== custom ||
        (op.mode !== 'both' && op.mode !== mode) || (!allowWrites && op.writes)) continue
      for (const binding of getEffectiveBindings(overrides, op.id)) {
        if (binding === normalized) return { kind: 'command', id: op.id }
        if (binding.startsWith(`${normalized} `)) return { kind: 'prefix' }
      }
    }
  }
  return { kind: 'none' }
}

export function formatBindingLabel(chord: string): string {
  return chord.split(' ').map((step) => step.split('+').map((part) =>
    ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win', escape: 'Esc', space: 'Space' })[part] ?? part.toUpperCase()).join('+')).join(' ')
}
