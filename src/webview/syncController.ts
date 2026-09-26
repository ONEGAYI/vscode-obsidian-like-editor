// webview 同步控制器：CM6 EditorView 与宿主消息的桥接（可在 jsdom 下单测）。
//
// 同步模式（依据探索笔记 03 §2/§4/§6）：
// - 本地乐观回显：用户输入立即进入 CM6 状态，同一事务的 changes 以
//   edit.request 发给宿主（不等 ack 即可继续输入）
// - 宿主确认：edit.ack ok 只推进 baseVersion（内容已一致），不重复应用；
//   拒绝时用附带的全文重同步
// - 外部变更：doc.changed 的增量单事务 dispatch（外部注解标记，updateListener
//   对其跳过，防止回发死循环）
// - 撤销/重做：不装 CM6 history 扩展（唯一权威栈在宿主 TextDocument），
//   Mod-Z / Mod-Shift-Z / Mod-Y 经 keymap 转发 history.request，由宿主执行
//   undoRedoService；变更回流走 doc.changed external 路径（无回声）
// - IME 组合缓冲（探索笔记 03 §6 / 05 R1）：组合期间（compositionstart..
//   compositionend）到达的外部增量/全文不直接 dispatch（避免打断组合或破坏
//   组合 DOM），缓冲到组合结束后按最新版本对账；缓冲期间 baseVersion 不
//   推进——组合产生的 edit.request 携带组合前版本，由宿主重定位；
//   flush 时外部增量坐标映射穿过组合编辑（CM6 ChangeSet），区间重叠无法
//   安全映射时进入冲突暂停（#4：保留本地输入并上报，不再全文覆盖丢字）
// - 未确认变更集（#4）：本地乐观编辑发出后未收 ack 前，外部增量必须经
//   mapSerGroupThroughCm 平移穿过未确认集再应用（否则静默错位）；区间
//   重叠无法安全映射 → 冲突暂停
// - 冲突暂停（#4）：ok:false ack（conflict/error）且本地有未确认输入时保留
//   本地文本（不重置）、上报 conflict.report 快照、显示横幅、暂停写回
//   （不再发送 edit.request、忽略 doc.changed）；doc.resync 兼作恢复信号
// - seq 持久化：经 bridge.setState 保存，webview 重载（retainContextWhenHidden
//   关闭导致的状态重建）后继续编号，宿主按 seq 幂等去重
import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, Prec, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { planFormatOperation } from './formatOperations'
import { createQuickActionStateReader } from './quickActionState'
import { FORMAT_OPERATIONS, type FormatOperationId } from '../shared/formatOperations'
import { getEffectiveBindings } from '../shared/keybindings'
import { KeybindingRouter } from './keybindingRouter'
import { liveLineNumbers, paintedLineNumbers } from './liveLineNumbers'
import { CODE_CARD_CLASS_NAMES, codeCardConfigFacet, codeCardCopyRequest, codeCardFoldField, liveCodeCard, type CodeCardConfig } from './liveCodeCard'
import { decorateReadingCodeCard, isReadingCodeBlock } from './readingCodeCard'
import {
  isHostToWebview,
  type CssProbeReport,
  type FindSessionProbe,
  type LineGutterProbe,
  type LiveSyntaxProbe,
  type OutlineProbe,
  type PaintProbe,
  type ReadingSyntaxProbe,
  type SerChange,
  type SidebarProbe,
  type TypographyInheritSample,
  type TypographyProbe,
  type TypographySample,
  type WebviewToHost,
} from '../shared/protocol'
import {
  CODEBLOCK_CARD_DEFAULT,
  CODEBLOCK_CARD_KEY,
  CODEBLOCK_COPY_BUTTON_DEFAULT,
  CODEBLOCK_COPY_BUTTON_KEY,
  CODEBLOCK_HIGHLIGHT_DEFAULT,
  CODEBLOCK_HIGHLIGHT_KEY,
  CODEBLOCK_LINE_NUMBERS_DEFAULT,
  CODEBLOCK_LINE_NUMBERS_KEY,
  SHOW_LINE_NUMBERS_DEFAULT,
  SHOW_LINE_NUMBERS_KEY,
  type SettingsPayload,
} from '../shared/settings'
import {
  FIND_CLASS_NAMES,
  computeFindMatches,
  findDecorations,
  matchIndexFrom,
  setFindMatches,
  type FindMatch,
} from './findSession'
import { liveDecorationsField, livePreviewDecorations, LIVE_CLASS_NAMES, tableCompositionSettled } from './liveDecorations'
import { createLinkInteractions, WIKILINK_CLASS_NAMES } from './liveLinks'
import { liveMath } from './liveMath'
import { MATH_CLASS_NAMES } from '../shared/math'
import { liveMermaid } from './liveMermaid'
import { renderMermaidIn, setMermaidDarkTheme } from './mermaidRender'
import { MERMAID_CLASS_NAMES, MERMAID_STATE_ATTR } from '../shared/mermaid'
import { ImageResourceManager } from './imageResource'
import { runPerfProbe } from './perfProbe'
import { runReadingPerfProbe } from './readingProbe'
import { createReadingContainer, prepareReadingImages } from './readingView'
import { READING_MARKDOWN_CLASS_NAMES } from './readingMarkdown'
import {
  applyOutlineSliderState,
  buildOutlineDom,
  buildOutlineSlider,
  buildOutlineToolbar,
  extractOutline,
  OUTLINE_CLASS_NAMES,
  type OutlineItem,
  type OutlineSliderDom,
  type OutlineToolbarDom,
  outlineItemsEqual,
  outlineSliderLevelAt,
  renderOutlineItems,
} from './outline'
import {
  migrateOutlineExpanded,
  normalizeOutlineExpandLevel,
  OUTLINE_EXPAND_LEVEL_DEFAULT,
  outlineCollapseFacts,
  type OutlineCollapseFacts,
  outlineExpandAncestors,
  outlineExpandLevelLabel,
  outlineExpandSetForLevel,
  outlineHiddenFlags,
  outlineRepresentativeIndex,
  outlineVisibleIndices,
} from './outlineCollapse'
import {
  outlineFilteredVisibleIndices,
  outlineSearchExpandSet,
  outlineSearchFilter,
  type OutlineSearchFilter,
  outlineSearchRepresentativeIndex,
} from './outlineSearch'
import {
  buildOutlineMenu,
  type OutlineMenuCommand,
  OUTLINE_MENU_CLASS_NAMES,
  outlineMenuPosition,
  outlineMenuSpec,
  outlineStructuralExpand,
} from './outlineMenu'
import {
  outlineChangesOrdered,
  outlineCopyText,
  outlineDeleteChange,
  outlineLevelChanges,
  outlineRenameChange,
} from './outlineSection'
import {
  outlineDropAllowed,
  outlineDropPositionAt,
  outlineMovePlan,
  type OutlineDropPosition,
} from './outlineDrag'
import { locateOutlineIndex } from './outlineLocate'
import { resolveStaleTaskToggle } from './taskToggle'
import { VirtualReadingView } from './readingVirtualView'
import { blankRowInputPlan, runCreateTable, runTableEdit, tableEditing, tableRowsAt } from './tableEditing'
import { selectTableRegion, tableRegionField } from './tableRegionSelection'
import { planTableRegionReplace, type TableRegion } from './tableRegion'
import { splitTableRowCells } from './tableCells'

/** rAF 不可用环境（旧 jsdom）退化为短超时（与 readingVirtualView 同款） */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => fn())
  } else {
    setTimeout(fn, 16)
  }
}

/** #66 高亮重算去抖（ms）：滚动事件驱动，轻于 250ms 数据刷新链路（只做
 *  定位纯函数 + 一次类切换，不解析文档） */
const OUTLINE_HIGHLIGHT_DEBOUNCE_MS = 100

/** #66 防抖动护栏超时（ms）：跳转程序性滚动后一直无滚动事件到达时的
 *  兜底释放（正常路径由首个滚动事件释放） */
const OUTLINE_JUMP_GUARD_MS = 1000


/** webview 与宿主的通信通道（由 acquireVsCodeApi 适配） */
export interface VsCodeBridge {
  postMessage(message: unknown): void
  getState<T>(): T | undefined
  setState(state: unknown): void
}

/** 视图模式（#6）：live=实时预览（CM6 编辑），reading=阅读（只读渲染） */
export type ViewMode = 'live' | 'reading'

/** webview 持久化状态（retainContextWhenHidden 关闭时重载恢复） */
interface PersistedState {
  seq?: number
  viewMode?: ViewMode
  /** 最近一次模式锚点（UTF-16 offset）：live=光标主位，reading=锚点块 start */
  anchor?: number
  conflictRevision?: number
  /** #53 右侧栏展开态（缺省收起） */
  sidebarOpen?: boolean
  /** #54 大纲面板 active 态（缺省激活：展开侧栏即见大纲，当前唯一面板） */
  outlineActive?: boolean
  /** #67 大纲展开档位（0=No-Expand、1–5=展开到 H1–H5；缺省 5=全展开。
   *  全局记忆（跨文档共享），与 sidebarOpen 同机制；手动折叠集合是
   *  会话内内存态，不持久化（重载回到档位精确展开集） */
  outlineExpandLevel?: number
  quickActionsOpen?: boolean
}

/** 外部同步事务标记：updateListener 见到它即跳过（不回发）。
 *  性能探针（#5）复用同一注解——探针编辑走渲染路径但不写回宿主 */
export const externalSync = Annotation.define<boolean>()

/** ChangeSet 展开的段表（定义域系坐标）：fromA/toA 为定义域区间，insLen 插入长度 */
interface ChainSection {
  fromA: number
  toA: number
  insLen: number
}

function chainSections(cs: ChangeSet): ChainSection[] {
  const out: ChainSection[] = []
  cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ fromA, toA, insLen: inserted.length })
  })
  return out
}

/**
 * 本地系坐标逆穿段表回定义域（baseVersion）系（C-2 出站方向）。
 * 插入/替换内容内部塌缩到段起点。调用方须先暂缓与插入内容相交的
 * 出站编辑；协议 offset/length 无法表达其内部位置或同点关联侧。
 */
function localPosToBase(p: number, sections: readonly ChainSection[]): number {
  let delta = 0
  for (const s of sections) {
    const afterStart = s.fromA + delta
    const afterEnd = afterStart + s.insLen
    if (p <= afterStart) {
      return p - delta
    }
    if (p >= afterEnd) {
      delta += s.insLen - (s.toA - s.fromA)
      continue
    }
    return s.fromA
  }
  return p - delta
}

/** 新编辑触及未确认变更的插入内容或纯删除塌缩点时，无法安全逆投影。
 *  纯删除虽无插入内容，紧接着在原位置补字（IME 替换选区的常见顺序）
 *  仍依赖前笔删除；若立即发旧基线坐标，宿主会与自己的删除判为冲突。 */
function touchesUnconfirmedChange(
  changes: readonly SerChange[],
  sections: readonly ChainSection[],
): boolean {
  let delta = 0
  for (const s of sections) {
    const afterStart = s.fromA + delta
    const afterEnd = afterStart + s.insLen
    if (changes.some((c) => {
      if (s.insLen > 0) {
        return c.length === 0
          ? c.offset >= afterStart && c.offset <= afterEnd
          : c.offset < afterEnd && c.offset + c.length > afterStart
      }
      return s.fromA < s.toA && (c.length === 0
        ? c.offset === afterStart
        : c.offset <= afterStart && c.offset + c.length > afterStart)
    })) {
      return true
    }
    delta += s.insLen - (s.toA - s.fromA)
  }
  return false
}

/** 逆穿已确认链后的变更：端点携带关联语义（正穿未确认集时保持前后次序） */
interface UnmappedChange extends SerChange {
  fromAssoc: 1 | -1
  toAssoc: 1 | -1
}

/**
 * 把一组「权威系（已含已确认事务）」增量逆平移回 unconfirmed 定义域
 * （baseVersion）系（C-2 入站方向）：外部增量坐标已含已确认编辑，
 * 直接穿未确认集会多平移已确认部分。端点落在已确认段的插入内容
 * 严格内部、或纯删除段的塌缩点上时归属二义，返回 null（冲突暂停）。
 */
function unmapSerGroupThroughAcked(
  changes: readonly SerChange[],
  chain: ChangeSet,
): UnmappedChange[] | null {
  const sections = chainSections(chain)
  const unmapPos = (p: number): { pos: number; assoc: 1 | -1 } | null => {
    let delta = 0
    for (const s of sections) {
      const afterStart = s.fromA + delta
      const afterEnd = afterStart + s.insLen
      if (s.insLen === 0 && p === afterStart) {
        return null // 纯删除段塌缩点：原被删区间内归属二义
      }
      if (p < afterStart) {
        return { pos: p - delta, assoc: -1 }
      }
      if (p === afterStart) {
        return { pos: s.fromA, assoc: -1 }
      }
      if (p === afterEnd) {
        delta += s.insLen - (s.toA - s.fromA)
        return { pos: p - delta, assoc: 1 }
      }
      if (p > afterEnd) {
        delta += s.insLen - (s.toA - s.fromA)
        continue
      }
      return null // 已确认段插入内容严格内部：与已确认内容冲突
    }
    return { pos: p - delta, assoc: -1 }
  }
  const out: UnmappedChange[] = []
  for (const c of changes) {
    const from = unmapPos(c.offset)
    const to = unmapPos(c.offset + c.length)
    if (!from || !to || from.pos > to.pos) {
      return null
    }
    out.push({
      offset: from.pos,
      length: to.pos - from.pos,
      text: c.text,
      fromAssoc: from.assoc,
      toAssoc: to.assoc,
    })
  }
  return out
}

/**
 * 把一组外部增量（坐标基于缓冲开始前的文档）映射穿过缓冲挂起期间累积的
 * 本地变更（通常为组合上屏事务）。真重叠（区间相交、同点双插入或区间
 * 跨过插入点——归属/顺序二义）返回 null，保守交由冲突暂停处理；
 * 端点仅相邻时按关联语义平移（C-3：CM6 touchesRange 对相邻也返回 true，
 * 不能直接用它判定冲突）。
 */
function mapSerGroupThroughCm(
  changes: readonly (SerChange & Partial<UnmappedChange>)[],
  local: ChangeSet,
): SerChange[] | null {
  const out: SerChange[] = []
  for (const c of changes) {
    const from = c.offset
    const to = c.offset + c.length
    if (conflictsWithLocal(from, to, c.fromAssoc ?? -1, local)) {
      return null
    }
    const mappedFrom = local.mapPos(from, c.fromAssoc ?? -1)
    const mappedTo = local.mapPos(to, c.toAssoc ?? 1)
    out.push({ offset: mappedFrom, length: mappedTo - mappedFrom, text: c.text })
  }
  return out
}

/** 外部区间与本地变更段是否真重叠（C-3）。
 *  fromAssoc=1 表示外部插入点语义在段插入内容之后（顺序已由逆穿确定），
 *  同点不再视为顺序二义；默认 -1（无上下文）时同点双插入仍判冲突。 */
function conflictsWithLocal(
  from: number,
  to: number,
  fromAssoc: 1 | -1,
  local: ChangeSet,
): boolean {
  let conflict = false
  local.iterChanges((fromA, toA) => {
    if (fromA === toA) {
      if (from === to) {
        if (from === fromA && fromAssoc !== 1) {
          conflict = true // 同点双插入且顺序未定：二义
        }
      } else if (from < fromA && to > fromA) {
        conflict = true // 外部区间跨过插入点：本地插入内容归属二义
      }
    } else if (from < toA && to > fromA) {
      conflict = true // 标准区间相交（端点相邻不算）
    }
  })
  return conflict
}

interface BufferedIncremental {
  version: number
  /** 增量（权威变更前系；入队时点的参考系） */
  changes: SerChange[]
  /** 入队时逆穿当时已确认链得到的 baseVersion 系增量；null = 与当时已确认
   *  编辑二义，无法安全逆映射（flush 时按冲突暂停处理）。
   *  为何入队即逆穿：组合编辑的 ack 可能在 flush 之前到达并复合进已确认链，
   *  届时缓冲增量的参考系（不含组合编辑）与已确认链（含）不再一致，迟到
   *  的逆穿会多平移组合编辑部分（#12 表格 IME 场景实测暴露） */
  baseChanges: SerChange[] | null
}

export class WebviewSyncController {
  private view: EditorView | undefined
  private sessionId = ''
  private docUri = ''
  private baseVersion = 0
  private seq: number
  private extraExtensions: Extension[] = []

  // ---- 视图模式状态（#6）----
  /** 当前模式：不写 TextDocument、不入撤销栈，切换只 dispatch 选区/effects */
  private viewMode: ViewMode
  /** 最近模式锚点：live=光标主位；reading=锚点块 src-start（源码位置锚点） */
  private modeAnchor: number | null
  /** live 容器（稳定类名 vsidian-view-live，内含 CM6 编辑器） */
  private liveWrapper: HTMLElement | undefined
  /** 阅读容器（稳定类名 vsidian-view-reading，块级源锚点结构） */
  private readingContainer: HTMLElement | undefined
  /** 阅读视图虚拟化控制器（#7：接管阅读容器的按需挂载/回收/锚点定位） */
  private readingView: VirtualReadingView | undefined
  /** 图片资源管理器（#10：双视图共用；经宿主通道解析工作区图源） */
  private images: ImageResourceManager | undefined
  private toolbar: HTMLElement | undefined
  private quickActionsEl: HTMLElement | undefined
  private quickToggleBtn: HTMLButtonElement | undefined
  private quickHeadingBtn: HTMLButtonElement | undefined
  private quickHeadingMenu: HTMLElement | undefined
  private quickActionsOpen: boolean
  private quickBindingHints: (op: FormatOperationId) => readonly string[] = () => []

  // ---- 右侧栏布局状态（#53）----
  /** 水平布局根（稳定类名 vsidian-body）：主编辑区 + 右侧栏 */
  private bodyEl: HTMLElement | undefined
  /** 主编辑区（稳定类名 vsidian-main）：顶栏 + 横幅 + live/reading 容器 */
  private mainEl: HTMLElement | undefined
  /** 右侧栏（稳定类名 vsidian-sidebar）：自有顶栏 + 面板容器（#54 接入内容） */
  private sidebarEl: HTMLElement | undefined
  /** 主编辑区顶栏的侧栏切换按钮（可访问名称随状态变化） */
  private sidebarToggleBtn: HTMLButtonElement | undefined
  /** 侧栏是纯 webview 视图状态（与 viewMode 同类）：切换零写回、
   *  不入撤销栈、不触发出站消息；经 bridge state 持久化（重载恢复） */
  private sidebarOpen: boolean

  // ---- 大纲面板状态（#54）----
  /** 大纲面板 active：与 sidebarOpen 同类的纯视图状态（零写回、零出站、
   *  bridge state 持久化）；面板显隐唯一开关是侧栏容器的 outline-active 类 */
  private outlineActive: boolean
  /** 侧栏顶栏的大纲按钮（可访问名称恒「大纲」，aria-expanded 随 active） */
  private outlineToggleBtn: HTMLButtonElement | undefined
  /** 大纲面板容器（条目内容经 renderOutlineItems 维护） */
  private outlinePanelEl: HTMLElement | undefined
  /** 当前大纲数据（级别 + 文字 + 起始行；序列变化才重建条目 DOM） */
  private outlineItems: OutlineItem[] = []
  /** 大纲计算时的文档快照（Text 不可变，引用比较即版本失效判定） */
  private outlineDoc: Text | null = null
  /** 可见时的大纲去抖刷新句柄（250ms 尾随去抖：定时器随每次调用重置，
   *  连续输入只在停顿 250ms 后解析一次——节流（定时器不重置）会让连续
   *  输入每 250ms 解析一次，不是注释声称的语义） */
  private outlineTimer: ReturnType<typeof setTimeout> | undefined
  /** #66 当前控制域条目索引（视口顶部行向上最近标题；null = 无标题、
   *  首标题之前或无布局环境） */
  private outlineLocatedIndex: number | null = null
  /** 滚动驱动的高亮重算去抖句柄（100ms 尾随：只做定位 + 类切换，轻于
   *  250ms 的数据解析链路） */
  private outlineHighlightTimer: ReturnType<typeof setTimeout> | undefined
  /** #66 防抖动护栏挂起中（跳转程序性滚动期间，滚动联动被吞） */
  private outlineJumpGuarded = false
  /** 护栏超时释放句柄（首个滚动事件先到则取消） */
  private outlineJumpGuardTimer: ReturnType<typeof setTimeout> | undefined

  // ---- 大纲折叠状态（#67）----
  /** 展开档位（0=No-Expand、1–5=展开到 Hn；bridge state 全局记忆） */
  private outlineExpandLevel: number
  /** 展开集合（父节点索引集合）：折叠状态唯一载体——档位切换整体替换、
   *  手动折叠/展开增删单键、滚动 only-expand 并入祖先链、编辑重建迁移 */
  private outlineExpanded: ReadonlySet<number> = new Set()
  /** 父子结构缓存（随 outlineItems 更新；箭头渲染与折叠推导消费） */
  private outlineFacts: OutlineCollapseFacts = { parents: [], hasChildren: [] }
  /** 折叠滑块 DOM（row + 六圆点；档位变化经 applyOutlineSliderState 落类） */
  private outlineSlider: OutlineSliderDom | undefined
  /** 上次高亮滚动落点（代表索引）：同索引不重复滚（用户手动滚面板不打扰） */
  private outlineLastScrolledRep: number | null = null

  // ---- 大纲工具条与标题搜索（#68）----
  /** 工具条 DOM（跳末按钮 + 重置按钮 + 搜索输入框；行为装配在本类） */
  private outlineToolbar: OutlineToolbarDom | undefined
  /** 当前搜索词（工具条输入框实值；空串 = 无过滤。输入即时生效无去抖
   *  ——标题序列量级小，QO 同款按键即时重算口径） */
  private outlineSearchQuery = ''
  /** 进入搜索前的展开集快照（空→非空时机取、清空时原样回放；编辑重建
   *  时随展开集同款迁移；搜索态切档时基准同步为档位精确集） */
  private outlineExpandedBeforeSearch: ReadonlySet<number> | null = null
  /** 搜索过滤缓存（kept/ranges/matchedIndices/noMatch；null = 无搜索态）。
   *  序列重建与词条变化时经 applyOutlineSearch 重算 */
  private outlineSearchState: OutlineSearchFilter | null = null

  // ---- 大纲右键菜单与重命名状态（#69）----
  /** 当前打开的菜单容器（挂侧栏内 absolute；undefined = 未打开） */
  private outlineMenuEl: HTMLElement | undefined
  /** 菜单目标条目索引（items 下标；菜单打开期间的命令分派对象） */
  private outlineMenuIndex: number | null = null
  /** 菜单打开期间菜单数据对应的文档快照（命令执行时 doc 已变则放弃——锚点过期防御） */
  private outlineMenuDoc: Text | null = null
  /** 菜单外点关闭监听（document capture pointerdown；close 时摘除） */
  private outlineMenuDismissPointer: ((e: PointerEvent) => void) | undefined
  /** 菜单 Esc 关闭监听（document capture keydown；close 时摘除） */
  private outlineMenuDismissKey: ((e: KeyboardEvent) => void) | undefined
  /** 重命名编辑态的条目索引（null = 无编辑态；条目内容区被 input 替换） */
  private outlineRenameIndex: number | null = null
  /** 重命名打开时的 doc 快照（review-loops C1：提交前锚点防御——外部改写
   *  使行号过期时放弃提交，与菜单/拖拽同口径，防错误行静默替换） */
  private outlineRenameDoc: Text | null = null
  /** #70 拖拽会话态：条目 pointerdown 时记录（源索引 + doc 锚点快照），
   *  超阈值 pointermove 进入拖拽态（moved）并计算落点；pointerup 执行
   *  移动计划写回。null = 无拖拽 */
  private outlineDragState: {
    fromIndex: number
    /** 起始文档快照（终局写回前要求当前 doc 与它内容等价；条目坐标的
     *  派生来源须等价于它，见 onOutlineDragEnd 的条目坐标防线） */
    doc: Text
    /** 起始指针 id（review-loops 第 2 轮：会话只由该指针的移动/释放驱动，
     *  多指针与「窗口外按下后拖入」的异指针事件既不推进也不收尾） */
    pointerId: number
    startX: number
    startY: number
    moved: boolean
    targetIndex: number | null
    position: OutlineDropPosition | null
    /** 当前带落点指示的条目（review-loops C4：增量清除，null = 无指示） */
    hintEl: HTMLElement | null
  } | null = null
  /** #70 拖拽收尾后吞一次面板 click（位移超阈值的拖拽后补发 click 不触发跳转） */
  private outlineSuppressClick = false

  // ---- 查找会话状态（#14）----
  /** 查找是纯只读视图状态：不写 TextDocument、不入撤销栈、零出站消息。
   *  匹配基于 webview 全文文本模型（CM6 doc），屏外内容同样命中 */
  private findPanel: HTMLElement | undefined
  private findInputEl: HTMLInputElement | undefined
  private findCountEl: HTMLElement | undefined
  private findOpen = false
  /** 首次打开后置位：view.state 从此回报 find 观测（含关闭态 open:false） */
  private findTouched = false
  private findQuery = ''
  /** 大小写语义固定：默认区分；UI 切换后全程保持所选语义 */
  private findCaseSensitive = true
  private findMatches: FindMatch[] = []
  /** 0 基当前序号（无匹配时无意义） */
  private findIndex = 0
  /** 匹配计算时的文档快照（Text 不可变，引用比较即版本失效判定） */
  private findDoc: Text | null = null
  /** document 级键盘拦截（Mod-F 打开 / Esc 关闭），dispose 时移除 */
  private docKeydown: ((e: KeyboardEvent) => void) | undefined
  private readonly keybindingRouter: KeybindingRouter
  private readonly cancelKeybindingOnBlur = () => this.keybindingRouter.cancel()

  // ---- 设置状态（#33）----
  /** 宿主下发的当前设置快照缓存（#34 行号等设置的消费源）；webview 不
   *  持久化设置——每次装载（init）后经 settings.get 向宿主拉取 */
  private settings: SettingsPayload | undefined

  // ---- 行号栏状态（#34）----
  /** 行号开关生效态：mount 时按定义默认装配（默认开），设置快照/变更
   *  到达后经 Compartment 热重配——不重建 EditorView */
  private lineNumbersOn = SHOW_LINE_NUMBERS_DEFAULT
  /** 行号扩展的运行时开关通道（extensions 装配点） */
  private readonly lineNumbersCompartment = new Compartment()

  // ---- 代码块卡片状态（#79）----
  /** 卡片配置生效态（card/lineNumbers/copyButton/highlight；lineNumbers
   *  与 copyButton 子项 #80/#81 接线，highlight #83——未接线键暂按默认开）；
   *  设置快照/变更到达后经 Compartment 热重配 facet，不重建 EditorView */
  private codeCardConfig: CodeCardConfig = {
    card: CODEBLOCK_CARD_DEFAULT,
    lineNumbers: true,
    copyButton: true,
    highlight: true,
  }
  /** 卡片扩展的运行时配置通道（extensions 装配点） */
  private readonly codeCardCompartment = new Compartment()

  /** #84 阅读侧折叠集合：键 = 块 data-vsidian-src-start（视图态，不持久化；
   *  块卸载重挂载后经此恢复收起形态） */
  private readonly readingCodeFold = new Set<number>()

  // ---- 宿主主题明暗自适应（不硬编码 dark，也不硬编码颜色）----
  /** CM6 明暗声明通道：跟随 webview body 的主题 class（vscode-dark 等），
   *  激活 baseTheme 内建变体（light: caret black / dark: caret white 等），
   *  本扩展不写任何光标/选区颜色 */
  private readonly darkCompartment = new Compartment()
  /** 上次应用值（跳过等值 reconfigure；undefined = 尚未应用过） */
  private hostDarkApplied: boolean | undefined
  /** body 主题 class 观察者：宿主切换明暗主题时热跟随 */
  private hostThemeObserver: MutationObserver | undefined

  // ---- 冲突暂停状态（#4）----
  /** 暂停写回：保留本地文本、忽略外部增量、不再发送 edit.request */
  private suspended = false
  private conflictRevision = 0
  /** 发出后未收 ok ack 的请求 seq 集合（全部确认后未确认集清空） */
  private inFlight = new Set<number>()
  /** 未确认变更集：本地文档相对 baseVersion 权威文本的累积变更；
   *  外部增量到达时必须平移穿过它（否则静默错位） */
  private unconfirmed: ChangeSet | null = null
  /** 已发出未确认事务（FIFO）：坐标为发出时逆穿未确认集的 baseVersion 系
   *  投影（C-2），ack ok 后按序剥离复合进已确认链 */
  private sentTxns: { seq: number; changes: SerChange[] }[] = []
  /** 首笔无法安全逆投影的事务起，后续本地事务合并在同一待发 ChangeSet。
   *  定义域是所有已发送事务之后的本地文档，全部 ack 后可直接作为新请求。 */
  private deferredLocal: ChangeSet | null = null
  /** 已确认事务复合（定义域 = unconfirmed 定义域 = baseVersion 系）：
   *  外部增量（权威系坐标）先逆穿它平移回 base 系再穿未确认集（C-2），
   *  避免把「已含已确认编辑」的坐标当 base 系多平移 */
  private ackedChain: ChangeSet | null = null
  private banner: HTMLElement | undefined

  // ---- IME 组合缓冲状态 ----
  /** 组合进行中（DOM compositionstart..compositionend） */
  private composing = false
  /** 空白格或矩形区域的组合暂缓：宿主只接收结束后的净变更。 */
  private blankComposition: { startState: EditorState; changes: ChangeSet | null; region?: TableRegion } | null = null
  private compositionCommittedText: string | null = null
  /** 组合期间到达、待 flush 的外部增量（按到达序） */
  private pendingExternal: BufferedIncremental[] = []
  /** 组合期间到达、待 flush 的全文消息（覆盖增量形态）。source 记录来源
   *  （B-1）：resync 对暂停面板兼作恢复信号，flush 的暂停分支据此解除暂停；
   *  ack 失败附文与 init 只重置文本、不解除暂停 */
  private pendingFull:
    | { version: number; text: string; source: 'resync' | 'init' | 'ack-fail' }
    | undefined
  /** 缓冲挂起期间收到的 ack 版本（flush 时与缓冲版本取 max） */
  private pendingVersionAck: number | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  /** 最近一次接受的 doc.changed 版本（C-4 单调防线：重复/迟到广播直接
   *  丢弃，覆盖直发与组合排队两条路径，防止同版本增量重复应用） */
  private lastDocChangedVersion = 0

  constructor(private readonly bridge: VsCodeBridge) {
    this.keybindingRouter = new KeybindingRouter({}, (id) => {
      if (id === 'find') this.openFind()
      else if (id === 'findNext') this.findStep('next')
      else if (id === 'findPrevious') this.findStep('prev')
      else this.bridge.postMessage({ kind: 'keybindings.execute', id })
    })
    const saved = bridge.getState<PersistedState>()
    this.seq = typeof saved?.seq === 'number' && saved.seq >= 0 ? Math.floor(saved.seq) : 0
    this.conflictRevision = typeof saved?.conflictRevision === 'number' && saved.conflictRevision >= 0
      ? Math.floor(saved.conflictRevision) : 0
    this.viewMode = saved?.viewMode === 'reading' ? 'reading' : 'live'
    this.modeAnchor = typeof saved?.anchor === 'number' && saved.anchor >= 0 ? Math.floor(saved.anchor) : null
    this.sidebarOpen = saved?.sidebarOpen === true
    this.outlineActive = saved?.outlineActive !== false
    this.outlineExpandLevel = normalizeOutlineExpandLevel(saved?.outlineExpandLevel)
    this.quickActionsOpen = saved?.quickActionsOpen === true
  }

  /** 创建编辑器视图并向宿主发送 ready（HTML 加载完成后调用一次） */
  mount(parent: HTMLElement, extraExtensions: Extension[] = []): void {
    if (this.view) {
      return
    }
    this.extraExtensions = extraExtensions
    this.toolbar = this.buildToolbar()
    this.quickActionsEl = this.buildQuickActions()
    this.banner = this.buildBanner()
    this.findPanel = this.buildFindPanel()
    this.liveWrapper = document.createElement('div')
    this.liveWrapper.className = 'vsidian-view-live'
    this.readingContainer = createReadingContainer()
    this.readingContainer.tabIndex = 0
    this.readingContainer.style.display = 'none'
    this.images = new ImageResourceManager({
      // http/https 图源直连（可加载性由 webview CSP 决定），其余经宿主解析
      isDirectSrc: (src) => /^https?:\/\//i.test(src),
      requestHost: (src, reqId) => {
        if (!this.sessionId) {
          return // init 前不可能有槽位；防御
        }
        this.bridge.postMessage({
          kind: 'image.request',
          sessionId: this.sessionId,
          docUri: this.docUri,
          reqId,
          src,
        })
      },
    })
    this.readingView = new VirtualReadingView(this.readingContainer, {
      // #10 图片生命周期：块挂载预备装载，卸载释放（src 清空、条目回收）
      // #60 Mermaid：挂载即渲染 pending 容器（DOM 随块卸载 el.remove 释放）
      onBlockMounted: (el) => {
        if (this.images) {
          prepareReadingImages(el, this.images)
        }
        renderMermaidIn(el)
        // #84 阅读代码块卡片：挂载即增强（幂等；mermaid 块类不同不命中）
        this.decorateReadingCodeCardBlock(el)
      },
      onBlockUnmounted: (el) => this.images?.detachWithin(el),
    })
    // 阅读滚动更新锚点（用户滚动即改变"当前位置"语义；短文档滚不动时
    // 锚点保持进入/定位时的值——视口读取无法表达目标，modeAnchor 是权威）。
    // 同一事件驱动 #7 的窗口重算（rAF 合帧）与 #66 的大纲高亮联动
    this.readingContainer.addEventListener('scroll', () => {
      const container = this.readingContainer
      const view = this.readingView
      // 只有真实可滚动（内容超出视口）时才以视口顶块更新锚点：短文档
      // 滚不动，视口读数（首块）无法表达定位目标，保留定位写入的权威锚点
      if (container && view && container.scrollHeight > container.clientHeight + 1) {
        const anchor = view.currentAnchor()
        if (anchor !== null) {
          this.modeAnchor = anchor
        }
      }
      view?.handleScroll()
      this.onOutlineScrollSignal()
    })
    // 任务勾选（#9）：阅读模式除任务勾选外只读——checkbox 点击经容器事件
    // 委托处理（虚拟化下元素按需创建/回收，不做逐元素监听）。
    // 点击意图取渲染态锚点（data-vsidian-checked），不受浏览器原生 checkbox
    // 激活时序影响；校验失败（过期锚点）即放弃，保持视图一致
    this.readingContainer.addEventListener('click', (event) => {
      const target = event.target
      if (this.isTaskCheckbox(target)) {
        event.preventDefault() // 取消原生翻转：勾选态由文档驱动重渲染
        this.toggleReadingTask(target)
      }
    })
    this.readingContainer.addEventListener('keydown', (event) => {
      // Enter 在 checkbox 上无原生激活，手动触发；空格依赖原生 click
      const target = event.target
      if (event.key === 'Enter' && this.isTaskCheckbox(target)) {
        event.preventDefault()
        this.toggleReadingTask(target)
      }
    })
    // 阅读链接单击 = 跳转意图上报（#10：执行归宿主；preventDefault 阻断
    // webview 原生导航——相对路径在本 origin 下必然失败且产生控制台噪声）。
    // #11：a.vsidian-wikilink 走双链意图（按名/路径解析），其余走 URI 意图
    this.readingContainer.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      const anchor = target?.closest?.('a')
      if (!anchor || !this.readingContainer!.contains(anchor)) {
        return
      }
      event.preventDefault()
      const href = anchor.getAttribute('href')
      if (href === null) {
        return // 渲染层已净化的危险链接（无 href）
      }
      const block = anchor.closest<HTMLElement>('[data-vsidian-src-start]')
      const srcStart = Number(block?.dataset['vsidianSrcStart'] ?? 0)
      const srcEnd = Number(block?.dataset['vsidianSrcEnd'] ?? srcStart)
      if (!this.sessionId) {
        return
      }
      if (anchor.classList.contains(WIKILINK_CLASS_NAMES.wikilink)) {
        // 双链：href 即 `|` 之前的原文 target（markdown-it 规则写入，未 trim）
        this.bridge.postMessage({
          kind: 'wikilink.activate',
          sessionId: this.sessionId,
          docUri: this.docUri,
          target: href,
          srcStart: Number.isInteger(srcStart) ? srcStart : 0,
          srcEnd: Number.isInteger(srcEnd) ? srcEnd : srcStart,
        })
        return
      }
      this.bridge.postMessage({
        kind: 'link.activate',
        sessionId: this.sessionId,
        docUri: this.docUri,
        href,
        srcStart: Number.isInteger(srcStart) ? srcStart : 0,
        srcEnd: Number.isInteger(srcEnd) ? srcEnd : srcStart,
      })
    })
    // #53 布局骨架：#app > body(水平) > main(主编辑区：顶栏+横幅+双视图)
    // + sidebar(右侧栏)；findPanel 浮层仍直接挂 #app（以 #app 为定位包含块）
    this.sidebarEl = this.buildSidebar()
    this.mainEl = document.createElement('div')
    this.mainEl.className = 'vsidian-main'
    this.mainEl.appendChild(this.toolbar)
    this.mainEl.appendChild(this.quickActionsEl)
    this.mainEl.appendChild(this.banner)
    this.mainEl.appendChild(this.liveWrapper)
    this.mainEl.appendChild(this.readingContainer)
    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'vsidian-body'
    this.bodyEl.appendChild(this.mainEl)
    this.bodyEl.appendChild(this.sidebarEl)
    parent.appendChild(this.bodyEl)
    parent.appendChild(this.findPanel)
    // 侧栏初始态（持久化恢复）落到 DOM 类与按钮可访问名称
    this.applySidebarDom()
    // 大纲面板初始态（持久化恢复）落到侧栏容器类与按钮 aria-expanded
    this.applyOutlineDom()
    this.applyQuickActionsDom()
    // document 捕获先于 VS Code webview 预加载脚本的 window 冒泡转发。
    this.docKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.quickHeadingMenu && !this.quickHeadingMenu.hidden) {
        e.preventDefault()
        e.stopPropagation()
        this.keybindingRouter.cancel()
        this.closeQuickHeadingMenu(true)
        return
      }
      const target = e.target instanceof Node ? e.target : null
      const liveFocused = this.viewMode === 'live' && !!target &&
        !!this.view?.contentDOM.contains(target) &&
        !this.view.state.readOnly && this.view.state.facet(EditorView.editable) && !this.suspended
      const readingFocused = this.viewMode === 'reading' && !!target &&
        !!this.readingContainer?.contains(target) &&
        !(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)
      const withinEditor = !!target && (target === document ||
        !!this.bodyEl?.contains(target) || !!this.findPanel?.contains(target))
      if (this.keybindingRouter.handle(e, this.viewMode,
        liveFocused || readingFocused || withinEditor, liveFocused)) return
      if (this.findOpen && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.closeFind()
        return
      }
    }
    document.addEventListener('keydown', this.docKeydown, true)
    window.addEventListener('blur', this.cancelKeybindingOnBlur)
    // 宿主明暗主题热跟随：body class 由 VSCode 随主题实时更新
    this.hostThemeObserver = new MutationObserver(() => this.applyHostTheme())
    this.hostThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    this.view = new EditorView({
      parent: this.liveWrapper,
      state: EditorState.create({ doc: '', extensions: this.extensions() }),
    })
    // #66 大纲高亮联动：live 视口滚动（用户与程序性同源）驱动当前控制域
    // 重算。监听器挂在 view 自身的 scrollDOM 上——dispose 时整棵 view.dom
    // 随 destroy 移除，无需单独解绑
    this.view.scrollDOM.addEventListener('scroll', () => this.onOutlineScrollSignal())
    this.hostDarkApplied = isVscodeDarkBody()
    this.applyModeDom(this.viewMode)
    this.refreshQuickActions()
    this.bridge.postMessage({ kind: 'ready' })
  }

  getView(): EditorView | undefined {
    return this.view
  }

  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.cancelOutlineRefresh()
    this.cancelOutlineHighlightUpdate()
    if (this.outlineJumpGuardTimer !== undefined) {
      clearTimeout(this.outlineJumpGuardTimer)
      this.outlineJumpGuardTimer = undefined
    }
    this.outlineJumpGuarded = false
    this.hostThemeObserver?.disconnect()
    this.hostThemeObserver = undefined
    if (this.docKeydown) {
      document.removeEventListener('keydown', this.docKeydown, true)
      this.docKeydown = undefined
    }
    window.removeEventListener('blur', this.cancelKeybindingOnBlur)
    this.keybindingRouter.cancel()
    this.view?.destroy()
    this.view = undefined
    this.banner?.remove()
    this.banner = undefined
    this.toolbar?.remove()
    this.toolbar = undefined
    this.quickActionsEl?.remove()
    this.quickActionsEl = undefined
    this.quickToggleBtn = undefined
    this.quickHeadingBtn = undefined
    this.quickHeadingMenu = undefined
    this.findPanel?.remove()
    this.findPanel = undefined
    this.findInputEl = undefined
    this.findCountEl = undefined
    this.liveWrapper?.remove()
    this.liveWrapper = undefined
    this.readingView?.dispose()
    this.readingView = undefined
    this.readingContainer?.remove()
    this.readingContainer = undefined
    this.sidebarToggleBtn = undefined
    this.outlineToggleBtn = undefined
    this.outlinePanelEl = undefined
    this.outlineSlider = undefined
    this.outlineToolbar = undefined
    // #69：菜单浮层与重命名编辑态随卸载退出（document 监听一并摘除）
    this.closeOutlineMenu()
    this.outlineRenameIndex = null
    this.outlineRenameDoc = null
    // #70：拖拽会话随卸载退出（document 监听一并摘除）
    document.removeEventListener('pointerdown', this.outlinePointerdownEntry, true)
    this.cancelOutlineDrag()
    this.sidebarEl?.remove()
    this.sidebarEl = undefined
    this.mainEl?.remove()
    this.mainEl = undefined
    this.bodyEl?.remove()
    this.bodyEl = undefined
    this.images?.dispose()
    this.images = undefined
  }

  /** 宿主消息入口（window message 事件转发） */
  handleHostMessage(message: unknown): void {
    if (!isHostToWebview(message)) {
      return
    }
    switch (message.kind) {
      case 'init':
        this.sessionId = message.sessionId
        this.docUri = message.docUri
        this.handleFullSync(message.version, message.text, {
          restoreAnchor: true,
          source: 'init',
        })
        // init 后主动回报一次视图状态（含持久化恢复的模式）：宿主的模式
        // 缓存尽早建立，重载场景（retainContextWhenHidden 关闭）不留窗口
        this.reportViewState()
        // 拉取当前设置快照（#33）：权威在宿主，webview 不持久化——每次
        // 装载（含重载）都拉取；宿主以 settings.snapshot 响应
        this.bridge.postMessage({ kind: 'settings.get' })
        this.bridge.postMessage({ kind: 'keybindings.get' })
        break
      case 'keybindings.snapshot':
      case 'keybindings.changed': {
        const overrides = message.overrides
        this.keybindingRouter.update(overrides)
        this.setQuickActionBindingHints((id) => getEffectiveBindings(overrides, id))
        break
      }
      case 'settings.snapshot':
      case 'settings.changed':
        // 设置快照与变更广播共用同一处理（#33）：snapshot 为设置页请求-
        // 响应与编辑器拉取的回填，changed 为保存成功的全量广播；缓存后由
        // #34 等消费方按需读取关心的键（editor.lineNumbers 经 Compartment
        // 热重配，缺键回默认、非法形态忽略）
        this.settings = message.values
        this.applyLineNumbersSetting()
        this.applyCodeCardSetting()
        break
      case 'edit.ack': {
        if (this.suspended) {
          // 暂停态：写回已停，任何 ack 结果都不再改变本地状态
          break
        }
        if (message.ok) {
          this.inFlight.delete(message.seq)
          // 按 seq 剥离已确认事务并复合进已确认链（C-2）：外部增量逆穿
          // 它平移回 baseVersion 系；宿主按序确认，通常命中队首
          this.confirmSentTxn(message.seq)
          // 未确认集的清空延后到缓冲 flush（组合输入映射仍需它）；
          // 全部确认且无缓冲挂起时本地与权威一致
          if (this.inFlight.size === 0 && !this.hasBufferedSync() && !this.deferredLocal) {
            this.unconfirmed = null
            this.ackedChain = null
            this.sentTxns = []
          }
          if (this.hasBufferedSync()) {
            this.pendingVersionAck = Math.max(this.pendingVersionAck ?? 0, message.version)
          } else if (this.inFlight.size === 0) {
            // 全部确认：基线推进到最新确认版本（C-2：部分确认时保持
            // unconfirmed 定义域版本，出站坐标经逆穿统一参考系）
            this.baseVersion = Math.max(this.baseVersion, message.version)
          }
          if (this.inFlight.size === 0 && !this.hasBufferedSync()) {
            this.sendDeferredLocal()
          }
          break
        }
        // ok:false（conflict/error）：本地有未确认输入时保留文本并暂停；
        // 无未确认输入时以附带全文重置（干净恢复），随后同样进入暂停
        const hasUnconfirmed = this.unconfirmed !== null || this.inFlight.size > 0
        if (!hasUnconfirmed && typeof message.text === 'string') {
          this.handleFullSync(message.version, message.text, { source: 'ack-fail' })
        }
        this.enterSuspended()
        break
      }
      case 'doc.changed':
        if (message.version <= this.lastDocChangedVersion) {
          // 版本单调防线（C-4）：同版本重复/迟到广播（宿主兜底确认竞态等）
          // 直接丢弃——版本与变更一一对应，重复应用会静默错位
          break
        }
        if (message.changes.length === 0) {
          // 无内容变更（#44：宿主侧已过滤空 dirty 事件，此处为第二道防线）。
          // 直接丢弃且不占用版本号：若空事件与真实增量同版本，后者仍须应用；
          // 也不得让暂缓态把它当成外部修改而升级为暂停。
          break
        }
        this.lastDocChangedVersion = message.version
        if (this.suspended) {
          // 暂停：外部增量不应用（保留本地输入，恢复时以全文对齐）
          break
        }
        if (this.deferredLocal && !this.composing && !this.blankComposition && !this.hasBufferedSync()) {
          // 待发集定义域未随外部增量重定位；保守暂停并保留本地全文，
          // 避免确认后用旧坐标覆盖权威文本。
          this.enterSuspended()
          break
        }
        if (this.composing || this.blankComposition || this.hasBufferedSync()) {
          // 组合中不打断输入；缓冲挂起期间到达的增量一并对齐到 flush。
          // 入队即逆穿到 base 系（参考系一致性见 BufferedIncremental 注释）
          this.pendingExternal.push({
            version: message.version,
            changes: message.changes,
            baseChanges: this.ackedChain
              ? unmapSerGroupThroughAcked(message.changes, this.ackedChain)
              : message.changes,
          })
        } else if (this.unconfirmed || this.ackedChain) {
          // 在途未确认编辑：外部增量（权威系）先逆穿已确认链回 base 系再
          // 穿未确认集（C-2），真重叠则冲突暂停
          const mapped = this.applyExternalGroup(message.changes)
          if (!mapped) {
            this.enterSuspended()
            break
          }
          this.dispatchExternal(mapped)
          this.baseVersion = message.version
        } else {
          this.baseVersion = message.version
          this.dispatchExternal(message.changes)
        }
        break
      case 'doc.resync':
        this.handleFullSync(message.version, message.text, { source: 'resync' })
        break
      case 'session.suspended':
        // 宿主通知：面板处于暂停状态（典型为 webview 重载后的状态恢复）
        this.enterSuspended()
        break
      case 'view.mode.set':
        // 模式切换指令（宿主命令路径；webview 按钮走同一状态机）
        this.setViewMode(message.mode)
        break
      case 'view.find.open':
        // 查找会话（#14）：webview 内浮动面板；纯只读视图操作
        this.openFind(message.query)
        break
      case 'view.find.close':
        this.closeFind()
        break
      case 'view.find.step':
        this.findStep(message.direction)
        break
      case 'table.command': {
        // 表格增删行列（#13）：仅 live 模式执行（阅读除勾选任务外只读）；
        // 操作经 CM6 事务走标准出站链路（一笔 edit.request = 撤销一次），
        // 暂停态下与 live 输入同语义（本地保留、不写回）
        if (this.view && this.viewMode === 'live') {
          runTableEdit(this.view, message.op)
        }
        break
      }
      case 'table.create': {
        if (this.view && this.viewMode === 'live') {
          runCreateTable(this.view)
        }
        break
      }
      case 'format.command': {
        this.runFormatOperation(message.op)
        break
      }
      case 'ui.command':
        switch (message.op) {
          case 'sidebarToggle': this.toggleSidebar(); break
          case 'outlineToggle':
            if (!this.sidebarOpen && !this.outlineActive) this.toggleSidebar()
            this.toggleOutline()
            break
          case 'outlineSearch':
            if (!this.sidebarOpen) this.toggleSidebar()
            if (!this.outlineActive) this.toggleOutline()
            this.outlineToolbar?.search.focus()
            break
          case 'outlineJumpBottom': this.outlineJumpToBottom(); break
          case 'outlineReset': this.resetOutline(); break
          case 'outlineCollapseAll': this.setOutlineExpandLevel(0); break
          case 'outlineExpandAll': this.setOutlineExpandLevel(5); break
        }
        break
      case 'sidebar.test.click': {
        // 测试钩子（#53）：点击真实侧栏切换按钮（与用户点击同一处理器；
        // 纯视图状态翻转，零写回）
        this.sidebarToggleBtn?.click()
        break
      }
      case 'quick.test.click': {
        const selector = message.action === 'toggle' ? '.vsidian-quick-toggle'
          : message.action === 'heading' ? '.vsidian-quick-heading'
            : message.action === 'bold' ? '[data-op="bold"]'
              : `[data-heading-op="${message.action}"]`
        ;(this.mainEl?.querySelector(selector) as HTMLButtonElement | null)?.click()
        break
      }
      case 'outline.test.click': {
        // 测试钩子（#54）：点击真实大纲按钮（与用户点击同一处理器；
        // 纯视图状态翻转，零写回）
        this.outlineToggleBtn?.click()
        break
      }
      case 'outline.test.itemClick': {
        // 测试钩子（#66）：点击第 index 个真实大纲条目，驱动与用户点击
        // 同一面板委托处理器（纯视图跳转，零写回）
        const nodes = this.outlinePanelEl
          ?.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)
        nodes?.[message.index]?.click()
        break
      }
      case 'outline.test.expandClick': {
        // 测试钩子（#67）：点击第 level 档真实圆点（click 冒泡到滑块行
        // 委托，与用户点击同一处理器；档位整体替换，纯视图状态零写回）
        this.outlineSlider?.dots[message.level]?.click()
        break
      }
      case 'outline.test.chevronClick': {
        // 测试钩子（#67）：点击第 index 个真实条目的折叠箭头（面板委托
        // 按目标分流：箭头折叠/展开，不触发跳转）
        const itemEl = this.outlinePanelEl
          ?.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)[message.index]
        itemEl
          ?.querySelector<HTMLButtonElement>(`.${OUTLINE_CLASS_NAMES.chevron}`)
          ?.click()
        break
      }
      case 'outline.test.searchInput': {
        // 测试钩子（#68）：向真实搜索输入框设值并派发 input 事件（与用户
        // 输入同一处理器；搜索过滤与片段高亮即时重算，纯视图零写回）
        const input = this.outlineToolbar?.search
        if (input) {
          input.value = message.text
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        break
      }
      case 'outline.test.toolbarClick': {
        // 测试钩子（#68）：点击工具条真实按钮（与用户点击同一处理器；
        // 跳转到末尾 = 纯视图滚动，重置 = 三合一回到面板初始态）
        if (message.action === 'jump-bottom') {
          this.outlineToolbar?.jumpBottom.click()
        } else if (message.action === 'reset') {
          this.outlineToolbar?.reset.click()
        }
        break
      }
      case 'outline.test.contextMenu': {
        // 测试钩子（#69）：对第 index 个真实条目派发 contextmenu（与用户
        // 右键同一面板委托处理器，菜单弹出）
        const itemEl = this.outlinePanelEl
          ?.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)[message.index]
        if (itemEl) {
          const rect = itemEl.getBoundingClientRect()
          itemEl.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: rect.left + 20, clientY: rect.top + 10,
          }))
        }
        break
      }
      case 'outline.test.menuClick': {
        // 测试钩子（#69）：点击菜单中 command 对应的真实按钮（与用户点击
        // 同一处理器；command 已由协议校验器限定为合法菜单命令）
        this.outlineMenuEl
          ?.querySelector<HTMLButtonElement>(`button[data-vsidian-command="${message.command}"]`)
          ?.click()
        break
      }
      case 'outline.test.menuClose': {
        // 测试钩子（#69）：关闭当前菜单（等价 Esc/外点路径）
        this.closeOutlineMenu()
        break
      }
      case 'outline.test.renameKey': {
        // 测试钩子（#69）：向重命名输入框注入文本并以 Enter/Esc 收尾
        // （真实 keydown 链路）
        const input = this.outlinePanelEl?.querySelector<HTMLInputElement>(
          `.${OUTLINE_MENU_CLASS_NAMES.renameInput}`,
        )
        if (input) {
          input.value = message.text
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: message.key === 'enter' ? 'Enter' : 'Escape',
            bubbles: true, cancelable: true,
          }))
        }
        break
      }
      case 'outline.test.drag': {
        // 测试钩子（#70）：真实条目 pointer 事件序列驱动拖拽链路（与用户
        // 拖拽同一处理器）；宿主测试无法向 webview 派发真实鼠标事件
        this.runOutlineDragTest(message.from, message.to, message.position, message.action)
        break
      }
      case 'table.test.key': {
        // 测试钩子：向真实编辑器派发 keydown，走用户按键的同一 keymap 链路。
        if (this.view) {
          this.view.contentDOM.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: message.key === 'select-all' ? 'a' : message.key === 'backspace' ? 'Backspace'
                : message.key === 'delete' ? 'Delete' : message.key === 'enter' ? 'Enter' : 'Tab',
              ctrlKey: message.key === 'select-all',
              shiftKey: message.key === 'shift-tab',
              bubbles: true,
              cancelable: true,
            }),
          )
        }
        break
      }
      case 'table.test.cellClick': {
        if (this.view && this.viewMode === 'live') {
          const row = this.view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[message.rowIndex]
          const cell = row?.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')[message.columnIndex]
          if (cell) {
            const rect = cell.getBoundingClientRect()
            const x = rect.left + Math.min(message.point === 'right-edge' ? rect.width - 2
              : message.point === 'middle' ? 35 : 15,
              Math.max(1, rect.width - 1))
            const y = rect.top + rect.height / 2
            cell.dispatchEvent(new MouseEvent('mousedown', {
              bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y,
            }))
            const settledRow = this.view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')[message.rowIndex]
            const settledCell = settledRow?.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')[message.columnIndex]
            settledCell?.dispatchEvent(new MouseEvent('mouseup', {
              bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
            }))
          }
        }
        break
      }
      case 'table.test.crossSelect': {
        if (this.view && message.anchor <= this.view.state.doc.length &&
            message.head <= this.view.state.doc.length) {
          this.view.dispatch({
            selection: EditorSelection.single(message.anchor, message.head),
            userEvent: 'select.pointer',
          })
        }
        break
      }
      case 'table.test.type': {
        if (this.view && this.viewMode === 'live') {
          const range = this.view.state.selection.main
          this.view.dispatch({
            changes: { from: range.from, to: range.to, insert: message.text },
            userEvent: 'input.type',
          })
        }
        break
      }
      case 'table.test.domType': {
        if (this.view && this.viewMode === 'live') {
          // 测试用浏览器内容可编辑输入路径；源码事务注入无法观测原生 DOM caret。
          if (document.activeElement !== this.view.contentDOM) this.view.focus()
          document.execCommand('insertText', false, message.text)
        }
        break
      }
      case 'table.test.select': {
        const view = this.view
        if (view && this.viewMode === 'live') queueMicrotask(() => {
          if (this.view !== view) return
          const selector = message.axis === 'row'
            ? '.vsidian-table-row-handle' : '.vsidian-table-column-handle'
          view.dom.querySelectorAll<HTMLButtonElement>(selector)[message.index]?.click()
        })
        break
      }
      case 'table.test.drag': {
        // 测试钩子（#43）：在真实宿主 webview 中向点阵抓手派发鼠标指针序列。
        // 仍经控件的 pointerdown/move/up 与 CM6 标准写回链路。
        const view = this.view
        if (view && this.viewMode === 'live') queueMicrotask(() => {
          if (this.view !== view) return
          const grips = [...view.dom.querySelectorAll<HTMLElement>('.vsidian-table-row-handle')]
          const rows = [...view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-row')]
          const source = grips[message.sourceIndex]
          const target = rows[Math.min(message.targetSlot, rows.length - 1)]
          if (!source || !target || message.targetSlot > rows.length) return
          const sourceRect = source.getBoundingClientRect()
          const targetRect = target.getBoundingClientRect()
          const x = targetRect.left + Math.max(1, targetRect.width / 2)
          const startY = sourceRect.top + sourceRect.height / 2
          const endY = message.targetSlot === rows.length
            ? targetRect.bottom - 2 : targetRect.top + 2
          source.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, clientX: x, clientY: startY,
          }))
          target.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: x, clientY: endY,
          }))
          document.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true, clientX: x, clientY: endY,
          }))
        })
        break
      }
      case 'sync.test.edit': {
        if (this.view && this.viewMode === 'live') {
          const at = this.clampToDoc(message.offset)
          this.view.dispatch({ changes: { from: at, insert: message.text } })
          if (message.closeAfter && this.sessionId) {
            this.bridge.postMessage({ kind: 'sync.test.close', sessionId: this.sessionId, docUri: this.docUri })
          }
        }
        break
      }
      case 'sync.test.composition': {
        const view = this.view
        if (!view || this.viewMode !== 'live') break
        if (message.phase === 'start') {
          view.focus()
          view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        } else if (message.phase === 'update') {
          const line = view.contentDOM.querySelector('.cm-line')
          if (line) {
            line.replaceChildren(document.createTextNode(message.text))
            const node = line.firstChild!
            document.getSelection()?.setBaseAndExtent(node, message.text.length, node, message.text.length)
            view.contentDOM.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: message.text, isComposing: true }))
          }
        } else {
          view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: message.text }))
        }
        break
      }
      case 'link.test.mousedown': {
        if (this.view && this.viewMode === 'live') {
          const selector = message.target === 'wikilink'
            ? '[data-vsidian-rendered-wikilink="true"]'
            : '[data-vsidian-rendered-link="true"]'
          const target = this.view.dom.querySelectorAll<HTMLElement>(selector)[message.index]
          if (target) {
            const rect = target.getBoundingClientRect()
            const mouse = {
              bubbles: true,
              cancelable: true,
              button: 0,
              ctrlKey: message.ctrlKey === true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
            }
            target.dispatchEvent(new MouseEvent('mousedown', mouse))
            this.view.contentDOM.dispatchEvent(new MouseEvent('mouseup', mouse))
          }
        }
        break
      }
      case 'view.locate': {
        // 定位（#10 查找/跳转入口）：光标移到源 offset；reading 滚动到块。
        // 纯视图操作——事务不带 changes，不产生编辑历史
        this.locateOffset(message.offset)
        break
      }
      case 'reading.perf': {
        // 阅读视图性能探针（#7）：往返滚动观测挂载/回收/解析；纯视图滚动
        const container = this.readingContainer
        const rview = this.readingView
        if (this.viewMode === 'reading' && rview && container) {
          void runReadingPerfProbe(rview, container, {
            scrollRounds: message.scrollRounds,
          }).then((report) => this.bridge.postMessage(report))
        } else {
          const empty = {
            mountedBlocks: 0,
            contentDomCount: 0,
            scrollTopPx: 0,
            scrollHeightPx: 0,
          }
          this.bridge.postMessage({
            kind: 'reading.perf.report',
            scrollRounds: message.scrollRounds,
            totalBlocks: 0,
            baseline: empty,
            afterScroll: empty,
            parseCount: 0,
            maxMountedBlocks: 0,
            ok: false,
          })
        }
        break
      }
      case 'reading.test.image':
        // 测试钩子（#7）：图片加载后布局变化的模拟载体（不产生写回）
        if (this.viewMode === 'reading' && this.readingView) {
          this.readingView.injectTestImage(
            message.srcStart,
            message.initialHeightPx,
            message.finalHeightPx,
            message.delayMs,
          )
        }
        break
      case 'task.test.click': {
        // 测试钩子（#9）：按视图与序号点击真实任务 checkbox（宿主测试无法
        // 向 webview 派发真实鼠标事件；此通道驱动与用户点击同一处理器）
        const root =
          message.view === 'reading'
            ? this.readingContainer ?? undefined
            : this.view?.dom
        const cls =
          message.view === 'reading'
            ? READING_MARKDOWN_CLASS_NAMES.taskCheckbox
            : LIVE_CLASS_NAMES.taskCheckbox
        const boxes = root?.querySelectorAll<HTMLInputElement>(`input.${cls}`)
        boxes?.[message.index]?.click()
        break
      }
      case 'codecard.test.copy': {
        // 测试钩子（#81）：按序号点击卡片头部复制按钮（驱动与用户点击相同
        // 的处理器链路：effect → codeblock.copy 出站 → 宿主剪贴板写入）
        const scope = this.viewMode === 'reading' ? this.readingContainer : this.view?.contentDOM
        const buttons = scope?.querySelectorAll<HTMLButtonElement>(
          `.${CODE_CARD_CLASS_NAMES.copy}`,
        )
        buttons?.[message.index]?.click()
        break
      }
      case 'codecard.test.fold': {
        // 测试钩子（#82）：按序号点击卡片头部折叠 chevron（驱动与用户点击
        // 相同的处理器链路：effect → codeCardFoldField 视图态切换）
        const scope = this.viewMode === 'reading' ? this.readingContainer : this.view?.contentDOM
        const buttons = scope?.querySelectorAll<HTMLButtonElement>(
          `.${CODE_CARD_CLASS_NAMES.fold}`,
        )
        buttons?.[message.index]?.click()
        break
      }
      case 'image.result':
        // #10 图片解析结果路由（只读显示通道：暂停态同样可用）
        this.images?.handleResult(message)
        break
      case 'view.state.request': {
        // 查找观测前同步校验新鲜度（文档变化后微任务可能尚未执行）；
        // 此处不在 CM6 update 内，可以安全 dispatch 纯 effect 事务
        if (this.findOpen) {
          this.findEnsureFresh()
          this.findRender()
        }
        this.reportViewState()
        break
      }
      case 'perf.probe': {
        // 异步执行（含 rAF 等待），完成后回报 perf.report（#5 性能测量通道）
        const view = this.view
        if (view) {
          void runPerfProbe(view, {
            typingRounds: message.typingRounds,
            scrollRounds: message.scrollRounds,
          }).then((report) => this.bridge.postMessage(report))
        }
        break
      }
    }
  }

  /**
   * 视图状态回报（view.state）：宿主按需请求（view.state.request）与本控制
   * 器主动推送（模式切换后）共用。主动推送让宿主的模式缓存常新——表格
   * 结构命令等宿主侧写操作据此在 reading 面板上给出可见反馈（不再静默
   * 丢弃后虚报成功）。
   */
  private reportViewState(): void {
    const doc = this.view?.state.doc
    const content = this.view?.dom.querySelector('.cm-content')
    let selectedGridRow: HTMLElement | null = null
    if (this.view && this.viewMode === 'live') {
      try {
        const node = this.view.domAtPos(this.view.state.selection.main.from).node
        selectedGridRow = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.cm-line') ?? null
      } catch {
        // 屏外选区没有 DOM；表格探针仅报告当前已挂载节点。
      }
    }
    const tableGrid = {
      visibleRows: content?.querySelectorAll('.vsidian-table-grid-row').length ?? 0,
      selectedRowIsGrid: selectedGridRow?.classList.contains('vsidian-table-grid-row') ?? false,
      selectedRowCells: selectedGridRow
        ? [...selectedGridRow.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')]
          .map((cell) => cell.textContent ?? '')
        : [],
      rowHandles: this.view?.dom.querySelectorAll('.vsidian-table-row-handle').length ?? 0,
    }
    // 标题装饰的可观测 DOM 文本：活动（源码态）与非活动（隐藏标记）
    // 各取第一个样本，供集成测试断言 Live Preview 语义
    let headingActiveText: string | undefined
    let headingHiddenText: string | undefined
    if (content) {
      for (const el of Array.from(content.querySelectorAll<HTMLElement>('.vsidian-heading-line'))) {
        const text = el.textContent ?? ''
        if (text.startsWith('#')) {
          headingActiveText ??= text
        } else {
          headingHiddenText ??= text
        }
        if (headingActiveText !== undefined && headingHiddenText !== undefined) {
          break
        }
      }
    }
    const headingElement = this.viewMode === 'reading'
      ? this.readingContainer?.querySelector<HTMLElement>('.vsidian-reading-heading-1 h1')
      : content?.querySelector<HTMLElement>('.vsidian-heading-line-1')
    const headingFontPx = headingElement
      ? Number.parseFloat(window.getComputedStyle(headingElement).fontSize)
      : undefined
    const readingActive = this.viewMode === 'reading' && this.readingView
    const rStats = readingActive ? this.readingView!.getStats() : undefined
    const rScroll = readingActive ? this.readingView!.getScrollObservation() : undefined
    // 锚点块 start 经源 offset → 块身份的纯数据映射（不依赖布局；
    // 虚拟化下含未挂载目标——块模型是映射依据）
    const readingAnchorStart =
      readingActive && this.modeAnchor !== null
        ? (this.readingView!.anchorStartFor(this.clampToDoc(this.modeAnchor)) ?? undefined)
        : undefined
    // 锚点块的布局顶部位置（挂载时取真实 offsetTop 语义；未挂载为 undefined）
    let readingAnchorTopPx: number | undefined
    if (readingActive && readingAnchorStart !== undefined && this.readingContainer) {
      const el = this.readingContainer.querySelector<HTMLElement>(
        `.vsidian-reading-block[data-vsidian-src-start="${readingAnchorStart}"]`,
      )
      if (el) {
        const box = this.readingContainer.getBoundingClientRect()
        readingAnchorTopPx = el.getBoundingClientRect().top - box.top + this.readingContainer.scrollTop
      }
    }
    // #32：typography 为 view.state 正式可选字段（协议校验器见
    // shared/protocol.ts 的 isTypographyProbe）
    const state: Extract<WebviewToHost, { kind: 'view.state' }> = {
      kind: 'view.state',
      text: doc?.toString() ?? '',
      docLength: doc?.length ?? 0,
      lineCount: doc?.lines ?? 0,
      renderedLines: this.view?.dom.querySelectorAll('.cm-line').length ?? 0,
      suspended: this.suspended,
      contentDomCount: content ? content.querySelectorAll('*').length : 0,
      headingLineCount: content ? content.querySelectorAll('.vsidian-heading-line').length : 0,
      headingActiveText,
      headingHiddenText,
      headingFontPx,
      viewMode: this.viewMode,
      selectionOffset: this.view?.state.selection.main.from ?? 0,
      wordSegmenter: typeof Intl.Segmenter === 'function',
      selectionHead: this.view?.state.selection.main.head ?? 0,
      selectionAssoc: this.view?.state.selection.main.assoc ?? 0,
      readingBlockCount: rStats?.mountedBlocks ?? 0,
      readingAnchorStart,
      // #7 按需挂载观测：块模型总量/挂载量/DOM 计数/解析次数/虚拟化状态
      readingTotalBlocks: rStats?.totalBlocks,
      readingMountedBlocks: rStats?.mountedBlocks,
      readingContentDomCount: rStats?.contentDomCount,
      readingParseCount: rStats?.parseCount,
      readingVirtualized: rStats?.virtualized,
      readingAnchorTopPx,
      readingScrollTopPx: rScroll?.scrollTop,
      readingScrollHeightPx: rScroll?.scrollHeight,
      cssProbe: this.collectCssProbe(),
      liveSyntax: this.collectLiveSyntax(),
      tableGrid,
      readingSyntax: this.viewMode === 'reading' ? this.collectReadingSyntax() : undefined,
      // #10 链接/图片观测（DOM 级：live 限视口，reading 限挂载块）
      liveLinkCount: content ? content.querySelectorAll('.vsidian-link').length : 0,
      liveImageCount: content ? content.querySelectorAll('.vsidian-image').length : 0,
      // #11 双链观测（live：范围外 widget + 范围内 mark；reading：a）
      liveWikilinkCount: content
        ? content.querySelectorAll(`.${WIKILINK_CLASS_NAMES.wikilink}`).length
        : 0,
      // #59 公式观测（live：视口内 KaTeX widget/降级 span；reading：挂载块内）
      liveMathCount: content
        ? content.querySelectorAll(`.${MATH_CLASS_NAMES.math}, .${MATH_CLASS_NAMES.mathError}`).length
        : 0,
      readingMathCount: readingActive
        ? this.readingContainer!.querySelectorAll(`.${MATH_CLASS_NAMES.math}, .${MATH_CLASS_NAMES.mathError}`).length
        : 0,
      // #60 Mermaid 观测（live：视口内渲染 widget/降级容器；reading：挂载块内）
      liveMermaidCount: content
        ? content.querySelectorAll(`.${MERMAID_CLASS_NAMES.diagram}`).length
        : 0,
      readingMermaidCount: readingActive
        ? this.readingContainer!.querySelectorAll(`.${MERMAID_CLASS_NAMES.diagram}`).length
        : 0,
      readingLinkCount: readingActive
        ? this.readingContainer!.querySelectorAll('a').length
        : 0,
      readingImageCount: readingActive
        ? this.readingContainer!.querySelectorAll('img').length
        : 0,
      readingWikilinkCount: readingActive
        ? this.readingContainer!.querySelectorAll(`a.${WIKILINK_CLASS_NAMES.wikilink}`).length
        : 0,
      // 图片状态计数按当前视图作用域（隐藏视图的槽位不计入——同一管理器
      // 服务双视图，隐藏侧的 DOM 不代表用户可见状态）
      imageStates: this.collectImageStates(),
      find: this.collectFindProbe(),
      typography: this.collectTypography(),
      // #33 设置快照缓存（宿主下发过才有值；缺省向后兼容）
      settings: this.settings,
      // #34 行号栏观测（开关态与视口内渲染结果）
      lineGutter: this.collectLineGutter(),
      // 绘制层探针（P0 回归）：正文可见性 / CM6 注入样式存活 / 行号禁选
      paint: this.collectPaint(),
      // #53 右侧栏观测（布局态与绘制层证据）
      sidebar: this.collectSidebar(),
      // #54 大纲观测（面板态、绘制层证据与全文标题序列）
      outline: this.collectOutline(),
    }
    this.bridge.postMessage(state)
  }

  /**
   * 进入冲突暂停：保留本地文本，上报快照（有未确认输入时），显示横幅，
   * 停止一切写回与外部同步；恢复唯一途径是 doc.resync（宿主 resumePanel）。
   */
  private enterSuspended(): void {
    if (this.suspended) {
      return
    }
    const hasUnconfirmed =
      this.unconfirmed !== null || this.inFlight.size > 0 || this.deferredLocal !== null || this.composing
    this.suspended = true
    this.setBannerVisible(true)
    if (hasUnconfirmed) {
      this.reportConflictSnapshot()
    }
    // 暂停后这些状态不再参与同步；恢复时由 doc.resync 全量对齐。
    // pendingFull 保留：暂停前的全文重置（恢复内容）在 flush 时仍应用
    this.unconfirmed = null
    this.ackedChain = null
    this.sentTxns = []
    this.deferredLocal = null
    this.inFlight.clear()
    this.pendingExternal = []
  }

  /**
   * 暂停/暂缓态每笔输入立即刷新宿主快照。两种状态的输入不在宿主 pending
   * 内，延后发送会在快速关闭或断连时留下无法取回的窗口。正常输入仍走
   * 增量 edit.request，不发送全文。
   *
   * #49 唯一例外：组合期间的暂缓输入不逐笔上报（见 recordLocalChangeSet
   * 暂缓分支注释）。暂停态（enterSuspended 进入时与暂停中的每笔输入）不受
   * 该例外影响，仍立即快照——暂停非高频路径，且组合中进入暂停时本地文本
   * 已脱离正常出站链路（inFlight/deferredLocal 均被清空），快照是此时唯一
   * 的取回通道，不放宽。
   */
  private reportConflictSnapshot(): void {
    if (!this.sessionId || (!this.suspended && !this.deferredLocal)) {
      return
    }
    this.conflictRevision += 1
    this.persistState()
    this.bridge.postMessage({
      kind: 'conflict.report',
      sessionId: this.sessionId,
      docUri: this.docUri,
      version: this.baseVersion,
      revision: this.conflictRevision,
      text: this.view?.state.doc.toString() ?? '',
    })
  }

  /** 全文同步（init / doc.resync）：组合中缓冲，否则立即重置。
   *  doc.resync 对暂停面板兼作恢复信号：重置文本并解除暂停（#4）。
   *  组合中的恢复（含暂停解除）延后到 flush。
   *  init 路径（restoreAnchor）额外恢复持久化的模式锚点：reading 滚动到
   *  锚点块，live 恢复光标（webview 重载场景，#6）。 */
  private handleFullSync(
    version: number,
    text: string,
    opts: { restoreAnchor?: boolean; source?: 'resync' | 'init' | 'ack-fail' } = {},
  ): void {
    if (opts.source === 'resync' && this.deferredLocal && !this.suspended) {
      // 主动全文与尚未发送的本地输入无法自动合并；保留本地快照供恢复。
      this.enterSuspended()
      return
    }
    if (this.composing || this.blankComposition || this.hasBufferedSync()) {
      if (!this.pendingFull || version >= this.pendingFull.version) {
        this.pendingFull = { version, text, source: opts.source ?? 'init' }
      }
      this.pendingExternal = this.pendingExternal.filter((group) => group.version > version)
      return
    }
    this.baseVersion = version
    // 全文重置即权威基线（C-4）：早于该版本的迟到增量一律丢弃
    this.lastDocChangedVersion = Math.max(this.lastDocChangedVersion, version)
    this.replaceDoc(text)
    this.exitSuspended()
    this.refreshReading()
    if (opts.restoreAnchor) {
      if (this.viewMode === 'reading') {
        if (this.modeAnchor !== null && this.readingView) {
          this.readingView.scrollToOffset(this.clampToDoc(this.modeAnchor))
        }
      } else if (this.modeAnchor !== null && this.modeAnchor > 0) {
        // 恢复光标：不带 changes 的事务，不产生编辑历史
        const pos = this.clampToDoc(this.modeAnchor)
        this.view?.dispatch({ selection: { anchor: pos } })
      }
    }
  }

  /** 解除暂停（doc.resync / init 全文装载后调用）：状态全量对齐 */
  private exitSuspended(): void {
    if (!this.suspended && !this.inFlight.size && this.unconfirmed === null) {
      return
    }
    this.suspended = false
    this.inFlight.clear()
    this.unconfirmed = null
    this.ackedChain = null
    this.sentTxns = []
    this.deferredLocal = null
    this.pendingExternal = []
    this.pendingFull = undefined
    this.pendingVersionAck = undefined
    this.setBannerVisible(false)
  }

  private hasBufferedSync(): boolean {
    return this.pendingExternal.length > 0 || this.pendingFull !== undefined
  }

  // ---- 视图模式状态机（#6）----
  // 模式是纯 webview 视图状态：切换绝不 dispatch 文本变更（不入撤销栈、
  // 不触发保存、未保存内容原地保留），只做容器显隐、锚点映射与选区恢复。
  // 宿主 TextDocument 版本因此不受切换影响。

  /** 切换入口（宿主 view.mode.set 消息驱动；#38 起由宿主标题栏三态命令
   *  与命令面板命令编排，webview 工具栏已移除） */
  private setViewMode(target: 'live' | 'reading' | 'toggle'): void {
    this.keybindingRouter.cancel()
    const next: ViewMode =
      target === 'toggle' ? (this.viewMode === 'live' ? 'reading' : 'live') : target
    if (next === this.viewMode) {
      this.persistState()
      return
    }
    // review-loops B3：命令面板切模式不经鼠标路径（无 pointercancel），
    // 拖拽会话若残留会跨模式存活（落点判定随视图重算漂移）——统一取消
    this.cancelOutlineDrag()
    if (this.view) selectTableRegion(this.view, null)
    if (next === 'reading') {
      const editorHadFocus = document.activeElement === this.view?.contentDOM
      // #84 切回阅读模式：已挂载块补卡片增强（常驻块不经挂载钩子）
      this.decorateMountedReadingCodeCards()
      // 锚点 = live 光标主位（选区最小 from）；阅读视图按当前 CM6 文本渲染
      // （含未确认输入），不依赖宿主权威。锚点随即规范化为块 start——
      // 短文档滚动无法表达目标时 modeAnchor 仍是权威锚点
      const sel = this.view?.state.selection
      const cursor = sel
        ? Math.min(...sel.ranges.map((r) => r.from))
        : this.modeAnchor ?? 0
      this.modeAnchor = cursor
      this.applyModeDom('reading') // 先更新模式（refreshReading 依赖它）
      if (editorHadFocus) this.readingContainer?.focus()
      this.refreshReading()
      if (this.readingView) {
        const start = this.readingView.anchorStartFor(this.clampToDoc(cursor)) ?? cursor
        this.modeAnchor = start
        this.readingView.scrollToSrcStart(start)
      }
      // #66：模式切换即时重算（reading 以视口顶块锚点换算；切换引发的
      // 滚动属程序性但目标即当前锚点，重算结果稳定，去抖吸收余波）
      this.updateOutlineLocated()
      // 查找会话跨模式保活（#14）：当前匹配位置经源位置锚点映射到新视图
      if (this.findOpen) {
        this.findEnsureFresh()
        this.findRender()
        this.findLocate()
      }
      return
    }
    // reading → live：源码位置锚点 = modeAnchor（用户滚动经 scroll 监听
    // 更新；进入/定位时规范化），非滚动百分比
    if (this.readingView && this.modeAnchor !== null) {
      const mapped = this.readingView.anchorStartFor(this.clampToDoc(this.modeAnchor))
      if (mapped !== null) {
        this.modeAnchor = mapped
      }
    }
    const readingHadFocus = document.activeElement === this.readingContainer
    this.applyModeDom('live')
    if (readingHadFocus) this.view?.focus()
    // 恢复光标到锚点并滚动到视口中部；事务不带 changes → 不产生编辑历史
    const pos = this.clampToDoc(this.modeAnchor ?? 0)
    this.view?.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    // #66：模式切换即时重算（live 以已渲染行的首可见行换算）
    this.updateOutlineLocated()
    // 查找会话跨模式保活（#14）：选区恢复到当前匹配（非仅块首）
    if (this.findOpen) {
      this.findEnsureFresh()
      this.findRender()
      this.findLocate()
    }
  }

  /** 容器显隐（稳定类名 vsidian-view-live / vsidian-view-reading） */
  private applyModeDom(mode: ViewMode): void {
    this.viewMode = mode
    this.closeQuickHeadingMenu(false)
    this.refreshQuickActions()
    if (this.liveWrapper) {
      this.liveWrapper.style.display = mode === 'live' ? '' : 'none'
    }
    if (this.readingContainer) {
      this.readingContainer.style.display = mode === 'reading' ? '' : 'none'
    }
    this.persistState()
    // 模式变化主动回报（宿主缓存常新：表格结构命令在 reading 面板上据此
    // 给出可见反馈，不再静默丢弃）。握手前（无 sessionId）不回报——宿主
    // 尚不认识此面板，mount 阶段的 DOM 初始化不算模式变化
    if (this.sessionId) {
      this.reportViewState()
    }
  }

  /** 阅读模式下按当前 CM6 文本重建阅读视图（保留滚动锚点）。
   *  调用点：进入 reading、全文重置（init/resync）、外部增量应用后。
   *  #7 起：全文切块（唯一一次解析）后按需挂载窗口；滚动路径不再进入此处 */
  private refreshReading(): void {
    if (this.viewMode !== 'reading' || !this.readingView || !this.view) {
      return
    }
    // 布局可用才读视口锚点（否则保留当前锚点 offset，重建后再映射）
    const hasLayout = (this.readingContainer?.scrollHeight ?? 0) > 0
    const keep = hasLayout ? this.readingView.currentAnchor() : null
    this.readingView.setDocument(this.view.state.doc.toString())
    if (keep !== null) {
      this.readingView.scrollToSrcStart(keep)
      this.modeAnchor = keep
    }
  }

  // ---- 任务勾选（#9）：阅读视图的 checkbox 交互 ----

  private isTaskCheckbox(node: EventTarget | null): node is HTMLInputElement {
    return (
      node instanceof HTMLInputElement &&
      node.type === 'checkbox' &&
      node.classList.contains(READING_MARKDOWN_CLASS_NAMES.taskCheckbox)
    )
  }

  /**
   * 阅读视图任务勾选：checkbox 源锚点严格再校验后，在（隐藏的）CM6 编辑器
   * 上派发替换事务——与手工编辑同一事务管线，出站走标准链路
   * （updateListener → edit.request：seq/baseVersion/未确认参考系/暂缓
   * 语义全部继承）。校验失败（过期锚点/已是目标态）即放弃：零写回、
   * 零历史。派发后乐观重建阅读视图（勾选态源自本地文档；冲突暂停期间
   * 与 live 输入同语义：本地保留、不写回）。
   */
  private toggleReadingTask(box: HTMLInputElement): void {
    const view = this.view
    if (!view) {
      return
    }
    const start = Number(box.dataset['vsidianSrcStart'])
    const end = Number(box.dataset['vsidianSrcEnd'])
    const displayedChecked = box.dataset['vsidianChecked'] === 'true'
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return
    }
    const target = resolveStaleTaskToggle(view.state.doc.toString(), start, end, displayedChecked)
    if (!target) {
      return
    }
    view.dispatch({
      changes: { from: target.from, to: target.to, insert: target.nextText },
    })
    this.refreshReading()
  }

  private clampToDoc(offset: number): number {
    return Math.max(0, Math.min(offset, this.view?.state.doc.length ?? 0))
  }

  /**
   * 定位执行（#10 view.locate 宿主消息与 #66 大纲点击共用同一实现）：
   * 光标移到源 offset；reading 滚动到锚点块。纯视图操作——事务不带
   * changes，不产生编辑历史。#66 起：程序性滚动前置防抖动护栏（过渡期
   * 中间态视口不参与高亮计算），并以目标位置所在行即时落位常驻高亮
   * （不等滚动事件——被点击条目就是目标控制域）。
   */
  private locateOffset(offset: number): void {
    const pos = this.clampToDoc(offset)
    this.suspendOutlineLinking()
    if (this.viewMode === 'reading' && this.readingView) {
      const start = this.readingView.anchorStartFor(pos) ?? pos
      this.modeAnchor = start
      this.readingView.scrollToSrcStart(start)
      // 定位意图重申（#11 起，#14 findLocate 同款机制）：屏外定位的滚动
      // 事件在挂载窗口重算（rAF）之前同步读取视口锚点，瞬态值不得覆盖
      // 定位目标——帧+宏任务后重申（同一窗口内的用户滚动会被覆盖）
      this.reassertReadingAnchor(start, 2)
    } else {
      this.modeAnchor = pos
      // #57：定位离开表格选区语境时清选区（view.locate 与大纲跳转共用）
      if (this.view) selectTableRegion(this.view, null)
      // 聚焦编辑器（#66，QO「jump + 聚焦」语义）：未聚焦时 CM6 不把选区
      // 同步到 DOM Selection，用户看不到光标落位；点击大纲即完成导航，
      // 焦点归还正文（继续输入/滚动）
      this.view?.focus()
      this.view?.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      })
    }
    const doc = this.view?.state.doc
    this.outlineLocatedIndex = doc
      ? locateOutlineIndex(this.outlineItems, doc.lineAt(pos).number)
      : null
    // #67：跳转落位含 only-expand（目标被折叠遮蔽时展开祖先链——点击
    // 折叠区条目或宿主 view.locate 落进折叠区时目标可见），高亮随代表落位
    if (this.outlineLocatedIndex !== null) {
      this.revealOutlineIndex(this.outlineLocatedIndex)
    }
    this.applyOutlineHighlight()
  }

  /** #66 大纲条目点击跳转：标题行号 → 源 offset（doc.line(n).from）后走
   *  locateOffset 双模式路径。行号为条目渲染时刻的值（大纲 250ms 去抖
   *  窗口内的编辑存在滞后可能，与点击时的可见条目一致） */
  private outlineJumpToItem(index: number): void {
    const view = this.view
    const item = this.outlineItems[index]
    if (!view || !item) {
      return
    }
    const line = Math.min(Math.max(1, item.line), view.state.doc.lines)
    this.locateOffset(view.state.doc.line(line).from)
  }

  /**
   * 阅读定位后的锚点重申（#14 findLocate 机制的 view.locate 复用，#11）：
   * 滚动事件突发期（含虚拟化挂载窗口重算与实测修正的异步阶段）内读到的
   * 瞬态视口锚点不得覆盖定位目标。rounds 轮（帧+宏任务）后仍保持目标锚点。
   */
  private reassertReadingAnchor(start: number, rounds: number): void {
    scheduleFrame(() => {
      setTimeout(() => {
        if (this.viewMode === 'reading') {
          this.modeAnchor = start
          if (rounds > 1) {
            this.reassertReadingAnchor(start, rounds - 1)
          }
        }
      }, 0)
    })
  }

  /** 图片槽位状态计数（#10）：按当前激活视图的作用域统计 DOM 状态标记 */
  private collectImageStates(): { loading: number; loaded: number; error: number } {
    const scope = this.viewMode === 'reading' ? this.readingContainer : this.liveWrapper
    const out = { loading: 0, loaded: 0, error: 0 }
    if (!scope) {
      return out
    }
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[data-vsidian-img-state]'))) {
      const s = el.dataset['vsidianImgState']
      if (s === 'loading' || s === 'loaded' || s === 'error') {
        out[s] += 1
      }
    }
    return out
  }

  /** CSS 契约探针（#6 内部测试验证入口；#8 扩展 span 级类）：宿主注入的
   *  测试片段仅经稳定类名定位；此处在 view.state 请求时读取 computed style
   *  回报。jsdom 无样式表计算，值可为空串/空变量（返回 null），真实断言在集成。 */
  private collectCssProbe(): CssProbeReport {
    const liveEl = this.liveWrapper?.querySelector('.vsidian-heading-line-1') ?? null
    const readingEl = this.readingContainer?.querySelector('.vsidian-reading-heading-1') ?? null
    const liveStrong = this.liveWrapper?.querySelector('.vsidian-strong') ?? null
    const liveInlineCode = this.liveWrapper?.querySelector('.vsidian-inline-code') ?? null
    const liveCodeLine = this.liveWrapper?.querySelector('.vsidian-code-line') ?? null
    const liveTablePipe = this.liveWrapper?.querySelector('.vsidian-table-pipe') ?? null
    const readingStrong = this.readingContainer?.querySelector('.vsidian-reading-block strong') ?? null
    const liveTaskBox = this.liveWrapper?.querySelector(`.${LIVE_CLASS_NAMES.taskCheckbox}`) ?? null
    const readingTaskBox = this.readingContainer?.querySelector(
      `.${READING_MARKDOWN_CLASS_NAMES.taskCheckbox}`,
    ) ?? null
    const liveLink = this.liveWrapper?.querySelector('.vsidian-link') ?? null
    const readingLink = this.readingContainer?.querySelector('.vsidian-reading-block a') ?? null
    const readingImage = this.readingContainer?.querySelector('.vsidian-reading-block img.vsidian-image') ?? null
    const readingTable = this.readingContainer?.querySelector('.vsidian-reading-block table') ?? null
    const liveWikilink = this.liveWrapper?.querySelector(`.${WIKILINK_CLASS_NAMES.wikilink}`) ?? null
    const readingWikilink = this.readingContainer?.querySelector(
      `.vsidian-reading-block a.${WIKILINK_CLASS_NAMES.wikilink}`,
    ) ?? null
    // #59 公式字体观测：katex.min.css 生效时 .katex 的 computed font-family
    // 含 KaTeX 字体族（CSP/样式注入失效时回落 body 字体——集成断言依据）
    const liveMathKatex = this.liveWrapper?.querySelector('.vsidian-math .katex') ?? null
    const readingMathKatex = this.readingContainer?.querySelector('.vsidian-reading-block .katex') ?? null
    const readFont = (el: Element | null): string | null =>
      el ? getComputedStyle(el).fontFamily || null : null
    const read = (el: Element | null): string | null =>
      el ? getComputedStyle(el).textDecorationColor : null
    let readingVarProbe: string | null = null
    if (this.readingContainer) {
      const value = getComputedStyle(this.readingContainer)
        .getPropertyValue('--vsidian-probe-var-reading')
        .trim()
      readingVarProbe = value === '' ? null : value
    }
    return {
      liveHeadingDecorationColor: read(liveEl),
      readingHeadingDecorationColor: read(readingEl),
      readingVarProbe,
      liveStrongDecorationColor: read(liveStrong),
      liveInlineCodeDecorationColor: read(liveInlineCode),
      liveCodeLineDecorationColor: read(liveCodeLine),
      readingStrongDecorationColor: read(readingStrong),
      liveTaskCheckboxDecorationColor: read(liveTaskBox),
      readingTaskCheckboxDecorationColor: read(readingTaskBox),
      liveLinkDecorationColor: read(liveLink),
      readingLinkDecorationColor: read(readingLink),
      readingImageDecorationColor: read(readingImage),
      // #12 表格样式入口探针（live 管道符 / reading 表格标签）
      liveTablePipeDecorationColor: read(liveTablePipe),
      readingTableDecorationColor: read(readingTable),
      // #11 双链样式入口探针（live widget/mark / reading a）
      liveWikilinkDecorationColor: read(liveWikilink),
      readingWikilinkDecorationColor: read(readingWikilink),
      // #59 公式字体探针（live widget / reading 块内的 KaTeX 层）
      liveMathFontFamily: readFont(liveMathKatex),
      readingMathFontFamily: readFont(readingMathKatex),
    }
  }

  /** #32 排版一致性采样：两模式正文/列表/引用/表格的 computed 基础排版。
   *  只读 DOM 与计算样式，不触发布局写入；隐藏侧（display:none）computed
   *  字体族/字号仍可读（继承链有效），几何口径 textInsetPx 无意义（rect
   *  全 0）——断言端须在对应模式激活态取各自样本。 */
  private collectTypography(): TypographyProbe {
    const scroller = this.liveWrapper?.querySelector<HTMLElement>('.cm-scroller') ?? null
    const readBase = (el: HTMLElement | null, anchor: HTMLElement | null): TypographySample | null => {
      if (!el) {
        return null
      }
      const cs = getComputedStyle(el)
      const fontPx = Number.parseFloat(cs.fontSize)
      const linePx = Number.parseFloat(cs.lineHeight)
      return {
        fontFamily: cs.fontFamily || null,
        fontSizePx: Number.isFinite(fontPx) ? fontPx : null,
        lineHeightPx: Number.isFinite(linePx) ? linePx : null,
        textInsetPx: anchor
          ? el.getBoundingClientRect().left - anchor.getBoundingClientRect().left
          : null,
      }
    }
    const readInherit = (el: HTMLElement | null): TypographyInheritSample | null => {
      if (!el) {
        return null
      }
      const cs = getComputedStyle(el)
      const fontPx = Number.parseFloat(cs.fontSize)
      return {
        fontFamily: cs.fontFamily || null,
        fontSizePx: Number.isFinite(fontPx) ? fontPx : null,
      }
    }
    return {
      live: readBase(
        this.liveWrapper?.querySelector<HTMLElement>('.cm-content') ?? null,
        scroller,
      ),
      reading: readBase(
        this.readingContainer?.querySelector<HTMLElement>('.vsidian-reading-block p') ?? null,
        this.readingContainer ?? null,
      ),
      liveList: readInherit(this.liveWrapper?.querySelector<HTMLElement>('.vsidian-list-line') ?? null),
      readingList: readInherit(this.readingContainer?.querySelector<HTMLElement>('.vsidian-reading-block li') ?? null),
      liveQuote: readInherit(this.liveWrapper?.querySelector<HTMLElement>('.vsidian-quote-line') ?? null),
      readingQuote: readInherit(this.readingContainer?.querySelector<HTMLElement>('.vsidian-reading-block blockquote') ?? null),
      liveTable: readInherit(this.liveWrapper?.querySelector<HTMLElement>('.vsidian-table-line') ?? null),
      readingTable: readInherit(this.readingContainer?.querySelector<HTMLElement>('.vsidian-reading-table td') ?? null),
    }
  }

  /** live 侧语法装饰统计（#8 双视图一致性观测）：直接装饰集合级计数 */
  private collectLiveSyntax(): LiveSyntaxProbe {
    const counts = {
      headingLines: 0,
      headerSpans: 0,
      strongSpans: 0,
      emphasisSpans: 0,
      inlineCodeSpans: 0,
      quoteLines: 0,
      codeLines: 0,
      listLines: 0,
      hrLines: 0,
      frontmatterLines: 0,
      taskGlyphs: 0,
      taskChecked: 0,
      tableLines: 0,
      tableCells: 0,
    }
    const view = this.view
    if (view) {
      view.state
        .field(liveDecorationsField)
        .decos.between(0, view.state.doc.length, (_from, _to, value) => {
          const spec = value.spec as { class?: string; widget?: { checked?: boolean } }
          if (typeof spec['class'] === 'string') {
            const cls = spec['class']
            if (cls.includes('vsidian-heading-line') && !cls.includes('vsidian-heading-inview')) {
              counts.headingLines += 1
            } else if (cls.includes('vsidian-header-')) {
              counts.headerSpans += 1
            } else if (cls.includes('vsidian-strong')) {
              counts.strongSpans += 1
            } else if (cls.includes('vsidian-emphasis')) {
              counts.emphasisSpans += 1
            } else if (cls.includes('vsidian-inline-code')) {
              counts.inlineCodeSpans += 1
            } else if (cls.includes('vsidian-quote-line')) {
              counts.quoteLines += 1
            } else if (cls.includes('vsidian-code-line')) {
              counts.codeLines += 1
            } else if (cls.includes('vsidian-list-line')) {
              counts.listLines += 1
            } else if (cls.includes('vsidian-hr-line')) {
              counts.hrLines += 1
            } else if (cls.includes('vsidian-frontmatter-line')) {
              counts.frontmatterLines += 1
            } else if (cls.includes('vsidian-table-cell')) {
              // #12：单元格内容 mark（cellHeader/align 修饰并入计数，不重复）
              counts.tableCells += 1
            } else if (cls.includes('vsidian-table-line')) {
              // 行级类包含全部表格行；cellHeader/align 修饰行已在前序命中
              counts.tableLines += 1
            }
          } else if (spec.widget !== undefined) {
            counts.taskGlyphs += 1
            if (spec.widget.checked === true) {
              counts.taskChecked += 1
            }
          }
        })
    }
    return counts
  }

  /** reading 侧渲染语义统计（#8：DOM 级计数；虚拟化下仅统计已挂载块，
   *  一致性对拍用小文档（全量挂载）进行） */
  private collectReadingSyntax(): ReadingSyntaxProbe {
    const container = this.readingContainer
    if (!container) {
      return {
        headings: 0,
        strongCount: 0,
        emphasisCount: 0,
        inlineCodeCount: 0,
        blockquoteBlocks: 0,
        codeBlocks: 0,
        hrCount: 0,
        listItems: 0,
        taskCheckboxes: 0,
        taskChecked: 0,
        tables: 0,
      }
    }
    const count = (selector: string): number => container.querySelectorAll(selector).length
    return {
      headings: count(
        '.vsidian-reading-block h1, .vsidian-reading-block h2, .vsidian-reading-block h3, .vsidian-reading-block h4, .vsidian-reading-block h5, .vsidian-reading-block h6',
      ),
      strongCount: count('.vsidian-reading-block strong'),
      emphasisCount: count('.vsidian-reading-block em'),
      inlineCodeCount: count('.vsidian-reading-block code:not(pre code)'),
      blockquoteBlocks: count('.vsidian-reading-block blockquote'),
      codeBlocks: count('.vsidian-reading-block:not(.vsidian-reading-frontmatter) pre'),
      hrCount: count('.vsidian-reading-block hr'),
      listItems: count('.vsidian-reading-block li'),
      taskCheckboxes: count('.vsidian-reading-task-checkbox'),
      taskChecked: Array.from(
        container.querySelectorAll<HTMLInputElement>('.vsidian-reading-task-checkbox'),
      ).filter((b) => b.checked).length,
      // #12：表格语义计数（块级 table 元素；只读呈现）
      tables: count('.vsidian-reading-block table'),
    }
  }

  /** 持久化（合并写入）：seq、viewMode、anchor、sidebarOpen、outlineActive、
   *  outlineExpandLevel（#67 档位全局记忆）共存互不覆盖 */
  private persistState(): void {
    const saved = this.bridge.getState<PersistedState>() ?? {}
    this.bridge.setState({
      ...saved,
      seq: this.seq,
      conflictRevision: this.conflictRevision,
      viewMode: this.viewMode,
      anchor: this.modeAnchor ?? undefined,
      sidebarOpen: this.sidebarOpen,
      outlineActive: this.outlineActive,
      outlineExpandLevel: this.outlineExpandLevel,
      quickActionsOpen: this.quickActionsOpen,
    })
  }

  /** #91 的有效绑定快照调用此入口；操作条不保存另一份默认键位。 */
  setQuickActionBindingHints(resolve: (op: FormatOperationId) => readonly string[]): void {
    this.quickBindingHints = resolve
    this.refreshQuickActions()
  }

  private runFormatOperation(op: FormatOperationId): void {
    this.closeQuickHeadingMenu(false)
    const view = this.view
    if (!view || this.viewMode !== 'live' || this.suspended ||
        view.state.readOnly || !view.state.facet(EditorView.editable)) return
    const range = view.state.selection.main
    const plan = planFormatOperation(view.state.doc.toString(), op,
      { from: range.from, to: range.to }, view.state.field(tableRegionField, false))
    if (plan?.changes.length) {
      view.dispatch({ changes: plan.changes,
        ...(plan.selection ? { selection: plan.selection } : {}) })
    }
    view.focus()
    this.refreshQuickActions()
  }

  private buildQuickActions(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'vsidian-quick-actions'
    bar.id = 'vsidian-quick-actions'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', '格式快速操作')
    const button = (label: string, icon: string, className: string): HTMLButtonElement => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = className
      el.setAttribute('aria-label', label)
      el.title = label
      const glyph = document.createElement('span')
      glyph.setAttribute('aria-hidden', 'true')
      glyph.textContent = icon
      el.appendChild(glyph)
      // 鼠标按下不抢 CM6 焦点；包括标题 popup 与表格矩形选区。
      el.addEventListener('mousedown', (event) => event.preventDefault())
      return el
    }
    const addOperation = (op: FormatOperationId, icon: string): void => {
      const item = FORMAT_OPERATIONS.find((entry) => entry.id === op)!
      const el = button(item.title, icon, 'vsidian-quick-action')
      el.dataset['op'] = op
      el.addEventListener('click', () => this.runFormatOperation(op))
      bar.appendChild(el)
    }
    addOperation('bold', 'B')
    addOperation('italic', 'I')
    addOperation('strikethrough', 'S̶')
    addOperation('inlineCode', '</>')
    const heading = button('标题', 'H⌄', 'vsidian-quick-heading')
    heading.setAttribute('aria-haspopup', 'menu')
    heading.setAttribute('aria-expanded', 'false')
    heading.setAttribute('aria-controls', 'vsidian-quick-heading-menu')
    heading.addEventListener('click', () => this.toggleQuickHeadingMenu())
    bar.appendChild(heading)
    this.quickHeadingBtn = heading
    for (const [op, icon] of [
      ['bulletList', '•'], ['orderedList', '1.'], ['taskList', '☑'], ['quote', '❞'],
      ['codeBlock', '{}'], ['link', '🔗'], ['clearInline', 'Tx'],
    ] as const) addOperation(op, icon)
    const createTable = button('插入表格', '▦', 'vsidian-quick-table')
    createTable.addEventListener('click', () => {
      const view = this.view
      if (view && this.viewMode === 'live' && !this.suspended &&
          !view.state.readOnly && view.state.facet(EditorView.editable)) {
        runCreateTable(view)
        view.focus()
      }
    })
    bar.appendChild(createTable)
    const menu = document.createElement('div')
    menu.className = 'vsidian-quick-heading-menu'
    menu.id = 'vsidian-quick-heading-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', '标题层级')
    menu.hidden = true
    for (const op of [
      'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'headingNone',
    ] as const) {
      const item = FORMAT_OPERATIONS.find((entry) => entry.id === op)!
      const el = button(item.title, op === 'headingNone' ? '正文' : op.replace('heading', 'H'),
        'vsidian-quick-heading-item')
      el.dataset['headingOp'] = op
      el.setAttribute('role', 'menuitemradio')
      el.setAttribute('aria-checked', 'false')
      el.addEventListener('click', () => {
        this.closeQuickHeadingMenu(false)
        this.runFormatOperation(op)
      })
      menu.appendChild(el)
    }
    menu.addEventListener('keydown', (event) => {
      const options = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      if (event.key === 'Escape') {
        event.preventDefault()
        this.closeQuickHeadingMenu(true)
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const index = options.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % options.length
            : (index + options.length - 1) % options.length
        options[next]?.focus()
      }
    })
    bar.appendChild(menu)
    this.quickHeadingMenu = menu
    return bar
  }

  private toggleQuickHeadingMenu(): void {
    const menu = this.quickHeadingMenu
    if (!menu || !this.quickHeadingBtn || this.viewMode !== 'live') return
    if (!menu.hidden) {
      this.closeQuickHeadingMenu(true)
      return
    }
    menu.style.left = `${this.quickHeadingBtn.offsetLeft}px`
    menu.hidden = false
    this.quickHeadingBtn.setAttribute('aria-expanded', 'true')
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }

  private closeQuickHeadingMenu(returnFocus: boolean): void {
    if (this.quickHeadingMenu) this.quickHeadingMenu.hidden = true
    this.quickHeadingBtn?.setAttribute('aria-expanded', 'false')
    if (returnFocus) this.quickHeadingBtn?.focus()
  }

  private applyQuickActionsDom(): void {
    const open = this.quickActionsOpen
    if (this.quickActionsEl) this.quickActionsEl.hidden = !open
    this.quickToggleBtn?.setAttribute('aria-expanded', String(open))
    if (!open) this.closeQuickHeadingMenu(false)
    if (open) this.refreshQuickActions()
  }

  private refreshQuickActions(): void {
    const bar = this.quickActionsEl
    const view = this.view
    if (!bar || !view || !this.quickActionsOpen) return
    const state = view.state
    const range = state.selection.main
    const region = state.field(tableRegionField, false)
    const editable = this.viewMode === 'live' && !this.suspended && !state.readOnly &&
      state.facet(EditorView.editable)
    const tree = state.field(liveDecorationsField).tree
    const readState = createQuickActionStateReader(state.doc, tree,
      { from: range.from, to: range.to }, region ?? null, editable)
    for (const el of bar.querySelectorAll<HTMLButtonElement>('[data-op], [data-heading-op]')) {
      const op = (el.dataset['op'] ?? el.dataset['headingOp']) as FormatOperationId
      const status = readState(op)
      el.disabled = status === 'disabled'
      el.dataset['formatState'] = status
      if (el.hasAttribute('role')) el.setAttribute('aria-checked', String(status === 'active'))
      else el.setAttribute('aria-pressed', status === 'mixed' ? 'mixed' : String(status === 'active'))
      const base = FORMAT_OPERATIONS.find((item) => item.id === op)!.title
      const bindings = this.quickBindingHints(op)
      const keys = bindings.map((key) => key.split('+').map((part) =>
        part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)).join('+'))
      el.title = keys.length ? `${base} (${keys.join('、')})` : base
      if (keys.length) el.setAttribute('aria-description', `快捷键：${keys.join('、')}`)
      else el.removeAttribute('aria-description')
    }
    const headingOptions = [...bar.querySelectorAll<HTMLElement>('[data-heading-op]')]
    this.quickHeadingBtn!.disabled = !editable || headingOptions.every((item) =>
      (item as HTMLButtonElement).disabled)
    bar.querySelector<HTMLButtonElement>('.vsidian-quick-table')!.disabled = !editable
  }

  /** 主编辑区顶栏（#53 图标化）：左端齿轮设置按钮（打开宿主级 Vsidian
   *  设置页面板——webview 无权自建面板，必须经 settings.open 出站），
   *  右端右侧栏切换按钮（margin-left:auto 推靠）。#6 的模式切换按钮已按
   *  #38 迁移至编辑器标题栏三态命令，不在顶栏渲染 */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'vsidian-toolbar'
    const settingsBtn = document.createElement('button')
    settingsBtn.type = 'button'
    settingsBtn.className = 'vsidian-settings-toggle'
    settingsBtn.setAttribute('aria-label', '打开 Vsidian 设置')
    settingsBtn.setAttribute('title', '打开 Vsidian 设置')
    settingsBtn.appendChild(createSettingsGearIcon())
    settingsBtn.addEventListener('click', () => this.bridge.postMessage({ kind: 'settings.open' }))
    const quickBtn = document.createElement('button')
    quickBtn.type = 'button'
    quickBtn.className = 'vsidian-quick-toggle'
    quickBtn.setAttribute('aria-label', '快速操作条')
    quickBtn.setAttribute('title', '快速操作条')
    quickBtn.setAttribute('aria-controls', 'vsidian-quick-actions')
    quickBtn.setAttribute('aria-expanded', 'false')
    quickBtn.textContent = '✎'
    // 与操作条内按钮一致：鼠标展开时保留正文焦点及表格矩形格区。
    // 只拦默认聚焦，不拦 click；Tab 聚焦后 Enter/Space 仍由原生按钮激活。
    quickBtn.addEventListener('mousedown', (event) => event.preventDefault())
    quickBtn.addEventListener('click', () => {
      this.quickActionsOpen = !this.quickActionsOpen
      this.applyQuickActionsDom()
      this.persistState()
    })
    this.quickToggleBtn = quickBtn
    const sidebarBtn = document.createElement('button')
    sidebarBtn.type = 'button'
    sidebarBtn.className = 'vsidian-sidebar-toggle'
    sidebarBtn.setAttribute('aria-controls', 'vsidian-sidebar')
    sidebarBtn.appendChild(createSidebarToggleIcon())
    sidebarBtn.addEventListener('click', () => this.toggleSidebar())
    this.sidebarToggleBtn = sidebarBtn
    bar.appendChild(settingsBtn)
    bar.appendChild(quickBtn)
    bar.appendChild(sidebarBtn)
    return bar
  }

  /** 右侧栏骨架（#53）：自有顶栏（#54 起含「大纲」按钮）+ 折叠滑块行
   *  （#67，outline-active 时显示）+ 面板区域（#54 起含大纲面板容器）。
   *  侧栏显隐由 vsidian-body 的 open 类经 CSS 控制；大纲面板与滑块行显隐
   *  由侧栏容器的 outline-active 类经 CSS 控制 */
  private buildSidebar(): HTMLElement {
    const sidebar = document.createElement('div')
    sidebar.className = 'vsidian-sidebar'
    sidebar.id = 'vsidian-sidebar'
    const bar = document.createElement('div')
    bar.className = 'vsidian-sidebar-toolbar'
    const actions = document.createElement('div')
    actions.className = 'vsidian-sidebar-toolbar-actions'
    // #54 大纲按钮：侧栏顶栏当前唯一一项（点击切换对应面板的显隐）
    const { toggle, panel } = buildOutlineDom()
    toggle.addEventListener('click', () => this.toggleOutline())
    // #66 条目点击跳转 + #67 箭头折叠：面板容器事件委托
    // （renderOutlineItems 重建条目 DOM 不丢监听；条目 DOM 与 outlineItems
    // 同序渲染，DOM 序号即数据索引）。点击按目标分流：箭头 = 单条折叠/
    // 展开（纯视图），文字 = 纯视图定位跳转（零写回、零出站、不入撤销栈）
    panel.addEventListener('click', (event) => {
      // #70：拖拽收尾后浏览器补发的 click 不触发跳转/折叠（只吞一次）
      if (this.outlineSuppressClick) {
        this.outlineSuppressClick = false
        event.stopPropagation()
        return
      }
      const target = event.target as HTMLElement | null
      const chevron = target?.closest?.(`.${OUTLINE_CLASS_NAMES.chevron}`)
      if (chevron instanceof HTMLElement && panel.contains(chevron)) {
        const itemEl = chevron.closest(`.${OUTLINE_CLASS_NAMES.item}`)
        const index = itemEl instanceof HTMLElement
          ? Array.from(
            panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`),
          ).indexOf(itemEl)
          : -1
        if (index >= 0) {
          this.toggleOutlineItemCollapsed(index)
        }
        return
      }
      const item = target?.closest?.(`.${OUTLINE_CLASS_NAMES.item}`)
      if (!(item instanceof HTMLElement) || !panel.contains(item)) {
        return
      }
      const index = Array.from(
        panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`),
      ).indexOf(item)
      if (index >= 0) {
        this.outlineJumpToItem(index)
      }
    })
    // #69 右键菜单：面板容器 contextmenu 委托（与 click 委托同模式——条目
    // DOM 重建不丢监听）。preventDefault 阻断浏览器原生菜单；目标取最近
    // 条目（箭头/文字/标记 span 上右键都算该条目）
    panel.addEventListener('contextmenu', (event) => {
      const target = event.target as HTMLElement | null
      const item = target?.closest?.(`.${OUTLINE_CLASS_NAMES.item}`)
      if (!(item instanceof HTMLElement) || !panel.contains(item)) {
        return
      }
      event.preventDefault()
      const index = Array.from(
        panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`),
      ).indexOf(item)
      if (index >= 0) {
        this.openOutlineMenu(index, event.clientX, event.clientY)
      }
    })
    // #70 拖拽排序：条目 pointerdown 委托（与 click/contextmenu 同模式——
    // 条目 DOM 重建不丢监听）。位移超 4px 才进入拖拽态（点击/箭头操作不受
    // 扰动）；启动即记 doc 锚点快照并校准数据（条目索引与文档坐标对齐）。
    // 命中隐藏条目不启动（折叠遮蔽/搜索过滤的条目不可拖）
    // review-loops 第 2 轮：按下入口清理挂 document capture 层，而非本面板
    // 委托。吞噬标志与残留会话的危害面都是整个 webview 文档——任何 pointerup
    // 都会走到 onOutlineDragEnd 按残留落点写回，任何 click 都可能被残留的
    // 吞噬标志吞掉；而新会话只可能由面板内 pointerdown 启动。capture 先于
    // 本委托兑现，清理后本次按下照常启动新会话
    document.addEventListener('pointerdown', this.outlinePointerdownEntry, true)
    panel.addEventListener('pointerdown', (event) => {
      if (this.view === undefined) {
        return
      }
      // 次指针守卫：只针对**触屏多点**（第二指起 isPrimary=false）——次指针
      // 落在条目上只作无效输入丢弃，否则会直接新建会话、覆盖起始指针的会话
      // （与 document capture 层的残留清理同口径）。判据必须带 pointerType
      // ==='touch' 前提（review-loops 第 4 轮）：`new PointerEvent('pointerdown',
      // {…})` 未显式赋 isPrimary 时引擎默认 false、pointerType 默认空串，只按
      // isPrimary 判会静默拒掉整个合成事件路径（真机鼠标/笔恒 isPrimary=true，
      // 现网不受影响；但未来任何用 PointerEvent 构造拖拽钩子的代码会失效）
      if (event.pointerType === 'touch' && event.isPrimary === false) {
        return
      }
      // 启动判据只看按键位掩码、不限指针类型：触屏接触态 button=0（浏览器
      // 回归实测），照常启动；鼠标右/中键与笔 eraser/barrel（button≥1，按
      // W3C 位掩码）落不进拖拽入口——右键手势走 contextmenu
      if (event.button !== 0) {
        return
      }
      const target = event.target as HTMLElement | null
      const itemEl = target?.closest?.(`.${OUTLINE_CLASS_NAMES.item}`)
      if (!(itemEl instanceof HTMLElement) || !panel.contains(itemEl)) {
        return
      }
      if (itemEl.classList.contains(OUTLINE_CLASS_NAMES.hidden)) {
        return
      }
      const index = Array.from(
        panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`),
      ).indexOf(itemEl)
      if (index < 0) {
        return
      }
      this.outlineEnsureFresh() // 数据与条目 DOM 对齐（拖拽锚点前提）
      if (!panel.contains(itemEl)) {
        return // 校准触发了重建：按下时的元素已脱挂，放弃启动（防错位）
      }
      this.outlineDragState = {
        fromIndex: index,
        doc: this.view.state.doc,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        targetIndex: null,
        position: null,
        hintEl: null,
      }
      document.addEventListener('pointermove', this.onOutlineDragMove)
      document.addEventListener('pointerup', this.onOutlineDragEnd)
      document.addEventListener('pointercancel', this.onOutlineDragCancel)
      document.addEventListener('keydown', this.onOutlineDragEscape, true)
      window.addEventListener('blur', this.onOutlineDragCancel)
    })
    this.outlineToggleBtn = toggle
    this.outlinePanelEl = panel
    actions.appendChild(toggle)
    bar.appendChild(actions)
    // #67 折叠滑块行：顶栏与面板之间（结绳记事六圆点）。点击走行级 click
    // 委托（圆点冒泡；键盘激活圆点的 click 同路）；拖拽走 pointer 事件——
    // 位移超阈值后捕获指针，逐档换算（outlineSliderLevelAt 最近圆点）。
    // 捕获后 click 目标变为行自身（圆点落空），拖拽选档不会双发
    const slider = buildOutlineSlider(this.outlineExpandLevel, outlineExpandLevelLabel)
    slider.row.addEventListener('click', (event) => {
      const dot = (event.target as HTMLElement | null)?.closest?.(
        `.${OUTLINE_CLASS_NAMES.sliderDot}`,
      )
      if (dot instanceof HTMLButtonElement) {
        const level = Number(dot.dataset['vsidianLevel'])
        if (Number.isInteger(level)) {
          this.setOutlineExpandLevel(level)
        }
      }
    })
    let dragStartX: number | null = null
    let dragging = false
    slider.row.addEventListener('pointerdown', (event) => {
      // 启动判据与面板条目入口同口径（review-loops 第 4 轮对齐）：只看法定
      // 按键（非主键不武装起始坐标），不设指针类型前提——旧判据带
      // pointerType==='mouse' 前缀，笔 barrel（button=2/buttons=2）据此在滑块
      // 行上会武装拖拽起点（实害有限：移动路径的 (buttons & 1) === 0 兜住
      // 后续推进；对齐后连起点都不再武装，且与其余三处判据同一条不变式）
      if (event.button !== 0) {
        return
      }
      dragStartX = event.clientX
      dragging = false
    })
    slider.row.addEventListener('pointermove', (event) => {
      if (dragStartX === null || (event.buttons & 1) === 0) {
        return
      }
      if (!dragging && Math.abs(event.clientX - dragStartX) > 4) {
        dragging = true
        slider.row.setPointerCapture(event.pointerId)
      }
      if (dragging) {
        const level = outlineSliderLevelAt(slider, event.clientX, this.outlineExpandLevel)
        if (level !== this.outlineExpandLevel) {
          this.setOutlineExpandLevel(level)
        }
      }
    })
    const endSliderDrag = (): void => {
      dragStartX = null
      dragging = false
    }
    slider.row.addEventListener('pointerup', endSliderDrag)
    slider.row.addEventListener('pointercancel', endSliderDrag)
    this.outlineSlider = slider
    // #68 工具条行：侧栏顶栏与滑块行之间（跳转到末尾、重置、搜索框）。
    // 按钮与输入均为纯视图操作（零写回、零出站、不入撤销栈）；搜索输入
    // 即时生效（input 事件直调，无去抖）
    const toolbar = buildOutlineToolbar()
    toolbar.jumpBottom.addEventListener('click', () => this.outlineJumpToBottom())
    toolbar.reset.addEventListener('click', () => this.resetOutline())
    toolbar.search.addEventListener('input', () => this.setOutlineSearch(toolbar.search.value))
    this.outlineToolbar = toolbar
    const panelHost = document.createElement('div')
    panelHost.className = 'vsidian-sidebar-panel'
    panelHost.appendChild(panel)
    sidebar.appendChild(bar)
    sidebar.appendChild(toolbar.row)
    sidebar.appendChild(slider.row)
    sidebar.appendChild(panelHost)
    return sidebar
  }

  /** 侧栏切换（#53）：纯视图状态翻转（零写回、零出站），随后落 DOM 与持久化 */
  private toggleSidebar(): void {
    this.sidebarOpen = !this.sidebarOpen
    this.applySidebarDom()
    // 展开即见大纲：面板从不可见到可见，数据可能滞后（收起期间无刷新调度）
    if (this.sidebarOpen && this.outlineActive) {
      this.outlineEnsureFresh()
    } else if (!this.sidebarOpen) {
      this.cancelOutlineRefresh()
      this.cancelOutlineHighlightUpdate()
      // #69：侧栏收起时浮层（菜单）与重命名编辑态随之退出
      this.closeOutlineMenu()
      this.cancelOutlineRename()
      // #70：拖拽会话随之退出（面板不可见，落点失去意义）
      this.cancelOutlineDrag()
    }
  }

  /** 侧栏状态落 DOM：body 容器的 open 类（CSS 显隐与图标粗细的唯一开关）
   *  与切换按钮的可访问名称同步（名称反映当前可执行的动作） */
  private applySidebarDom(): void {
    if (this.bodyEl) {
      this.bodyEl.classList.toggle('vsidian-sidebar-open', this.sidebarOpen)
    }
    const btn = this.sidebarToggleBtn
    if (btn) {
      const label = this.sidebarOpen ? '收起右侧栏' : '展开右侧栏'
      btn.setAttribute('aria-label', label)
      btn.setAttribute('title', label)
      btn.setAttribute('aria-expanded', String(this.sidebarOpen))
    }
    this.persistState()
  }

  // ---- 大纲面板（#54）----
  // 与 sidebarOpen / viewMode 同类：纯 webview 视图状态（零写回、零出站、
  // 不入撤销栈），经 bridge state 持久化。数据源是 CM6 全文（含未保存编辑），
  // 与视口渲染、live/reading 模式均无关（CM6 doc 在两模式下都是权威文本模型）。

  /** 大纲按钮点击：active 翻转后落 DOM；再激活时校准数据（隐藏期间无调度） */
  private toggleOutline(): void {
    this.outlineActive = !this.outlineActive
    this.applyOutlineDom()
    if (this.outlineActive) {
      this.outlineEnsureFresh()
    } else {
      this.cancelOutlineRefresh()
      this.cancelOutlineHighlightUpdate()
      // #69：面板关闭时浮层（菜单）与重命名编辑态随之退出
      this.closeOutlineMenu()
      this.cancelOutlineRename()
      // #70：拖拽会话随之退出（面板不可见，落点失去意义）
      this.cancelOutlineDrag()
    }
  }

  /** 大纲状态落 DOM：侧栏容器的 outline-active 类是面板显隐唯一开关
   *  （CSS 控制；与 #53 的 sidebar-open 类同模式），按钮 aria-expanded 同步 */
  private applyOutlineDom(): void {
    if (this.sidebarEl) {
      this.sidebarEl.classList.toggle('vsidian-outline-active', this.outlineActive)
    }
    this.outlineToggleBtn?.setAttribute('aria-expanded', String(this.outlineActive))
    this.persistState()
  }

  /** 大纲面板当前是否用户可见（可见才值得去抖重算；不可见时数据由
   *  view.state 回报前的即时校准兜底） */
  private outlineVisible(): boolean {
    return this.sidebarOpen && this.outlineActive
  }

  /** 取消未决的去抖回调：面板已不可见（侧栏收起或面板关闭）时，迟到触发
   *  只会在隐藏面板上做无谓解析与 DOM 重建——重开路径有校准兜底 */
  private cancelOutlineRefresh(): void {
    if (this.outlineTimer !== undefined) {
      clearTimeout(this.outlineTimer)
      this.outlineTimer = undefined
    }
  }

  /** 文档变化后的去抖刷新调度：仅可见时开启，避免不可见面板伴随每次按键
   *  解析；连续输入只在停顿后解析一次（尾随去抖：定时器随每次调用重置） */
  private scheduleOutlineRefresh(): void {
    if (this.outlineTimer !== undefined) {
      clearTimeout(this.outlineTimer)
    }
    this.outlineTimer = setTimeout(() => {
      this.outlineTimer = undefined
      this.outlineEnsureFresh()
    }, 250)
  }

  /**
   * 大纲新鲜度校准（与 #14 查找的 findEnsureFresh 同模式）：Text 引用比较
   * 判过期，过期则解析。解析复用 liveDecorationsField 维护的增量解析树
   * （TreeFragment.applyChanges + addTree 随每笔文档事务增量更新，见
   * liveDecorations.ts）：该树与当前 state.doc 同步，大纲直接取用，不在
   * 去抖定时器里再做一次全量 parse（10 万行文档全量解析约 256ms，是
   * 主线程卡顿级；增量树的语义等价由单测对照钉住）。field 恒随
   * livePreviewDecorations 装配（extensions 无条件注册），取不到时由
   * extractOutline 内部回退全量解析（防御路径）。序列（级别 + 文字）
   * 未变时只更新数据（行号），不重建条目 DOM——正文编辑不触碰大纲 DOM。
   * #67 序列变化重建时展开集合经 diff 迁移（重命名不扰动、删除丢键、
   * 新增/升格父自动展开——刷新存活，见 outlineCollapse 模块头）。
   */
  private outlineEnsureFresh(): void {
    const view = this.view
    const doc = view?.state.doc
    if (!view || !doc || this.outlineDoc === doc) {
      return
    }
    const firstRender = this.outlineDoc === null // 从未渲染：首场必落 DOM（含空态占位）
    this.outlineDoc = doc
    const tree = view.state.field(liveDecorationsField, false)?.tree
    const items = extractOutline(doc, tree)
    const changed = firstRender || !outlineItemsEqual(items, this.outlineItems)
    const prevItems = this.outlineItems
    const prevExpanded = this.outlineExpanded
    this.outlineItems = items
    this.outlineFacts = outlineCollapseFacts(items)
    if (firstRender || prevItems.length === 0) {
      // 首场或旧序列为空（空文档、或真实宿主装载期先在初始空 doc 上跑过
      // 首场——重载恢复实测路径）：没有可迁移的折叠状态，按档位精确集
      // 初始化（手动折叠是会话态，重载后从这里重置）
      this.outlineExpanded = outlineExpandSetForLevel(items, this.outlineExpandLevel)
      // #68：同场景没有可迁移的搜索快照，快照与档位精确集对齐（清空
      // 回放与档位指示一致）
      if (this.outlineExpandedBeforeSearch !== null) {
        this.outlineExpandedBeforeSearch = outlineExpandSetForLevel(items, this.outlineExpandLevel)
      }
    } else {
      // fallbackLevel 传当前档位（review-loops C2 熔断回退贴近用户意图）
      this.outlineExpanded = migrateOutlineExpanded(
        prevItems, items, prevExpanded, this.outlineExpandLevel,
      )
      // #68：搜索展开快照随编辑同款迁移（重命名/增删不扰动清空回放的
      // 目标视图——快照与展开集是同一坐标系的两个视图）
      if (this.outlineExpandedBeforeSearch !== null) {
        this.outlineExpandedBeforeSearch = migrateOutlineExpanded(
          prevItems,
          items,
          this.outlineExpandedBeforeSearch,
          this.outlineExpandLevel,
        )
      }
    }
    if (changed && this.outlinePanelEl) {
      // #69：条目 DOM 重建使菜单锚点与重命名编辑态过期——先关闭再重建
      // （重命名提交路径已在 finishOutlineRename 先清状态，此处无重入）
      this.closeOutlineMenu()
      // review-loops 第 3 轮：编辑态被重建丢弃要留痕（与提交路径同口径）
      // ——输入框随重建消失且零写回，无诊断时用户无从判断为何没生效
      if (this.outlineRenameIndex !== null) {
        console.warn('[vsidian] 大纲重命名放弃：文档外部改写，重命名编辑态随条目重建退出')
      }
      this.outlineRenameIndex = null
      this.outlineRenameDoc = null
      // #70：条目 DOM 重建使拖拽锚点与落点指示过期——取消拖拽（零写回；
      // 写回路径自身即时 ensureFresh 时序列未变不进此分支，拖拽不被误杀）
      this.cancelOutlineDrag()
      // #68 搜索态：重建后按当前词条重算过滤（新序列的命中链并入展开集）
      if (this.outlineSearchState !== null) {
        this.applyOutlineSearch()
      } else {
        renderOutlineItems(this.outlinePanelEl, items, this.outlineFacts.hasChildren)
        this.applyOutlineCollapseDom()
      }
    } else if (this.outlineExpanded !== prevExpanded) {
      // 序列未变但展开集合被迁移修正（safeFilter 等）：状态类跟随
      this.applyOutlineCollapseDom()
    }
    // #66：文档变化后行号随编辑漂移（序列未变也可能），统一重算并重施加
    // 高亮——重建路径丢了类、未重建路径行号变了也要重定位控制域；
    // #67：重算含 only-expand（located 被折叠遮蔽时展开祖先链）
    this.updateOutlineLocated()
  }

  // ---- 大纲折叠状态机落 DOM（#67）----
  // 状态载体是 outlineExpanded（父节点索引集合）+ outlineExpandLevel（档位，
  // 持久化）；推导纯函数见 outlineCollapse.ts。DOM 上三类状态类：hidden
  // （折叠遮蔽，display:none）、collapsed（折叠中的父节点，箭头旋转）、
  // located（高亮，施加在可见代表上——被遮蔽时为第一个可见祖先）。

  /** 滑块选档：档位记录 + 展开集整体替换为档位精确集（手动微调不保留），
   *  圆点 active 类与可访问状态同步，高亮代表可能变化（重施加）。
   *  #68 搜索态：档位精确集作为新基准（清空回放的快照同步替换——回放
   *  后与档位指示一致），展开集再并入命中祖先链（命中路径保持可见） */
  private setOutlineExpandLevel(level: number): void {
    const next = Math.max(0, Math.min(5, Math.floor(level)))
    this.outlineExpandLevel = next
    const base = outlineExpandSetForLevel(this.outlineItems, next)
    const search = this.outlineSearchState
    if (search !== null) {
      if (this.outlineExpandedBeforeSearch !== null) {
        this.outlineExpandedBeforeSearch = base
      }
      this.outlineExpanded = new Set(
        outlineSearchExpandSet(this.outlineItems, base, search.matchedIndices),
      )
    } else {
      this.outlineExpanded = base
    }
    if (this.outlineSlider) {
      applyOutlineSliderState(this.outlineSlider, next)
    }
    this.applyOutlineCollapseDom()
    this.applyOutlineHighlight()
    this.persistState()
  }

  /** 手动折叠/展开单条（箭头点击）：非父节点忽略；会话态不持久化 */
  private toggleOutlineItemCollapsed(index: number): void {
    if (this.outlineFacts.hasChildren[index] !== true) {
      return
    }
    const next = new Set(this.outlineExpanded)
    if (next.has(index)) {
      next.delete(index)
    } else {
      next.add(index)
    }
    this.outlineExpanded = next
    this.applyOutlineCollapseDom()
    this.applyOutlineHighlight()
  }

  /** 折叠可见性落 DOM：hidden/collapsed 类与箭头 aria-expanded（条目 DOM
   *  与 outlineItems 同序的不变式下按序 toggle；toggle 幂等）。
   *  #68 搜索态下 hidden = 折叠遮蔽 ∨ 搜索过滤（组合可见口径，同一
   *  display:none 类承载），无匹配时挂「无匹配」占位 */
  private applyOutlineCollapseDom(): void {
    const panel = this.outlinePanelEl
    if (!panel) {
      return
    }
    const hidden = outlineHiddenFlags(this.outlineItems, this.outlineExpanded)
    const search = this.outlineSearchState
    const nodes = panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i]!
      const isParent = this.outlineFacts.hasChildren[i] === true
      const collapsed = isParent && !this.outlineExpanded.has(i)
      el.classList.toggle(OUTLINE_CLASS_NAMES.collapsed, collapsed)
      el.classList.toggle(
        OUTLINE_CLASS_NAMES.hidden,
        hidden[i] === true || (search !== null && !search.kept[i]),
      )
      const chevron = el.querySelector<HTMLButtonElement>(`.${OUTLINE_CLASS_NAMES.chevron}`)
      if (chevron) {
        chevron.setAttribute('aria-expanded', String(!collapsed))
      }
    }
    // 「无匹配」占位：有词条但零命中（空序列的「无标题」占位由
    // renderOutlineItems 承担，两者互斥）；renderOutlineItems 重建会清掉
    // 占位元素，此处在每条折叠落 DOM 路径上幂等补挂
    const nomatch = search !== null && search.noMatch && this.outlineItems.length > 0
    let placeholder = panel.querySelector<HTMLElement>(`.${OUTLINE_CLASS_NAMES.nomatch}`)
    if (nomatch && !placeholder) {
      placeholder = document.createElement('div')
      placeholder.className = OUTLINE_CLASS_NAMES.nomatch
      placeholder.textContent = '无匹配'
      panel.appendChild(placeholder)
    } else if (!nomatch && placeholder) {
      placeholder.remove()
    }
  }

  /** only-expand（滚动动态展开/跳转落位共用）：目标被折叠遮蔽时并入其
   *  祖先链（只增不减，其他折叠区不动），展开集合变化才重施加状态类 */
  private revealOutlineIndex(index: number): void {
    const next = outlineExpandAncestors(this.outlineItems, this.outlineExpanded, index)
    if (next !== this.outlineExpanded) {
      this.outlineExpanded = next
      this.applyOutlineCollapseDom()
    }
  }

  // ---- 大纲右键菜单与重命名（#69）----
  // 菜单是 webview 自绘浮层（挂侧栏内 absolute，不触 CM6）：结构命令消费
  // 折叠状态机（纯视图）；复制经宿主剪贴板消息桥（clipboard.write）；调级/
  // 重命名/删除是写操作——文本变换由 outlineSection 产出 SerChange，一次
  // CM6 事务 dispatch（单笔 edit.request = 宿主撤销一次），写后即时校准
  // 大纲（不等 250ms 去抖，票面「写回后大纲与正文即时一致」）。

  /** 打开菜单（先关旧菜单与重命名态）。定位：挂载后量尺寸，侧栏坐标系
   *  内 clamp + 点击点落在目标条目内时让位到条目下方（不遮挡目标） */
  private openOutlineMenu(index: number, clientX: number, clientY: number): void {
    const sidebar = this.sidebarEl
    const panel = this.outlinePanelEl
    const item = panel?.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)[index]
    if (!sidebar || !panel || !item || !this.view) {
      return
    }
    // review-loops B4：拖拽进行中右键可达此（contextmenu 委托不查拖拽态），
    // 先取消拖拽防两会话并存的指示混乱（数据由锚点防御兜底）
    this.cancelOutlineDrag()
    this.closeOutlineMenu()
    this.cancelOutlineRename()
    const hasChildren = this.outlineFacts.hasChildren[index] === true
    const menu = buildOutlineMenu(outlineMenuSpec(hasChildren), (command) => {
      this.runOutlineMenuCommand(command)
    })
    this.outlineMenuEl = menu
    this.outlineMenuIndex = index
    this.outlineMenuDoc = this.view.state.doc
    sidebar.appendChild(menu)
    // 定位（jsdom 无布局时退化为左上角；真宿主见 outlineMenuPosition 契约）
    const bounds = sidebar.getBoundingClientRect()
    const targetRect = item.getBoundingClientRect()
    const size = { w: menu.offsetWidth || 200, h: menu.offsetHeight || 260 }
    const pos = outlineMenuPosition(
      { x: clientX, y: clientY },
      size,
      { left: bounds.left, top: bounds.top, width: bounds.width || 280, height: bounds.height || 560 },
      { top: targetRect.top, bottom: targetRect.bottom },
    )
    menu.style.left = `${Math.max(0, pos.left - bounds.left)}px`
    menu.style.top = `${Math.max(0, pos.top - bounds.top)}px`
    // 关闭通道：菜单外 pointerdown（capture，含其他面板区域）与 Esc
    this.outlineMenuDismissPointer = (e) => {
      if (menu.contains(e.target as Node)) {
        return
      }
      this.closeOutlineMenu()
    }
    this.outlineMenuDismissKey = (e) => {
      if (e.key === 'Escape') {
        this.closeOutlineMenu()
      }
    }
    document.addEventListener('pointerdown', this.outlineMenuDismissPointer, true)
    document.addEventListener('keydown', this.outlineMenuDismissKey, true)
  }

  /** 关闭菜单（幂等；摘除 document 关闭监听） */
  private closeOutlineMenu(): void {
    if (this.outlineMenuDismissPointer) {
      document.removeEventListener('pointerdown', this.outlineMenuDismissPointer, true)
      this.outlineMenuDismissPointer = undefined
    }
    if (this.outlineMenuDismissKey) {
      document.removeEventListener('keydown', this.outlineMenuDismissKey, true)
      this.outlineMenuDismissKey = undefined
    }
    this.outlineMenuEl?.remove()
    this.outlineMenuEl = undefined
    this.outlineMenuIndex = null
    this.outlineMenuDoc = null
  }

  /** 菜单命令分派：结构命令/复制/调级/删除/重命名（见模块头） */
  private runOutlineMenuCommand(command: OutlineMenuCommand): void {
    const index = this.outlineMenuIndex
    const view = this.view
    if (index === null || index >= this.outlineItems.length || !view) {
      this.closeOutlineMenu()
      return
    }
    // 锚点过期防御：菜单打开期间文档被外部变更改写（ensureFresh 会关菜单，
    // 此处是竞态兜底）——坐标与行号失效，放弃执行
    if (this.outlineMenuDoc !== view.state.doc) {
      this.closeOutlineMenu()
      return
    }
    if (command === 'rename') {
      const target = index
      this.closeOutlineMenu()
      this.startOutlineRename(target)
      return
    }
    this.closeOutlineMenu()
    const doc = view.state.doc
    if (command === 'expandRecursively' || command === 'collapseSiblings' || command === 'expandSiblings') {
      const next = outlineStructuralExpand(command, this.outlineItems, this.outlineExpanded, index)
      if (next !== this.outlineExpanded) {
        this.outlineExpanded = next
        this.applyOutlineCollapseDom()
        this.applyOutlineHighlight()
      }
      return
    }
    if (command === 'copyHeading' || command === 'copySiblings' || command === 'copyChildren' || command === 'copySection') {
      const kind = command === 'copyHeading' ? 'heading'
        : command === 'copySiblings' ? 'siblings'
          : command === 'copyChildren' ? 'children' : 'section'
      const text = outlineCopyText(kind, doc, this.outlineItems, index)
      if (text !== null) {
        this.bridge.postMessage({ kind: 'clipboard.write', text })
      }
      return
    }
    if (command === 'copyLink') {
      // `[[笔记名#标题]]` 的拼接在宿主侧（docUri 取笔记名）。标题取条目原文
      // （OutlineItem.text，含行内标记）——宿主 findHeadingOffset 按标题行
      // 字面文本比较，两侧口径同源才能定位回原标题；剥标记可见文本只用于
      // 「复制标题」（copyHeading，纯文本场景）
      this.bridge.postMessage({
        kind: 'clipboard.write',
        linkHeading: { docUri: this.docUri, heading: this.outlineItems[index]!.text },
      })
      return
    }
    if (command === 'levelUp' || command === 'levelUpRecursive' || command === 'levelDown' || command === 'levelDownRecursive') {
      const delta: -1 | 1 = command.startsWith('levelUp') ? 1 : -1
      const recursive = command.endsWith('Recursive')
      this.applyOutlineEdits(outlineLevelChanges(doc, this.outlineItems, index, delta, recursive))
      return
    }
    if (command === 'delete') {
      const change = outlineDeleteChange(doc, this.outlineItems, index)
      this.applyOutlineEdits(change ? [change] : null)
    }
  }

  /** 写操作落 CM6（单事务 = 单笔 edit.request = 撤销一次）；写后即时校准
   *  大纲（折叠状态经 #67 迁移机制存活）。null/空变更静默忽略（钳制等） */
  private applyOutlineEdits(changes: ReadonlyArray<{ offset: number; length: number; text: string }> | null): void {
    const view = this.view
    if (!view || !changes || changes.length === 0) {
      return
    }
    // review-loops C3：「升序互不重叠」是全部大纲写计划生成端的约定，但
    // CM6 ChangeSet 对乱序/重叠段不报错而是 flush 合成（静默错位写入权威
    // 文档）——运行时断言兜底：违例放弃并留诊断（与 confirmSentTxn 的
    // 显式排序同根约束）。判据抽成纯函数以便直接单测（review-loops 第 2 轮）
    if (!outlineChangesOrdered(changes)) {
      console.error(
        `[vsidian] 大纲写回变更段违例（升序互不重叠）：${JSON.stringify(changes)}，放弃写回`,
      )
      // 放弃路径也要回到展示态：调用方（重命名提交）已清编辑态状态，
      // 条目 DOM 里的 input 若不重建会卡在编辑态（review-loops 第 2 轮）
      this.rebuildOutlineItemsDom()
      return
    }
    try {
      view.dispatch({
        changes: changes.map((c) => ({ from: c.offset, to: c.offset + c.length, insert: c.text })),
      })
    } catch (error) {
      // review-loops C6：越界坐标等异常若逃逸只在监听器里静默吞掉——
      // 留诊断线索（大纲与正文不同步时可定位）
      console.error('[vsidian] 大纲写回 dispatch 失败（变更段与当前文档不匹配）', error)
      this.rebuildOutlineItemsDom()
      return
    }
    this.outlineEnsureFresh()
  }

  /** 条目行内重命名编辑态：条目内容区替换为 input（值 = 原文 text——行内
   *  标记是资产，编辑原文不剥标记）。Enter 提交 / Esc 取消 / 失焦提交；
   *  input 上的 click 与 keydown 不外冒（不触发跳转与正文快捷键） */
  private startOutlineRename(index: number): void {
    const panel = this.outlinePanelEl
    const item = this.outlineItems[index]
    const el = panel?.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)[index]
    if (!panel || !item || !el) {
      return
    }
    this.cancelOutlineRename()
    this.outlineRenameIndex = index
    this.outlineRenameDoc = this.view?.state.doc ?? null
    const input = document.createElement('input')
    input.type = 'text'
    input.className = OUTLINE_MENU_CLASS_NAMES.renameInput
    input.value = item.text
    input.setAttribute('aria-label', '重命名标题')
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        this.finishOutlineRename(true)
      } else if (event.key === 'Escape') {
        this.finishOutlineRename(false)
      }
    })
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('pointerdown', (event) => event.stopPropagation())
    input.addEventListener('contextmenu', (event) => event.stopPropagation())
    input.addEventListener('focusout', () => this.finishOutlineRename(true))
    // 内容区替换：保留 chevron/spacer（文字对齐锚），其余（含文本节点）移除
    const keep = el.querySelector(`.${OUTLINE_CLASS_NAMES.chevron}, .${OUTLINE_CLASS_NAMES.chevronSpacer}`)
    el.replaceChildren(...(keep ? [keep] : []), input)
    input.focus()
    input.select()
  }

  /** 结束重命名编辑态：commit=true 整标题行替换写回（Setext → ATX 单行）；
   *  false 取消（零写回）。状态先清空（focusout/Enter 双路径防重入） */
  private finishOutlineRename(commit: boolean): void {
    const index = this.outlineRenameIndex
    if (index === null) {
      return
    }
    this.outlineRenameIndex = null
    const input = this.outlinePanelEl?.querySelector<HTMLInputElement>(
      `.${OUTLINE_MENU_CLASS_NAMES.renameInput}`,
    )
    const newText = input?.value ?? ''
    const item = this.outlineItems[index]
    const view = this.view
    // 锚点防御（review-loops C1，与菜单/拖拽同口径）：重命名打开期间文档
    // 被改写（同文件多面板/git checkout 等）则行号过期，提交会改写错误
    // 行——放弃提交视作取消（零写回）。第 2 轮：**内容等价**（doc.eq）的
    // 全文重置（宿主 resync/init 重发同一文本）行号并不过期，不得误放弃
    const docAnchored = view !== undefined && this.outlineRenameDoc !== null &&
      (view.state.doc === this.outlineRenameDoc || view.state.doc.eq(this.outlineRenameDoc))
    // 放弃要留痕：输入被丢弃且零写回，无诊断时用户无从判断为何没生效
    if (commit && item && newText !== item.text && !docAnchored) {
      console.warn('[vsidian] 大纲重命名放弃：编辑期间文档已被改写（行号锚点过期）')
    }
    this.outlineRenameDoc = null
    if (commit && input && item && view && newText !== item.text && docAnchored) {
      const change = outlineRenameChange(view.state.doc, this.outlineItems, index, newText)
      if (change) {
        this.applyOutlineEdits([change]) // 内部 ensureFresh 重建条目（input 随之消失）
        return
      }
    }
    this.rebuildOutlineItemsDom()
  }

  /** 取消重命名编辑态（外部交互转移焦点时的兜底；不写回） */
  private cancelOutlineRename(): void {
    if (this.outlineRenameIndex === null) {
      return
    }
    this.finishOutlineRename(false)
  }

  /** 重建条目 DOM（重命名取消后恢复展示态；与 ensureFresh 的重建同构）。
   *  review-loops 第 2 轮：重建即取消拖拽会话——条目 DOM 被替换后 dragging
   *  提示与 hintEl 都指向脱挂节点，会话继续存活会留下「指示消失但拖拽仍在」
   *  的失同步态（与 ensureFresh changed 分支同口径）
   *  review-loops 第 3 轮：搜索态下重建必须重放命中高亮——命中区间取自
   *  outlineSearchState 缓存（与条目序列同一次计算、同长对齐），只是把
   *  同一次渲染补上 hits 参数：不追加第二次重建，也不走 applyOutlineSearch
   *  （那里会重算过滤并再渲染一遍），无递归风险 */
  private rebuildOutlineItemsDom(): void {
    const panel = this.outlinePanelEl
    if (!panel) {
      return
    }
    this.cancelOutlineDrag()
    renderOutlineItems(panel, this.outlineItems, this.outlineFacts.hasChildren,
      this.outlineSearchState?.ranges)
    this.applyOutlineCollapseDom()
    this.applyOutlineHighlight()
  }

  // ---- 大纲拖拽排序（#70）----
  // 移动原子 = 控制域（outlineDrag.ts 的移动计划纯函数单一事实源）；一次
  // 拖拽 = 一次 CM6 事务 dispatch（applyOutlineEdits，单笔 edit.request =
  // 宿主撤销一次），写后即时 ensureFresh（折叠/搜索/高亮随 #67 迁移与
  // #68 重算自动存活）。交互链路：条目 pointerdown 记锚点 → 超阈值
  // pointermove 进入拖拽态并逐次计算落点（三态命中 + 有效性）→ pointerup
  // 写回 / Esc·pointercancel 取消。落点指示是纯类切换（dragging 源条目
  // 弱化 + drop-before/after 插入线 + drop-inside 包裹高亮），拖拽期间
  // 条目 DOM 不重建（锚点防御兜底）。不可见条目（折叠遮蔽/搜索过滤）
  // 不构成合法落点——用户看不到的位置不构成拖拽意图。

  /** 拖拽 pointermove：超阈值进入拖拽态；计算落点并施加指示类。
   *  命中目标优先取事件目标链（合成事件路径），真实布局回退
   *  elementFromPoint（指针物理位置）。
   *  review-loops 第 2 轮：只认起始指针（pointerId 不符即忽略），且按键已
   *  释放（buttons=0）说明手势在 webview 之外结束——立即取消，避免纯悬停
   *  继续推进会话、画出落点指示，或让随后的释放被当作 drop 写回
   *  review-loops 第 2 轮补（和弦按键）：非主键按下即结束会话。和弦按键
   *  （左键按住时再按右键）不投递 pointerdown——浏览器只在首个按键按下时
   *  报 pointerdown，第二个按键只报 pointermove(button=2, buttons=3)，其
   *  释放也不是 pointerup。若左键先松，右键抬起会成为最后一个按键的真实
   *  pointerup（button=2, buttons=0，且 pointerId 与起始指针相同），残留会话
   *  即按残留落点写出 drop（实测一次误写回）。故该判据只能落在移动路径上；
   *  不变式：仅主键（左键）释放执行落点写回
   *  review-loops 第 3 轮：判据只按 buttons 位掩码、不限指针类型——按 W3C
   *  位掩码，笔的 barrel 键是 bit1（按下 button=2/buttons=2，接触期间按下则
   *  buttons=3），旧判据以 pointerType==='mouse' 为前提，笔据此绕过守卫
   *  （同第 2 轮鼠标和弦的失效模式换输入类别）。接触态的 buttons 只含 bit0
   *  （触屏实测 pointermove buttons=1；笔接触态按 W3C 同为 1），按掩码换算
   *  不进此分支 */
  private readonly onOutlineDragMove = (event: PointerEvent): void => {
    const drag = this.outlineDragState
    const panel = this.outlinePanelEl
    if (!drag || !panel || event.pointerId !== drag.pointerId) {
      return
    }
    // bit0（接触/左键）之外的任一位落下（鼠标右/中键、笔 barrel）即证明
    // 手势意图已变：结束会话（与面板 pointerdown 的启动判据同口径）
    if ((event.buttons & ~1) !== 0) {
      this.cancelOutlineDrag()
      return
    }
    if (event.buttons === 0) {
      this.cancelOutlineDrag()
      return
    }
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) {
        return
      }
      drag.moved = true
      // review-loops C4：源条目提示只在进入拖拽态时施加一次（原先每 move
      // 全量循环 toggle/removeClassList，数千条目 × 60-120Hz 掉帧）
      const src = panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)[drag.fromIndex]
      src?.classList.add(OUTLINE_CLASS_NAMES.dragging)
    }
    // 落点指示增量化：只清上一个指示元素（全量清除留给收尾兜底）
    drag.hintEl?.classList.remove(
      OUTLINE_CLASS_NAMES.dropBefore,
      OUTLINE_CLASS_NAMES.dropAfter,
      OUTLINE_CLASS_NAMES.dropInside,
    )
    drag.hintEl = null
    drag.targetIndex = null
    drag.position = null
    const nodes = panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)
    const hit = (event.target as Element | null)?.closest?.(`.${OUTLINE_CLASS_NAMES.item}`)
      ?? document.elementFromPoint?.(event.clientX, event.clientY)?.closest(`.${OUTLINE_CLASS_NAMES.item}`)
    if (!(hit instanceof HTMLElement) || !panel.contains(hit)) {
      return
    }
    if (hit.classList.contains(OUTLINE_CLASS_NAMES.hidden)) {
      return // 不可见条目不作为落点（口径见区块头）
    }
    const index = Array.from(nodes).indexOf(hit)
    if (index < 0 || !outlineDropAllowed(this.outlineItems, drag.fromIndex, index)) {
      return // 拖入自身控制域内部：无有效落点（不显示指示、drop 无写回）
    }
    const rect = hit.getBoundingClientRect()
    if (rect.height <= 0) {
      return // 无布局环境（防御）：几何不可知，不构成落点
    }
    const position = outlineDropPositionAt(rect.top, rect.height, event.clientY)
    drag.targetIndex = index
    drag.position = position
    drag.hintEl = hit
    hit.classList.add(
      position === 'before' ? OUTLINE_CLASS_NAMES.dropBefore
        : position === 'after' ? OUTLINE_CLASS_NAMES.dropAfter
          : OUTLINE_CLASS_NAMES.dropInside,
    )
  }

  /** 拖拽 pointerup：有效落点执行移动计划写回（一次编辑事务）；锚点过期
   *  （拖拽期间文档被改写）放弃。收尾后吞一次补发 click。
   *  review-loops 第 2 轮：只认起始指针的释放（other pointer 的 up 不收尾，
   *  避免「窗口外按下后拖入 webview」的异指针手势误判为 drop）
   *  review-loops 第 2 轮补（和弦按键）：纵深防线——仅主键（左键）释放执行
   *  drop。和弦路径下右键抬起会以起始指针的 pointerId 送来真实 pointerup
   *  （button=2, buttons=0，见 onOutlineDragMove 的和弦守卫）；合成事件或
   *  其他路径送来非主键释放时同样不得按残留落点写回，会话留给主键释放收尾
   *  review-loops 第 3 轮：判据只按 button、不限指针类型——笔的 barrel 键
   *  释放同样是 button=2（同上，旧判据的 mouse 前提会放它过闸） */
  private readonly onOutlineDragEnd = (event: PointerEvent): void => {
    const drag = this.outlineDragState
    if (!drag || event.pointerId !== drag.pointerId) {
      return
    }
    // 仅主键（button=0）释放收尾：非主键释放（鼠标右/中键、笔 barrel）既不
    // 收尾也不写回（与移动路径守卫同口径）
    if (event.button !== 0) {
      return
    }
    const perform = drag.moved && drag.targetIndex !== null && drag.position !== null
    const { fromIndex, targetIndex, position, doc: snapshot } = drag
    this.cancelOutlineDrag()
    if (!perform) {
      return
    }
    this.outlineSuppressClick = true
    // 锚点防御（#69 菜单同思路；第 3 轮与重命名提交路径同口径）：拖拽期间
    // doc 被改写则索引与坐标失效；但**内容等价**的全文重置（宿主 resync/init
    // 重发同一文本）只是换了 Text 实例、行号并未过期，不得误放弃。放弃留痕
    // （与重命名同口径），否则用户只看到「拖了没反应」
    const doc = this.view?.state.doc
    if (!doc || (doc !== snapshot && !doc.eq(snapshot))) {
      console.warn('[vsidian] 大纲拖拽放弃：编辑期间文档已被改写（锚点过期）')
      return
    }
    // 条目坐标防线（review-loops 第 4 轮，P2 实测）：写回计划按**条目序列**
    // 的行号算搬移范围，而序列的行号由 outlineItems 承载——它可能在拖拽期间
    // 被去抖刷新换成中间态的行号：outlineEnsureFresh 只在序列变化（级别/原文/
    // 可见文本/标记不同）时才 cancelOutlineDrag，序列逐字相同而行号平移
    // （外部插入/删除正文行）时它照常把 items 换成新行号的序列，会话存活。
    // 此时若上面那条判据放行（文档回到原文：实例换代但内容等价、eq 通过），
    // 写回就变成「行号取自中间态 items、改动范围取自起始快照」，把错坐标写进
    // 权威文档（实测：`#### 丁` 段与 `## 丙` 段被切走，文档错位且丢内容）。
    // 故判据补上「items 是快照内容的派生物」这一半：items 的派生来源
    // （outlineDoc，outlineItems 的唯一赋值点即 outlineEnsureFresh，二者恒同源）
    // 必须仍与起始快照**内容等价**。doc.eq 只比内容不比坐标——它证明当前内容
    // 等于起始内容，不证明手上的 items 行号还对应这份内容；而派生来源等价即
    // items 的行号来自等价内容（内容相同 ⇒ 行号相同），可与当前 doc 直接对齐。
    // 只比实例不比内容会误伤：正常 resync 只换 Text 实例（items 未换，或换过但
    // 仍从等价内容派生），那两类坐标都仍然有效，照常写回（第 3 轮容错不回退）。
    const itemsDoc = this.outlineDoc
    if (itemsDoc === null || (itemsDoc !== snapshot && !itemsDoc.eq(snapshot))) {
      console.warn('[vsidian] 大纲拖拽放弃：大纲条目坐标已随外部改写刷新（非起始快照派生）')
      return
    }
    const plan = outlineMovePlan(doc, this.outlineItems, fromIndex, targetIndex!, position!)
    if (plan) {
      this.applyOutlineEdits(plan.changes) // 内部 ensureFresh 即时刷新大纲
    }
  }

  /** pointercancel（系统手势接管等）：视作取消，零写回 */
  private readonly onOutlineDragCancel = (): void => {
    this.cancelOutlineDrag()
  }

  /** 大纲按下入口清理（document capture pointerdown）：
   *  - 复位拖拽吞噬标志：drop 收尾置位的「吞一次浏览器补发 click」标志只在
   *    补发 click 抵达时解除，而写回会在 pointerup 处理内同步重建条目 DOM
   *    ——补发 click 不送达时标志残留，会吞掉用户下一次真实点击（review-loops
   *    第 2 轮：真实鼠标实测 drop 后 flag 仍为 true 且下一次点击被吞）。任何
   *    按下都先复位；补发 click 恒在本次按下之后，故「只吞一次」口径不变
   *  - 清理残留拖拽会话：越界释放（up 不送达 webview，如释放在窗口原生
   *    chrome／另一窗口）留下的会话，任意一次新按下都证明该手势已结束
   *  次指针（触屏多点第二指）跳过第二条，不误杀进行中的拖拽；判据带
   *  pointerType==='touch' 前提（review-loops 第 4 轮）——合成 PointerEvent
   *  的 isPrimary 默认为 false，只按它判会让残留清理在合成事件路径上整体失效 */
  private readonly outlinePointerdownEntry = (event: PointerEvent): void => {
    this.outlineSuppressClick = false
    if (event.pointerType === 'touch' && event.isPrimary === false) {
      return
    }
    if (!this.outlineDragState) {
      return
    }
    this.cancelOutlineDrag()
  }

  /** Esc 取消拖拽（拖拽期间 document capture keydown）：零写回 */
  private readonly onOutlineDragEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.cancelOutlineDrag()
    }
  }

  /** 结束拖拽会话（幂等）：摘除 document/window 监听、清指示类与状态
   *  （指针捕获只用于折叠滑块行，拖拽链路不经 capture——setPointerCapture
   *  会劫走条目内折叠箭头的 click，浏览器回归实证后已回退） */
  private cancelOutlineDrag(): void {
    const drag = this.outlineDragState
    if (!drag) {
      return
    }
    this.outlineDragState = null
    document.removeEventListener('pointermove', this.onOutlineDragMove)
    document.removeEventListener('pointerup', this.onOutlineDragEnd)
    document.removeEventListener('pointercancel', this.onOutlineDragCancel)
    document.removeEventListener('keydown', this.onOutlineDragEscape, true)
    window.removeEventListener('blur', this.onOutlineDragCancel)
    this.clearOutlineDragDom()
  }

  /** 清拖拽指示类（条目 DOM 全量幂等清除） */
  private clearOutlineDragDom(): void {
    const panel = this.outlinePanelEl
    panel?.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`).forEach((el) => {
      el.classList.remove(
        OUTLINE_CLASS_NAMES.dragging,
        OUTLINE_CLASS_NAMES.dropBefore,
        OUTLINE_CLASS_NAMES.dropAfter,
        OUTLINE_CLASS_NAMES.dropInside,
      )
    })
  }

  /** #70 测试钩子驱动真实拖拽链路：向真实条目派发 pointer 事件序列
   *  （pointerdown → 超阈值 move → 目标三态区域 move），action 决定收尾
   *  （hover 留悬停态供 probe 观测 / drop 补 pointerup 写回 / escape 按
   *  Esc 取消）。落点 Y 取目标条目的 12%/50%/88% 分位（25% 容差内稳定
   *  命中 before/inside/after） */
  private runOutlineDragTest(
    from: number,
    to: number,
    position: OutlineDropPosition,
    action: 'hover' | 'drop' | 'escape',
  ): void {
    const panel = this.outlinePanelEl
    if (!panel) {
      return
    }
    // 会话卫生：上一轮 hover 留下的悬停会话先取消（否则 pointerdown 守卫
    // 拒绝新会话——集成用例连续驱动时必需）
    if (this.outlineDragState) {
      this.cancelOutlineDrag()
    }
    const nodes = panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)
    const fromEl = nodes[from]
    const toEl = nodes[to]
    if (!fromEl || !toEl) {
      return
    }
    const fromRect = fromEl.getBoundingClientRect()
    const toRect = toEl.getBoundingClientRect()
    const yRatio = position === 'before' ? 0.12 : position === 'after' ? 0.88 : 0.5
    const y = toRect.top + toRect.height * yRatio
    const fire = (type: string, target: Element, x: number, yy: number): void => {
      // 会话校验（review-loops 第 2 轮）读 pointerId 与 buttons：合成事件按
      // 真实指针形态构造——同一指针 id，移动期间按键为按下态、释放为 0
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: yy,
        buttons: type === 'pointerup' ? 0 : 1,
      }))
    }
    fire('pointerdown', fromEl, fromRect.left + 20, fromRect.top + fromRect.height / 2)
    // 超阈值 move（起点右下偏移 > 4px，目标链路外先进入拖拽态）
    fire('pointermove', panel, fromRect.left + 60, fromRect.top + fromRect.height / 2 + 12)
    fire('pointermove', toEl, toRect.left + 40, y)
    if (action === 'hover') {
      return
    }
    if (action === 'escape') {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
      }))
      return
    }
    fire('pointerup', toEl, toRect.left + 40, y)
  }

  // ---- 大纲定位与常驻高亮（#66）----
  // 当前控制域 = 视口顶部行向上最近的标题（locateOutlineIndex 单一事实源）。
  // 高亮是常亮位置指示器（半透明横条），不是滚动瞬时反馈：跳转即时落位、
  // 滚动去抖重算（100ms，轻于 250ms 数据链路）、模式切换即时重算；跳转的
  // 程序性滚动经防抖动护栏挂起联动（QO startJumping 同款语义：首个滚动
  // 事件被吞并释放，或超时释放），过渡期中间态不反向改写高亮。

  /** 滚动信号入口（live scrollDOM 与 reading 容器共用）：护栏挂起时吞掉
   *  首个滚动事件并释放（跳转程序性滚动的产物不触发重算）；否则去抖调度 */
  private onOutlineScrollSignal(): void {
    if (this.outlineJumpGuarded) {
      this.outlineJumpGuarded = false
      if (this.outlineJumpGuardTimer !== undefined) {
        clearTimeout(this.outlineJumpGuardTimer)
        this.outlineJumpGuardTimer = undefined
      }
      return
    }
    this.scheduleOutlineHighlightUpdate()
  }

  /** 程序性滚动（跳转/定位）前挂起滚动联动：1 秒超时兜底释放（正常路径
   *  由首个滚动事件释放——被吞的那次就是程序性滚动本身） */
  private suspendOutlineLinking(): void {
    this.outlineJumpGuarded = true
    if (this.outlineJumpGuardTimer !== undefined) {
      clearTimeout(this.outlineJumpGuardTimer)
    }
    this.outlineJumpGuardTimer = setTimeout(() => {
      this.outlineJumpGuardTimer = undefined
      this.outlineJumpGuarded = false
    }, OUTLINE_JUMP_GUARD_MS)
  }

  /** 取消未决的高亮去抖回调（面板不可见/销毁路径；迟到回调只在隐藏面板
   *  上做无谓重算——重开有 ensureFresh 校准兜底） */
  private cancelOutlineHighlightUpdate(): void {
    if (this.outlineHighlightTimer !== undefined) {
      clearTimeout(this.outlineHighlightTimer)
      this.outlineHighlightTimer = undefined
    }
  }

  /** 滚动驱动的高亮重算调度：仅面板可见时开启（不可见面板不伴随滚动
   *  做无谓计算），100ms 尾随去抖（定时器随事件重置，连续滚动只在
   *  停顿后重算一次） */
  private scheduleOutlineHighlightUpdate(): void {
    if (!this.outlineVisible()) {
      return
    }
    if (this.outlineHighlightTimer !== undefined) {
      clearTimeout(this.outlineHighlightTimer)
    }
    this.outlineHighlightTimer = setTimeout(() => {
      this.outlineHighlightTimer = undefined
      if (this.outlineJumpGuarded) {
        return // 护栏挂起：迟到回调不重算（挂起期间的高亮由跳转直接落位）
      }
      this.updateOutlineLocated()
    }, OUTLINE_HIGHLIGHT_DEBOUNCE_MS)
  }

  /** 重算当前控制域并施加高亮（同步即时路径：模式切换、文档校准、跳转）。
   *  #67：重算含 only-expand——located 被折叠遮蔽时展开其祖先链（滚动
   *  联动的动态展开语义），再按可见代表施加高亮 */
  private updateOutlineLocated(): void {
    const line = this.outlineViewportTopLine()
    this.outlineLocatedIndex = line === null ? null : locateOutlineIndex(this.outlineItems, line)
    if (this.outlineLocatedIndex !== null) {
      this.revealOutlineIndex(this.outlineLocatedIndex)
    }
    this.applyOutlineHighlight()
  }

  /** 视口顶部行（1 基）按模式分流：live 在已渲染行 DOM 里找首个底边越过
   *  视口顶的行，经 posAtDOM（文档结构映射，不依赖 viewState 的视口元
   *  数据——其更新依赖 IntersectionObserver 驱动的 measure 循环）换算
   *  行号；reading 以视口顶块锚点（源 start）换算行号（与 reading 自身
   *  滚动锚点同源）。无布局环境（jsdom，矩形全 0）或无已渲染行返回 null */
  private outlineViewportTopLine(): number | null {
    const view = this.view
    if (!view) {
      return null
    }
    if (this.viewMode === 'reading') {
      const anchor = this.readingView?.currentAnchor() ?? null
      if (anchor === null) {
        return null
      }
      return view.state.doc.lineAt(this.clampToDoc(anchor)).number
    }
    const scrollerTop = view.scrollDOM.getBoundingClientRect().top
    const lines = view.contentDOM.querySelectorAll('.cm-line')
    for (const line of lines) {
      const rect = line.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > scrollerTop + 0.5) {
        try {
          return view.state.doc.lineAt(view.posAtDOM(line, 0)).number
        } catch {
          return null
        }
      }
    }
    return null
  }

  /** 把 located 施加到面板条目（DOM 与 outlineItems 同序渲染的不变式下按
   *  序号 toggle；toggle 幂等，未变化条目零 DOM 写入）。#67 起高亮施加在
   *  「可见代表」上：located 条目被折叠遮蔽时为第一个可见祖先
   *  （outlineRepresentativeIndex；only-expand 已尽量让自身可见，回退
   *  仅在手动折叠/档位切换遮蔽路径生效）。#68 搜索态下代表口径加上过滤
   *  （折叠可见 ∧ 搜索保留，outlineSearchRepresentativeIndex；链上无
   *  可见代表则高亮消失——不强加到无关条目）。代表变化时高亮行滚进面板
   *  可视区（scrollIntoView nearest——已可见零滚动，同代表不重复滚） */
  private applyOutlineHighlight(): void {
    const panel = this.outlinePanelEl
    if (!panel) {
      return
    }
    const search = this.outlineSearchState
    const rep = this.outlineLocatedIndex === null
      ? null
      : search === null
        ? outlineRepresentativeIndex(this.outlineItems, this.outlineExpanded, this.outlineLocatedIndex)
        : outlineSearchRepresentativeIndex(
          this.outlineItems,
          this.outlineExpanded,
          search.kept,
          this.outlineLocatedIndex,
        )
    let index = 0
    for (const el of panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)) {
      el.classList.toggle(OUTLINE_CLASS_NAMES.located, index === rep)
      index += 1
    }
    if (rep === null || rep === this.outlineLastScrolledRep || !this.outlineVisible()) {
      return
    }
    const el = panel.querySelectorAll<HTMLElement>(`.${OUTLINE_CLASS_NAMES.item}`)[rep]
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
      this.outlineLastScrolledRep = rep
    }
  }

  // ---- 大纲工具条与标题搜索（#68）----
  // 纯视图状态（零写回、零出站、不入撤销栈）：搜索词是会话内内存态（不
  // 持久化、不跨文档保留）。语义见 outlineSearch.ts 模块头；可见口径 =
  // 折叠可见 ∩ 搜索过滤；进入搜索时快照展开集、清空时原样回放（QO 同款）。

  /** 搜索态判定（词条非空即活跃；空输入等于无过滤） */
  private outlineSearchActive(): boolean {
    return this.outlineSearchQuery !== ''
  }

  /** 搜索词变更入口（工具条输入框 input 事件；输入即时生效无去抖）：
   *  空→非空取展开快照；非空→空回放快照并清除；词条变化重算过滤并把
   *  命中祖先链并入当前展开集（只增不减——搜索态手动折叠不被覆盖） */
  private setOutlineSearch(query: string): void {
    const wasActive = this.outlineSearchActive()
    const nextActive = query !== ''
    if (!wasActive && nextActive) {
      this.outlineExpandedBeforeSearch = new Set(this.outlineExpanded)
    }
    if (wasActive && !nextActive) {
      const snapshot = this.outlineExpandedBeforeSearch
      this.outlineExpandedBeforeSearch = null
      if (snapshot) {
        this.outlineExpanded = new Set(snapshot)
      }
    }
    this.outlineSearchQuery = query
    this.applyOutlineSearch()
  }

  /** 搜索态全量落 DOM：重算过滤缓存 → 展开集并入命中祖先链 → 条目重渲染
   *  （带片段高亮；mark 生命周期 = 渲染级，词条或序列变化即随重建消失）
   *  → 折叠/过滤 hidden 类与「无匹配」占位 → 高亮代表重施加。
   *  搜索关闭时清缓存并重渲染（去掉 mark），回放的展开集已就位 */
  private applyOutlineSearch(): void {
    // review-loops 第 2 轮：条目 DOM 重建即取消拖拽会话（同 ensureFresh
    // changed 分支口径）——重建后 dragging 提示与 hintEl 均指向脱挂节点
    this.cancelOutlineDrag()
    if (!this.outlineSearchActive()) {
      this.outlineSearchState = null
      if (this.outlinePanelEl) {
        renderOutlineItems(this.outlinePanelEl, this.outlineItems, this.outlineFacts.hasChildren)
      }
      this.applyOutlineCollapseDom()
      this.applyOutlineHighlight()
      return
    }
    const filter = outlineSearchFilter(this.outlineItems, this.outlineSearchQuery)
    this.outlineSearchState = filter
    this.outlineExpanded = new Set(
      outlineSearchExpandSet(this.outlineItems, this.outlineExpanded, filter.matchedIndices),
    )
    if (this.outlinePanelEl) {
      renderOutlineItems(
        this.outlinePanelEl,
        this.outlineItems,
        this.outlineFacts.hasChildren,
        filter.ranges,
      )
    }
    this.applyOutlineCollapseDom()
    this.applyOutlineHighlight()
  }

  /** #68 跳转到笔记末尾：滚动正文到文档末尾（live = 末尾滚进视口下缘、
   *  reading = 滚动到末尾锚点块），不落光标（live 选区不动、不聚焦——
   *  纯滚动语义），零写回；高亮即时落位末尾控制域（不等滚动事件） */
  private outlineJumpToBottom(): void {
    const view = this.view
    const doc = view?.state.doc
    if (!view || !doc) {
      return
    }
    this.suspendOutlineLinking()
    if (this.viewMode === 'reading' && this.readingView) {
      const start = this.readingView.anchorStartFor(doc.length) ?? doc.length
      this.modeAnchor = start
      this.readingView.scrollToSrcStart(start)
      this.reassertReadingAnchor(start, 2)
    } else {
      this.modeAnchor = doc.length
      // 双滚（QO To Bottom 同款）：第一滚走 CM6 标准路径（scrollIntoView
      // 以高度模型定位），虚拟行高估算误差下可能停在「估算底部」；帧+宏
      // 任务后按真实 scrollHeight 补滚（视口渲染挂载、docHeight 收敛后）
      view.dispatch({ effects: EditorView.scrollIntoView(doc.length, { y: 'end' }) })
      scheduleFrame(() => {
        setTimeout(() => {
          if (this.view === view && this.viewMode !== 'reading') {
            const scroller = view.scrollDOM
            scroller.scrollTop = scroller.scrollHeight
          }
        }, 0)
      })
    }
    this.outlineLocatedIndex = locateOutlineIndex(this.outlineItems, doc.lines)
    if (this.outlineLocatedIndex !== null) {
      this.revealOutlineIndex(this.outlineLocatedIndex)
    }
    this.applyOutlineHighlight()
  }

  /** #68 重置三合一：清空搜索词（快照作废，不回放——重置即回初始态）、
   *  档位回默认 5（展开集整体替换为档位精确集，手动折叠随之清空）、
   *  输入框同步清空。全程纯视图零写回 */
  private resetOutline(): void {
    if (this.outlineExpandedBeforeSearch !== null) {
      this.outlineExpandedBeforeSearch = null
    }
    this.setOutlineSearch('')
    if (this.outlineToolbar) {
      this.outlineToolbar.search.value = ''
    }
    this.setOutlineExpandLevel(OUTLINE_EXPAND_LEVEL_DEFAULT)
  }

  // ---- 查找会话（#14）----
  // UI 形态：webview 内浮动层（custom editor webview 不可用 VSCode 原生
  // find 控件）。入口：Mod-F 拦截、宿主 view.find.open（命令面板共用）、
  // 输入框 Enter/Shift-Enter、F3 循环导航；Esc 关闭归还焦点。
  // 匹配集基于 CM6 doc 全文文本模型；文档变化经 Text 引用比较判过期。

  /** 查找面板 DOM（稳定类名见 FIND_CLASS_NAMES；默认隐藏，open 类控制显隐） */
  private buildFindPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.className = FIND_CLASS_NAMES.panel
    panel.setAttribute('role', 'search')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = FIND_CLASS_NAMES.input
    input.setAttribute('placeholder', '查找')
    input.setAttribute('aria-label', '在文档中查找')
    input.addEventListener('input', () => {
      this.findQuery = input.value
      this.findDoc = null // 查询变化：以当前位置为参考重算
      this.findRecompute(this.findReferencePos())
      this.findRender()
      this.findLocate()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.findStep(e.shiftKey ? 'prev' : 'next')
      }
    })
    const count = document.createElement('span')
    count.className = FIND_CLASS_NAMES.count
    count.textContent = '0/0'
    const mkBtn = (cls: string, label: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = label
      b.setAttribute('aria-label', label)
      b.addEventListener('click', onClick)
      return b
    }
    // 大小写切换按钮：语义为「忽略大小写」开关——active 类与 aria-pressed
    // 同步表示「忽略生效」，默认区分大小写（未激活、未按下）
    const caseBtn = mkBtn(FIND_CLASS_NAMES.caseToggle, '忽略大小写', () => {
      this.findCaseSensitive = !this.findCaseSensitive
      caseBtn.classList.toggle(FIND_CLASS_NAMES.caseActive, !this.findCaseSensitive)
      caseBtn.setAttribute('aria-pressed', String(!this.findCaseSensitive))
      this.findDoc = null
      this.findRecompute(this.findReferencePos())
      this.findRender()
      this.findLocate()
    })
    caseBtn.setAttribute('aria-pressed', 'false')
    this.findInputEl = input
    this.findCountEl = count
    panel.appendChild(input)
    panel.appendChild(count)
    panel.appendChild(caseBtn)
    panel.appendChild(mkBtn(FIND_CLASS_NAMES.prev, '上一个匹配', () => this.findStep('prev')))
    panel.appendChild(mkBtn(FIND_CLASS_NAMES.next, '下一个匹配', () => this.findStep('next')))
    panel.appendChild(mkBtn(FIND_CLASS_NAMES.close, '关闭查找', () => this.closeFind()))
    return panel
  }

  /** 打开查找面板（可预置查询词；重复打开重新聚焦输入框并全选查询） */
  private openFind(query?: string): void {
    this.findTouched = true
    if (typeof query === 'string' && query !== this.findQuery) {
      this.findQuery = query
      if (this.findInputEl) {
        this.findInputEl.value = query
      }
      this.findDoc = null
      this.findRecompute(this.findReferencePos())
    } else {
      this.findEnsureFresh()
    }
    this.findOpen = true
    this.findPanel?.classList.add(FIND_CLASS_NAMES.open)
    this.findRender()
    this.findLocate()
    const el = this.findInputEl
    if (el) {
      el.focus()
      el.select()
    }
  }

  /** 关闭查找：清空装饰与阅读高亮，归还焦点（live → CM6；reading → 失焦输入框） */
  private closeFind(): void {
    if (!this.findOpen) {
      return
    }
    this.findOpen = false
    this.findPanel?.classList.remove(FIND_CLASS_NAMES.open)
    this.findMatches = []
    this.findIndex = 0
    // 纯 effect 事务：不带 changes，无编辑历史、无出站
    this.view?.dispatch({ effects: setFindMatches.of({ matches: [], index: 0 }) })
    this.readingView?.highlightBlock(null)
    if (this.viewMode === 'live') {
      this.view?.focus()
    } else {
      this.findInputEl?.blur()
    }
  }

  /** 循环导航（上一项/下一项）：步进后重绘并定位到新当前匹配 */
  private findStep(direction: 'next' | 'prev'): void {
    if (!this.findOpen) {
      return
    }
    this.findEnsureFresh()
    const n = this.findMatches.length
    if (n === 0) {
      return
    }
    this.findIndex = (this.findIndex + (direction === 'next' ? 1 : n - 1)) % n
    this.findRender()
    this.findLocate()
  }

  /** 匹配参考位置：live 取光标主位；reading 取当前锚点（源码位置语义） */
  private findReferencePos(): number {
    if (this.viewMode === 'reading') {
      return this.modeAnchor ?? 0
    }
    return this.view?.state.selection.main.from ?? 0
  }

  /** 无条件重算匹配集（查询/选项变化路径）：当前匹配取参考位置后首个 */
  private findRecompute(ref: number): void {
    const doc = this.view?.state.doc
    this.findDoc = doc ?? null
    this.findMatches = doc
      ? computeFindMatches(doc.toString(), this.findQuery, this.findCaseSensitive)
      : []
    this.findIndex = matchIndexFrom(this.findMatches, ref)
  }

  /** 按需重算（导航/渲染前调用）：文档未变化时零开销；
   *  变化后以旧当前匹配位置为参考就近保持（版本失效策略） */
  private findEnsureFresh(): void {
    const doc = this.view?.state.doc
    if (!doc || doc === this.findDoc) {
      return
    }
    const prevFrom = this.findMatches[this.findIndex]?.from
    this.findRecompute(prevFrom ?? this.findReferencePos())
  }

  /** 重绘可观测状态：live 装饰效应、计数文本、阅读命中块（不改滚动位置） */
  private findRender(): void {
    this.view?.dispatch({
      effects: setFindMatches.of({ matches: this.findMatches, index: this.findIndex }),
    })
    const total = this.findMatches.length
    const cur = this.findMatches[this.findIndex]
    if (this.findCountEl) {
      this.findCountEl.textContent = `${total > 0 ? this.findIndex + 1 : 0}/${total}`
      this.findCountEl.classList.toggle(FIND_CLASS_NAMES.countEmpty, total === 0)
    }
    if (this.readingView) {
      // 块级高亮只在阅读模式生效（live 容器隐藏期不占用 DOM 类）
      const start =
        cur && this.viewMode === 'reading'
          ? (this.readingView.anchorStartFor(this.clampToDoc(cur.from)) ?? null)
          : null
      this.readingView.highlightBlock(start)
    }
  }

  /** 定位当前匹配（屏外内容同样定位；与视口/模式位置恢复协同）：
   *  live → 选区+滚动（事务不带 changes）；reading → 源位置锚点映射到块、
   *  滚动挂载目标并施加命中高亮 */
  private findLocate(): void {
    const cur = this.findMatches[this.findIndex]
    if (!cur) {
      return
    }
    this.modeAnchor = cur.from
    if (this.viewMode === 'reading' && this.readingView) {
      const start = this.readingView.anchorStartFor(this.clampToDoc(cur.from)) ?? cur.from
      this.modeAnchor = start
      this.readingView.scrollToSrcStart(start)
      this.readingView.highlightBlock(start)
      // 定位意图重申：滚动事件（异步，含 clamp 后的视口读数）触发的锚点
      // 更新不得覆盖查找定位——帧+宏任务后（滚动事件突发期之后）重申目标
      // 锚点；同一窗口内的用户滚动会被覆盖（一帧内，定位优先）
      scheduleFrame(() => {
        setTimeout(() => {
          if (this.findOpen && this.viewMode === 'reading') {
            const c2 = this.findMatches[this.findIndex]
            if (c2 === cur) {
              this.modeAnchor = start
            }
          }
        }, 0)
      })
    } else {
      if (this.view) selectTableRegion(this.view, null)
      this.view?.dispatch({
        selection: { anchor: cur.from, head: cur.to },
        effects: EditorView.scrollIntoView(cur.from, { y: 'center' }),
      })
    }
  }

  /** view.state 查找观测（#14）：首次打开后回报（含关闭态） */
  private collectFindProbe(): FindSessionProbe | undefined {
    if (!this.findTouched) {
      return undefined
    }
    const cur = this.findMatches[this.findIndex]
    return {
      open: this.findOpen,
      query: this.findQuery,
      caseSensitive: this.findCaseSensitive,
      total: this.findMatches.length,
      index: this.findMatches.length > 0 ? this.findIndex + 1 : 0,
      currentFrom: cur?.from ?? null,
      currentTo: cur?.to ?? null,
    }
  }

  /** 把 SerChange 组转为 clamp 到当前文档长度的 CM change spec */
  private clampedSpec(changes: readonly SerChange[]) {
    const len = this.view?.state.doc.length ?? 0
    return changes.map((c) => ({
      from: Math.min(c.offset, len),
      to: Math.min(c.offset + c.length, len),
      insert: c.text,
    }))
  }

  /**
   * 外部增量以单事务应用（externalSync 注解，不回发）；
   * 区间 clamp 到当前文档长度（宿主与本地状态的毫秒级竞态防御，
   * 避免超范围坐标抛错）。阅读模式下随后重建阅读视图（保留滚动锚点）。
   */
  private dispatchExternal(changes: readonly SerChange[]): void {
    const view = this.view
    if (!view) {
      return
    }
    view.dispatch({ changes: this.clampedSpec(changes), annotations: externalSync.of(true) })
    this.refreshReading()
  }

  /**
   * 外部增量组（坐标 = 权威当前系，直发路径）应用的统一入口：
   * 1. 有已确认事务时先逆穿已确认链，平移回 unconfirmed 定义域（baseVersion
   *    系）——外部坐标已含已确认编辑，直接穿未确认集会多平移已确认部分（C-2）
   * 2. 再穿未确认集映射到本地系；两阶段任一二义（真重叠）返回 null（冲突暂停）
   * 3. 应用成功后，未确认集与已确认链都以 base 系增量 rebase（定义域推进，
   *    CM6 mapDesc 精确保持段语义），baseVersion 由调用方推进
   *
   * 组合缓冲 flush 路径不经过此入口的逆穿阶段（缓冲增量已在入队时逆穿，
   * 见 BufferedIncremental.baseChanges），直接调 applyBaseChanges。
   */
  private applyExternalGroup(changes: readonly SerChange[]): SerChange[] | null {
    let baseChanges: readonly (SerChange & Partial<UnmappedChange>)[] = changes
    if (this.ackedChain) {
      const rev = unmapSerGroupThroughAcked(changes, this.ackedChain)
      if (!rev) {
        return null
      }
      baseChanges = rev
    }
    return this.applyBaseChanges(baseChanges)
  }

  /**
   * baseVersion 系增量穿未确认集映射到本地系并 rebase 参考系
   * （直发与组合 flush 共用的后半段；返回本地系增量，二义返回 null）。
   */
  private applyBaseChanges(
    baseChanges: readonly (SerChange & Partial<UnmappedChange>)[],
  ): SerChange[] | null {
    if (!this.unconfirmed) {
      // 已确认链非空时未确认集必非空（同源清空）；异常态自愈
      this.ackedChain = null
      this.sentTxns = []
      return [...baseChanges]
    }
    const mapped = mapSerGroupThroughCm(baseChanges, this.unconfirmed)
    if (!mapped) {
      return null
    }
    const gCs = ChangeSet.of(
      [...baseChanges]
        .sort((a, b) => a.offset - b.offset)
        .map((c) => ({ from: c.offset, to: c.offset + c.length, insert: c.text })),
      this.unconfirmed.length,
    )
    // 待确认事务与 unconfirmed/ackedChain 共用定义域；外部增量推进定义域时
    // 也要同步平移其坐标，否则稍后 ack 会把旧位置复合进 ackedChain。
    this.sentTxns = this.sentTxns.map((txn) => {
      const cs = ChangeSet.of(
        txn.changes.map((c) => ({ from: c.offset, to: c.offset + c.length, insert: c.text })),
        this.unconfirmed!.length,
      ).mapDesc(gCs, false) as ChangeSet
      const rebased: SerChange[] = []
      cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        rebased.push({
          offset: fromA,
          length: toA - fromA,
          text: inserted.sliceString(0, inserted.length),
        })
      })
      return { seq: txn.seq, changes: rebased }
    })
    this.unconfirmed = this.unconfirmed.mapDesc(gCs, false) as ChangeSet
    if (this.ackedChain) {
      this.ackedChain = this.ackedChain.mapDesc(gCs, false) as ChangeSet
    }
    return mapped
  }

  /** ack ok(seq)：把该事务从待确认队列剥离并复合进已确认链（C-2）。
   *  事务坐标为 base 系投影，与已确认链同定义域，经 mapDesc rebase 后
   *  compose（该事务发出晚于已确认事务，mapDesc before=false） */
  private confirmSentTxn(seq: number): void {
    const idx = this.sentTxns.findIndex((t) => t.seq === seq)
    if (idx < 0) {
      return // 未知 seq（暂停清理后的迟到 ack）：忽略
    }
    const [txn] = this.sentTxns.splice(idx, 1)
    if (!txn) {
      return
    }
    const baseLen = this.ackedChain ? this.ackedChain.length : this.unconfirmed?.length
    if (baseLen === undefined) {
      return
    }
    const cs = ChangeSet.of(
      [...txn.changes]
        .sort((a, b) => a.offset - b.offset)
        .map((c) => ({ from: c.offset, to: c.offset + c.length, insert: c.text })),
      baseLen,
    )
    this.ackedChain = this.ackedChain
      ? (this.ackedChain.compose(cs.mapDesc(this.ackedChain, false) as ChangeSet))
      : cs
  }

  /** 普通事务与空白格组合净变更共用同一出站/未确认坐标链。 */
  private recordLocalChangeSet(changeSet: ChangeSet, changes: SerChange[]): void {
    if (changes.length === 0 || !this.sessionId) {
      this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(changeSet) : changeSet
      return
    }
    if (this.deferredLocal || (
      this.unconfirmed && touchesUnconfirmedChange(changes, chainSections(this.unconfirmed))
    )) {
      this.deferredLocal = this.deferredLocal
        ? this.deferredLocal.compose(changeSet)
        : changeSet
      this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(changeSet) : changeSet
      // 组合期间不逐笔上报全文快照（#49）：IME 候选更新从第二笔起必然触碰
      // 未确认区间进入本分支，逐笔 conflict.report 意味着大文档下每个候选
      // 都全文序列化 + postMessage。组合结束 flush 后 deferredLocal 经
      // sendDeferredLocal 以单笔 edit.request 出站、文本进入宿主权威文档，
      // 取回语义由 VSCode 文本管线兜底；丢失窗口仅限组合进行中（候选未
      // 上屏）快速关闭/断连，与 VSCode 原生编辑器同类行为一致。组合外
      // （composing === false）的暂缓输入保持逐笔快照，取回兜底不放宽。
      if (!this.composing) {
        this.reportConflictSnapshot()
      }
      return
    }
    const baseChanges = this.toBaseChanges(changes)
    this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(changeSet) : changeSet
    this.seq += 1
    this.persistState()
    this.inFlight.add(this.seq)
    this.sentTxns.push({ seq: this.seq, changes: baseChanges })
    this.bridge.postMessage({
      kind: 'edit.request', sessionId: this.sessionId, docUri: this.docUri,
      seq: this.seq, baseVersion: this.baseVersion, changes: baseChanges,
    })
  }

  private reportBlankCompositionSnapshot(pending: boolean): void {
    if (!this.sessionId) return
    this.conflictRevision += 1
    this.persistState()
    this.bridge.postMessage({
      kind: 'conflict.report', sessionId: this.sessionId, docUri: this.docUri,
      version: this.baseVersion, revision: this.conflictRevision,
      text: this.view?.state.doc.toString() ?? '', compositionPending: pending,
    })
  }

  /** 候选期间只跨桥传变更片段；宿主以组合开始时的全文快照为基线增量应用。 */
  private reportBlankCompositionChanges(changeSet: ChangeSet): void {
    if (!this.sessionId) return
    const changes: SerChange[] = []
    changeSet.iterChanges((from, to, _fromB, _toB, inserted) => {
      changes.push({ offset: from, length: to - from, text: inserted.sliceString(0, inserted.length) })
    })
    if (changes.length === 0) return
    this.conflictRevision += 1
    this.persistState()
    this.bridge.postMessage({
      kind: 'composition.changed', sessionId: this.sessionId, docUri: this.docUri,
      revision: this.conflictRevision, changes,
    })
  }

  /** 已发请求全部确认后，以确认后的权威版本发送待发本地净变更。 */
  private sendDeferredLocal(): void {
    const deferred = this.deferredLocal
    if (!deferred || this.suspended || this.blankComposition ||
        this.inFlight.size > 0 || this.hasBufferedSync()) {
      return
    }
    this.deferredLocal = null
    this.ackedChain = null
    this.sentTxns = []
    const changes: SerChange[] = []
    deferred.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({
        offset: fromA,
        length: toA - fromA,
        text: inserted.sliceString(0, inserted.length),
      })
    })
    if (changes.length === 0) {
      this.unconfirmed = null
      return
    }
    this.unconfirmed = deferred
    this.seq += 1
    this.persistState()
    this.inFlight.add(this.seq)
    this.sentTxns.push({ seq: this.seq, changes })
    this.bridge.postMessage({
      kind: 'edit.request',
      sessionId: this.sessionId,
      docUri: this.docUri,
      seq: this.seq,
      baseVersion: this.baseVersion,
      changes,
    })
  }

  /**
   * 出站请求坐标转换：本地系 → baseVersion 系（C-2）。宿主重定位把请求
   * 坐标解释为 baseVersion 系，有未确认编辑时本地系与其不一致（多笔在途
   * 的连续输入会被静默错位），必须先逆穿未确认集。未确认集为空时本地系
   * 即 base 系，原样返回。
   */
  private toBaseChanges(changes: SerChange[]): SerChange[] {
    const u = this.unconfirmed
    if (!u || changes.length === 0) {
      return changes
    }
    const sections = chainSections(u)
    return changes.map((c) => {
      const from = localPosToBase(c.offset, sections)
      const to = localPosToBase(c.offset + c.length, sections)
      return { offset: from, length: to - from, text: c.text }
    })
  }

  private beginBlankComposition(): void {
    if (this.blankComposition || this.viewMode !== 'live' || !this.view) return
    const state = this.view.state
    const selection = state.selection.main
    if (!selection.empty || (!blankRowInputPlan(state, selection.from, selection.to, 'x') &&
        !state.field(tableRegionField, false))) return
    this.blankComposition = { startState: state, changes: null,
      region: state.field(tableRegionField, false) ?? undefined }
    this.compositionCommittedText = null
    this.reportBlankCompositionSnapshot(true)
  }

  /** 仅空白网格组合：结束后取净输入，一笔规范化并沿既有出站链提交。 */
  private finishBlankComposition(): boolean {
    const pending = this.blankComposition
    const view = this.view
    if (!pending || !view) return false
    let net = pending.changes
    if (!net) {
      this.blankComposition = null
      view.dispatch({ selection: view.state.selection, annotations: tableCompositionSettled.of(true) })
      this.reportBlankCompositionSnapshot(false)
      return false
    }
    const initial: SerChange[] = []
    net.iterChanges((from, to, _fromB, _toB, inserted) => {
      initial.push({ offset: from, length: to - from, text: inserted.sliceString(0, inserted.length) })
    })
    let normalized = false
    if (pending.region) {
      const start = pending.startState
      const field = start.field(liveDecorationsField, false)
      const rows = field && tableRowsAt(start, pending.region.tableFrom, field.tree)
      const header = start.doc.lineAt(pending.region.tableFrom)
      const lineNumber = header.number + pending.region.rowFrom + (pending.region.rowFrom > 0 ? 1 : 0)
      const initialLine = lineNumber <= start.doc.lines ? start.doc.line(lineNumber) : null
      const currentLine = lineNumber <= view.state.doc.lines ? view.state.doc.line(lineNumber) : null
      const initialCell = initialLine && splitTableRowCells(initialLine.text, initialLine.from)[pending.region.columnFrom]
      const currentCell = currentLine && splitTableRowCells(currentLine.text, currentLine.from)[pending.region.columnFrom]
      if (rows && initialCell && currentCell) {
        const oldContent = start.doc.sliceString(initialCell.contentFrom, initialCell.contentTo)
        const newContent = view.state.doc.sliceString(currentCell.contentFrom, currentCell.contentTo)
        const typed = this.compositionCommittedText ??
          (newContent.endsWith(oldContent) ? newContent.slice(0, newContent.length - oldContent.length) : newContent)
        const plan = typed ? planTableRegionReplace(start.doc.toString(), rows, pending.region, typed) : null
        if (plan || !typed) {
          const desired = plan ? [...plan.changes].reverse().reduce((doc, change) =>
            doc.slice(0, change.from) + change.insert + doc.slice(change.to), start.doc.toString())
            : start.doc.toString()
          const current = view.state.doc.toString()
          if (desired !== current) {
            let prefix = 0
            while (prefix < current.length && prefix < desired.length && current[prefix] === desired[prefix]) prefix++
            let suffix = 0
            while (suffix < current.length - prefix && suffix < desired.length - prefix &&
              current[current.length - 1 - suffix] === desired[desired.length - 1 - suffix]) suffix++
            view.dispatch({ changes: { from: prefix, to: current.length - suffix,
              insert: desired.slice(prefix, desired.length - suffix) },
              selection: { anchor: plan?.selection ?? initialCell.contentFrom },
              annotations: tableCompositionSettled.of(true) })
            net = pending.changes
          }
          normalized = true
        }
      }
    }
    if (initial.length === 1 && initial[0]!.length === 0 && initial[0]!.text) {
      const edit = initial[0]!
      const plan = blankRowInputPlan(pending.startState, edit.offset, edit.offset, edit.text)
      if (plan) {
        const line = view.state.doc.lineAt(plan.from)
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: plan.insert },
          selection: { anchor: plan.selection },
        })
        net = pending.changes
        normalized = true
      }
    }
    this.blankComposition = null
    this.compositionCommittedText = null
    const changes: SerChange[] = []
    net!.iterChanges((from, to, _fromB, _toB, inserted) => {
      changes.push({ offset: from, length: to - from, text: inserted.sliceString(0, inserted.length) })
    })
    // 组合取消可能先插后删；ChangeSet 仍可包含文本相同的替换。
    const effective = changes.some((change) =>
      pending.startState.doc.sliceString(change.offset, change.offset + change.length) !== change.text)
    if (!effective) {
      view.dispatch({ selection: view.state.selection, annotations: tableCompositionSettled.of(true) })
      this.reportBlankCompositionSnapshot(false)
      return false
    }
    if (!normalized) {
      view.dispatch({ selection: view.state.selection, annotations: tableCompositionSettled.of(true) })
    }
    // 并发全文没有可证明的局部重定位，留给暂停态取回，不能覆盖候选。
    if (this.pendingFull) {
      this.reportBlankCompositionSnapshot(true)
      return true
    }
    if (this.suspended) {
      this.reportConflictSnapshot()
      this.reportBlankCompositionSnapshot(true)
      return true
    }
    this.recordLocalChangeSet(net!, changes)
    this.reportBlankCompositionSnapshot(false)
    return true
  }

  /**
   * 应用缓冲的外部同步。compositionend 后宏任务晚于 CM6 最终上屏微任务；
   * 空白网格组合先提交净本地变更，再将外部变更穿过它做重定位。
   */
  private flushBufferedExternal(): void {
    this.flushTimer = undefined
    if (this.composing || !this.view) {
      // 新一轮组合进行中：缓冲保持，待下一轮 compositionend 重新调度
      return
    }
    const blankInput = this.finishBlankComposition()
    if (blankInput && this.pendingFull) {
      this.pendingFull = undefined
      this.pendingExternal = []
      this.pendingVersionAck = undefined
      this.enterSuspended()
      this.reportConflictSnapshot()
      return
    }
    if (this.suspended) {
      // 暂停期间外部增量作废（保留本地输入，恢复时以全文对齐）；
      // 暂停前缓冲的全文重置仍应用（保留恢复内容，不静默丢弃）
      const suspendedAckVersion = this.pendingVersionAck
      this.pendingVersionAck = undefined
      const groups = this.pendingExternal
      this.pendingExternal = []
      if (this.pendingFull) {
        const { version, text, source } = this.pendingFull
        this.pendingFull = undefined
        this.replaceDoc(text)
        this.baseVersion = Math.max(version, suspendedAckVersion ?? version)
        this.lastDocChangedVersion = Math.max(this.lastDocChangedVersion, version)
        if (source === 'resync') {
          // 协议明文 doc.resync 对暂停面板兼作恢复信号（B-1）：组合中的
          // 恢复延后到这里生效——全文装载并解除暂停
          this.exitSuspended()
          for (const group of groups) {
            if (group.version > version) {
              this.dispatchExternal(group.changes)
              this.baseVersion = Math.max(this.baseVersion, group.version)
            }
          }
          this.refreshReading()
        }
      }
      return
    }
    const ackVersion = this.pendingVersionAck
    this.pendingVersionAck = undefined
    if (this.pendingFull) {
      const { version, text } = this.pendingFull
      this.pendingFull = undefined
      this.unconfirmed = null
      this.ackedChain = null
      this.sentTxns = []
      this.deferredLocal = null
      this.replaceDoc(text)
      this.baseVersion = Math.max(version, ackVersion ?? version)
      this.lastDocChangedVersion = Math.max(this.lastDocChangedVersion, version)
    }
    const groups = this.pendingExternal
    this.pendingExternal = []
    let lastVersion = this.baseVersion
    for (const group of groups) {
      if (this.deferredLocal) {
        this.enterSuspended()
        return
      }
      // 外部增量已在入队时逆穿到 base 系（迟到逆穿会多平移组合编辑，见
      // BufferedIncremental 注释）；base 系增量直接穿未确认集应用（C-2 后半段）
      const mapped = group.baseChanges
        ? this.applyBaseChanges(group.baseChanges)
        : null // 入队时即与已确认编辑二义：无法安全映射
      if (!mapped) {
        // 外部区间与本地未确认编辑真重叠：无法安全映射。保留本地输入、
        // 暂停写回并上报冲突（#4；不再 sync.request 全文覆盖丢组合输入）
        this.enterSuspended()
        return
      }
      this.view.dispatch({ changes: this.clampedSpec(mapped), annotations: externalSync.of(true) })
      lastVersion = group.version
    }
    if (this.inFlight.size === 0) {
      // 缓冲应用完且无在途请求：本地与权威一致
      this.unconfirmed = null
      this.ackedChain = null
      this.sentTxns = []
    }
    this.refreshReading()
    this.baseVersion = Math.max(lastVersion, ackVersion ?? lastVersion)
    this.sendDeferredLocal()
  }

  private scheduleFlush(): void {
    if (this.flushTimer === undefined && (this.hasBufferedSync() || this.blankComposition)) {
      this.flushTimer = setTimeout(() => this.flushBufferedExternal(), 0)
    }
  }

  /** 撤销/重做转发：宿主持有唯一权威栈，本地不装 history 扩展 */
  private requestHistory(op: 'undo' | 'redo'): boolean {
    if (!this.sessionId) {
      return false // 未初始化：让事件继续传播（defaultKeymap 的本地 no-op undo）
    }
    this.bridge.postMessage({ kind: 'history.request', op })
    return true
  }

  private replaceDoc(text: string): void {
    const view = this.view
    if (!view) {
      return
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: externalSync.of(true),
    })
  }

  // ---- 行号栏（#34）----

  /**
   * 应用行号设置（settings.snapshot / settings.changed 到达时）：
   * - 源文件行号语义：CM6 对 \r\n→\n 的规范化不改行数，lineNumbers() 从
   *   doc 直算即源文件行号——不写换行映射代码（共享笔记 34 号推论）
   * - 缺键回定义默认（向后兼容）；非布尔形态忽略（协议是宽标量容器，
   *   类型语义校验归宿主，webview 侧防御）
   * - 经 Compartment.reconfigure 增删扩展，EditorView 不重建；阅读模式
   *   天然无行号（gutter 挂在 liveWrapper 内的 EditorView 上，reading
   *   时整体隐藏），切回 live 按本状态恢复
   */
  private applyLineNumbersSetting(): void {
    const raw = this.settings?.[SHOW_LINE_NUMBERS_KEY]
    const on = typeof raw === 'boolean' ? raw : SHOW_LINE_NUMBERS_DEFAULT
    if (on === this.lineNumbersOn) {
      return
    }
    this.lineNumbersOn = on
    this.view?.dispatch({
      effects: this.lineNumbersCompartment.reconfigure(on ? liveLineNumbers() : []),
    })
  }

  /**
   * 应用代码块卡片设置（#79–#81；settings.snapshot / settings.changed 到达时）：
   * card 总开关、行号/复制子开关分别读 codeblock.* 键（缺键回定义默认、
   * 非布尔忽略——与行号同口径）；highlight 由 #83 接入，暂保持默认开。
   * 经 Compartment.reconfigure 热重配 codeCardConfigFacet（卡片装饰
   * StateField 检测到 facet 变化时对围栏表全量重建），EditorView 不重建
   */
  private applyCodeCardSetting(): void {
    const bool = (raw: unknown, fallback: boolean): boolean =>
      typeof raw === 'boolean' ? raw : fallback
    const next: CodeCardConfig = {
      card: bool(this.settings?.[CODEBLOCK_CARD_KEY], CODEBLOCK_CARD_DEFAULT),
      lineNumbers: bool(this.settings?.[CODEBLOCK_LINE_NUMBERS_KEY], CODEBLOCK_LINE_NUMBERS_DEFAULT),
      copyButton: bool(this.settings?.[CODEBLOCK_COPY_BUTTON_KEY], CODEBLOCK_COPY_BUTTON_DEFAULT),
      highlight: bool(this.settings?.[CODEBLOCK_HIGHLIGHT_KEY], CODEBLOCK_HIGHLIGHT_DEFAULT),
    }
    if (
      next.card === this.codeCardConfig.card &&
      next.lineNumbers === this.codeCardConfig.lineNumbers &&
      next.copyButton === this.codeCardConfig.copyButton &&
      next.highlight === this.codeCardConfig.highlight
    ) {
      return
    }
    this.codeCardConfig = next
    this.view?.dispatch({
      effects: this.codeCardCompartment.reconfigure(this.codeCardExtension()),
    })
    // #84 阅读侧同步刷新已挂载的代码块卡片（Live 侧经 facet 热重配）
    if (this.viewMode === 'reading') {
      this.decorateMountedReadingCodeCards()
    }
  }

  /** #84 增强单个阅读代码块（挂载钩子与重装饰共用入口） */
  private decorateReadingCodeCardBlock(block: HTMLElement): void {
    if (!isReadingCodeBlock(block)) {
      return
    }
    const srcStart = Number(block.dataset['vsidianSrcStart'] ?? '-1')
    decorateReadingCodeCard(block, {
      config: this.codeCardConfig,
      folded: this.readingCodeFold.has(srcStart),
      onCopy: (code) => this.postCodeCopy(code),
      onFoldToggle: () => {
        if (!this.readingCodeFold.delete(srcStart)) {
          this.readingCodeFold.add(srcStart)
        }
        this.decorateReadingCodeCardBlock(block)
      },
    })
  }

  /** #84 刷新全部已挂载阅读块的卡片形态（设置变更/切回阅读模式） */
  private decorateMountedReadingCodeCards(): void {
    this.readingContainer
      ?.querySelectorAll<HTMLElement>('.vsidian-reading-block')
      .forEach((el) => this.decorateReadingCodeCardBlock(el))
  }

  /** #81/#84 复制出站（Live effect 转发与阅读直连共用） */
  private postCodeCopy(text: string): void {
    if (this.sessionId) {
      this.bridge.postMessage({
        kind: 'codeblock.copy',
        sessionId: this.sessionId,
        docUri: this.docUri,
        text,
      })
    }
  }

  /** 卡片扩展装配（#79–#82）：facet + 折叠状态 + 装饰 StateField + 复制
   *  请求转发监听。初次装配与设置热重配共用，保证监听器在默认配置下同样在场 */
  private codeCardExtension() {
    return [
      codeCardConfigFacet.of(this.codeCardConfig),
      codeCardFoldField,
      liveCodeCard,
      // #81 复制请求转发：零写回事务携带 effect → codeblock.copy 出站
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions) {
          for (const eff of tr.effects) {
            if (eff.is(codeCardCopyRequest)) {
              this.postCodeCopy(eff.value)
            }
          }
        }
      }),
    ]
  }

  /** 行号栏观测（#34 view.state 扩展字段）。过滤 CM6 的隐藏测量探针
   *  单元格（visibility:hidden、用于测量 gutter 文本宽度的 dummy——真实
   *  宿主与 jsdom 均存在，不是行号） */
  private collectLineGutter(): LineGutterProbe {
    const view = this.view
    if (!view || !this.lineNumbersOn) {
      return { on: this.lineNumbersOn, count: 0, first: null, last: null }
    }
    const texts = Array.from(
      view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    )
      .filter((el) => (el as HTMLElement).style.visibility !== 'hidden')
      .map((el) => el.textContent ?? '')
    return {
      on: this.lineNumbersOn,
      count: texts.length,
      first: texts.length > 0 ? texts[0] : null,
      last: texts.length > 0 ? texts[texts.length - 1] : null,
    }
  }

  /**
   * 绘制层探针（P0 回归，语义见 protocol.ts PaintProbe）：首个含文本行的
   * 首字符命中测试落在内容区内（DOM 数量与几何坐标探针测不出的"真的
   * 可见"），附带 CM6 baseTheme 存活与行号禁选观测。
   */
  private collectPaint(): PaintProbe {
    const view = this.view
    const contentEl = view?.dom.querySelector<HTMLElement>('.cm-content')
    if (!view || !contentEl) {
      return {
        textVisible: false,
        scrollerDisplay: null,
        gutterUserSelect: null,
        darkTheme: false,
        caretColor: null,
      }
    }
    // elementFromPoint/几何 rect 依赖真实布局：jsdom（单测宿主）无布局能力
    // 且 elementFromPoint 缺失，任何异常都视为不可见（PaintProbe 语义注记：
    // jsdom 下 textVisible 恒 false，只作真宿主集成断言依据）
    let textVisible = false
    try {
      for (const line of Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-line')).slice(0, 8)) {
        const tn = Array.from(line.getElementsByTagName('*'))
          .flatMap((el) => Array.from(el.childNodes))
          .find((n) => n.nodeType === 3 && (n.nodeValue ?? '').trim().length > 0)
        const direct = Array.from(line.childNodes).find(
          (n) => n.nodeType === 3 && (n.nodeValue ?? '').trim().length > 0,
        )
        const textNode = (tn ?? direct) as ChildNode | undefined
        if (!textNode || !textNode.nodeValue) {
          continue
        }
        const r = document.createRange()
        r.setStart(textNode as unknown as Node, 0)
        r.setEnd(textNode as unknown as Node, 1)
        const cr = r.getBoundingClientRect()
        if (cr.width <= 0 || cr.height <= 0) {
          continue
        }
        const hit = document.elementFromPoint(cr.x + cr.width / 2, cr.y + cr.height / 2)
        if (hit && contentEl.contains(hit)) {
          textVisible = true
          break
        }
      }
    } catch {
      textVisible = false
    }
    const guttersEl = view.dom.querySelector<HTMLElement>('.cm-gutters')
    const gridRow = view.contentDOM.querySelector<HTMLElement>('.vsidian-table-grid-row')
    const delimiterRow = view.contentDOM.querySelector<HTMLElement>('.vsidian-table-grid-delimiter')
    const headerRow = view.contentDOM.querySelector<HTMLElement>(
      '.vsidian-table-grid-row.vsidian-table-header-line')
    const headerCellBackgrounds = headerRow
      ? [...headerRow.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')]
        .map((cell) => getComputedStyle(cell).backgroundColor)
      : []
    const firstCell = gridRow?.querySelector<HTMLElement>(':scope > .vsidian-table-grid-cell') ?? null
    const selectedRow = view.contentDOM.querySelector<HTMLElement>(
      '.vsidian-table-grid-row.vsidian-table-row-selected',
    )
    const selectedRowCell = selectedRow?.querySelector<HTMLElement>(':scope > .vsidian-table-grid-cell') ?? null
    const selectedColumnCell = view.contentDOM.querySelector<HTMLElement>(
      '.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-selected',
    )
    const regionCells = view.contentDOM.querySelectorAll<HTMLElement>(
      '.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-region-cell',
    )
    const regionCell = regionCells[0] ?? null
    const columnFirst = view.contentDOM.querySelector<HTMLElement>(
      '.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-first',
    )
    const columnLast = view.contentDOM.querySelector<HTMLElement>(
      '.vsidian-table-grid-row > .vsidian-table-grid-cell.vsidian-table-column-last',
    )
    let cellVisible = false
    try {
      const cells = view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-table-grid-cell')
      // 只取少量已挂载格做绘制命中；长表格的 view.state 不逐格测量。
      for (let index = 0; index < Math.min(cells.length, 12); index++) {
        const cell = cells[index]!
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const text = node.nodeValue ?? ''
          const at = text.search(/\S/)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + 1)
          const rect = range.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) continue
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          if (hit && cell.contains(hit)) {
            cellVisible = true
            break
          }
        }
        if (cellVisible) break
      }
    } catch {
      // jsdom 无布局和 elementFromPoint；真宿主才能证明实际可见。
    }
    let caretGridColumn: number | null = null
    let caretDomColumn: number | null = null
    let caretNativeRectHeight: number | null = null
    try {
      const selection = window.getSelection()
      if (selection?.isCollapsed && selection.rangeCount > 0 &&
          selection.focusNode && view.contentDOM.contains(selection.focusNode)) {
        const rect = selection.getRangeAt(0).getBoundingClientRect()
        caretNativeRectHeight = rect.height
        const focusElement = selection.focusNode instanceof Element
          ? selection.focusNode : selection.focusNode.parentElement
        const domCell = focusElement?.closest<HTMLElement>(
          '.vsidian-table-grid-row > .vsidian-table-grid-cell')
        if (domCell?.parentElement) {
          caretDomColumn = [...domCell.parentElement.querySelectorAll(
            ':scope > .vsidian-table-grid-cell')].indexOf(domCell)
        }
        // 零宽格的 DOM Selection 锚在 .cm-content 上，浏览器给出 0×0 Range；
        // CM6 仍能按光标关联侧返回实际排版坐标。
        const point = rect.height > 0 ? rect : view.coordsAtPos(
          view.state.selection.main.head, view.state.selection.main.assoc || -1)
        if (point) {
          const hit = document.elementFromPoint(point.left + 1,
            (point.top + point.bottom) / 2)
          const cell = hit?.closest<HTMLElement>('.vsidian-table-grid-row > .vsidian-table-grid-cell')
          const row = cell?.parentElement
          if (cell && row) {
            caretGridColumn = [...row.querySelectorAll(':scope > .vsidian-table-grid-cell')].indexOf(cell)
          }
        }
      }
    } catch {
      // jsdom 无绘制位置；只有真实宿主可断言光标所在格。
    }
    const activeEmpty = view.contentDOM.querySelector<HTMLElement>('.vsidian-table-grid-empty-active')
    if (activeEmpty) {
      try {
        const rect = activeEmpty.getBoundingClientRect()
        const caretStyle = getComputedStyle(activeEmpty, '::after')
        const nativeCaret = getComputedStyle(contentEl).caretColor
        const hit = document.elementFromPoint(rect.left + 11, rect.top + 14)
        if (rect.width > 0 && rect.height > 0 &&
            Number.parseFloat(caretStyle.borderLeftWidth) > 0 &&
            (nativeCaret === 'transparent' || nativeCaret === 'rgba(0, 0, 0, 0)') &&
            hit && activeEmpty.contains(hit)) {
          const row = activeEmpty.parentElement
          if (row) caretGridColumn = [...row.querySelectorAll(':scope > .vsidian-table-grid-cell')]
            .indexOf(activeEmpty)
        }
      } catch {
        // 绘制探针不干预编辑状态。
      }
    }
    const cellStyle = firstCell ? getComputedStyle(firstCell) : null
    const rowStyle = selectedRow ? getComputedStyle(selectedRow) : null
    const rowCellStyle = selectedRowCell ? getComputedStyle(selectedRowCell) : null
    const columnStyle = selectedColumnCell ? getComputedStyle(selectedColumnCell) : null
    const columnFirstStyle = columnFirst ? getComputedStyle(columnFirst) : null
    const columnLastStyle = columnLast ? getComputedStyle(columnLast) : null
    const regionStyle = regionCell ? getComputedStyle(regionCell) : null
    // #55 标题行左缘绘制观测：视口内标题行（.vsidian-heading-inview）的
    // computed box-shadow / border-left-width distinct 集合——标题行不得
    // 绘制左缘竖线（真宿主应分别为 'none' / '0px'）；无挂载标题行为 null
    let headingPaint: {
      inviewCount: number
      boxShadowValues: string[]
      borderLeftWidthValues: string[]
    } | null = null
    const inviewHeadings = Array.from(
      view.contentDOM.querySelectorAll<HTMLElement>('.vsidian-heading-inview'),
    )
    if (inviewHeadings.length > 0) {
      const boxShadowValues = new Set<string>()
      const borderLeftWidthValues = new Set<string>()
      for (const el of inviewHeadings) {
        const style = getComputedStyle(el)
        boxShadowValues.add(style.boxShadow)
        borderLeftWidthValues.add(style.borderLeftWidth)
      }
      headingPaint = {
        inviewCount: inviewHeadings.length,
        boxShadowValues: [...boxShadowValues].sort(),
        borderLeftWidthValues: [...borderLeftWidthValues].sort(),
      }
    }
    // 光标取证：本扩展未启用 drawSelection，CM6 光标即原生 caret，颜色
    // 由 baseTheme 明暗变体决定（light=black / dark=white）。darkTheme 取
    // facet 实值（jsdom 可读），caretColor 取计算值（jsdom 无 CSS 引擎为 null）
    let caretColor: string | null = null
    try {
      caretColor = getComputedStyle(contentEl).caretColor || null
    } catch {
      caretColor = null
    }
    // #59 公式绘制探针：按当前激活视图取首个公式元素（隐藏侧 display:none
    // 的 rect 全 0 不作依据）；rect 有面积且 elementFromPoint 命中才算画出来
    const mathScope = this.viewMode === 'reading' ? this.readingContainer : view.contentDOM
    const mathEl = mathScope?.querySelector<HTMLElement>(
      `.${MATH_CLASS_NAMES.math}, .${MATH_CLASS_NAMES.mathError}`,
    ) ?? null
    let mathVisible = false
    let mathDisplay: string | null = null
    if (mathEl) {
      mathDisplay = getComputedStyle(mathEl).display
      try {
        const rect = mathEl.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          if (hit && mathEl.contains(hit)) {
            mathVisible = true
          }
        }
      } catch {
        // jsdom 无布局与 elementFromPoint；真宿主才能证明实际可见。
      }
    }
    const math = mathEl
      ? {
          visible: mathVisible,
          display: mathDisplay,
          count: mathScope
            ? mathScope.querySelectorAll(
                `.${MATH_CLASS_NAMES.math}, .${MATH_CLASS_NAMES.mathError}`,
              ).length
            : 0,
        }
      : undefined
    // #60 Mermaid 绘制探针：按当前激活视图取图表容器（分态计数）；
    // 可见性优先取已渲染 SVG 的 rect + elementFromPoint 命中（错误降级
    // 容器同样可命中——可见 ≠ 语法有效，语义由 rendered/error 分开断言）
    const mermaidScope = this.viewMode === 'reading' ? this.readingContainer : view.contentDOM
    const mermaidEl = mermaidScope?.querySelector<HTMLElement>(
      `.${MERMAID_CLASS_NAMES.diagram}`,
    ) ?? null
    const mermaidSvg = mermaidEl?.querySelector('svg') ?? mermaidEl
    let mermaidVisible = false
    let mermaidDisplay: string | null = null
    if (mermaidEl) {
      mermaidDisplay = getComputedStyle(mermaidEl).display
      try {
        const rect = mermaidSvg!.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          if (hit && mermaidEl.contains(hit)) {
            mermaidVisible = true
          }
        }
      } catch {
        // jsdom 无布局与 elementFromPoint；真宿主才能证明实际可见。
      }
    }
    const mermaidCounts = mermaidScope
      ? {
          rendered: mermaidScope.querySelectorAll(
            `.${MERMAID_CLASS_NAMES.diagram}[${MERMAID_STATE_ATTR}="rendered"]`,
          ).length,
          error: mermaidScope.querySelectorAll(
            `.${MERMAID_CLASS_NAMES.diagram}[${MERMAID_STATE_ATTR}="error"]`,
          ).length,
          count: mermaidScope.querySelectorAll(`.${MERMAID_CLASS_NAMES.diagram}`).length,
        }
      : { rendered: 0, error: 0, count: 0 }
    const mermaid = mermaidEl
      ? { visible: mermaidVisible, display: mermaidDisplay, ...mermaidCounts }
      : undefined
    const quickBar = this.quickActionsEl
    const quickBold = quickBar?.querySelector<HTMLElement>('[data-op="bold"]') ?? null
    const quickActive = quickBar?.querySelector<HTMLElement>('[data-format-state="active"]') ?? null
    const barRect = quickBar?.getBoundingClientRect()
    const toolbarRect = this.toolbar?.getBoundingClientRect()
    const editorRect = this.liveWrapper?.getBoundingClientRect()
    const quickActions = {
      open: this.quickActionsOpen,
      togglePainted: hitPaintedElement(this.quickToggleBtn),
      barPainted: hitPaintedElement(quickBar, quickBar),
      boldPainted: hitPaintedElement(quickBold, quickBar),
      activePainted: !!quickActive && paintedWithVisibleBackground(quickActive),
      menuPainted: hitPaintedElement(this.quickHeadingMenu, this.quickHeadingMenu),
      barBelowToolbar: !!barRect && !!toolbarRect && barRect.height > 0 &&
        barRect.top >= toolbarRect.bottom - 1,
      editorBelowBar: !!barRect && !!editorRect && barRect.height > 0 &&
        editorRect.top >= barRect.bottom - 1,
    }
    // #79 代码块卡片绘制探针：当前激活视图取头部横带。CM6 挂载缓冲内的
    // 头部可能滚出可视裁剪区（rect 在视口外，elementFromPoint 不命中），
    // 故遍历取首个「rect 有面积 + 在视口内 + elementFromPoint 命中」的
    // 头部；全部未命中时回落首个（display 探针仍可用）
    const codeScope = this.viewMode === 'reading' ? this.readingContainer : view.contentDOM
    const cardHeaders = codeScope
      ? [...codeScope.querySelectorAll<HTMLElement>(`.${CODE_CARD_CLASS_NAMES.header}`)]
      : []
    let cardHeader: HTMLElement | null = null
    let codeCardVisible = false
    for (const header of cardHeaders) {
      try {
        const rect = header.getBoundingClientRect()
        if (
          rect.width > 0 && rect.height > 0 &&
          rect.bottom > 0 && rect.top < window.innerHeight
        ) {
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          if (hit && header.contains(hit)) {
            cardHeader = header
            codeCardVisible = true
            break
          }
        }
      } catch {
        // jsdom 无布局与 elementFromPoint；真宿主才能证明实际可见。
      }
      if (!cardHeader) {
        cardHeader = header
      }
    }
    const codeCardDisplay = cardHeader ? getComputedStyle(cardHeader).display : null
    // #83 tok-* token 元素计数（卡片关闭仅高亮时 code 节由 token 驱动存在）
    const tokenCount = codeScope
      ? codeScope.querySelectorAll('[class*="tok-"]').length
      : 0
    const code = cardHeader || tokenCount > 0
      ? {
        visible: codeCardVisible,
        display: codeCardDisplay,
        label:
          // #83 徽标在标签内：取标签的末文本节点（显示名），不含徽标字形
          cardHeader?.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)?.lastChild?.textContent ?? null,
        headerCount: codeScope
          ? codeScope.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.header}`).length
          : 0,
        cardLineCount: codeScope
          ? codeScope.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.line}`).length
          : 0,
        // #80 卡内行号文本序列（视口内；关闭行号子开关后为空数组）
        lineNumberTexts: codeScope
          ? [...codeScope.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`)]
            .map((el) => el.textContent ?? '')
            .filter((t) => t !== '')
          : [],
        // #81 复制按钮在场数（编辑态同样发射、常驻在场；可见性由 CSS 悬停
        // 承担，DOM 常驻才能被此计数与宿主点击钩子命中；收起态不发射）
        copyCount: codeScope
          ? codeScope.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.copy}`).length
          : 0,
        // #82 收起态头部数（chevron -collapsed 计数）
        foldedCount: codeScope
          ? codeScope.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.foldCollapsed}`).length
          : 0,
        // #83 视口内 tok-* token 元素数
        tokenCount,
        // 全部头部语言标签序列（DOM 顺序；断言渲染型围栏的 Mermaid 标签）
        labels: cardHeaders
          .map((h) => h.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)?.lastChild?.textContent ?? '')
          .filter((t) => t !== ''),
      }
      : undefined
    return {
      textVisible,
      scrollerDisplay: view.scrollDOM ? getComputedStyle(view.scrollDOM).display : null,
      gutterUserSelect: guttersEl ? getComputedStyle(guttersEl).userSelect : null,
      visibleLineNumbers: paintedLineNumbers(view),
      darkTheme: view.state.facet(EditorView.darkTheme),
      caretColor,
      table: {
        cellVisible,
        caretGridColumn,
        delimiterDisplay: delimiterRow ? getComputedStyle(delimiterRow).display : null,
        headerCellBackgrounds,
        caretDomColumn,
        caretNativeRectHeight,
        cellBreakDisplay: view.contentDOM.querySelector('.vsidian-table-cell-break')
          ? getComputedStyle(view.contentDOM.querySelector('.vsidian-table-cell-break')!).display : null,
        gridDisplay: gridRow ? getComputedStyle(gridRow).display : null,
        cellBorderWidth: cellStyle?.borderLeftWidth ?? null,
        rowOutlineColor: rowStyle?.outlineColor ?? null,
        rowOutlineWidth: rowStyle?.outlineWidth ?? null,
        rowBackgroundColor: rowCellStyle?.backgroundColor ?? null,
        columnBorderColor: columnStyle?.borderLeftColor ?? null,
        columnBorderWidth: columnStyle?.borderLeftWidth ?? null,
        columnRightBorderWidth: columnStyle?.borderRightWidth ?? null,
        columnTopBorderWidth: columnFirstStyle?.borderTopWidth ?? null,
        columnBottomBorderWidth: columnLastStyle?.borderBottomWidth ?? null,
        columnBackgroundColor: columnStyle?.backgroundColor ?? null,
        regionCellCount: regionCells.length,
        regionBackgroundColor: regionStyle?.backgroundColor ?? null,
        regionTopBorderWidth: regionStyle?.borderTopWidth ?? null,
        regionLeftBorderWidth: regionStyle?.borderLeftWidth ?? null,
      },
      math,
      mermaid,
      quickActions,
      code,
      heading: headingPaint,
    }
  }

  /**
   * #53 右侧栏观测：布局态与绘制层证据（语义见 protocol.ts SidebarProbe）。
   * 命中类字段走 elementFromPoint——侧栏/按钮只有真实绘制（非 display:none、
   * 非零尺寸、无覆盖遮挡）时才可能命中；线宽为 computed stroke-width 文本
   * （两态差异唯一来源是样式表类规则）。jsdom 无布局与 CSS 引擎：命中恒
   * false、线宽/名称容错为 null，真宿主断言见集成
   */
  private collectSidebar(): SidebarProbe {
    const readStroke = (el: Element | null): string | null => {
      if (!el) {
        return null
      }
      try {
        const value = getComputedStyle(el).strokeWidth
        return value === '' ? null : value
      } catch {
        return null
      }
    }
    const widthOf = (el: HTMLElement | null | undefined): number | null => {
      if (!el) {
        return null
      }
      try {
        return el.getBoundingClientRect().width
      } catch {
        return null
      }
    }
    const sidebarBar = this.sidebarEl?.querySelector<HTMLElement>('.vsidian-sidebar-toolbar') ?? null
    return {
      open: this.sidebarOpen,
      sidebarToolbarPainted: hitPaintedElement(sidebarBar, this.sidebarEl),
      togglePainted: hitPaintedElement(this.sidebarToggleBtn),
      settingsPainted: hitPaintedElement(
        this.toolbar?.querySelector<HTMLButtonElement>('button.vsidian-settings-toggle') ?? null,
      ),
      toggleBarStrokeWidth: readStroke(
        this.sidebarToggleBtn?.querySelector('.vsidian-sidebar-icon-bar') ?? null,
      ),
      toggleFrameStrokeWidth: readStroke(
        this.sidebarToggleBtn?.querySelector('.vsidian-sidebar-icon-frame') ?? null,
      ),
      mainWidthPx: widthOf(this.mainEl),
      sidebarWidthPx: widthOf(this.sidebarEl),
      toggleAriaLabel: this.sidebarToggleBtn?.getAttribute('aria-label') ?? null,
      settingsAriaLabel:
        this.toolbar?.querySelector<HTMLButtonElement>('button.vsidian-settings-toggle')
          ?.getAttribute('aria-label') ?? null,
    }
  }

  /**
   * #54 大纲观测：面板态与绘制层证据（语义见 protocol.ts OutlineProbe）。
   * 回报前先做新鲜度校准（所有 view.state 回报路径统一走这里）：Text 引用
   * 未变时零成本，过期则解析一次（复用 liveDecorationsField 的增量树）。
   * 命中字段走 elementFromPoint——侧栏展开 + 面板 active + 显隐样式表规则
   * 生效（display:none/零尺寸时命中失败），DOM 存在性探不出样式失效。
   * 图标尺寸与滚动几何为 computed/布局度量（长面板裁剪时中心点在宿主外、
   * 命中失败，scrollHeight > clientHeight 证明高度约束生效）。jsdom 无布局
   * 与 CSS 引擎：命中恒 false、几何度量透传 0、图标尺寸容错为 null，名称
   * 在未装配时为 null，真宿主断言见集成。
   */
  private collectOutline(): OutlineProbe {
    this.outlineEnsureFresh()
    const iconSizeOf = (el: HTMLElement | null | undefined): number | null => {
      const svg = el?.querySelector('svg')
      if (!svg) {
        return null
      }
      try {
        const value = getComputedStyle(svg).width
        const px = value === '' ? NaN : Number.parseFloat(value)
        return Number.isFinite(px) ? px : null
      } catch {
        return null
      }
    }
    const panel = this.outlinePanelEl
    const dimensionOf = (
      el: HTMLElement | null | undefined,
      key: 'scrollHeight' | 'clientHeight',
    ): number | null => {
      if (!el) {
        return null
      }
      try {
        const value = el[key]
        return Number.isFinite(value) ? value : null
      } catch {
        return null
      }
    }
    /** #65 样式透传绘制证据：computed 字重/字体族/颜色。条目 400 与显式
     *  粗体段 700 的对照是「字重只认显式标记」的用户可见差异；条目与正文
     *  标题的颜色对照是主题色同源证据（同变量族解析同值）。目标元素不在
     *  （无条目/无标记/无标题行）或取值失败时为 null（jsdom 无 CSS 引擎） */
    const outlineStyle = () => {
      const read = (el: Element | null, prop: 'fontWeight' | 'fontFamily' | 'color'): string | null => {
        if (!el) {
          return null
        }
        try {
          const value = getComputedStyle(el)[prop]
          return typeof value === 'string' && value !== '' ? value : null
        } catch {
          return null
        }
      }
      const panel = this.outlinePanelEl ?? null
      const item = panel?.querySelector(`.${OUTLINE_CLASS_NAMES.item}`) ?? null
      const strong = panel?.querySelector(`.${OUTLINE_CLASS_NAMES.item} .${OUTLINE_CLASS_NAMES.span.strong}`) ?? null
      const code = panel?.querySelector(`.${OUTLINE_CLASS_NAMES.item} .${OUTLINE_CLASS_NAMES.span.code}`) ?? null
      const heading = this.liveWrapper?.querySelector('.vsidian-heading-line') ?? null
      return {
        itemFontWeight: read(item, 'fontWeight'),
        strongFontWeight: read(strong, 'fontWeight'),
        codeFontFamily: read(code, 'fontFamily'),
        itemFontFamily: read(item, 'fontFamily'),
        itemColor: read(item, 'color'),
        headingColor: read(heading, 'color'),
      }
    }
    const visibleIndices = outlineVisibleIndices(this.outlineItems, this.outlineExpanded)
    return {
      active: this.outlineActive,
      togglePainted: hitPaintedElement(this.outlineToggleBtn),
      panelPainted: hitPaintedElement(panel, panel),
      toggleIconSizePx: iconSizeOf(this.outlineToggleBtn),
      panelScrollHeightPx: dimensionOf(panel, 'scrollHeight'),
      panelClientHeightPx: dimensionOf(panel, 'clientHeight'),
      items: this.outlineItems.map((item) => ({
        ...item,
        spans: item.spans.map((span) => ({ ...span })),
      })),
      toggleAriaLabel: this.outlineToggleBtn?.getAttribute('aria-label') ?? null,
      panelAriaLabel: this.outlinePanelEl?.getAttribute('aria-label') ?? null,
      style: outlineStyle(),
      // #66 常驻高亮观测：located 索引/文字 + 绘制层证据（中心点命中 +
      // computed 背景非全透明；jsdom 无布局恒 false，真宿主断言见集成）
      locatedItemIndex: this.outlineLocatedIndex,
      locatedText: this.outlineLocatedIndex !== null
        ? this.outlineItems[this.outlineLocatedIndex]?.text ?? null
        : null,
      locatedPainted: this.collectOutlineLocatedPainted(),
      // #67 折叠观测：档位实值 + 可见索引序列（折叠可见性断言权威口径）+
      // 滑块行/当前档圆点/折叠箭头的绘制层证据
      expandLevel: this.outlineExpandLevel,
      visibleIndices: visibleIndices,
      sliderPainted: hitPaintedElement(this.outlineSlider?.row, this.outlineSlider?.row),
      sliderActiveDotPainted: this.collectOutlineSliderActiveDotPainted(),
      chevronPainted: hitPaintedElement(
        this.outlinePanelEl?.querySelector<HTMLElement>(`.${OUTLINE_CLASS_NAMES.chevron}`) ?? null,
        this.outlinePanelEl,
      ),
      // #68 搜索与工具条观测：词条实值/组合可见口径（搜索关闭时与
      // visibleIndices 同值）+ 工具条行、命中片段、无匹配占位的绘制证据
      // 与控件可访问名称（jsdom 无布局：命中恒 false，真宿主断言见集成）
      searchQuery: this.outlineSearchQuery,
      searchActive: this.outlineSearchActive(),
      filteredVisibleIndices: this.outlineSearchState === null
        ? visibleIndices
        : outlineFilteredVisibleIndices(
          this.outlineItems,
          this.outlineExpanded,
          this.outlineSearchState.kept,
        ),
      toolbarPainted: hitPaintedElement(this.outlineToolbar?.row, this.outlineToolbar?.row),
      jumpBottomAriaLabel: this.outlineToolbar?.jumpBottom.getAttribute('aria-label') ?? null,
      resetAriaLabel: this.outlineToolbar?.reset.getAttribute('aria-label') ?? null,
      searchPlaceholder: this.outlineToolbar?.search.getAttribute('placeholder') ?? null,
      searchHitPainted: this.collectOutlineSearchHitPainted(),
      nomatchPainted: hitPaintedElement(
        this.outlinePanelEl?.querySelector<HTMLElement>(`.${OUTLINE_CLASS_NAMES.nomatch}`) ?? null,
        this.outlinePanelEl,
      ),
      // #69 菜单观测：打开态（容器挂载于侧栏）、目标索引、绘制证据（中心点
      // elementFromPoint 命中——侧栏展开 + 样式表浮层规则生效）、级联子菜单
      // 可见（hover/focus 展开：computed display 非 none 且非空）
      menuOpen: this.outlineMenuEl !== undefined,
      menuTargetIndex: this.outlineMenuEl !== undefined ? this.outlineMenuIndex : null,
      menuPainted: hitPaintedElement(this.outlineMenuEl, this.outlineMenuEl),
      submenuVisible: this.collectOutlineSubmenuVisible(),
      renamingIndex: this.outlineRenameIndex,
      // #70 拖拽观测：源/落点索引与三态实值（悬停态经 outline.test.drag
      // action=hover 驱动后采集）+ 落点指示绘制证据
      draggingIndex: this.outlineDragState?.moved ? this.outlineDragState.fromIndex : null,
      dropTargetIndex: this.outlineDragState?.targetIndex ?? null,
      dropPosition: this.outlineDragState?.position ?? null,
      dropHintPainted: this.collectOutlineDropHintPainted(),
    }
  }

  /** #70 落点指示绘制证据：带指示类的条目中心点命中自身（真实布局）且
   *  computed 插入线（box-shadow）或包裹高亮（outline 非虚线宽 > 0 /
   *  背景非全透明）任一可读——样式失效时类在而视觉差异不在，此处捕获。
   *  jsdom 无布局恒 false，真宿主断言见集成 */
  private collectOutlineDropHintPainted(): boolean {
    const panel = this.outlinePanelEl
    if (!panel) {
      return false
    }
    const el = panel.querySelector<HTMLElement>(
      `.${OUTLINE_CLASS_NAMES.dropBefore}, .${OUTLINE_CLASS_NAMES.dropAfter}, ` +
      `.${OUTLINE_CLASS_NAMES.dropInside}`,
    )
    if (!el || !hitPaintedElement(el, el)) {
      return false
    }
    try {
      const cs = getComputedStyle(el)
      if (cs.boxShadow !== '' && cs.boxShadow !== 'none') {
        return true
      }
      const outlineWidth = Number.parseFloat(cs.outlineWidth)
      if (cs.outlineStyle !== 'none' && cs.outlineStyle !== '' &&
          Number.isFinite(outlineWidth) && outlineWidth > 0) {
        return true
      }
      return paintedWithVisibleBackground(el)
    } catch {
      return false
    }
  }

  /** #69 级联子菜单可见证据：任一子菜单 computed display 非 none 且非空串
   *  （CSS 未加载/未 hover 时 display 为 none 或空——jsdom 恒 false） */
  private collectOutlineSubmenuVisible(): boolean {
    const menu = this.outlineMenuEl
    if (!menu) {
      return false
    }
    for (const el of Array.from(menu.querySelectorAll<HTMLElement>(`.${OUTLINE_MENU_CLASS_NAMES.submenu}`))) {
      try {
        const display = getComputedStyle(el).display
        if (display !== '' && display !== 'none') {
          return true
        }
      } catch {
        // 计算失败保守视为不可见
      }
    }
    return false
  }

  /** #66 located 条目的绘制层证据：施加了 located 类的元素（#67 起为
   *  可见代表——被折叠遮蔽时是第一个可见祖先）中心点 elementFromPoint
   *  命中自身（真实布局与显隐规则生效）且 computed background-color 非
   *  全透明（半透明横条规则生效——样式失效时无背景可读）。代表元素在
   *  面板滚动区可视范围外时命中失败；#67 的高亮行滚进可视区使常态下
   *  命中成立（跳转/滚动落位即滚，probe 采集时已就位） */
  private collectOutlineLocatedPainted(): boolean {
    const panel = this.outlinePanelEl
    if (!panel) {
      return false
    }
    const el = panel.querySelector<HTMLElement>(`.${OUTLINE_CLASS_NAMES.located}`)
    return !!el && paintedWithVisibleBackground(el)
  }

  /** #67 当前档圆点绘制证据：active 圆点中心点命中（真实布局 + active
   *  类规则生效——选择器写错时圆点无类可命中）且 computed 背景非全透明
   *  （实心珠真实绘制；jsdom 无布局恒 false，真宿主断言见集成） */
  private collectOutlineSliderActiveDotPainted(): boolean {
    const dot = this.outlineSlider?.dots[this.outlineExpandLevel]
    if (!dot || !dot.classList.contains(OUTLINE_CLASS_NAMES.sliderActive)) {
      return false
    }
    return paintedWithVisibleBackground(dot)
  }

  /** #68 命中片段绘制证据：首个非隐藏条目内的 mark 中心点命中自身且
   *  computed 背景非全透明（片段高亮规则真实绘制——mark 无背景规则时
   *  视觉上不可区分，computed 捕获；无搜索/无命中或 jsdom 无布局恒
   *  false，真宿主断言见集成） */
  private collectOutlineSearchHitPainted(): boolean {
    const panel = this.outlinePanelEl
    if (!panel) {
      return false
    }
    const mark = panel.querySelector<HTMLElement>(
      `.${OUTLINE_CLASS_NAMES.item}:not(.${OUTLINE_CLASS_NAMES.hidden}) ` +
      `mark.${OUTLINE_CLASS_NAMES.searchHit}`,
    )
    return !!mark && paintedWithVisibleBackground(mark)
  }

  /** 暂停提示横幅：说明输入已保留、写回已暂停，提供取回与恢复按钮 */
  private buildBanner(): HTMLElement {
    const banner = document.createElement('div')
    banner.className = 'vsidian-suspend-banner'
    banner.style.display = 'none'
    const label = document.createElement('span')
    label.className = 'vsidian-suspend-banner-text'
    label.textContent = '检测到无法安全同步的外部修改：写回已暂停，本地输入已保留，不会被覆盖。'
    banner.appendChild(label)
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.dataset['action'] = 'copy'
    copy.textContent = '复制未确认输入'
    const resume = document.createElement('button')
    resume.type = 'button'
    resume.dataset['action'] = 'resume'
    resume.textContent = '放弃本地修改并重新同步'
    banner.appendChild(copy)
    banner.appendChild(resume)
    banner.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const action = target.closest('button')?.dataset['action']
      if ((action === 'copy' || action === 'resume') && this.sessionId) {
        this.bridge.postMessage({
          kind: 'conflict.action',
          sessionId: this.sessionId,
          docUri: this.docUri,
          action,
        })
      }
    })
    return banner
  }

  private setBannerVisible(visible: boolean): void {
    if (this.banner) {
      this.banner.style.display = visible ? 'flex' : 'none'
    }
  }

  /** 宿主明暗主题跟随：body class 变化时热重配 dark 声明（等值跳过）；
   *  #60：Mermaid 主题联动（缓存清空 + 在文档容器重渲染，等值跳过） */
  private applyHostTheme(): void {
    const dark = isVscodeDarkBody()
    if (dark === this.hostDarkApplied || !this.view) {
      return
    }
    this.hostDarkApplied = dark
    setMermaidDarkTheme(dark)
    this.view.dispatch({
      effects: this.darkCompartment.reconfigure(EditorView.darkTheme.of(dark)),
    })
  }

  private extensions() {
    return [
      EditorView.lineWrapping,
      // 宿主明暗主题声明：初始按 body 主题 class 判定，切换时热重配
      // （applyHostTheme）。baseTheme 内建变体接管 caret 等颜色——不硬编码
      this.darkCompartment.of(EditorView.darkTheme.of(isVscodeDarkBody())),
      // 行号栏（#34）：源文件行号经 Compartment 装配（设置开关热重配，
      // mount 时按定义默认开）；列在流内、与正文以固定间距相隔的布局
      // 见 main.css 的 #34 段（行号列宽随位数自适应，无降级机制）
      this.lineNumbersCompartment.of(this.lineNumbersOn ? liveLineNumbers() : []),
      // 标题实时预览装饰（#5 切片）：直接装饰（StateField）+ 间接装饰
      // （ViewPlugin 按 visibleRanges），见 liveDecorations.ts 头注释
      livePreviewDecorations,
      // #10 链接/图片：视口间接装饰（链接 span、图片 widget）+ Ctrl/Cmd
      // 单击跳转意图上报（执行归宿主）；#11 双链同通道（原始 target 上报）
      createLinkInteractions({
        postActivate: (href, srcStart, srcEnd) => {
          if (this.sessionId) {
            this.bridge.postMessage({
              kind: 'link.activate',
              sessionId: this.sessionId,
              docUri: this.docUri,
              href,
              srcStart,
              srcEnd,
            })
          }
        },
        postActivateWikilink: (target, srcStart, srcEnd) => {
          if (this.sessionId) {
            this.bridge.postMessage({
              kind: 'wikilink.activate',
              sessionId: this.sessionId,
              docUri: this.docUri,
              target,
              srcStart,
              srcEnd,
            })
          }
        },
        images: this.images!,
      }),
      // #59 公式：跨行块表（StateField 增量）+ 视口装饰（光标进入显源码、
      // 离开恢复 KaTeX 排版；渲染与装饰实例均按源文缓存）
      liveMath,
      // #60 Mermaid：围栏表 + 跨行块 replace 装饰（光标进入围栏显源码、
      // 离开恢复渲染图；渲染容器与阅读侧共用 mermaidRender 管线）
      liveMermaid,
      // #79 代码块卡片：呈现态围栏收起 + 头部横带 + 卡片行类（配置经
      // Compartment 热重配，围栏表复用上方 mermaidFencesField）
      this.codeCardCompartment.of(this.codeCardExtension()),
      // 表格单元格输入钩子（#12）：表格行内键入 | 转义写回 \|；
      // 编辑面即 CM6 源文本行，同步链路复用本控制器的标准出站路径
      tableEditing,
      // 查找装饰（#14）：当前匹配（直接）+ 全部匹配（视口内间接）
      findDecorations,
      ...this.extraExtensions,
      EditorView.updateListener.of((update) => {
        if (this.quickActionsOpen && (update.docChanged || update.selectionSet)) {
          // StateField 已在本事务更新；微任务避免在 CM6 update 生命周期内
          // 再读取旧 EditorView.state。重复信号合并由当前状态读取自然收敛。
          queueMicrotask(() => this.refreshQuickActions())
        }
        if (!update.docChanged) {
          return
        }
        // 查找会话的匹配失效（#14）：文档变化后标记过期，微任务中重算并
        // 刷新（updateListener 内不可同步 dispatch；纯 effect 事务零写回）
        if (this.findOpen) {
          queueMicrotask(() => {
            if (this.findOpen && this.view) {
              this.findEnsureFresh()
              this.findRender()
            }
          })
        }
        // 大纲刷新调度（#54）：仅面板可见时去抖开启（不可见面板不伴随每次
        // 按键全量解析；数据新鲜度由 view.state 回报前的即时校准兜底）
        if (this.outlineVisible()) {
          this.scheduleOutlineRefresh()
        }
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(externalSync)) {
            continue
          }
          if (this.blankComposition) {
            const buffered = this.blankComposition
            buffered.changes = buffered.changes ? buffered.changes.compose(tr.changes) : tr.changes
            this.reportBlankCompositionChanges(tr.changes)
            continue
          }
          if (this.suspended) {
            // 暂停写回：本地文本继续保留累积，但不回传、不追踪同步状态；
            // 立即刷新宿主全文快照，快速关闭时也能取回这笔输入。
            this.reportConflictSnapshot()
            continue
          }
          const changes: SerChange[] = []
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({
              offset: fromA,
              length: toA - fromA,
              text: inserted.sliceString(0, inserted.length),
            })
          })
          this.recordLocalChangeSet(tr.changes, changes)
        }
      }),
      // 撤销/重做转发 keymap：置于数组末尾（CM6 扩展数组靠后者优先级高），
      // 先于调用方传入的 defaultKeymap（其本地 undo/redo 绑定在未装 history
      // 扩展时为 no-op）匹配
      keymap.of([
        { key: 'Mod-z', run: () => this.requestHistory('undo') },
        { key: 'Shift-Mod-z', run: () => this.requestHistory('redo') },
        { key: 'Mod-y', run: () => this.requestHistory('redo') },
      ]),
      // IME 组合状态跟踪：compositionend 后调度缓冲 flush
      Prec.highest(EditorView.domEventHandlers({
        compositionstart: () => {
          this.composing = true
          this.beginBlankComposition()
        },
        compositionupdate: () => {
          this.composing = true
          this.beginBlankComposition()
        },
        compositionend: (event) => {
          this.compositionCommittedText = event.data || null
          this.composing = false
          this.scheduleFlush()
        },
      })),
    ]
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 绘制层命中探测（#53 起 sidebar/outline 探针共用）：元素中心点
 *  elementFromPoint 命中 scope（缺省元素自身）才算真实绘制——display:none、
 *  零尺寸或覆盖遮挡时命中失败，几何/存在性探针测不出样式失效 */
function hitPaintedElement(
  el: HTMLElement | null | undefined,
  scope?: HTMLElement,
): boolean {
  if (!el) {
    return false
  }
  try {
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) {
      return false
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const within = scope ?? el
    return !!hit && within.contains(hit)
  } catch {
    return false
  }
}

/** #66/#67 绘制层证据共用口径：中心点 elementFromPoint 命中自身（真实
 *  布局与显隐规则生效）且 computed background-color 非全透明（背景规则
 *  生效——located 横条与滑块实心圆点共用；样式失效时任一失守即 false） */
function paintedWithVisibleBackground(el: HTMLElement): boolean {
  if (!hitPaintedElement(el, el)) {
    return false
  }
  try {
    const bg = getComputedStyle(el).backgroundColor
    if (bg === '' || bg === 'transparent') {
      return false
    }
    const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(bg)
    if (!rgb) {
      return false // 异常形态保守视为未绘制
    }
    return rgb[4] === undefined || Number.parseFloat(rgb[4]!) > 0
  } catch {
    return false
  }
}

/** 齿轮设置图标（#53：lucide-cog 意象，内联 SVG，不引入图标库）。
 *  线宽是图标自身笔画的恒定属性（stroke-width=2），不参与两态变化 */
function createSettingsGearIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const circle = document.createElementNS(SVG_NS, 'circle')
  circle.setAttribute('cx', '12')
  circle.setAttribute('cy', '12')
  circle.setAttribute('r', '3.5')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute(
    'd',
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08'
      + 'a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51'
      + 'a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08'
      + 'a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2'
      + 'v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73'
      + 'l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74'
      + 'l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0'
      + 'l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  )
  svg.appendChild(path)
  svg.appendChild(circle)
  return svg
}

/** 侧栏切换图标（#53：Obsidian side-bar-right / lucide panel-right 意象）：
 *  矩形外框 + 右侧竖线。两态粗细差异的唯一来源是样式表（收起细线 1.5px /
 *  展开粗线 3px，随 vsidian-sidebar-open 类切换），SVG 属性上不写
 *  stroke-width——样式失效时两态同值，集成绘制断言据此暴露 */
function createSidebarToggleIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const frame = document.createElementNS(SVG_NS, 'rect')
  frame.setAttribute('class', 'vsidian-sidebar-icon-frame')
  frame.setAttribute('x', '1.75')
  frame.setAttribute('y', '2.75')
  frame.setAttribute('width', '12.5')
  frame.setAttribute('height', '10.5')
  frame.setAttribute('rx', '1.5')
  const bar = document.createElementNS(SVG_NS, 'line')
  bar.setAttribute('class', 'vsidian-sidebar-icon-bar')
  bar.setAttribute('x1', '11')
  bar.setAttribute('y1', '2.75')
  bar.setAttribute('x2', '11')
  bar.setAttribute('y2', '13.25')
  svg.appendChild(frame)
  svg.appendChild(bar)
  return svg
}

/** VSCode webview 明暗主题判定：深色（vscode-dark）与暗色高对比
 *  （vscode-high-contrast）为暗；浅色（vscode-light）与亮色高对比
 *  （vscode-high-contrast-light）为亮。body class 由 VSCode 随主题
 *  实时更新，观察者见 WebviewSyncController.applyHostTheme */
export function isVscodeDarkBody(body: HTMLElement = document.body): boolean {
  const cl = body.classList
  return cl.contains('vscode-dark') || cl.contains('vscode-high-contrast')
}
