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
//   安全映射时保守请求全文重同步（sync.request），不静默丢字
// - seq 持久化：经 bridge.setState 保存，webview 重载（retainContextWhenHidden
//   关闭导致的状态重建）后继续编号，宿主按 seq 幂等去重
import { Annotation, ChangeSet, EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  isHostToWebview,
  type SerChange,
} from '../shared/protocol'

/** webview 与宿主的通信通道（由 acquireVsCodeApi 适配） */
export interface VsCodeBridge {
  postMessage(message: unknown): void
  getState<T>(): T | undefined
  setState(state: unknown): void
}

/** 外部同步事务标记：updateListener 见到它即跳过（不回发） */
const externalSync = Annotation.define<boolean>()

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

export class WebviewSyncController {
  private view: EditorView | undefined
  private sessionId = ''
  private docUri = ''
  private baseVersion = 0
  private seq: number
  private extraExtensions: Extension[] = []

  // ---- IME 组合缓冲状态 ----
  /** 组合进行中（DOM compositionstart..compositionend） */
  private composing = false
  /** 组合期间到达、待 flush 的外部增量（按到达序） */
  private pendingExternal: BufferedIncremental[] = []
  /** 组合期间到达、待 flush 的全文消息（覆盖增量形态） */
  private pendingFull: { version: number; text: string } | undefined
  /** 缓冲挂起期间收到的 ack 版本（flush 时与缓冲版本取 max） */
  private pendingVersionAck: number | undefined
  /** 缓冲挂起期间本地事务（含组合上屏事务）的累积变更，flush 坐标映射用 */
  private bufferLocal: ChangeSet | null = null
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly bridge: VsCodeBridge) {
    const saved = bridge.getState<{ seq?: unknown }>()
    this.seq = typeof saved?.seq === 'number' && saved.seq >= 0 ? Math.floor(saved.seq) : 0
  }

  /** 创建编辑器视图并向宿主发送 ready（HTML 加载完成后调用一次） */
  mount(parent: HTMLElement, extraExtensions: Extension[] = []): void {
    if (this.view) {
      return
    }
    this.extraExtensions = extraExtensions
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: '', extensions: this.extensions() }),
    })
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
        this.handleFullSync(message.version, message.text)
        break
      case 'edit.ack': {
        const fullText = message.ok === false ? message.text : undefined
        if (typeof fullText === 'string') {
          // 拒绝附全文：重置本地文档（组合中缓冲到 flush）
          this.handleFullSync(message.version, fullText)
        } else {
          // 成功确认或不附全文的失败（error）：不改变文档，仅推进版本
          // （缓冲挂起时延后到 flush，避免虚报 webview 实际状态对应的版本）
          if (this.hasBufferedSync()) {
            this.pendingVersionAck = Math.max(this.pendingVersionAck ?? 0, message.version)
          } else {
            this.baseVersion = message.version
          }
        }
        break
      }
      case 'doc.changed':
        if (this.composing || this.hasBufferedSync()) {
          // 组合中不打断输入；缓冲挂起期间到达的增量一并对齐到 flush
          this.pendingExternal.push({ version: message.version, changes: message.changes })
        } else {
          this.baseVersion = message.version
          this.dispatchExternal(message.changes)
        }
        break
      case 'doc.resync':
        this.handleFullSync(message.version, message.text)
        break
      case 'view.state.request': {
        const doc = this.view?.state.doc
        this.bridge.postMessage({
          kind: 'view.state',
          text: doc?.toString() ?? '',
          docLength: doc?.length ?? 0,
          lineCount: doc?.lines ?? 0,
          renderedLines: this.view?.dom.querySelectorAll('.cm-line').length ?? 0,
        })
        break
      }
    }
  }

  /** 全文同步（init / doc.resync / ack 失败附全文）：组合中缓冲，否则立即重置 */
  private handleFullSync(version: number, text: string): void {
    if (this.composing || this.hasBufferedSync()) {
      this.pendingFull = { version, text }
      this.pendingExternal = []
    } else {
      this.baseVersion = version
      this.replaceDoc(text)
    }
  }

  private hasBufferedSync(): boolean {
    return this.pendingExternal.length > 0 || this.pendingFull !== undefined
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
   * 避免超范围坐标抛错）
   */
  private dispatchExternal(changes: readonly SerChange[]): void {
    const view = this.view
    if (!view) {
      return
    }
    view.dispatch({ changes: this.clampedSpec(changes), annotations: externalSync.of(true) })
  }

  /**
   * 应用缓冲的外部同步。调用时机：compositionend 后的宏任务（setTimeout 0），
   * 晚于 CM6 在 microtask 中生成的组合上屏事务（@codemirror/view 6.43 的
   * observers.compositionend 用 Promise.resolve().then(flush)），因此
   * bufferLocal 此时已含组合编辑、组合文本的 edit.request 也已发出。
   */
  private flushBufferedExternal(): void {
    this.flushTimer = undefined
    if (this.composing || !this.view) {
      // 新一轮组合进行中：缓冲保持，待下一轮 compositionend 重新调度
      return
    }
    const ackVersion = this.pendingVersionAck
    this.pendingVersionAck = undefined
    if (this.pendingFull) {
      const { version, text } = this.pendingFull
      this.pendingFull = undefined
      this.pendingExternal = []
      this.bufferLocal = null
      this.replaceDoc(text)
      this.baseVersion = Math.max(version, ackVersion ?? version)
      return
    }
    const groups = this.pendingExternal
    this.pendingExternal = []
    let local = this.bufferLocal
    this.bufferLocal = null
    let lastVersion = this.baseVersion
    for (const group of groups) {
      let changes = group.changes
      if (local) {
        const mapped = mapSerGroupThroughCm(group.changes, local)
        if (!mapped) {
          // 外部区间与本地未确认编辑重叠：无法安全映射，请求宿主全文重同步。
          // 保守策略（重叠合并保留未确认输入属 #4 范围，本票不实现）
          this.bridge.postMessage({ kind: 'sync.request' })
          return
        }
        changes = mapped
      }
      // spec 与 ChangeSet 的坐标基准都必须是 dispatch 前的文档
      const spec = this.clampedSpec(changes)
      const baseLen = this.view.state.doc.length
      const applied = ChangeSet.of(spec, baseLen)
      this.view.dispatch({ changes: spec, annotations: externalSync.of(true) })
      if (local) {
        // 并入 local 供其后缓冲组映射
        local = local.compose(applied)
      }
      lastVersion = group.version
    }
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

  private extensions() {
    return [
      EditorView.lineWrapping,
      ...this.extraExtensions,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return
        }
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(externalSync)) {
            continue
          }
          // 缓冲挂起期间累积本地变更（组合上屏事务等），供 flush 坐标映射
          if (this.hasBufferedSync()) {
            this.bufferLocal = this.bufferLocal ? this.bufferLocal.compose(tr.changes) : tr.changes
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
            continue
          }
          this.seq += 1
          this.bridge.setState({ seq: this.seq })
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
