// 设置定义与读写纯逻辑（#33）：单一事实源，宿主（settingsService）与
// webview（设置页渲染）两端共享，不依赖 vscode / DOM。
//
// 设计决策（工单 #33 + AGENTS.md「插件设置入口」约定）：
// - 存储与 schema 完全归 Vsidian 自有链路：不使用 workspace.getConfiguration，
//   不声明 contributes.configuration——设置项不出现在 VSCode 统一设置中心，
//   界面入口只有扩展自己的设置页。
// - 定义含键、类型、默认值；校验内建于类型（当前仅 boolean，#34「显示源
//   文件行号」同型；number/string 为后续扩展预留）。
// - 生产注册表初始为空：设置页据此渲染空状态，不展示不能生效的占位开关；
//   后续工单接入实际设置项时在 PRODUCTION_SETTING_DEFINITIONS 追加。
// - 值域语义：无效存量（类型不符）恢复默认值；未知键（历史遗留）忽略；
//   补丁应用按批原子——任一键非法整批拒绝，有效值不落地。

/** 协议载荷中的设置值：标量容器（协议层只约束形态，合法性由本模块按定义判定；
 *  放宽数值类型不需要改协议——「整体下发而非逐项布尔」的扩展预留） */
export type SettingsPayloadValue = boolean | number | string

/** 设置快照：键 → 当前生效值 */
export type SettingsPayload = Record<string, SettingsPayloadValue>

/** 单个设置项定义 */
export interface SettingDefinition {
  /** 稳定标识（点分层级，如 'editor.lineNumbers'；不得为空串） */
  key: string
  /** 值类型：校验规则的来源。当前仅 boolean */
  type: 'boolean'
  /** 默认值：缺省与无效存量的回退目标 */
  default: boolean
  /** 设置页展示名（非空语义由渲染层保证） */
  title: string
  /** 可选说明（设置页副文案） */
  description?: string
}

/**
 * #34「显示行号」：实时预览侧 CM6 行号栏开关。键与消费方常量成对导出——
 * webview（syncController 的 Compartment 装配）与宿主（无直接消费，经快照
 * 透传）读同一键，避免字面量漂移。默认开启（首次安装即显示，工单 #34）。
 */
export const SHOW_LINE_NUMBERS_KEY = 'editor.lineNumbers'
export const SHOW_LINE_NUMBERS_DEFAULT = true

/**
 * #79「代码块卡片」总开关：围栏代码块呈现态收起为卡片（隐藏围栏标记、
 * 头部横带 + 语言标签；行号/复制按钮子开关见 #80/#81 的
 * codeblock.lineNumbers / codeblock.copyButton，语法高亮见 #83 的
 * codeblock.highlight）。关闭后回到朴素源码围栏外观。键与消费方
 * （syncController 的 codeCardCompartment）成对导出。
 */
export const CODEBLOCK_CARD_KEY = 'codeblock.card'
export const CODEBLOCK_CARD_DEFAULT = true

/**
 * #80「卡内行号」子开关：卡片内代码行行首的块内行号（每块从 1 起、围栏
 * 行不占号）。依附卡片总开关——卡片关闭时本项无效。
 */
export const CODEBLOCK_LINE_NUMBERS_KEY = 'codeblock.lineNumbers'
export const CODEBLOCK_LINE_NUMBERS_DEFAULT = true

/**
 * 生产设置定义注册表：#33 交付空状态页面与完整数据链路，#34 加入首个
 * 实际设置项「显示行号」（设置页自此渲染真实开关），#79 加入「代码块卡片」，
 * #80 加入「卡内行号」。
 */
export const PRODUCTION_SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: SHOW_LINE_NUMBERS_KEY,
    type: 'boolean',
    default: SHOW_LINE_NUMBERS_DEFAULT,
    title: '显示行号',
    description: '在实时预览左侧留白带内显示源文件行号（阅读模式不显示）。',
  },
  {
    key: CODEBLOCK_CARD_KEY,
    type: 'boolean',
    default: CODEBLOCK_CARD_DEFAULT,
    title: '代码块卡片',
    description: '围栏代码块在光标离开时收起为卡片：隐藏围栏标记，显示语言头部横带。关闭后回到朴素源码围栏外观。',
  },
  {
    key: CODEBLOCK_LINE_NUMBERS_KEY,
    type: 'boolean',
    default: CODEBLOCK_LINE_NUMBERS_DEFAULT,
    title: '卡内行号',
    description: '卡片内代码行行首显示块内行号（每块从 1 起，围栏行不占号）。需开启「代码块卡片」。',
  },
]

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 定义自校验（注册入口防线：非法定义整体拒绝） */
export function isSettingDefinition(v: unknown): v is SettingDefinition {
  return (
    isObject(v) &&
    typeof v.key === 'string' &&
    v.key.length > 0 &&
    v.type === 'boolean' &&
    typeof v.default === 'boolean' &&
    typeof v.title === 'string' &&
    (v.description === undefined || typeof v.description === 'string')
  )
}

/** 值是否符合定义的类型（当前：boolean） */
function valueMatchesType(def: SettingDefinition, value: unknown): boolean {
  if (def.type === 'boolean') {
    return typeof value === 'boolean'
  }
  return false
}

/** 按定义表产出默认值快照 */
export function settingsDefaults(defs: readonly SettingDefinition[]): SettingsPayload {
  const out: SettingsPayload = {}
  for (const def of defs) {
    out[def.key] = def.default
  }
  return out
}

/**
 * 存量清洗：持久化容器读出的任意 JSON → 合法快照。
 * 规则：非对象整体视为空；未知键忽略（历史遗留不进入快照）；类型不符的
 * 值恢复默认；缺失键回填默认。永不抛错、永不部分读取非法字段。
 */
export function sanitizeStoredSettings(
  defs: readonly SettingDefinition[],
  stored: unknown,
): SettingsPayload {
  const out = settingsDefaults(defs)
  if (!isObject(stored)) {
    return out
  }
  for (const def of defs) {
    const value = stored[def.key]
    if (valueMatchesType(def, value)) {
      // valueMatchesType 已按定义类型校验；TS 无法对依赖 def 的谓词收窄
      out[def.key] = value as SettingsPayloadValue
    }
  }
  return out
}

/** 补丁应用结果：ok 时 merged 为合并后的完整快照；拒绝时列出非法键 */
export type ApplySettingsResult =
  | { ok: true; merged: SettingsPayload }
  | { ok: false; rejected: string[] }

/**
 * 补丁应用（保存路径）：patch 中每个键必须已定义且值匹配类型，任一非法
 * 整批拒绝（原子性——半批落地会让「无效值恢复默认」语义漂移为部分生效）。
 * 空补丁合法且幂等。
 */
export function applySettingsPatch(
  defs: readonly SettingDefinition[],
  current: SettingsPayload,
  patch: unknown,
): ApplySettingsResult {
  if (!isObject(patch)) {
    return { ok: false, rejected: [] }
  }
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const rejected: string[] = []
  for (const key of Object.keys(patch)) {
    const def = byKey.get(key)
    if (!def || !valueMatchesType(def, patch[key])) {
      rejected.push(key)
    }
  }
  if (rejected.length > 0) {
    return { ok: false, rejected }
  }
  // 上方已验证 patch 为对象、键全部已定义且值匹配类型（收窄安全）
  return { ok: true, merged: { ...current, ...(patch as SettingsPayload) } }
}
