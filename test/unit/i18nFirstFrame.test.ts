// @vitest-environment jsdom
// webview 语言包装配契约（#93 i18n 基础设施，懒加载命门）：
// - 首帧：bootLocaleFromDocument 从数据岛装配，页面文案立即可用（不依赖
//   任何宿主消息——ready/settings.get 均未发生）
// - 切换：locale.changed 到达后原子换包、常驻文本节点重渲染、
//   <html lang> 同步
// 断言对象是用户可见文本（视觉层断言纪律），非 DOM 存在性。
import { describe, it, expect, beforeEach } from 'vitest'
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
