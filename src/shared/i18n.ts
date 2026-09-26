// t() 取词状态模块（#93 i18n 基础设施）：语言包装配与取词的唯一运行时
// 状态，webview / 宿主 / 单测三条装配路径共用（规格「字典架构」：装配
// 三径同构，同一状态模块，无第四种旁路）。
//
// 约束（懒加载命门）：本模块【不得】静态 import 任何字典文件——只有宿主
// bundle 引字典，webview 产物零字典字节（test/unit/i18nBundleBytes.test.ts
// 钉住）。键类型的编译期检查经 type-only import 获得（编译后擦除，零字节）。
//
// 回退链：当前包缺键 → en 包（装配时可选提供，宿主路径提供；webview 单包
// 持有故无此层）→ 键名本身。编译期 parity 已保证两包键集一致，运行时回退
// 仅作防御。
import type { MessageKey } from './locales/en'

/** 语言包：键 → 文案（装配前的 JSON 形态，与字典源解耦） */
export type MessageBundle = Readonly<Record<string, string>>

/** 插值参数：{x} 占位符的替换值（string | number） */
export type MessageParams = Record<string, string | number>

interface LocaleStateEntry {
  lang: string
  messages: MessageBundle
}

let current: LocaleStateEntry | undefined
let fallback: MessageBundle | undefined
const listeners = new Set<() => void>()

/**
 * 装配当前语言包（原子换包）。装配三径：
 * - 宿主：静态 import 字典后按生效语言装配（locales/index.ts 的
 *   installHostLocale），并提供 en 回退包；
 * - webview：首帧从数据岛装配（webview/localeBoot.ts），locale.changed
 *   到达时换包；
 * - 单测：直接注入测试语言包。
 * 每次装配通知全部监听者（常驻文本节点重渲染的驱动源）。
 */
export function installLocale(
  lang: string,
  messages: MessageBundle,
  options?: { fallback?: MessageBundle },
): void {
  current = { lang, messages }
  if (options?.fallback) {
    fallback = options.fallback
  }
  for (const listener of listeners) {
    listener()
  }
}

/** 取词：{x} 简单占位插值（不做复数语法）；缺参占位符原样保留 */
export function t(key: MessageKey | (string & {}), params?: MessageParams): string {
  let text: string | undefined = current?.messages[key]
  if (text === undefined) {
    text = fallback?.[key]
  }
  if (text === undefined) {
    return key
  }
  if (params) {
    // 单遍扫描（R2）：替换值不参与后续匹配——逐参数 replaceAll 会级联，
    // 值中含后续占位符字样（如 "{y}"）时被二次替换
    text = text.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
  return text!
}

/** 当前生效语言代码（未装配为空串） */
export function currentLocaleLang(): string {
  return current?.lang ?? ''
}

/** 订阅语言包装配（每次 installLocale 后触发）；返回取消函数 */
export function onLocaleChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
