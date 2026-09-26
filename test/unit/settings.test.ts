// 设置定义与读写纯逻辑契约（#33）：设置项定义（键/类型/默认值/校验内建于
// 类型）、默认快照、存量清洗（无效值恢复默认、未知键忽略）与补丁应用
// （有效值可保存回读、无效值整批拒绝）。#34 起生产注册表含首个实际设置项
// 「显示行号」；其余读写语义仍以 fixture 定义覆盖。
// #95 i18n 起定义文案键化（titleKey/descriptionKey 为消息键）：注册表断言
// 键名 + 经 zh-cn 字典同源取值（不再复制字面量）。
import { describe, it, expect } from 'vitest'
import {
  CODEBLOCK_CARD_DEFAULT,
  CODEBLOCK_CARD_KEY,
  PRODUCTION_SETTING_DEFINITIONS,
  SHOW_LINE_NUMBERS_DEFAULT,
  SHOW_LINE_NUMBERS_KEY,
  applySettingsPatch,
  isSettingDefinition,
  sanitizeStoredSettings,
  settingsDefaults,
  type SettingDefinition,
} from '../../src/shared/settings'
import { zhCn } from '../../src/shared/locales/zh-cn'

/** fixture 定义：契约测试专用的布尔设置项（titleKey 复用生产词条键） */
const FIXTURE_DEFS: readonly SettingDefinition[] = [
  { key: 'editor.lineNumbers', type: 'boolean', default: false, titleKey: 'setting.editorLineNumbers.title' },
  { key: 'editor.spellcheck', type: 'boolean', default: true, titleKey: 'setting.testFlag.title' },
]

describe('生产注册表（#34 起含实际设置项；#95 文案键化）', () => {
  it('注册「显示行号」：键 editor.lineNumbers、boolean、默认开启', () => {
    // #34：首个实际设置项接入，设置页不再是空状态（#33 设计的预期演进）
    const def = PRODUCTION_SETTING_DEFINITIONS[0]
    expect(def.key).toBe('editor.lineNumbers')
    expect(def.type).toBe('boolean')
    expect(def.default).toBe(true)
    expect(def.titleKey).toBe('setting.editorLineNumbers.title')
    expect(zhCn[def.titleKey as keyof typeof zhCn]).toBe('显示行号')
    expect(isSettingDefinition(def)).toBe(true)
  })

  it('注册「代码块卡片」：键 codeblock.card、boolean、默认开启（#79）', () => {
    const def = PRODUCTION_SETTING_DEFINITIONS[1]
    expect(def.key).toBe('codeblock.card')
    expect(def.type).toBe('boolean')
    expect(def.default).toBe(true)
    expect(def.titleKey).toBe('setting.codeblockCard.title')
    expect(zhCn[def.titleKey as keyof typeof zhCn]).toBe('代码块卡片')
    expect(isSettingDefinition(def)).toBe(true)
  })

  it('注册「卡内行号」：键 codeblock.lineNumbers、boolean、默认开启（#80）', () => {
    const def = PRODUCTION_SETTING_DEFINITIONS[2]
    expect(def.key).toBe('codeblock.lineNumbers')
    expect(def.type).toBe('boolean')
    expect(def.default).toBe(true)
    expect(def.titleKey).toBe('setting.codeblockLineNumbers.title')
    expect(zhCn[def.titleKey as keyof typeof zhCn]).toBe('卡内行号')
    expect(isSettingDefinition(def)).toBe(true)
  })

  it('注册「复制按钮」：键 codeblock.copyButton、boolean、默认开启（#81）', () => {
    const def = PRODUCTION_SETTING_DEFINITIONS[3]
    expect(def.key).toBe('codeblock.copyButton')
    expect(def.type).toBe('boolean')
    expect(def.default).toBe(true)
    expect(def.titleKey).toBe('setting.codeblockCopyButton.title')
    expect(zhCn[def.titleKey as keyof typeof zhCn]).toBe('复制按钮')
    expect(isSettingDefinition(def)).toBe(true)
  })

  it('注册「语法高亮」：键 codeblock.highlight、boolean、默认开启（#83）', () => {
    const def = PRODUCTION_SETTING_DEFINITIONS[4]
    expect(def.key).toBe('codeblock.highlight')
    expect(def.type).toBe('boolean')
    expect(def.default).toBe(true)
    expect(def.titleKey).toBe('setting.codeblockHighlight.title')
    expect(zhCn[def.titleKey as keyof typeof zhCn]).toBe('语法高亮')
    expect(isSettingDefinition(def)).toBe(true)
  })

  it('键与消费方常量一致：webview/宿主经 SHOW_LINE_NUMBERS_KEY 读同一键', () => {
    expect(SHOW_LINE_NUMBERS_KEY).toBe('editor.lineNumbers')
    expect(SHOW_LINE_NUMBERS_DEFAULT).toBe(true)
  })

  it('键与消费方常量一致：卡片总开关经 CODEBLOCK_CARD_KEY 读同一键（#79）', () => {
    expect(CODEBLOCK_CARD_KEY).toBe('codeblock.card')
    expect(CODEBLOCK_CARD_DEFAULT).toBe(true)
  })
})

describe('settingsDefaults', () => {
  it('按定义产出默认值快照', () => {
    expect(settingsDefaults(FIXTURE_DEFS)).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': true,
    })
  })

  it('空定义表产出空快照', () => {
    expect(settingsDefaults([])).toEqual({})
  })
})

describe('sanitizeStoredSettings（存量清洗：无效恢复默认、未知忽略、缺省回填）', () => {
  it('存量非对象（null/数组/字符串/数字）时全量回默认', () => {
    for (const stored of [null, undefined, [], 'x', 42]) {
      expect(sanitizeStoredSettings(FIXTURE_DEFS, stored)).toEqual({
        'editor.lineNumbers': false,
        'editor.spellcheck': true,
      })
    }
  })

  it('合法存量值保留', () => {
    expect(
      sanitizeStoredSettings(FIXTURE_DEFS, { 'editor.lineNumbers': true }),
    ).toEqual({
      'editor.lineNumbers': true,
      'editor.spellcheck': true,
    })
  })

  it('类型不符的存量值恢复默认（不抛错、不部分读取）', () => {
    expect(
      sanitizeStoredSettings(FIXTURE_DEFS, { 'editor.lineNumbers': 1, 'editor.spellcheck': 'on' }),
    ).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': true,
    })
  })

  it('未知键的存量被忽略（历史遗留设置不进入快照）', () => {
    expect(
      sanitizeStoredSettings(FIXTURE_DEFS, { 'legacy.removed': true, 'editor.spellcheck': false }),
    ).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': false,
    })
  })
})

describe('applySettingsPatch（补丁应用：有效保存回读、无效整批拒绝）', () => {
  const current = { 'editor.lineNumbers': false, 'editor.spellcheck': true }

  it('有效补丁产出合并后的新快照（未涉及键保持原值）', () => {
    const result = applySettingsPatch(FIXTURE_DEFS, current, { 'editor.lineNumbers': true })
    expect(result).toEqual({
      ok: true,
      merged: { 'editor.lineNumbers': true, 'editor.spellcheck': true },
    })
  })

  it('空补丁合法且幂等（merged 与 current 一致）', () => {
    expect(applySettingsPatch(FIXTURE_DEFS, current, {})).toEqual({
      ok: true,
      merged: current,
    })
  })

  it('未知键拒绝', () => {
    const result = applySettingsPatch(FIXTURE_DEFS, current, { 'unknown.key': true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejected).toContain('unknown.key')
    }
  })

  it('类型不符拒绝（boolean 定义不接受数字/字符串/null）', () => {
    for (const bad of [1, 'true', null, undefined]) {
      const result = applySettingsPatch(FIXTURE_DEFS, current, { 'editor.lineNumbers': bad as never })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.rejected).toContain('editor.lineNumbers')
      }
    }
  })

  it('补丁非对象拒绝', () => {
    for (const bad of [null, 'x', 42, [true]]) {
      const result = applySettingsPatch(FIXTURE_DEFS, current, bad as never)
      expect(result.ok).toBe(false)
    }
  })

  it('原子性：一批中任一键非法则整批拒绝（有效键不落地）', () => {
    const result = applySettingsPatch(FIXTURE_DEFS, current, {
      'editor.lineNumbers': true,
      'editor.spellcheck': 'yes' as never,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejected).toContain('editor.spellcheck')
      expect(result.rejected).not.toContain('editor.lineNumbers')
    }
  })
})

describe('isSettingDefinition（定义自校验：注册入口防线）', () => {
  it('接受合法定义', () => {
    expect(isSettingDefinition(FIXTURE_DEFS[0])).toBe(true)
    expect(isSettingDefinition({ key: 'a', type: 'boolean', default: false, titleKey: 'k' })).toBe(true)
  })

  it('拒绝 key 非字符串或空串', () => {
    expect(isSettingDefinition({ key: 1, type: 'boolean', default: false, titleKey: 'k' })).toBe(false)
    expect(isSettingDefinition({ key: '', type: 'boolean', default: false, titleKey: 'k' })).toBe(false)
  })

  it('拒绝未知 type 与非布尔 default', () => {
    expect(isSettingDefinition({ key: 'a', type: 'number', default: 1, titleKey: 'k' })).toBe(false)
    expect(isSettingDefinition({ key: 'a', type: 'boolean', default: 1, titleKey: 'k' })).toBe(false)
    expect(isSettingDefinition({ key: 'a', type: 'boolean', default: 'false', titleKey: 'k' })).toBe(false)
  })

  it('拒绝 titleKey 非字符串与整体非对象', () => {
    expect(isSettingDefinition({ key: 'a', type: 'boolean', default: false, titleKey: 1 })).toBe(false)
    expect(isSettingDefinition(null)).toBe(false)
    expect(isSettingDefinition('x')).toBe(false)
  })

  it('descriptionKey 可选：缺省合法，存在时须为字符串', () => {
    expect(isSettingDefinition({ key: 'a', type: 'boolean', default: false, titleKey: 'k', descriptionKey: 'kd' })).toBe(true)
    expect(isSettingDefinition({ key: 'a', type: 'boolean', default: false, titleKey: 'k', descriptionKey: 1 })).toBe(false)
  })
})
