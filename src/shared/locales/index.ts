// 语言注册表与解析（#93 i18n 基础设施）——【仅宿主 bundle 与单测可引】：
// 本文件静态 import 两语言包，webview 产物不得引用（懒加载命门，经
// test/unit/i18nBundleBytes.test.ts 断言钉住）。webview 侧的语言装配入口
// 是 webview/localeBoot.ts（数据岛 + locale.changed），不经过本文件。
import { installLocale } from '../i18n'
import { en, type MessageKey } from './en'
import { zhCn } from './zh-cn'

export type { MessageKey }

/** 内部语言代码（统一小写，与 nls 文件名惯例对齐） */
export type LocaleCode = 'en' | 'zh-cn'

/** 语言设置值域（general.language，#4 注册定义） */
export type LocalePreference = 'auto' | LocaleCode

/** 支持语言清单（顺序即建议的选项展示顺序） */
export const SUPPORTED_LOCALES: readonly LocaleCode[] = ['en', 'zh-cn']

/** 语言包注册表（宿主作为包载体静态持有两包；Node 端无加载成本） */
export const LOCALE_MESSAGES: Readonly<Record<LocaleCode, Readonly<Record<string, string>>>> = {
  en,
  'zh-cn': zhCn,
}

export function isLocaleCode(v: unknown): v is LocaleCode {
  return v === 'en' || v === 'zh-cn'
}

/**
 * 生效语言解析（规格「两层语言模型」）：显式偏好直接生效；auto / 缺省 /
 * 非法值按宿主显示语言解析——vscode.env.language 以 zh 开头（zh/zh-cn/
 * zh-tw…）解析为 zh-cn，其余（含 en 与未适配语言）解析为 en。
 */
export function resolveLocale(preference: unknown, envLanguage: string): LocaleCode {
  if (preference === 'zh-cn' || preference === 'en') {
    return preference
  }
  // env 缺省（旧宿主/异常语境）视为非 zh，回落 en；不抛错
  return String(envLanguage ?? '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en'
}

/**
 * 宿主侧装配（装配三径之一）：静态 import 字典后按生效语言装配，并登记
 * en 包为运行时回退（宿主常驻两包，回退链完整可用）。
 */
export function installHostLocale(lang: LocaleCode): void {
  installLocale(lang, LOCALE_MESSAGES[lang], { fallback: en })
}
