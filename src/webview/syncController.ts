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
import { Annotation, ChangeSet, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  isHostToWebview,
  type CssProbeReport,
  type SerChange,
} from '../shared/protocol'
import { mapChangeThroughChanges } from '../shared/changeMapping'
import { headingDecorations } from './headings'
import { runPerfProbe } from './perfProbe'
import { runReadingPerfProbe } from './readingProbe'
import { createReadingContainer } from './readingView'
import { VirtualReadingView } from './readingVirtualView'

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
}

/** 外部同步事务标记：updateListener 见到它即跳过（不回发）。
 *  性能探针（#5）复用同一注解——探针编辑走渲染路径但不写回宿主 */
export const externalSync = Annotation.define<boolean>()

/**
 * 把一组外部增量（坐标基于缓冲开始前的文档）映射穿过缓冲挂起期间累积的
 * 本地变更（通常为组合上屏事务）。任一区间与本地变更相交即返回 null
 * （插入点/删除区间的映射存在二义，保守交由全文重同步处理）。
 */
function mapSerGroupThroughCm(
  changes: readonly SerChange[],
  local: ChangeSet,
): SerChange[] | null {
  const out: SerChange[] = []
  for (const c of changes) {
    const from = c.offset
    const to = c.offset + c.length
    if (local.touchesRange(from, to)) {
      return null
    }
    const mappedFrom = local.mapPos(from, -1)
    const mappedTo = local.mapPos(to, 1)
    out.push({ offset: mappedFrom, length: mappedTo - mappedFrom, text: c.text })
  }
  return out
}

interface BufferedIncremental {
  version: number
  changes: SerChange[]
}

/**
 * 把未确认集（ChangeSet，定义域 = 权威基线文档）穿过一条权威系外部增量组
 * （坐标基于同一权威基线），返回以新权威基线为定义域的重建未确认集。
 * 段与外部区间不可安全映射（重叠二义）时返回 null——该场景在应用前的
 * mapSerGroupThroughCm 检查中已被拦截，此处为一致性防御。
 */
function mapUnconfirmedThroughExternal(
  unconfirmed: ChangeSet,
  external: readonly SerChange[],
): ChangeSet | null {
  const sections: { from: number; to: number; insert: string }[] = []
  unconfirmed.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.sliceString(0, inserted.length)
    sections.push({ from: fromA, to: toA, insert: text })
  })
  const mapped: { from: number; to: number; insert: string }[] = []
  for (const s of sections) {
    const r = mapChangeThroughChanges(
      { offset: s.from, length: s.to - s.from, text: s.insert },
      [external],
    )
    if (r === null) {
      return null
    }
    mapped.push({ from: r.offset, to: r.offset + r.length, insert: r.text })
  }
  let delta = 0
  for (const c of external) {
    delta += c.text.length - c.length
  }
  return ChangeSet.of(mapped, unconfirmed.length + delta)
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
  /** live 容器（稳定类名 oile-view-live，内含 CM6 编辑器） */
  private liveWrapper: HTMLElement | undefined
  /** 阅读容器（稳定类名 oile-view-reading，块级源锚点结构） */
  private readingContainer: HTMLElement | undefined
  /** 阅读视图虚拟化控制器（#7：接管阅读容器的按需挂载/回收/锚点定位） */
  private readingView: VirtualReadingView | undefined
  private toolbar: HTMLElement | undefined

  // ---- 冲突暂停状态（#4）----
  /** 暂停写回：保留本地文本、忽略外部增量、不再发送 edit.request */
  private suspended = false
  /** 发出后未收 ok ack 的请求 seq 集合（全部确认后未确认集清空） */
  private inFlight = new Set<number>()
  /** 未确认变更集：本地文档相对 baseVersion 权威文本的累积变更；
   *  外部增量到达时必须平移穿过它（否则静默错位） */
  private unconfirmed: ChangeSet | null = null
  private banner: HTMLElement | undefined

  // ---- IME 组合缓冲状态 ----
  /** 组合进行中（DOM compositionstart..compositionend） */
  private composing = false
  /** 组合期间到达、待 flush 的外部增量（按到达序） */
  private pendingExternal: BufferedIncremental[] = []
  /** 组合期间到达、待 flush 的全文消息（覆盖增量形态） */
  private pendingFull: { version: number; text: string } | undefined
  /** 缓冲挂起期间收到的 ack 版本（flush 时与缓冲版本取 max） */
  private pendingVersionAck: number | undefined
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly bridge: VsCodeBridge) {
    const saved = bridge.getState<PersistedState>()
    this.seq = typeof saved?.seq === 'number' && saved.seq >= 0 ? Math.floor(saved.seq) : 0
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
    this.liveWrapper = document.createElement('div')
    this.liveWrapper.className = 'oile-view-live'
    this.readingContainer = createReadingContainer()
    this.readingContainer.style.display = 'none'
    this.readingView = new VirtualReadingView(this.readingContainer)
    // 阅读滚动更新锚点（用户滚动即改变"当前位置"语义；短文档滚不动时
    // 锚点保持进入/定位时的值——视口读取无法表达目标，modeAnchor 是权威）。
    // 同一事件驱动 #7 的窗口重算（rAF 合帧）
    this.readingContainer.addEventListener('scroll', () => {
      const container = this.readingContainer
      const view = this.readingView
      if (container && view && container.scrollHeight > 0) {
        const anchor = view.currentAnchor()
        if (anchor !== null) {
          this.modeAnchor = anchor
        }
      }
      view?.handleScroll()
    })
    parent.appendChild(this.toolbar)
    parent.appendChild(this.banner)
    parent.appendChild(this.liveWrapper)
    parent.appendChild(this.readingContainer)
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
    this.view?.destroy()
    this.view = undefined
    this.banner?.remove()
    this.banner = undefined
    this.toolbar?.remove()
    this.toolbar = undefined
    this.liveWrapper?.remove()
    this.liveWrapper = undefined
    this.readingView?.dispose()
    this.readingView = undefined
    this.readingContainer?.remove()
    this.readingContainer = undefined
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
        this.handleFullSync(message.version, message.text, { restoreAnchor: true })
        break
      case 'edit.ack': {
        if (this.suspended) {
          // 暂停态：写回已停，任何 ack 结果都不再改变本地状态
          break
        }
        if (message.ok) {
          this.inFlight.delete(message.seq)
          // 未确认集的清空延后到缓冲 flush（组合输入映射仍需它）；
          // 全部确认且无缓冲挂起时本地与权威一致
          if (this.inFlight.size === 0 && !this.hasBufferedSync()) {
            this.unconfirmed = null
          }
          if (this.hasBufferedSync()) {
            this.pendingVersionAck = Math.max(this.pendingVersionAck ?? 0, message.version)
          } else {
            this.baseVersion = message.version
          }
          break
        }
        // ok:false（conflict/error）：本地有未确认输入时保留文本并暂停；
        // 无未确认输入时以附带全文重置（干净恢复），随后同样进入暂停
        const hasUnconfirmed = this.unconfirmed !== null || this.inFlight.size > 0
        if (!hasUnconfirmed && typeof message.text === 'string') {
          this.handleFullSync(message.version, message.text)
        }
        this.enterSuspended()
        break
      }
      case 'doc.changed':
        if (this.suspended) {
          // 暂停：外部增量不应用（保留本地输入，恢复时以全文对齐）
          break
        }
        if (this.composing || this.hasBufferedSync()) {
          // 组合中不打断输入；缓冲挂起期间到达的增量一并对齐到 flush
          this.pendingExternal.push({ version: message.version, changes: message.changes })
        } else if (this.unconfirmed) {
          // 在途未确认编辑：外部增量必须平移穿过未确认集，重叠则冲突暂停
          const mapped = mapSerGroupThroughCm(message.changes, this.unconfirmed)
          if (!mapped) {
            this.enterSuspended()
            break
          }
          this.dispatchExternal(mapped)
          const next = mapUnconfirmedThroughExternal(this.unconfirmed, message.changes)
          if (!next) {
            // 防御：应用前检查未拦截的不可映射段，按冲突暂停处理
            this.enterSuspended()
            break
          }
          this.unconfirmed = next
          this.baseVersion = message.version
        } else {
          this.baseVersion = message.version
          this.dispatchExternal(message.changes)
        }
        break
      case 'doc.resync':
        this.handleFullSync(message.version, message.text)
        break
      case 'session.suspended':
        // 宿主通知：面板处于暂停状态（典型为 webview 重载后的状态恢复）
        this.enterSuspended()
        break
      case 'view.mode.set':
        // 模式切换指令（宿主命令路径；webview 按钮走同一状态机）
        this.setViewMode(message.mode)
        break
      case 'view.locate': {
        // 定位（#10 查找/跳转入口）：光标移到源 offset；reading 滚动到块。
        // 纯视图操作——事务不带 changes，不产生编辑历史
        const pos = this.clampToDoc(message.offset)
        if (this.viewMode === 'reading' && this.readingView) {
          const start = this.readingView.anchorStartFor(pos) ?? pos
          this.modeAnchor = start
          this.readingView.scrollToSrcStart(start)
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
      case 'view.state.request': {
        const doc = this.view?.state.doc
        const content = this.view?.dom.querySelector('.cm-content')
        // 标题装饰的可观测 DOM 文本：活动（源码态）与非活动（隐藏标记）
        // 各取第一个样本，供集成测试断言 Live Preview 语义
        let headingActiveText: string | undefined
        let headingHiddenText: string | undefined
        if (content) {
          for (const el of Array.from(content.querySelectorAll<HTMLElement>('.oile-heading-line'))) {
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
            `.oile-reading-block[data-oile-src-start="${readingAnchorStart}"]`,
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
          headingLineCount: content ? content.querySelectorAll('.oile-heading-line').length : 0,
          headingActiveText,
          headingHiddenText,
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
        })
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
   * 进入冲突暂停：保留本地文本，上报快照（有未确认输入时），显示横幅，
   * 停止一切写回与外部同步；恢复唯一途径是 doc.resync（宿主 resumePanel）。
   */
  private enterSuspended(): void {
    if (this.suspended) {
      return
    }
    const hasUnconfirmed =
      this.unconfirmed !== null || this.inFlight.size > 0 || this.composing
    this.suspended = true
    this.setBannerVisible(true)
    if (hasUnconfirmed && this.sessionId) {
      this.bridge.postMessage({
        kind: 'conflict.report',
        sessionId: this.sessionId,
        docUri: this.docUri,
        version: this.baseVersion,
        text: this.view?.state.doc.toString() ?? '',
      })
    }
    // 暂停后这些状态不再参与同步；恢复时由 doc.resync 全量对齐。
    // pendingFull 保留：暂停前的全文重置（恢复内容）在 flush 时仍应用
    this.unconfirmed = null
    this.inFlight.clear()
    this.pendingExternal = []
  }

  /** 全文同步（init / doc.resync）：组合中缓冲，否则立即重置。
   *  doc.resync 对暂停面板兼作恢复信号：重置文本并解除暂停（#4）。
   *  组合中的恢复（含暂停解除）延后到 flush。
   *  init 路径（restoreAnchor）额外恢复持久化的模式锚点：reading 滚动到
   *  锚点块，live 恢复光标（webview 重载场景，#6）。 */
  private handleFullSync(
    version: number,
    text: string,
    opts: { restoreAnchor?: boolean } = {},
  ): void {
    if (this.composing || this.hasBufferedSync()) {
      this.pendingFull = { version, text }
      this.pendingExternal = []
      return
    }
    this.baseVersion = version
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
  }

  /** 容器显隐与按钮文案（稳定类名 oile-view-live / oile-view-reading） */
  private applyModeDom(mode: ViewMode): void {
    this.viewMode = mode
    if (this.liveWrapper) {
      this.liveWrapper.style.display = mode === 'live' ? '' : 'none'
    }
    if (this.readingContainer) {
      this.readingContainer.style.display = mode === 'reading' ? '' : 'none'
    }
    const btn = this.toolbar?.querySelector<HTMLButtonElement>('button.oile-mode-toggle')
    if (btn) {
      btn.textContent = mode === 'live' ? '切换到阅读模式' : '切换到实时预览'
    }
    this.persistState()
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

  private clampToDoc(offset: number): number {
    return Math.max(0, Math.min(offset, this.view?.state.doc.length ?? 0))
  }

  /** CSS 契约探针（#6 内部测试验证入口）：宿主注入的测试片段仅经稳定
   *  类名定位；此处在 view.state 请求时读取 computed style 回报。
   *  jsdom 无样式表计算，值可为空串/空变量（返回 null），真实断言在集成。 */
  private collectCssProbe(): CssProbeReport {
    const liveEl = this.liveWrapper?.querySelector('.oile-heading-line-1') ?? null
    const readingEl = this.readingContainer?.querySelector('.oile-reading-heading-1') ?? null
    const read = (el: Element | null): string | null =>
      el ? getComputedStyle(el).textDecorationColor : null
    let readingVarProbe: string | null = null
    if (this.readingContainer) {
      const value = getComputedStyle(this.readingContainer)
        .getPropertyValue('--oile-probe-var-reading')
        .trim()
      readingVarProbe = value === '' ? null : value
    }
    return {
      liveHeadingDecorationColor: read(liveEl),
      readingHeadingDecorationColor: read(readingEl),
      readingVarProbe,
    }
  }

  /** 持久化（合并写入）：seq、viewMode、anchor 共存互不覆盖 */
  private persistState(): void {
    const saved = this.bridge.getState<PersistedState>() ?? {}
    this.bridge.setState({
      ...saved,
      seq: this.seq,
      viewMode: this.viewMode,
      anchor: this.modeAnchor ?? undefined,
    })
  }

  /** 切换入口工具栏（#6）：按钮与宿主命令走同一状态机 */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'oile-toolbar'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'oile-mode-toggle'
    btn.textContent = '切换到阅读模式'
    btn.addEventListener('click', () => this.setViewMode('toggle'))
    bar.appendChild(btn)
    return bar
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
      this.pendingExternal = []
      if (this.pendingFull) {
        const { version, text } = this.pendingFull
        this.pendingFull = undefined
        this.replaceDoc(text)
        this.baseVersion = Math.max(version, suspendedAckVersion ?? version)
      }
      return
    }
    const ackVersion = this.pendingVersionAck
    this.pendingVersionAck = undefined
    if (this.pendingFull) {
      const { version, text } = this.pendingFull
      this.pendingFull = undefined
      this.pendingExternal = []
      this.unconfirmed = null
      this.replaceDoc(text)
      this.refreshReading()
      this.baseVersion = Math.max(version, ackVersion ?? version)
      return
    }
    const groups = this.pendingExternal
    this.pendingExternal = []
    let lastVersion = this.baseVersion
    for (const group of groups) {
      let changes = group.changes
      if (this.unconfirmed) {
        const mapped = mapSerGroupThroughCm(group.changes, this.unconfirmed)
        if (!mapped) {
          // 外部区间与本地未确认编辑重叠：无法安全映射。保留本地输入、
          // 暂停写回并上报冲突（#4；不再 sync.request 全文覆盖丢组合输入）
          this.enterSuspended()
          return
        }
        changes = mapped
      }
      const spec = this.clampedSpec(changes)
      this.view.dispatch({ changes: spec, annotations: externalSync.of(true) })
      if (this.unconfirmed) {
        // 未确认集以权威系原始增量重建（定义域推进到新权威基线），
        // 供其后缓冲组与后续外部增量对账
        const next = mapUnconfirmedThroughExternal(this.unconfirmed, group.changes)
        if (!next) {
          this.enterSuspended()
          return
        }
        this.unconfirmed = next
      }
      lastVersion = group.version
    }
    if (this.inFlight.size === 0) {
      // 缓冲应用完且无在途请求：本地与权威一致
      this.unconfirmed = null
    }
    this.refreshReading()
    this.baseVersion = Math.max(lastVersion, ackVersion ?? lastVersion)
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
    banner.className = 'oile-suspend-banner'
    banner.style.display = 'none'
    const label = document.createElement('span')
    label.className = 'oile-suspend-banner-text'
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
      // （ViewPlugin 按 visibleRanges），见 headings.ts 头注释
      headingDecorations,
      ...this.extraExtensions,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return
        }
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(externalSync)) {
            continue
          }
          if (this.suspended) {
            // 暂停写回：本地文本继续保留累积，但不回传、不追踪同步状态
            continue
          }
          // 未确认变更集累积：外部增量到达时须平移穿过（防静默错位）
          this.unconfirmed = this.unconfirmed ? this.unconfirmed.compose(tr.changes) : tr.changes
          const changes: SerChange[] = []
          tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({
              offset: fromA,
              length: toA - fromA,
              text: inserted.sliceString(0, inserted.length),
            })
          })
          if (changes.length === 0 || !this.sessionId) {
            continue
          }
          this.seq += 1
          this.persistState() // 合并写入：保留 viewMode/anchor（#6）
          this.inFlight.add(this.seq)
          this.bridge.postMessage({
            kind: 'edit.request',
            sessionId: this.sessionId,
            docUri: this.docUri,
            seq: this.seq,
            baseVersion: this.baseVersion,
            changes,
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
