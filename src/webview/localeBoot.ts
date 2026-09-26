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
 * （取词回退键名，不抛错）并 console.warn 留下定位信息（R4：语言链路的
 * 静默失败可观测）；成功时同步 <html lang>（与宿主注入双保险）。
 */
export function bootLocaleFromDocument(): boolean {
  const island = document.getElementById(LOCALE_ISLAND_ID)
  const text = island?.textContent
  if (!text) {
    console.warn(
      `[vsidian] locale island #${LOCALE_ISLAND_ID} is missing or empty: ` +
        `all texts fall back to message keys (current lang=${JSON.stringify(currentLocaleLang())})`,
    )
    return false
  }
  const data = parseLocaleIsland(text)
  if (!data) {
    console.warn(
      `[vsidian] locale island #${LOCALE_ISLAND_ID} is malformed: ` +
        `texts fall back to message keys (current lang=${JSON.stringify(currentLocaleLang())}, ` +
        `raw head=${JSON.stringify(text.slice(0, 80))})`,
    )
    return false
  }
  installLocale(data.lang, data.messages)
  document.documentElement.lang = data.lang
  return true
}

/**
 * 宿主消息入口（locale.changed）：非该消息静默忽略（不是语言链路的失败）；
 * 命中但载荷非法（协议校验不过）时丢弃并 console.warn 留下当前 lang 现值
 * （R4）；合法时原子换包并同步 <html lang>，installLocale 通知触发常驻
 * 文本重渲染。
 */
export function handleLocaleChangedMessage(message: unknown): void {
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { kind?: unknown }).kind !== 'locale.changed'
  ) {
    return
  }
  // 造型到目标形态后经协议守卫整体校验（isHostToWebview 的收窄无法与
  // 上方的手写 kind 判定关联，须先造型）
  const localeMessage = message as { kind: 'locale.changed'; lang: string; messages: Record<string, string> }
  if (!isHostToWebview(localeMessage)) {
    console.warn(
      '[vsidian] dropping malformed locale.changed message ' +
        `(current lang=${JSON.stringify(currentLocaleLang())})`,
    )
    return
  }
  installLocale(localeMessage.lang, localeMessage.messages)
  document.documentElement.lang = localeMessage.lang
}
