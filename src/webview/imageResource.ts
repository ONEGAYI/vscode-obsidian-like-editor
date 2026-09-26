// webview 图片资源管理器（工单 #10）：双视图共用的图片生命周期状态机。
//
// 状态机（槽位级，槽位 = 阅读视图的 <img> 或 live 视图 widget 的容器 span）：
//   loading（占位）→ loaded（宿主/直连 src 应用且 img load 事件确认）
//                  → error（宿主解析失败或 img 加载失败；点击可重试）
//
// 通道分工：
// - http/https 图源（deps.isDirectSrc）：不经宿主，直接应用原始 src——
//   可加载性由 webview CSP 决定（https 放行、http 被拦 → error 态可重试）
// - 其余（工作区相对路径）：经宿主 image.request / image.result 通道解析为
//   webview 资源 URI（asWebviewUri；本地与远程工作区同通道）
//
// 释放（「离开视口卸载释放节点」）：
// - detach/detachWithin：解绑监听、清空 img src（释放解码位图）、状态归零、
//   槽位从条目移除；条目无槽位时整体回收（解析结果字符串一并释放）
// - sweep：CM6 widget 无销毁回调——以 isConnected 兜底清理脱离文档的槽位
//
// 本层不触碰编辑器状态与文档文本（图片是纯显示资源，零写回契约的使用方
// 由 syncController 保证；重试点击会阻断冒泡以免触发外层链接导航）。
import { t } from '../shared/i18n'

/** 槽位状态（stable class/data 入口，样式见 main.css 与选择器映射表） */
export type ImageSlotState = 'loading' | 'loaded' | 'error'

export const IMAGE_CLASS_NAMES = {
  /** 图片槽位基类（阅读 img 与 live widget 容器共用） */
  image: 'vsidian-image',
  /** 状态修饰类（与 data-vsidian-img-state 同步） */
  state: (s: ImageSlotState) => `vsidian-image-${s}`,
} as const

export interface ImageManagerDeps {
  /** 远程直连图源判定（http/https）：true 时应用原始 src，不经宿主 */
  isDirectSrc(src: string): boolean
  /** 发起宿主解析请求（非直连图源；reqId 由管理器分配并自增） */
  requestHost(src: string, reqId: number): void
}

/** 图源规范化：容错 percent-decode 一次。CommonMark 语义下链接目标就是
 *  解码值——live 源文原样（部分编码）与 markdown-it 全编码形态由此归一为
 *  同一逻辑图源（去重请求、同键缓存）；非法转义序列按原样保留。 */
function normalizeImgSrc(src: string): string {
  try {
    return decodeURIComponent(src)
  } catch {
    return src
  }
}

/** 宿主 image.result 消息的数据形态（协议层已校验） */
export interface ImageResultPayload {
  reqId: number
  ok: boolean
  src?: string
  reason?: string
  detail?: string
}

interface ImageEntry {
  status: 'pending' | 'ok' | 'error'
  /** 解析成功后的可加载地址（直连图源为原始 src） */
  src?: string
  reason?: string
  reqId?: number
  waiters: Set<HTMLElement>
}

interface SlotRecord {
  rawSrc: string
  entry: ImageEntry
  /** 实际承载图片的元素（阅读 = 槽位自身；live = render 回调创建的 img） */
  img: HTMLImageElement | null
  render?: (slot: HTMLElement, src: string) => HTMLImageElement
  onLoad: () => void
  onError: () => void
  onClick: (event: MouseEvent) => void
}

export class ImageResourceManager {
  private readonly deps: ImageManagerDeps
  private readonly slots = new Map<HTMLElement, SlotRecord>()
  private readonly entries = new Map<string, ImageEntry>()
  private nextReqId = 0

  constructor(deps: ImageManagerDeps) {
    this.deps = deps
  }

  /**
   * 绑定一个图片槽位。阅读视图：槽位即 <img>（原 src 已剥离），解析成功
   * 后直接写回 src 属性。live 视图：传 render 回调构建内部 <img>
   * （widget 重建时由回调恢复），返回值用于监听 load/error。
   */
  attach(
    slot: HTMLElement,
    rawSrc: string,
    render?: (slot: HTMLElement, src: string) => HTMLImageElement,
  ): void {
    if (this.slots.has(slot)) {
      return
    }
    rawSrc = normalizeImgSrc(rawSrc)
    slot.classList.add(IMAGE_CLASS_NAMES.image)
    slot.dataset['vsidianImgSrc'] = rawSrc
    let entry = this.entries.get(rawSrc)
    if (!entry) {
      if (this.deps.isDirectSrc(rawSrc)) {
        entry = { status: 'ok', src: rawSrc, waiters: new Set() }
        this.entries.set(rawSrc, entry)
      } else {
        const reqId = ++this.nextReqId
        entry = { status: 'pending', reqId, waiters: new Set() }
        // 先入表再发请求：同步实现的 requestHost（测试直驱）产出的结果
        // 才能路由回本条目
        this.entries.set(rawSrc, entry)
        this.deps.requestHost(rawSrc, reqId)
      }
    }
    const record: SlotRecord = {
      rawSrc,
      entry,
      img: null,
      render,
      onLoad: () => this.setSlotState(slot, 'loaded'),
      onError: () => this.setSlotState(slot, 'error', 'load-failed'),
      onClick: (event) => this.handleRetryClick(slot, event),
    }
    this.slots.set(slot, record)
    entry.waiters.add(slot)
    slot.addEventListener('load', record.onLoad)
    slot.addEventListener('error', record.onError)
    slot.addEventListener('click', record.onClick)
    if (entry.status === 'ok') {
      this.applyToSlot(slot, record, entry.src!)
    } else if (entry.status === 'error') {
      this.setSlotState(slot, 'error', entry.reason)
    } else {
      this.setSlotState(slot, 'loading')
    }
  }

  /** 解绑并释放一个槽位 */
  detach(slot: HTMLElement): void {
    const record = this.slots.get(slot)
    if (!record) {
      return
    }
    this.slots.delete(slot)
    record.entry.waiters.delete(slot)
    slot.removeEventListener('load', record.onLoad)
    slot.removeEventListener('error', record.onError)
    slot.removeEventListener('click', record.onClick)
    this.releaseImages(record)
    delete slot.dataset['vsidianImgState']
    slot.classList.remove(
      IMAGE_CLASS_NAMES.state('loading'),
      IMAGE_CLASS_NAMES.state('loaded'),
      IMAGE_CLASS_NAMES.state('error'),
    )
    if (record.entry.waiters.size === 0) {
      // 条目回收：解析结果字符串一并释放（回视口时重新请求）
      this.entries.delete(record.rawSrc)
    }
  }

  /** 释放容器（阅读块卸载/容器重建）内全部图片槽位 */
  detachWithin(root: HTMLElement): void {
    for (const slot of [...this.slots.keys()]) {
      if (root === slot || root.contains(slot)) {
        this.detach(slot)
      }
    }
  }

  /** 宿主 image.result 路由（协议层已校验的消息体） */
  handleResult(msg: ImageResultPayload): void {
    let matched: ImageEntry | undefined
    for (const entry of this.entries.values()) {
      if (entry.status === 'pending' && entry.reqId === msg.reqId) {
        matched = entry
        break
      }
    }
    if (!matched) {
      return // 未知/迟到 reqId：无在途条目，丢弃
    }
    if (msg.ok && typeof msg.src === 'string') {
      matched.status = 'ok'
      matched.src = msg.src
      for (const slot of matched.waiters) {
        const record = this.slots.get(slot)
        if (record) {
          this.applyToSlot(slot, record, msg.src!)
        }
      }
      return
    }
    matched.status = 'error'
    matched.reason = msg.reason ?? 'read-error'
    for (const slot of matched.waiters) {
      this.setSlotState(slot, 'error', matched.reason)
    }
  }

  /** 清理已脱离文档的槽位（CM6 widget 移出视口无销毁回调的兜底）。
   *  只清理 live 视图槽位（attach 时带 render 回调者）：阅读视图槽位的
   *  生命周期由块挂载/卸载钩子显式管理，且 jsdom 测试环境容器可不在
   *  文档树内（isConnected 不可作为阅读槽位的存活判据） */
  sweep(): void {
    for (const slot of [...this.slots.keys()]) {
      const record = this.slots.get(slot)
      if (record && record.render !== undefined && !slot.isConnected) {
        this.detach(slot)
      }
    }
  }

  /** 状态计数（view.state 的 imageStates 观测数据源） */
  getStates(): { loading: number; loaded: number; error: number } {
    const out = { loading: 0, loaded: 0, error: 0 }
    for (const slot of this.slots.keys()) {
      const s = slot.dataset['vsidianImgState']
      if (s === 'loading' || s === 'loaded' || s === 'error') {
        out[s] += 1
      }
    }
    return out
  }

  dispose(): void {
    for (const slot of [...this.slots.keys()]) {
      this.detach(slot)
    }
    this.entries.clear()
  }

  // ---- 内部 ----

  private applyToSlot(slot: HTMLElement, record: SlotRecord, src: string): void {
    this.releaseImages(record)
    if (record.render) {
      const img = record.render(slot, src)
      record.img = img
      img.addEventListener('load', record.onLoad)
      img.addEventListener('error', record.onError)
    } else if (slot instanceof HTMLImageElement) {
      record.img = slot
      slot.setAttribute('src', src)
    }
    this.setSlotState(slot, 'loading') // src 已应用，等 img load/error 确认
  }

  private releaseImages(record: SlotRecord): void {
    if (record.img) {
      record.img.removeEventListener('load', record.onLoad)
      record.img.removeEventListener('error', record.onError)
      // 清空 src：释放解码位图（离开视口即不再占用内存）
      record.img.removeAttribute('src')
      record.img = null
    }
  }

  private setSlotState(slot: HTMLElement, state: ImageSlotState, reason?: string): void {
    slot.dataset['vsidianImgState'] = state
    for (const s of ['loading', 'loaded', 'error'] as const) {
      slot.classList.toggle(IMAGE_CLASS_NAMES.state(s), s === state)
    }
    if (state === 'error') {
      slot.dataset['vsidianImgReason'] = reason ?? 'unknown'
      slot.title = t('decor.imageError', { reason: reason ?? t('decor.unknownReason') })
    } else {
      delete slot.dataset['vsidianImgReason']
    }
  }

  private handleRetryClick(slot: HTMLElement, event: MouseEvent): void {
    const record = this.slots.get(slot)
    if (!record || slot.dataset['vsidianImgState'] !== 'error') {
      return
    }
    // 阻断冒泡：错误态重试不得触发外层 <a> 导航或容器级点击语义
    event.stopPropagation()
    event.preventDefault()
    this.setSlotState(slot, 'loading')
    const entry = record.entry
    if (entry.status === 'ok') {
      // 解析成功但加载失败（坏数据/网络）：重新应用同一地址
      this.applyToSlot(slot, record, entry.src!)
      return
    }
    if (entry.status === 'error') {
      // 宿主解析失败：旧条目作废（同 src 的其他槽位保持本地 error 态，
      // 可各自重试），解绑后重新 attach 发起新请求（新 reqId）
      this.entries.delete(record.rawSrc)
      this.detach(slot)
      this.attach(slot, record.rawSrc, record.render)
    }
    // pending：在途请求到达后自然迁移，不重复发起
  }
}
