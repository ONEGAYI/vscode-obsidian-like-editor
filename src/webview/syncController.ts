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
import { Annotation, ChangeSet, EditorState, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  isHostToWebview,
  type CssProbeReport,
  type FindSessionProbe,
  type LiveSyntaxProbe,
  type ReadingSyntaxProbe,
  type SerChange,
} from '../shared/protocol'
import {
  FIND_CLASS_NAMES,
  computeFindMatches,
  findDecorations,
  matchIndexFrom,
  setFindMatches,
  type FindMatch,
} from './findSession'
import { liveDecorationsField, livePreviewDecorations, LIVE_CLASS_NAMES } from './liveDecorations'
import { createLinkInteractions, WIKILINK_CLASS_NAMES } from './liveLinks'
import { ImageResourceManager } from './imageResource'
import { runPerfProbe } from './perfProbe'
import { runReadingPerfProbe } from './readingProbe'
import { createReadingContainer, prepareReadingImages } from './readingView'
import { READING_MARKDOWN_CLASS_NAMES } from './readingMarkdown'
import { resolveStaleTaskToggle } from './taskToggle'
import { VirtualReadingView } from './readingVirtualView'
import { runCreateTable, runTableEdit, tableEditing } from './tableEditing'

/** rAF 不可用环境（旧 jsdom）退化为短超时（与 readingVirtualView 同款） */
function scheduleFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => fn())
  } else {
    setTimeout(fn, 16)
  }
}

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
  /** 原始增量（权威变更前系；入队时点的参考系） */
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
    const saved = bridge.getState<PersistedState>()
    this.seq = typeof saved?.seq === 'number' && saved.seq >= 0 ? Math.floor(saved.seq) : 0
    this.conflictRevision = typeof saved?.conflictRevision === 'number' && saved.conflictRevision >= 0
      ? Math.floor(saved.conflictRevision) : 0
    this.viewMode = saved?.viewMode === 'reading' ? 'reading' : 'live'
    this.modeAnchor = typeof saved?.anchor === 'number' && saved.anchor >= 0 ? Math.floor(saved.anchor) : null
  }

  /** 创建编辑器视图并向宿主发送 ready（HTML 加载完成后调用一次） */
  mount(parent: HTMLElement, extraExtensions: Extension[] = []): void {
    if (this.view) {
      return
    }
    this.extraExtensions = extraExtensions
    this.toolbar = this.buildToolbar()
    this.banner = this.buildBanner()
    this.findPanel = this.buildFindPanel()
    this.liveWrapper = document.createElement('div')
    this.liveWrapper.className = 'vsidian-view-live'
    this.readingContainer = createReadingContainer()
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
      onBlockMounted: (el) => this.images && prepareReadingImages(el, this.images),
      onBlockUnmounted: (el) => this.images?.detachWithin(el),
    })
    // 阅读滚动更新锚点（用户滚动即改变"当前位置"语义；短文档滚不动时
    // 锚点保持进入/定位时的值——视口读取无法表达目标，modeAnchor 是权威）。
    // 同一事件驱动 #7 的窗口重算（rAF 合帧）
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
    parent.appendChild(this.toolbar)
    parent.appendChild(this.banner)
    parent.appendChild(this.liveWrapper)
    parent.appendChild(this.readingContainer)
    parent.appendChild(this.findPanel)
    // webview 内键盘拦截（#14）：Mod-F 打开查找（custom editor webview 不可用
    // VSCode 原生 find 控件）；Esc 关闭并归还焦点。capture 阶段先行处理
    this.docKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        this.openFind()
        return
      }
      if (this.findOpen && e.key === 'Escape') {
        e.preventDefault()
        this.closeFind()
        return
      }
      if (this.findOpen && e.key === 'F3') {
        e.preventDefault()
        this.findStep(e.shiftKey ? 'prev' : 'next')
      }
    }
    document.addEventListener('keydown', this.docKeydown, true)
    this.view = new EditorView({
      parent: this.liveWrapper,
      state: EditorState.create({ doc: '', extensions: this.extensions() }),
    })
    this.applyModeDom(this.viewMode)
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
    if (this.docKeydown) {
      document.removeEventListener('keydown', this.docKeydown, true)
      this.docKeydown = undefined
    }
    this.view?.destroy()
    this.view = undefined
    this.banner?.remove()
    this.banner = undefined
    this.toolbar?.remove()
    this.toolbar = undefined
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
        this.lastDocChangedVersion = message.version
        if (this.suspended) {
          // 暂停：外部增量不应用（保留本地输入，恢复时以全文对齐）
          break
        }
        if (this.deferredLocal && !this.composing && !this.hasBufferedSync()) {
          // 待发集定义域未随外部增量重定位；保守暂停并保留本地全文，
          // 避免确认后用旧坐标覆盖权威文本。
          this.enterSuspended()
          break
        }
        if (this.composing || this.hasBufferedSync()) {
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
      case 'table.test.key': {
        // 测试钩子（#13）：向真实编辑器派发 Tab keydown（与用户按键同一
        // keymap 链路；纯选区导航零写回）
        if (this.view) {
          this.view.contentDOM.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Tab',
              shiftKey: message.key === 'shift-tab',
              bubbles: true,
              cancelable: true,
            }),
          )
        }
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
        const pos = this.clampToDoc(message.offset)
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
          this.view?.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: 'center' }),
          })
        }
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
    this.bridge.postMessage({
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
      readingSyntax: this.viewMode === 'reading' ? this.collectReadingSyntax() : undefined,
      // #10 链接/图片观测（DOM 级：live 限视口，reading 限挂载块）
      liveLinkCount: content ? content.querySelectorAll('.vsidian-link').length : 0,
      liveImageCount: content ? content.querySelectorAll('.vsidian-image').length : 0,
      // #11 双链观测（live：范围外 widget + 范围内 mark；reading：a）
      liveWikilinkCount: content
        ? content.querySelectorAll(`.${WIKILINK_CLASS_NAMES.wikilink}`).length
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
    })
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
    if (this.composing || this.hasBufferedSync()) {
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

  /** 切换入口（宿主 view.mode.set 消息与工具栏按钮共用） */
  private setViewMode(target: 'live' | 'reading' | 'toggle'): void {
    const next: ViewMode =
      target === 'toggle' ? (this.viewMode === 'live' ? 'reading' : 'live') : target
    if (next === this.viewMode) {
      this.persistState()
      return
    }
    if (next === 'reading') {
      // 锚点 = live 光标主位（选区最小 from）；阅读视图按当前 CM6 文本渲染
      // （含未确认输入），不依赖宿主权威。锚点随即规范化为块 start——
      // 短文档滚动无法表达目标时 modeAnchor 仍是权威锚点
      const sel = this.view?.state.selection
      const cursor = sel
        ? Math.min(...sel.ranges.map((r) => r.from))
        : this.modeAnchor ?? 0
      this.modeAnchor = cursor
      this.applyModeDom('reading') // 先更新模式（refreshReading 依赖它）
      this.refreshReading()
      if (this.readingView) {
        const start = this.readingView.anchorStartFor(this.clampToDoc(cursor)) ?? cursor
        this.modeAnchor = start
        this.readingView.scrollToSrcStart(start)
      }
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
    this.applyModeDom('live')
    // 恢复光标到锚点并滚动到视口中部；事务不带 changes → 不产生编辑历史
    const pos = this.clampToDoc(this.modeAnchor ?? 0)
    this.view?.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    // 查找会话跨模式保活（#14）：选区恢复到当前匹配（非仅块首）
    if (this.findOpen) {
      this.findEnsureFresh()
      this.findRender()
      this.findLocate()
    }
  }

  /** 容器显隐与按钮文案（稳定类名 vsidian-view-live / vsidian-view-reading） */
  private applyModeDom(mode: ViewMode): void {
    this.viewMode = mode
    if (this.liveWrapper) {
      this.liveWrapper.style.display = mode === 'live' ? '' : 'none'
    }
    if (this.readingContainer) {
      this.readingContainer.style.display = mode === 'reading' ? '' : 'none'
    }
    const btn = this.toolbar?.querySelector<HTMLButtonElement>('button.vsidian-mode-toggle')
    if (btn) {
      btn.textContent = mode === 'live' ? '切换到阅读模式' : '切换到实时预览'
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

  /** 持久化（合并写入）：seq、viewMode、anchor 共存互不覆盖 */
  private persistState(): void {
    const saved = this.bridge.getState<PersistedState>() ?? {}
    this.bridge.setState({
      ...saved,
      seq: this.seq,
      conflictRevision: this.conflictRevision,
      viewMode: this.viewMode,
      anchor: this.modeAnchor ?? undefined,
    })
  }

  /** 切换入口工具栏（#6）：按钮与宿主命令走同一状态机 */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'vsidian-toolbar'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'vsidian-mode-toggle'
    btn.textContent = '切换到阅读模式'
    btn.addEventListener('click', () => this.setViewMode('toggle'))
    bar.appendChild(btn)
    return bar
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

  /** 已发请求全部确认后，以确认后的权威版本发送待发本地净变更。 */
  private sendDeferredLocal(): void {
    const deferred = this.deferredLocal
    if (!deferred || this.suspended || this.inFlight.size > 0 || this.hasBufferedSync()) {
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

  /**
   * 应用缓冲的外部同步。调用时机：compositionend 后的宏任务（setTimeout 0），
   * 晚于 CM6 在 microtask 中生成的组合上屏事务（@codemirror/view 6.43 的
   * observers.compositionend 用 Promise.resolve().then(flush)），因此
   * unconfirmed 此时已含组合编辑、组合文本的 edit.request 也已发出。
   */
  private flushBufferedExternal(): void {
    this.flushTimer = undefined
    if (this.composing || !this.view) {
      // 新一轮组合进行中：缓冲保持，待下一轮 compositionend 重新调度
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
    if (this.flushTimer === undefined && this.hasBufferedSync()) {
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

  private extensions() {
    return [
      EditorView.lineWrapping,
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
      // 表格单元格输入钩子（#12）：表格行内键入 | 转义写回 \|；
      // 编辑面即 CM6 源文本行，同步链路复用本控制器的标准出站路径
      tableEditing,
      // 查找装饰（#14）：当前匹配（直接）+ 全部匹配（视口内间接）
      findDecorations,
      ...this.extraExtensions,
      EditorView.updateListener.of((update) => {
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
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(externalSync)) {
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
          if (changes.length === 0 || !this.sessionId) {
            // 无文本变更的事务不进入写回，但仍是本地状态的一部分
            this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(tr.changes) : tr.changes
            continue
          }
          if (this.deferredLocal || (
            this.unconfirmed && touchesUnconfirmedChange(changes, chainSections(this.unconfirmed))
          )) {
            // 继续乐观回显；待已有请求全部确认后一次性发送净变更。
            this.deferredLocal = this.deferredLocal
              ? this.deferredLocal.compose(tr.changes)
              : tr.changes
            this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(tr.changes) : tr.changes
            // 暂缓集内容不在宿主 pending 里：立即上报全文快照，面板
            // 关闭/断连后取回不缺这部分输入
            this.reportConflictSnapshot()
            continue
          }
          // 出站坐标先逆穿本事务前的未确认集，回到 baseVersion 参考系（C-2）
          const baseChanges = this.toBaseChanges(changes)
          // 未确认变更集累积：外部增量到达时须平移穿过（防静默错位）
          this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(tr.changes) : tr.changes
          this.seq += 1
          this.persistState() // 合并写入：保留 viewMode/anchor（#6）
          this.inFlight.add(this.seq)
          this.sentTxns.push({ seq: this.seq, changes: baseChanges })
          this.bridge.postMessage({
            kind: 'edit.request',
            sessionId: this.sessionId,
            docUri: this.docUri,
            seq: this.seq,
            baseVersion: this.baseVersion,
            changes: baseChanges,
          })
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
      EditorView.domEventHandlers({
        compositionstart: () => {
          this.composing = true
        },
        compositionupdate: () => {
          this.composing = true
        },
        compositionend: () => {
          this.composing = false
          this.scheduleFlush()
        },
      }),
    ]
  }
}
