// @vitest-environment jsdom
// webview 语言包装配契约（#93 i18n 基础设施，懒加载命门）：
// - 首帧：bootLocaleFromDocument 从数据岛装配，页面文案立即可用（不依赖
//   任何宿主消息——ready/settings.get 均未发生）
// - 切换：locale.changed 到达后原子换包、常驻文本节点重渲染、
//   <html lang> 同步
// 断言对象是用户可见文本（视觉层断言纪律），非 DOM 存在性。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  bootLocaleFromDocument,
  handleLocaleChangedMessage,
} from '../../src/webview/localeBoot'
import {
  SettingsPageView,
  SETTINGS_PAGE_CLASS_NAMES,
} from '../../src/webview/settingsPageView'
import { LOCALE_ISLAND_ID } from '../../src/shared/locales/island'

function plantIsland(json: string): void {
  document.getElementById(LOCALE_ISLAND_ID)?.remove()
  const script = document.createElement('script')
  script.type = 'application/json'
  script.id = LOCALE_ISLAND_ID
  script.textContent = json
  document.head.append(script)
}

function mountView(): { view: SettingsPageView; parent: HTMLElement; sent: unknown[] } {
  const sent: unknown[] = []
  const view = new SettingsPageView({ postMessage: (m) => sent.push(m) }, [])
  const parent = document.createElement('div')
  document.body.append(parent)
  view.mount(parent)
  return { view, parent, sent }
}

describe('首帧装配（数据岛 → 首帧文案，零宿主消息）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  it('数据岛装配后 mount 的页面首帧即显示数据岛词条', () => {
    plantIsland('{"lang":"zh-cn","messages":{"settings.pageTitle":"数据岛标题"}}')
    expect(bootLocaleFromDocument()).toBe(true)
    const { parent } = mountView()
    const title = parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.title}`)
    // 断言用户可见文本来自数据岛（未发生任何 settings.get 往返）
    expect(title?.textContent).toBe('数据岛标题')
  })

  it('数据岛同步 <html lang>', () => {
    plantIsland('{"lang":"en","messages":{}}')
    bootLocaleFromDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('数据岛缺失/损坏时 boot 返回 false（页面回退键名显示，不抛错）', () => {
    expect(bootLocaleFromDocument()).toBe(false)
    plantIsland('{broken')
    expect(bootLocaleFromDocument()).toBe(false)
    const { parent } = mountView()
    expect(
      parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.title}`)?.textContent,
    ).toBe('settings.pageTitle')
  })
})

describe('locale.changed 换包（原子换包 + 常驻文本重渲染 + lang 同步）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  it('换包后常驻标题文本变为新语言包词条，html lang 同步', () => {
    plantIsland('{"lang":"zh-cn","messages":{"settings.pageTitle":"中文标题"}}')
    bootLocaleFromDocument()
    const { parent } = mountView()
    expect(
      parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.title}`)?.textContent,
    ).toBe('中文标题')

    handleLocaleChangedMessage({
      kind: 'locale.changed',
      lang: 'en',
      messages: { 'settings.pageTitle': 'Swapped title' },
    })
    // 用户可见文本已换语言（重渲染，非仅状态更新）
    expect(
      parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.title}`)?.textContent,
    ).toBe('Swapped title')
    expect(document.documentElement.lang).toBe('en')
  })

  it('非 locale.changed 消息被忽略（不换包不重渲染）', () => {
    plantIsland('{"lang":"zh-cn","messages":{"settings.pageTitle":"中文标题"}}')
    bootLocaleFromDocument()
    const { parent } = mountView()
    handleLocaleChangedMessage({ kind: 'settings.snapshot', values: {} })
    handleLocaleChangedMessage('junk')
    expect(
      parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.title}`)?.textContent,
    ).toBe('中文标题')
  })
})

describe('语言链路诊断（R4：静默失败可观测）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  it('数据岛缺失/损坏时 console.warn 含元素 id 与原文片段等定位信息', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // 缺失：告警含数据岛元素 id
    bootLocaleFromDocument()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain(LOCALE_ISLAND_ID)
    // 完好数据岛：不告警
    warn.mockClear()
    plantIsland('{"lang":"en","messages":{"k":"v"}}')
    expect(bootLocaleFromDocument()).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    // 损坏：告警含原文片段（定位注入点的问题载荷）
    warn.mockClear()
    plantIsland('{broken')
    expect(bootLocaleFromDocument()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('{broken')
    warn.mockRestore()
  })

  it('非法 locale.changed 载荷丢弃时告警（含当前 lang 现值）；合法与无关消息不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    plantIsland('{"lang":"zh-cn","messages":{}}')
    bootLocaleFromDocument()
    // 无关消息（含非对象垃圾）静默忽略：不是语言链路的失败
    handleLocaleChangedMessage({ kind: 'settings.snapshot', values: {} })
    handleLocaleChangedMessage('junk')
    expect(warn).not.toHaveBeenCalled()
    // kind 为 locale.changed 但载荷非法（缺 messages）：丢弃并告警
    handleLocaleChangedMessage({ kind: 'locale.changed', lang: 'en' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('zh-cn')
    expect(document.documentElement.lang).toBe('zh-cn')
    // 合法载荷正常换包，不告警
    warn.mockClear()
    handleLocaleChangedMessage({ kind: 'locale.changed', lang: 'en', messages: { 'k.a': 'w' } })
    expect(warn).not.toHaveBeenCalled()
    expect(document.documentElement.lang).toBe('en')
    warn.mockRestore()
  })
})
