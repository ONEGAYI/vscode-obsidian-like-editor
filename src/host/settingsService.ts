// 宿主设置服务（#33）：设置定义注册表 + 持久化 + 变更通知的唯一宿主侧入口。
//
// 存储决策（工单 #33 + AGENTS.md「插件设置入口」约定）：context.globalState
// （按用户 profile 持久、跨窗口一致、重启保留，无同步语义）+ 纯代码 schema
// ——不用 workspace.getConfiguration、不声明 contributes.configuration，设置
// 与 VSCode 统一设置中心完全解耦。存储形如 overlay：只记用户显式设置过的
// 键值，默认值永远来自定义表（定义演进时不固化旧默认）。
//
// 本模块不依赖 vscode（SettingsStorage 抽象），可在单测注入假持久层；
// 纯校验逻辑在 shared/settings（单一事实源）。
import {
  applySettingsPatch,
  isSettingDefinition,
  sanitizeStoredSettings,
  settingsDefaults,
  type SettingDefinition,
  type SettingsPayload,
  type SettingsPayloadValue,
} from '../shared/settings'

/** 持久层抽象：vscode 层以 context.globalState 实现（Memento 子集） */
export interface SettingsStorage {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): Thenable<void>
}

/** 变更监听者：保存成功后以新快照调用 */
export type SettingsListener = (values: SettingsPayload) => void

/** 保存结果：ok 时 values 为保存后的完整快照 */
export type SettingsApplyResult =
  | { ok: true; values: SettingsPayload }
  | { ok: false; rejected: string[]; reason: 'invalid' | 'storage' }

/** 运行时定义注册结果 */
export interface AddDefinitionsResult {
  ok: boolean
  error?: string
}

export class SettingsService {
  private readonly defs = new Map<string, SettingDefinition>()
  private readonly listeners = new Set<SettingsListener>()

  constructor(
    private readonly storage: SettingsStorage,
    defs: readonly SettingDefinition[] = [],
    private readonly storageKey = 'vsidian.settings',
  ) {
    // 构造期定义直接信任（编译期类型 + 单一调用点）；运行时注册走
    // addDefinitions 的完整校验
    for (const def of defs) {
      this.defs.set(def.key, def)
    }
  }

  /**
   * 运行时注册定义（#33 集成测试钩子的 fixture 定义经此并入；后续工单
   * 也可用于懒注册场景）。原子：任一定义非法或键已存在则整批拒绝。
   */
  addDefinitions(defs: readonly unknown[]): AddDefinitionsResult {
    for (const candidate of defs) {
      if (!isSettingDefinition(candidate)) {
        return { ok: false, error: `非法定义：${JSON.stringify(candidate)}` }
      }
      if (this.defs.has(candidate.key)) {
        return { ok: false, error: `设置键已存在：${candidate.key}` }
      }
    }
    for (const def of defs as readonly SettingDefinition[]) {
      this.defs.set(def.key, def)
    }
    return { ok: true }
  }

  /** 当前定义表（设置页渲染依据） */
  getDefinitions(): readonly SettingDefinition[] {
    return [...this.defs.values()]
  }

  /** 当前生效快照：默认值 + 存量 overlay 清洗（无效恢复默认、未知忽略） */
  getSnapshot(): SettingsPayload {
    return sanitizeStoredSettings(
      this.getDefinitions(),
      this.storage.get<Record<string, unknown>>(this.storageKey),
    )
  }

  /**
   * 保存补丁（设置页 settings.set / 测试钩子入口）：
   * 1. 纯函数整批校验（未知键、类型不符拒绝——半批落地会让「无效值恢复
   *    默认」漂移为部分生效）
   * 2. overlay 合并后持久化；写失败返回 storage 失败且不通知
   * 3. 成功后以新快照通知全部监听者（宿主层在此接广播到编辑器面板）
   */
  async apply(patch: unknown): Promise<SettingsApplyResult> {
    const current = this.getSnapshot()
    const result = applySettingsPatch(this.getDefinitions(), current, patch)
    if (!result.ok) {
      return { ok: false, rejected: result.rejected, reason: 'invalid' }
    }
    const overlay = {
      ...this.storage.get<Record<string, unknown>>(this.storageKey),
      // applySettingsPatch 已验证 patch 为对象且键全部已定义（收窄安全）
      ...(patch as Record<string, SettingsPayloadValue>),
    }
    try {
      await this.storage.update(this.storageKey, overlay)
    } catch {
      return { ok: false, rejected: [], reason: 'storage' }
    }
    const values = this.getSnapshot()
    for (const listener of this.listeners) {
      listener(values)
    }
    return { ok: true, values }
  }

  /** 订阅变更；返回取消函数 */
  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 默认值快照（辅助：重置语义与文档用） */
  defaults(): SettingsPayload {
    return settingsDefaults(this.getDefinitions())
  }
}
