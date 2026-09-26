// @vitest-environment jsdom
// 设置 schema string 枚举契约（#93 i18n 基础设施）：
// - SettingDefinition 支持 type:'string' + enum 值域（isSettingDefinition /
//   valueMatchesType（经 sanitize/apply 间接验证）/ 清洗与补丁同步）
// - 设置页下拉控件：渲染、当前值选中、optionLabels 显示名、变更上送、
//   快照回显；boolean 定义仍渲染复选框（不回归）
import { describe, it, expect } from 'vitest'
import {
  applySettingsPatch,
  isSettingDefinition,
  sanitizeStoredSettings,
  settingsDefaults,
  type SettingDefinition,
} from '../../src/shared/settings'
import { SettingsService, type SettingsStorage } from '../../src/host/settingsService'
import {
  SettingsPageView,
  SETTINGS_PAGE_CLASS_NAMES,
} from '../../src/webview/settingsPageView'

const ENUM_DEFS: readonly SettingDefinition[] = [
  {
    key: 'general.language',
    type: 'string',
    default: 'auto',
    enum: ['auto', 'zh-cn', 'en'],
    titleKey: 'setting.editorLineNumbers.title',
    optionLabels: { 'zh-cn': '简体中文', en: 'English' },
  },
]

describe('isSettingDefinition（string 枚举定义校验）', () => {
  it('接受合法 string 枚举定义（default ∈ enum）', () => {
    expect(isSettingDefinition(ENUM_DEFS[0])).toBe(true)
  })

  it('拒绝 enum 缺失 / 空数组 / 含非字符串 / 含重复值', () => {
    expect(isSettingDefinition({ ...ENUM_DEFS[0], enum: undefined })).toBe(false)
    expect(isSettingDefinition({ ...ENUM_DEFS[0], enum: [] })).toBe(false)
    expect(isSettingDefinition({ ...ENUM_DEFS[0], enum: ['auto', 1] })).toBe(false)
    expect(isSettingDefinition({ ...ENUM_DEFS[0], enum: ['auto', 'auto'] })).toBe(false)
  })

  it('拒绝 default 不在值域或类型不符', () => {
    expect(isSettingDefinition({ ...ENUM_DEFS[0], default: 'fr' })).toBe(false)
    expect(isSettingDefinition({ ...ENUM_DEFS[0], default: true })).toBe(false)
  })

  it('optionLabels 可选：缺省合法，值非字符串拒绝', () => {
    expect(isSettingDefinition({ ...ENUM_DEFS[0], optionLabels: undefined })).toBe(true)
    expect(isSettingDefinition({ ...ENUM_DEFS[0], optionLabels: { auto: 1 } })).toBe(false)
  })
})

describe('清洗与补丁（值域校验随 type 扩展同步）', () => {
  it('settingsDefaults 产出字符串默认值', () => {
    expect(settingsDefaults(ENUM_DEFS)).toEqual({ 'general.language': 'auto' })
  })

  it('存量清洗：值域内保留，值域外/类型不符恢复默认', () => {
    expect(sanitizeStoredSettings(ENUM_DEFS, { 'general.language': 'en' })).toEqual({
      'general.language': 'en',
    })
    expect(sanitizeStoredSettings(ENUM_DEFS, { 'general.language': 'fr' })).toEqual({
      'general.language': 'auto',
    })
    expect(sanitizeStoredSettings(ENUM_DEFS, { 'general.language': true })).toEqual({
      'general.language': 'auto',
    })
  })

  it('补丁应用：值域内合法持久化，值域外整批拒绝（原子性）', () => {
    const current = settingsDefaults(ENUM_DEFS)
    expect(applySettingsPatch(ENUM_DEFS, current, { 'general.language': 'zh-cn' })).toEqual({
      ok: true,
      merged: { 'general.language': 'zh-cn' },
    })
    const rejected = applySettingsPatch(ENUM_DEFS, current, { 'general.language': 'fr' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.rejected).toContain('general.language')
    }
    // 混合批：一个非法值整批拒绝
    const mixed = applySettingsPatch(ENUM_DEFS, current, {
      'general.language': 'fr',
      'unknown.key': 'x',
    })
    expect(mixed.ok).toBe(false)
  })

  it('合法值经 SettingsService 持久化并可读回（overlay 存储往返）', async () => {
    const store: Record<string, unknown> = {}
    const storage: SettingsStorage = {
      get: <T,>(key: string) => store[key] as T | undefined,
      update: (key: string, value: unknown) => {
        store[key] = value
        return Promise.resolve()
      },
    }
    const service = new SettingsService(storage, ENUM_DEFS)
    const saved = await service.apply({ 'general.language': 'en' })
    expect(saved.ok).toBe(true)
    expect(service.getSnapshot()['general.language']).toBe('en')
    // 新实例从同一持久层读回（重开窗口语义）
    expect(
      new SettingsService(storage, ENUM_DEFS).getSnapshot()['general.language'],
    ).toBe('en')
  })
})

function mountView(defs: readonly SettingDefinition[]): {
  parent: HTMLElement
  sent: unknown[]
  view: SettingsPageView
} {
  const sent: unknown[] = []
  const view = new SettingsPageView({ postMessage: (m) => sent.push(m) }, defs)
  const parent = document.createElement('div')
  document.body.append(parent)
  view.mount(parent)
  return { parent, sent, view }
}

describe('设置页下拉控件渲染与交互', () => {
  it('string 定义渲染 select：选项顺序与值域一致，默认值选中', () => {
    const { parent } = mountView(ENUM_DEFS)
    const select = parent.querySelector<HTMLSelectElement>(
      `select.${SETTINGS_PAGE_CLASS_NAMES.select}`,
    )
    expect(select, '应渲染下拉控件').toBeTruthy()
    expect([...select!.options].map((o) => o.value)).toEqual(['auto', 'zh-cn', 'en'])
    expect(select!.value).toBe('auto')
  })

  it('optionLabels 作为选项显示名；未提供显示名的值显示原值', () => {
    const { parent } = mountView(ENUM_DEFS)
    const select = parent.querySelector<HTMLSelectElement>(
      `select.${SETTINGS_PAGE_CLASS_NAMES.select}`,
    )!
    const byValue = new Map([...select.options].map((o) => [o.value, o.textContent]))
    expect(byValue.get('auto')).toBe('auto')
    expect(byValue.get('zh-cn')).toBe('简体中文')
    expect(byValue.get('en')).toBe('English')
  })

  it('变更上送 settings.set 携带所选值', () => {
    const { parent, sent } = mountView(ENUM_DEFS)
    const select = parent.querySelector<HTMLSelectElement>(
      `select.${SETTINGS_PAGE_CLASS_NAMES.select}`,
    )!
    select.value = 'en'
    select.dispatchEvent(new Event('change'))
    expect(sent).toContainEqual({
      kind: 'settings.set',
      values: { 'general.language': 'en' },
    })
  })

  it('快照回显：settings.snapshot 更新下拉当前值（宿主权威）', () => {
    const { view, parent } = mountView(ENUM_DEFS)
    view.handleHostMessage({
      kind: 'settings.snapshot',
      values: { 'general.language': 'zh-cn' },
    })
    const select = parent.querySelector<HTMLSelectElement>(
      `select.${SETTINGS_PAGE_CLASS_NAMES.select}`,
    )!
    expect(select.value).toBe('zh-cn')
  })

  it('boolean 定义仍渲染复选框（schema 扩展不回归既有控件）', () => {
    const { parent } = mountView([
      ENUM_DEFS[0],
      { key: 'editor.flag', type: 'boolean', default: true, titleKey: 'setting.testFlag.title' },
    ])
    expect(
      parent.querySelectorAll(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`),
    ).toHaveLength(1)
    expect(parent.querySelectorAll(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)).toHaveLength(1)
  })
})
