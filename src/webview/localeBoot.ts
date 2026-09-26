// webview 语言装配入口（#93 i18n 基础设施，装配三径之二）：
// - 首帧：bootLocaleFromDocument 从 HTML 数据岛（宿主生成点注入的非执行
//   JSON）装配当前语言包——不依赖任何宿主消息，文案首帧即就绪；
// - 切换：handleLocaleChangedMessage 处理宿主 locale.changed（原子换包），
//   同步 <html lang>；常驻文本重渲染由 onLocaleChanged 订阅方各自完成
//   （设置页 SettingsPageView、编辑器面板 #94 迁移面）。
//
// 本模块不 import 字典文件（webview 产物零字典字节；语言包只经数据岛与
// locale.changed 进入 webview，任一时刻至多持有当前生效语言包）。
import { installLocale, onLocaleChanged, currentLocaleLang } from '../shared/i18n'
import { LOCALE_ISLAND_ID, parseLocaleIsland } from '../shared/locales/island'
import { isHostToWebview } from '../shared/protocol'

export { onLocaleChanged, currentLocaleLang }

/**
 * 首帧装配：读取文档数据岛并安装语言包。数据岛缺失/损坏返回 false
 * （取词回退键名，不抛错）；成功时同步 <html lang>（与宿主注入双保险）。
 */
export function bootLocaleFromDocument(): boolean {
  const island = document.getElementById(LOCALE_ISLAND_ID)
  const text = island?.textContent
  if (!text) {
    return false
  }
  const data = parseLocaleIsland(text)
  if (!data) {
    return false
  }
  installLocale(data.lang, data.messages)
  document.documentElement.lang = data.lang
  return true
}

/**
 * 宿主消息入口（locale.changed）：非该消息静默忽略；命中时原子换包并
 * 同步 <html lang>，installLocale 通知触发常驻文本重渲染。
 */
export function handleLocaleChangedMessage(message: unknown): void {
  if (!isHostToWebview(message) || message.kind !== 'locale.changed') {
    return
  }
  installLocale(message.lang, message.messages)
  document.documentElement.lang = message.lang
}
