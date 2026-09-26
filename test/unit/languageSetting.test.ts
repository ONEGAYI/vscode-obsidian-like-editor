// @vitest-environment jsdom
// #96 语言设置项（general.language）与切换即生效契约：
// - 生产注册表注册：enum 值域与顺序、默认 auto、定义自校验通过
// - 设置链路的 auto 语义隔离：显式选择不随宿主 env 变化；auto 跟随 env
// - 持久化往返（同存储新服务实例 = 重开窗口语义）
// - 设置页「常规」分组渲染：nav 分类可见文本、默认分组、语言项下拉与
//   选项显示名——auto 随装配语言取词（t()），语言自名不自译（静态直显，
//   en 装配下「简体中文」不变）
// - 换包后常驻文本重渲染（分类标题、auto 选项名就地更新，不重挂载）
// 断言对象是用户可见文本（视觉层断言纪律），非 DOM 存在性。
import { describe, it, expect } from 'vitest'
import {
  PRODUCTION_SETTING_DEFINITIONS,
  LANGUAGE_KEY,
  isSettingDefinition,
  settingsDefaults,
  type SettingDefinition,
} from '../../src/shared/settings'
import { SettingsService, type SettingsStorage } from '../../src/host/settingsService'
import {
  SettingsPageView,
  SETTINGS_PAGE_CLASS_NAMES,
} from '../../src/webview/settingsPageView'
import { installLocale } from '../../src/shared/i18n'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'
import { resolveLocale } from '../../src/shared/locales'

function memoryStorage(): { storage: SettingsStorage; store: Record<string, unknown> } {
  const store: Record<string, unknown> = {}
  return {
    store,
    storage: {
      get: <T,>(key: string) => store[key] as T | undefined,
      update: (key: string, value: unknown) => {
        store[key] = value
        return Promise.resolve()
      },
    },
  }
}

function makeView(defs: readonly SettingDefinition[]): {
  view: SettingsPageView
  sent: unknown[]
  parent: HTMLElement
} {
  const sent: unknown[] = []
  const view = new SettingsPageView({ postMessage: (m) => sent.push(m) }, defs)
  const parent = document.createElement('div')
  view.mount(parent)
  return { view, sent, parent }
}

const NAV_ITEM = '.vsidian-settings-nav-item'

describe('生产注册表：general.language 定义（#96）', () => {
  it('注册定义：默认 auto、值域 [auto, zh-cn, en]、经 isSettingDefinition 校验', () => {
    const def = PRODUCTION_SETTING_DEFINITIONS.find((d) => d.key === LANGUAGE_KEY)
    expect(def, '生产注册表应含 general.language').toBeDefined()
    expect(def!.type).toBe('string')
    expect(def!.default).toBe('auto')
    expect(def!.type === 'string' ? def!.enum : []).toEqual(['auto', 'zh-cn', 'en'])
    expect(isSettingDefinition(def)).toBe(true)
  })

  it('默认快照 general.language 为 auto（首装无偏好即 auto 语义）', () => {
    expect(settingsDefaults(PRODUCTION_SETTING_DEFINITIONS)[LANGUAGE_KEY]).toBe('auto')
  })
})

describe('auto 语义隔离（存储值 → 解析接线）', () => {
  it('显式选择不跟随宿主显示语言；auto 跟随', async () => {
    const { storage } = memoryStorage()
    const service = new SettingsService(storage, PRODUCTION_SETTING_DEFINITIONS)
    // 显式 zh-cn：英文宿主环境仍解析 zh-cn
    await service.apply({ [LANGUAGE_KEY]: 'zh-cn' })
    expect(resolveLocale(service.getSnapshot()[LANGUAGE_KEY], 'en-US')).toBe('zh-cn')
    // 显式 en：中文宿主环境仍解析 en
    await service.apply({ [LANGUAGE_KEY]: 'en' })
    expect(resolveLocale(service.getSnapshot()[LANGUAGE_KEY], 'zh-cn')).toBe('en')
    // auto：跟随宿主显示语言（zh* → zh-cn，其余 → en）
    await service.apply({ [LANGUAGE_KEY]: 'auto' })
    expect(resolveLocale(service.getSnapshot()[LANGUAGE_KEY], 'zh-cn')).toBe('zh-cn')
    expect(resolveLocale(service.getSnapshot()[LANGUAGE_KEY], 'en-US')).toBe('en')
  })

  it('持久化往返：新服务实例（重开窗口语义）读回显式选择', async () => {
    const { storage } = memoryStorage()
    await new SettingsService(storage, PRODUCTION_SETTING_DEFINITIONS).apply({
      [LANGUAGE_KEY]: 'en',
    })
    const reopened = new SettingsService(storage, PRODUCTION_SETTING_DEFINITIONS)
    expect(reopened.getSnapshot()[LANGUAGE_KEY]).toBe('en')
    // 值域外存量清洗回默认 auto
    storage.update('vsidian.settings', { [LANGUAGE_KEY]: 'fr' })
    expect(reopened.getSnapshot()[LANGUAGE_KEY]).toBe('auto')
  })

  it('optionLabelKeys 校验：合法对象通过，值非字符串拒绝', () => {
    const def = PRODUCTION_SETTING_DEFINITIONS.find((d) => d.key === LANGUAGE_KEY)!
    expect(isSettingDefinition({ ...def, optionLabelKeys: undefined })).toBe(true)
    expect(isSettingDefinition({ ...def, optionLabelKeys: { auto: 'setting.languageAuto' } })).toBe(true)
    expect(isSettingDefinition({ ...def, optionLabelKeys: { auto: 1 } })).toBe(false)
  })
})

describe('设置页「常规」分组渲染与选项显示名（视觉层断言）', () => {
  it('zh 装配：nav 含「常规」「编辑器」，默认显示常规组，下拉三选项（自动 / 简体中文 / English）', () => {
    installLocale('zh-cn', zhCn)
    const { parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    const navTexts = [...parent.querySelectorAll<HTMLButtonElement>(NAV_ITEM)].map((b) => b.textContent)
    expect(navTexts[0]).toBe(zhCn['settings.generalSection'])
    expect(navTexts).toContain('编辑器')
    // 默认分组 = 首个分类（常规）：语言项直接可见
    expect(parent.querySelector(`h2.vsidian-settings-heading`)?.textContent)
      .toBe(zhCn['settings.generalSection'])
    const select = parent.querySelector<HTMLSelectElement>(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)!
    expect([...select.options].map((o) => o.value)).toEqual(['auto', 'zh-cn', 'en'])
    // auto 档随当前语言取词；语言自名静态直显
    expect([...select.options].map((o) => o.textContent))
      .toEqual(['自动', '简体中文', 'English'])
    expect(select.value).toBe('auto')
  })

  it('语言自名不自译：en 装配下 auto 选项变 Auto，「简体中文」保持原样', () => {
    installLocale('en', en)
    const { parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    const select = parent.querySelector<HTMLSelectElement>(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)!
    expect([...select.options].map((o) => o.textContent))
      .toEqual(['Auto', '简体中文', 'English'])
    expect(parent.querySelector(`h2.vsidian-settings-heading`)?.textContent)
      .toBe(en['settings.generalSection'])
  })

  it('换包重渲染：同一挂载就地更新——常规分类标题与 auto 选项名随新语言，编辑器分类仍为存量中文', () => {
    installLocale('zh-cn', zhCn)
    const { parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    expect([...parent.querySelectorAll<HTMLButtonElement>(NAV_ITEM)].map((b) => b.textContent))
      .toEqual(['常规', '编辑器'])
    installLocale('en', en)
    // 不重新 mount：onLocaleChanged 订阅触发 applyLocale → render 重建
    expect([...parent.querySelectorAll<HTMLButtonElement>(NAV_ITEM)].map((b) => b.textContent))
      .toEqual(['General', '编辑器'])
    const select = parent.querySelector<HTMLSelectElement>(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)!
    expect([...select.options].map((o) => o.textContent)).toEqual(['Auto', '简体中文', 'English'])
    // 换回 zh 同样就地恢复
    installLocale('zh-cn', zhCn)
    expect([...parent.querySelectorAll<HTMLButtonElement>(NAV_ITEM)].map((b) => b.textContent))
      .toEqual(['常规', '编辑器'])
  })

  it('分组隔离：切到「编辑器」组只显示编辑器定义（开关），语言项不在其中', () => {
    installLocale('zh-cn', zhCn)
    const { parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    const editorNav = [...parent.querySelectorAll<HTMLButtonElement>(NAV_ITEM)]
      .find((b) => b.textContent === '编辑器')!
    editorNav.click()
    expect(parent.querySelector(`h2.vsidian-settings-heading`)?.textContent).toBe('编辑器')
    const boxes = parent.querySelectorAll<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)
    expect(boxes.length).toBe(PRODUCTION_SETTING_DEFINITIONS.filter((d) => d.type === 'boolean').length)
    expect(parent.querySelector(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)).toBeNull()
  })

  it('搜索跨组命中常规项并标注分类，点击定位到常规组', () => {
    installLocale('zh-cn', zhCn)
    const { parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    const search = parent.querySelector<HTMLInputElement>('input[type=search]')!
    search.value = '界面语言'
    search.dispatchEvent(new Event('input'))
    const result = parent.querySelector<HTMLButtonElement>('.vsidian-settings-result')!
    expect(result.textContent).toContain(zhCn['settings.generalSection'])
    result.click()
    expect(parent.querySelector<HTMLSelectElement>(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)).toBeTruthy()
  })

  it('settings.changed 回显语言值（宿主权威）', () => {
    installLocale('zh-cn', zhCn)
    const { view, parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    view.handleHostMessage({ kind: 'settings.changed', values: { [LANGUAGE_KEY]: 'en' } })
    expect(parent.querySelector<HTMLSelectElement>(`select.${SETTINGS_PAGE_CLASS_NAMES.select}`)!.value)
      .toBe('en')
  })
})
