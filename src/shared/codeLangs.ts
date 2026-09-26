// 代码块语言注册表单一事实源（工单 #78 规格，docs/specs/code-block-card.md）：
// 显示名、别名路由。#79 起供卡片头部语言标签；#83 起语法引擎按 id 路由
// （Lezer 语言包 / legacy-modes）。live 装饰与阅读渲染共用同一注册表。
// 不依赖 vscode / DOM / CM6（node 单测直驱）。
//
// 显示名为 Prism show-language 命名风格（首字母大写，如 Plain text、
// C++）；别名匹配大小写不敏感、取 info string 首词（CommonMark 语言
// 标识语义，```js title=x 按 js 路由）；未识别 info string 不回退任何
// 语言（卡片标签显示 trim 后原文，高亮按纯文本处理）。

export interface CodeLanguageEntry {
  /** 稳定语言 id（= 规范 info string，小写） */
  id: string
  /** 头部标签显示名 */
  displayName: string
  /** 别名（info string 匹配用，小写；不含 id 本身） */
  aliases: readonly string[]
}

/** 注册表语言（17 项 + 独立纯文本条目 text，规格「语言注册表」表；
 *  语法来源 #83 接线） */
export const CODE_LANGUAGES: readonly CodeLanguageEntry[] = [
  { id: 'javascript', displayName: 'JavaScript', aliases: ['js', 'jsx', 'mjs', 'cjs'] },
  { id: 'typescript', displayName: 'TypeScript', aliases: ['ts', 'tsx'] },
  { id: 'json', displayName: 'JSON', aliases: [] },
  { id: 'html', displayName: 'HTML', aliases: ['htm'] },
  { id: 'css', displayName: 'CSS', aliases: [] },
  { id: 'python', displayName: 'Python', aliases: ['py'] },
  { id: 'shell', displayName: 'Shell', aliases: ['sh', 'bash', 'zsh'] },
  { id: 'powershell', displayName: 'PowerShell', aliases: ['ps1', 'pwsh'] },
  { id: 'c', displayName: 'C', aliases: [] },
  { id: 'cpp', displayName: 'C++', aliases: ['cc', 'c++'] },
  { id: 'java', displayName: 'Java', aliases: [] },
  { id: 'go', displayName: 'Go', aliases: ['golang'] },
  { id: 'rust', displayName: 'Rust', aliases: ['rs'] },
  { id: 'sql', displayName: 'SQL', aliases: ['pgsql'] },
  { id: 'yaml', displayName: 'YAML', aliases: ['yml'] },
  { id: 'markdown', displayName: 'Markdown', aliases: ['md'] },
  { id: 'verilog', displayName: 'Verilog', aliases: ['systemverilog', 'sv'] },
]

/** 纯文本语言（无语言标记 / text / plaintext）的注册表内表示 */
export const PLAIN_TEXT_LANGUAGE: CodeLanguageEntry = {
  id: 'text',
  displayName: 'Plain text',
  aliases: ['plaintext', 'txt'],
}

export interface ResolvedCodeLanguage {
  id: string
  displayName: string
}

const ALL_ENTRIES: readonly CodeLanguageEntry[] = [...CODE_LANGUAGES, PLAIN_TEXT_LANGUAGE]

/**
 * info string 首词（CommonMark 语言标识语义）：语言判定只看第一个空白
 * 分隔词（```js title=x → js）；trim 后空串返回 ''。live 与阅读侧共用，
 * 保证多词 info string 两视图同路由。
 */
export function codeInfoFirstWord(info: string): string {
  return /^\S+/.exec(info.trim())?.[0] ?? ''
}

/** info string → 语言条目（首词语义）；空串/text/plaintext → 纯文本；
 *  未识别返回 null */
export function resolveCodeLanguage(info: string): ResolvedCodeLanguage | null {
  const key = codeInfoFirstWord(info).toLowerCase()
  if (key === '') {
    return { id: PLAIN_TEXT_LANGUAGE.id, displayName: PLAIN_TEXT_LANGUAGE.displayName }
  }
  for (const entry of ALL_ENTRIES) {
    if (key === entry.id || entry.aliases.includes(key)) {
      return { id: entry.id, displayName: entry.displayName }
    }
  }
  return null
}
