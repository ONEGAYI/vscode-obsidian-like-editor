// webview 同步控制器：CM6 EditorView 与宿主消息的桥接（可在 jsdom 下单测）。
//
// 同步模式（依据探索笔记 03 §2）：
// - 本地乐观回显：用户输入立即进入 CM6 状态，同一事务的 changes 以
//   edit.request 发给宿主（不等 ack 即可继续输入）
// - 宿主确认：edit.ack ok 只推进 baseVersion（内容已一致），不重复应用；
//   拒绝时用附带的全文重同步
// - 外部变更：doc.changed 的增量单事务 dispatch（外部注解标记，updateListener
//   对其跳过，防止回发死循环）
// - seq 持久化：经 bridge.setState 保存，webview 重载（retainContextWhenHidden
//   关闭导致的状态重建）后继续编号，宿主按 seq 幂等去重
import { Annotation, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
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

function toCmChanges(changes: readonly SerChange[]) {
  return changes.map((c) => ({ from: c.offset, to: c.offset + c.length, insert: c.text }))
}

export class WebviewSyncController {
  private view: EditorView | undefined
  private sessionId = ''
  private docUri = ''
  private baseVersion = 0
  private seq: number
  private extraExtensions: Extension[] = []

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
        this.baseVersion = message.version
        this.replaceDoc(message.text)
        break
      case 'edit.ack':
        this.baseVersion = message.version
        if (!message.ok && typeof message.text === 'string') {
          this.replaceDoc(message.text)
        }
        break
      case 'doc.changed':
        this.baseVersion = message.version
        this.view?.dispatch({
          changes: toCmChanges(message.changes),
          annotations: externalSync.of(true),
        })
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
    ]
  }
}
