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

/** resolveCustomTextEditor 阶段的装配行为（记忆 + diff 防御 → 决策）：
 *  - bounce-to-source：priority=default 下 VSCode 把 .md 交给本扩展，记忆为
 *    source 时立即弹回原生编辑器（不装配任何 webview 内容）；
 *    D10：本 uri 处于任一 diff 标签时跳过弹回、正常装配（openWith 会把
 *    对比折叠成单文件），跳过时不改写记忆
 *  - restore-reading：面板就绪后恢复阅读模式（面板自身状态优先，见
 *    decideReadingRestore）
 *  - assemble-live：正常装配（live 或面板自身状态） */
export type ResolveBehavior = 'bounce-to-source' | 'restore-reading' | 'assemble-live'

export function decideResolveBehavior(
  remembered: TriViewMode,
  uriInDiffContext: boolean,
): ResolveBehavior {
  if (remembered === 'source') {
    return uriInDiffContext ? 'assemble-live' : 'bounce-to-source'
  }
  if (remembered === 'reading') {
    return 'restore-reading'
  }
  return 'assemble-live'
}

/** 初始 reading 恢复的优先级决策（持久化优先级契约）：
 *  全新面板 bridge state 为空、默认 live → 下发 reading；面板已自恢复
 *  reading（同面板重载等场景）→ 保持面板实际状态，不重复下发 */
export function decideReadingRestore(
  panelMode: 'live' | 'reading',
): 'send-reading' | 'keep-panel-state' {
  return panelMode === 'reading' ? 'keep-panel-state' : 'send-reading'
}

// ---- D10 diff 语境防御 ----
// Vsidian 成为 .md 默认编辑器后，diff 上下文（git SCM 点开更改、资源管理器
// 「比较选中」、custom editor 出现在 diff 一侧）是三态切换的雷区：
// 1. diff 上盲目 openWith 会把对比折叠成单文件（或对虚拟 uri 错误动作）；
// 2. custom editor 出现在 diff 一侧时 tab input 对扩展 API 不透明（拿不到
//    original/modified），只能靠 tab label 的 `a ↔ b` 分隔符启发式检测；
// 3. 关闭 dirty 原生文档的 tab 可能导致文档 revert。
// 故 Vsidian 不做 diff 切换支持，做防御性排除：三命令与循环命令在 diff
// 语境拒绝（no-op + 轻提示），resolve 弹回在 diff 语境跳过（diff 完整性
// 优先于模式记忆恢复，跳过时不改写记忆）。

/** tab input 形态归纳（diff 语境检测的输入抽象；宿主层映射 vscode.TabInput*） */
export type TabInputKind = 'text' | 'text-diff' | 'custom' | 'other'

/** diff 标签形态 `a ↔ b` 解析（两侧为文件展示名）；非该形态返回 undefined */
export function parseDiffLabel(label: string): { left: string; right: string } | undefined {
  const sep = ' ↔ '
  const idx = label.indexOf(sep)
  if (idx < 0) {
    return undefined
  }
  const left = label.slice(0, idx).trim()
  const right = label.slice(idx + sep.length).trim()
  if (!left || !right) {
    return undefined
  }
  return { left, right }
}

/** uri 的末段文件名（解码百分号编码，与 tab label 展示名同口径） */
export function uriBaseName(uri: string): string {
  const withoutQuery = uri.split('?')[0]?.split('#')[0] ?? uri
  const last = withoutQuery.split('/').pop() ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** 活动标签 diff 语境判定（三命令/循环命令的前置守卫）：
 *  - 文本 diff input（TabInputTextDiff）直接判定；
 *  - input 不透明（custom editor 在 diff 一侧，API 拿不到 original/modified）
 *    且 label 为 `a ↔ b` 形态：有 contextUri（editor/title 菜单传入的资源）
 *    时须一侧 basename 匹配才判 diff（防标签巧合误伤），无 contextUri
 *    （命令面板入口）时保守判定 */
export function isDiffContext(probe: {
  inputKind: TabInputKind
  label: string
  contextUri?: string
}): boolean {
  if (probe.inputKind === 'text-diff') {
    return true
  }
  if (probe.inputKind !== 'other') {
    return false
  }
  const parsed = parseDiffLabel(probe.label)
  if (!parsed) {
    return false
  }
  if (probe.contextUri === undefined) {
    return true
  }
  const name = uriBaseName(probe.contextUri)
  return name !== '' && (name === parsed.left || name === parsed.right)
}

/** diff 标签摘要（弹回防御的输入；文本 diff 附 original/modified） */
export interface DiffTabInfo {
  inputKind: TabInputKind
  label: string
  original?: string
  modified?: string
}

/** 本 uri 是否出现在任一 diff 标签（resolve 弹回防御）：
 *  文本 diff 按 original/modified 精确匹配；不透明标签按 `a ↔ b` 一侧
 *  basename 匹配本 uri 文件名 */
export function isUriInDiffContext(uri: string, tabs: readonly DiffTabInfo[]): boolean {
  const name = uriBaseName(uri)
  for (const tab of tabs) {
    if (tab.inputKind === 'text-diff') {
      if (tab.original === uri || tab.modified === uri) {
        return true
      }
      continue
    }
    if (tab.inputKind !== 'other') {
      continue
    }
    const parsed = parseDiffLabel(tab.label)
    if (parsed && name !== '' && (name === parsed.left || name === parsed.right)) {
      return true
    }
  }
  return false
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
  /** 拒绝：diff-context=活动标签处于对比视图（D10）；panel-not-ready=无
   *  就绪面板（装载中）；no-op=已在源码编辑器 */
  | { kind: 'reject'; reason: 'diff-context' | 'panel-not-ready' | 'no-op' }

/** 动作映射：当前模式 + 目标模式 → 动作计划。
 *  inDiffContext 为真（D10 活动标签 diff 语境）时任何组合都拒绝；
 *  hasReadyPanel 仅对面板内切换有意义（无就绪面板时拒绝，提示稍后重试） */
export function planViewSwitch(
  current: TriViewMode,
  target: TriViewMode,
  hasReadyPanel: boolean,
  inDiffContext: boolean,
): ViewSwitchPlan {
  if (inDiffContext) {
    return { kind: 'reject', reason: 'diff-context' }
  }
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
