import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  KEYBINDING_OPERATIONS, getEffectiveBindings, normalizeChord,
  findBindingConflicts, applyBindingChange, resolveKeybinding,
  type KeybindingOverrides,
} from '../../src/shared/keybindings'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'

describe('快捷键契约', () => {
  it('登记全部用户命令并保留固定默认值', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(KEYBINDING_OPERATIONS.map((op) => op.command).sort()).toEqual(
      manifest.contributes.commands.map((item: { command: string }) => item.command).sort())
    expect(KEYBINDING_OPERATIONS.find((op) => op.id === 'bold')?.defaults).toEqual(['ctrl+b'])
    for (let n = 0; n <= 6; n++) {
      const id = n ? `heading${n}` : 'headingNone'
      expect(KEYBINDING_OPERATIONS.find((op) => op.id === id)?.defaults).toEqual([`ctrl+${n}`])
    }
    for (const id of ['inlineMath', 'blockMath', 'wikilink', 'horizontalRule']) {
      expect(getEffectiveBindings({}, id)).toEqual([])
    }
  })

  it('全部操作名持字典键：titleKey 在两语言包中都有词条', () => {
    for (const op of KEYBINDING_OPERATIONS) {
      expect(typeof en[op.titleKey], `${op.id} 的 titleKey 缺 en 词条`).toBe('string')
      expect(typeof zhCn[op.titleKey], `${op.id} 的 titleKey 缺 zh-cn 词条`).toBe('string')
    }
  })

  it('缺省、显式清空和覆盖是不同状态', () => {
    expect(getEffectiveBindings({}, 'bold')).toEqual(['ctrl+b'])
    expect(getEffectiveBindings({ bold: [] }, 'bold')).toEqual([])
    expect(getEffectiveBindings({ bold: ['ctrl+k ctrl+b', 'ctrl+shift+b'] }, 'bold'))
      .toEqual(['ctrl+k ctrl+b', 'ctrl+shift+b'])
    expect(resolveKeybinding({ italic: ['ctrl+b'] }, 'live', 'ctrl+b'))
      .toEqual({ kind: 'command', id: 'italic' })
  })

  it('规范化输入并排除修饰键独立绑定', () => {
    expect(normalizeChord(' Control + Shift + B ')).toBe('ctrl+shift+b')
    expect(normalizeChord('ctrl+k ctrl+b')).toBe('ctrl+k ctrl+b')
    expect(normalizeChord('ctrl')).toBeNull()
    expect(normalizeChord('ctrl+k ctrl+b ctrl+c')).toBeNull()
  })

  it('重叠范围下同键和单段前缀冲突，互斥范围不冲突', () => {
    const custom: KeybindingOverrides = { bold: ['ctrl+k ctrl+b'] }
    expect(findBindingConflicts(custom, 'italic', 'ctrl+k')).toContain('bold')
    expect(findBindingConflicts(custom, 'italic', 'ctrl+k ctrl+b')).toContain('bold')
    expect(findBindingConflicts({ toReading: ['ctrl+k'] }, 'toLive', 'ctrl+k')).toEqual([])
  })

  it('显式替换只移走冲突项并保留其余绑定', () => {
    const before: KeybindingOverrides = { bold: ['ctrl+b', 'ctrl+k ctrl+b'] }
    expect(applyBindingChange(before, 'italic', ['ctrl+b'], false).ok).toBe(false)
    const result = applyBindingChange(before, 'italic', ['ctrl+b'], true)
    expect(result).toMatchObject({ ok: true, overrides: { bold: ['ctrl+k ctrl+b'], italic: ['ctrl+b'] } })
  })

  it('首段等待、超时/取消和完整两段键解析', () => {
    const overrides: KeybindingOverrides = { bold: ['ctrl+k ctrl+b'] }
    expect(resolveKeybinding(overrides, 'live', 'ctrl+k')).toEqual({ kind: 'prefix' })
    expect(resolveKeybinding(overrides, 'live', 'ctrl+k ctrl+b')).toEqual({ kind: 'command', id: 'bold' })
    expect(resolveKeybinding(overrides, 'reading', 'ctrl+k')).toEqual({ kind: 'none' })
    expect(resolveKeybinding({}, 'live', 'ctrl+b', false)).toEqual({ kind: 'none' })
    expect(resolveKeybinding({}, 'reading', 'f3', false)).toEqual({ kind: 'command', id: 'findNext' })
  })
})
