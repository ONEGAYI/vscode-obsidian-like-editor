// 三态视图编排纯逻辑（工单 #38）：live（实时预览）/ reading（阅读）/
// source（源码编辑器）的循环推导、全局模式记忆读取与切换动作映射。
//
// 本模块不依赖 vscode API：宿主层（textEditorProvider）注入 memento 读取器
// 与执行通道，全部决策可单元测试。
//
// 记忆写入时序（宿主执行层遵守，webview 不感知记忆）：
// - 进入 Vsidian（open-in-vsidian）：必须先把记忆写为目标 mode 再执行
//   openWith —— resolve 阶段的弹回（source）与恢复（reading）都读最新记忆，
//   后写会被弹回或落到错误模式
// - 其余动作：动作成功后写（只在成功切换后持久化）
/** 三态视图模式：live=实时预览面板、reading=阅读面板、source=原生源码编辑器 */
export type TriViewMode = 'live' | 'reading' | 'source'

/** 全局模式记忆键（context.globalState；值 'live' | 'reading' | 'source'，
 *  无历史时不写入、读取缺省 live） */
export const LAST_MODE_KEY = 'onegayi.vsidian.lastMode'

/** 三态循环顺序：live → reading → source → live（命令面板循环命令的推导依据） */
export function nextTriMode(current: TriViewMode): TriViewMode {
  switch (current) {
    case 'live':
      return 'reading'
    case 'reading':
      return 'source'
    case 'source':
      return 'live'
  }
}

/** 读取全局记忆的模式：无历史或非法值容错为 live（首次打开进实时预览）。
 *  入参为 memento 读取器（vscode 层传 globalState.get） */
export function readRememberedMode(get: <T>(key: string) => T | undefined): TriViewMode {
  const value = get<string>(LAST_MODE_KEY)
  return value === 'reading' || value === 'source' ? value : 'live'
}

/** resolveCustomTextEditor 阶段的装配行为（记忆 → 决策）：
 *  - bounce-to-source：priority=default 下 VSCode 把 .md 交给本扩展，记忆为
 *    source 时立即弹回原生编辑器（不装配任何 webview 内容）
 *  - restore-reading：面板就绪后恢复阅读模式（面板自身状态优先，见
 *    decideReadingRestore）
 *  - assemble-live：正常装配（live 或面板自身状态） */
export type ResolveBehavior = 'bounce-to-source' | 'restore-reading' | 'assemble-live'

export function decideResolveBehavior(remembered: TriViewMode): ResolveBehavior {
  switch (remembered) {
    case 'source':
      return 'bounce-to-source'
    case 'reading':
      return 'restore-reading'
    case 'live':
      return 'assemble-live'
  }
}

/** 初始 reading 恢复的优先级决策（持久化优先级契约）：
 *  全新面板 bridge state 为空、默认 live → 下发 reading；面板已自恢复
 *  reading（同面板重载等场景）→ 保持面板实际状态，不重复下发 */
export function decideReadingRestore(
  panelMode: 'live' | 'reading',
): 'send-reading' | 'keep-panel-state' {
  return panelMode === 'reading' ? 'keep-panel-state' : 'send-reading'
}

/** 三态切换动作计划（宿主执行层映射为 openWith / postToPanel） */
export type ViewSwitchPlan =
  /** 从源码编辑器（重新）进入 Vsidian：宿主先写记忆为 mode 再
   *  openWith(uri, VIEW_TYPE)，目标模式经 resolve 恢复链路落到面板 */
  | { kind: 'open-in-vsidian'; mode: 'live' | 'reading' }
  /** 切到原生源码编辑器：openWith(uri, 'default')，成功后写记忆 'source' */
  | { kind: 'open-in-source-editor' }
  /** 面板内切模式：向活动文档的全部 ready 面板发 view.mode.set，成功后写记忆 */
  | { kind: 'switch-panel-mode'; mode: 'live' | 'reading' }
  /** 拒绝：panel-not-ready=无就绪面板（装载中）；no-op=已在源码编辑器 */
  | { kind: 'reject'; reason: 'panel-not-ready' | 'no-op' }

/** 动作映射：当前模式 + 目标模式 → 动作计划。
 *  hasReadyPanel 仅对面板内切换有意义（无就绪面板时拒绝，提示稍后重试） */
export function planViewSwitch(
  current: TriViewMode,
  target: TriViewMode,
  hasReadyPanel: boolean,
): ViewSwitchPlan {
  if (current === 'source') {
    if (target === 'source') {
      return { kind: 'reject', reason: 'no-op' }
    }
    return { kind: 'open-in-vsidian', mode: target }
  }
  if (target === 'source') {
    return { kind: 'open-in-source-editor' }
  }
  if (!hasReadyPanel) {
    return { kind: 'reject', reason: 'panel-not-ready' }
  }
  return { kind: 'switch-panel-mode', mode: target }
}
