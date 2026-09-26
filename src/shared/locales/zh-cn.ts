// 简体中文语言包（#93 i18n 基础设施）。以 `Record<MessageKey, string>` 约束
// 到英文包的类型基准：缺键、多键均编译失败（编译期 parity）；运行时键集
// 一致性另由 test/unit/i18nLocales.test.ts 钉住（防构建旁路）。
import type { MessageKey } from './en'

export const zhCn: Record<MessageKey, string> = {
  'settings.pageTitle': 'Vsidian 设置',
}
