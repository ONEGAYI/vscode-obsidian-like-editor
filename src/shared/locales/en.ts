// 英文语言包（#93 i18n 基础设施）——字典单一事实源的【类型基准】：
// `MessageKey = keyof typeof en`，zh-cn.ts 以 `Record<MessageKey, string>`
// 约束（缺键/多键即 tsc 编译失败，编译期 parity）。
//
// 翻译约定（规格「翻译流程与术语」）：术语以 docs/specs/i18n.md 附录术语表
// 为唯一术语源；按钮与动作用祈使动词，标题与标签名词短语，描述为完整句、
// 句尾句号，sentence case。本票只入基础设施所需词条，存量文案随 #94/#95
// 迁移工单逐面补齐（键前缀分组见规格「字典架构」表）。
export const en = {
  /** 设置页面板标题（宿主 createWebviewPanel 标题与页面 h1 同源） */
  'settings.pageTitle': 'Vsidian Settings',
  /** 设置页「常规」分组标题（#96 general.* 设置项的归属分组） */
  'settings.generalSection': 'General',
  /** 设置页「常规」分组副文案（对齐「编辑器」分组的说明句式） */
  'settings.generalSectionDescription':
    'Adjust basic Vsidian behavior. Changes save automatically.',
  /** 设置项「界面语言」标题（#96 general.language；定义 title 键化由 #95 接管） */
  'setting.language': 'Interface language',
  /** 设置项「界面语言」说明（auto 语义与切换即生效） */
  'setting.languageDescription':
    'The display language for interface text. Auto follows the VS Code display language (Simplified Chinese in Chinese environments, English otherwise); an explicit choice no longer follows it. Changes take effect immediately.',
  /** 语言下拉 auto 档显示名（随当前语言取词；具体语言为静态自名不自译） */
  'setting.languageAuto': 'Auto',
} as const satisfies Record<string, string>

/** 字典键：点分扁平键，以本包为类型基准（编译期检查 t() 取词键） */
export type MessageKey = keyof typeof en
