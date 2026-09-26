// 简体中文语言包（#93 i18n 基础设施）。以 `Record<MessageKey, string>` 约束
// 到英文包的类型基准：缺键、多键均编译失败（编译期 parity）；运行时键集
// 一致性另由 test/unit/i18nLocales.test.ts 钉住（防构建旁路）。
import type { MessageKey } from './en'

export const zhCn: Record<MessageKey, string> = {
  'settings.pageTitle': 'Vsidian 设置',
  'settings.generalSection': '常规',
  'settings.generalSectionDescription': '调整 Vsidian 的基础行为。更改会自动保存。',
  'setting.language': '界面语言',
  'setting.languageDescription':
    '界面文案的显示语言。选择「自动」时跟随 VS Code 显示语言（中文环境显示简体中文，其余显示英文）；显式选择后不再跟随。更改立即生效。',
  'setting.languageAuto': '自动',
}
