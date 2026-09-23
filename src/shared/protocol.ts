// 消息协议单一事实源：宿主（extension host）与 webview 两端共享的消息类型
// 与结构校验。两端不依赖 vscode / DOM，位置一律使用全文 UTF-16 code unit
// offset（与 TextDocument.contentChanges 的 rangeOffset/rangeLength 及
// CodeMirror 的文档定位同构）。
//
// 设计依据：探索笔记 02 §5（协议设计建议）、§6（陷阱清单）。

/** 一次变更：把全文 [offset, offset+length) 替换为 text（与 contentChanges 同构） */
export interface SerChange {
  offset: number
  length: number
  text: string
}

/** 宿主 → webview 消息 */
export type HostToWebview =
  /** ready 后首发：全文 + 当前权威版本 */
  | { kind: 'init'; sessionId: string; docUri: string; version: number; text: string }
  /** 编辑请求已应用（或被拒绝）。
   *  失败语义（#4 起）：conflict = 不可安全应用（重定位失败/版本异常/日志缺口），
   *  宿主已保留该请求的输入并暂停面板写回；error = 写回通道失败（applyEdit）。
   *  两者均附权威全文：webview 无未确认输入时重置装载，有则保留本地输入。 */
  | { kind: 'edit.ack'; seq: number; ok: true; version: number }
  | { kind: 'edit.ack'; seq: number; ok: false; reason: 'conflict' | 'error'; version: number; text?: string }
  /** 权威文档发生变更：变更增量（同指变更前文档） */
  | { kind: 'doc.changed'; version: number; changes: SerChange[]; origin: 'external' }
  /** 全文重同步（应 sync.request 或宿主主动）：webview 以全文重置本地文档；
   *  对暂停中的面板兼作恢复信号（重置并解除暂停） */
  | { kind: 'doc.resync'; version: number; text: string }
  /** 面板处于暂停写回状态（webview 重载后由 init 后跟随下发，恢复暂停提示） */
  | { kind: 'session.suspended'; version: number; reason: 'conflict' | 'host-error' }
  /** 请求 webview 回报视图诊断（文本与渲染行数，供测试与性能观测） */
  | { kind: 'view.state.request' }

/** webview → 宿主消息 */
export type WebviewToHost =
  /** webview 脚本加载完成，请求 init */
  | { kind: 'ready' }
  /** 编辑请求：seq 会话内单调递增；baseVersion 为发送方自认的权威版本 */
  | {
      kind: 'edit.request'
      sessionId: string
      docUri: string
      seq: number
      baseVersion: number
      changes: SerChange[]
    }
  /** 撤销/重做请求：作用于宿主 TextDocument 权威历史（探索笔记 03 §4） */
  | { kind: 'history.request'; op: 'undo' | 'redo' }
  /** 请求宿主回发全文重同步（外部变更与本地状态无法安全对齐时） */
  | { kind: 'sync.request' }
  /** 冲突/暂停时的本地全文快照上报：宿主保存供用户取回未确认输入 */
  | { kind: 'conflict.report'; sessionId: string; docUri: string; version: number; text: string }
  /** 暂停横幅按钮动作：copy = 请求宿主复制未确认输入；resume = 请求恢复（重新同步） */
  | { kind: 'conflict.action'; sessionId: string; docUri: string; action: 'copy' | 'resume' }
  /** 视图诊断回报 */
  | {
      kind: 'view.state'
      text: string
      docLength: number
      lineCount: number
      renderedLines: number
      /** 面板是否处于暂停写回状态（#4；可选字段向后兼容） */
      suspended?: boolean
    }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isPositiveInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isString(v: unknown): boolean {
  return typeof v === 'string'
}

export function isSerChange(v: unknown): v is SerChange {
  return (
    isObject(v) &&
    isNonNegativeInt(v.offset) &&
    isNonNegativeInt(v.length) &&
    isString(v.text)
  )
}

function isSerChangeArray(v: unknown): v is SerChange[] {
  return Array.isArray(v) && v.every(isSerChange)
}

/** 宿主侧校验 webview 消息；非法消息必须整体丢弃，不部分读取字段 */
export function isWebviewToHost(v: unknown): v is WebviewToHost {
  if (!isObject(v)) {
    return false
  }
  switch (v.kind) {
    case 'ready':
      return true
    case 'edit.request':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isPositiveInt(v.seq) &&
        isNonNegativeInt(v.baseVersion) &&
        isSerChangeArray(v.changes)
      )
    case 'history.request':
      return v.op === 'undo' || v.op === 'redo'
    case 'sync.request':
      return true
    case 'conflict.report':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isNonNegativeInt(v.version) &&
        isString(v.text)
      )
    case 'conflict.action':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        (v.action === 'copy' || v.action === 'resume')
      )
    case 'view.state':
      return (
        isString(v.text) &&
        isNonNegativeInt(v.docLength) &&
        isNonNegativeInt(v.lineCount) &&
        isNonNegativeInt(v.renderedLines) &&
        (v.suspended === undefined || typeof v.suspended === 'boolean')
      )
    default:
      return false
  }
}

/** webview 侧校验宿主消息 */
export function isHostToWebview(v: unknown): v is HostToWebview {
  if (!isObject(v)) {
    return false
  }
  switch (v.kind) {
    case 'init':
      return (
        isString(v.sessionId) &&
        isString(v.docUri) &&
        isNonNegativeInt(v.version) &&
        isString(v.text)
      )
    case 'edit.ack':
      if (!isPositiveInt(v.seq) || !isNonNegativeInt(v.version)) {
        return false
      }
      if (v.ok === true) {
        return true
      }
      if (v.ok === false) {
        return (
          (v.reason === 'conflict' || v.reason === 'error') &&
          (v.text === undefined || isString(v.text))
        )
      }
      return false
    case 'doc.changed':
      return (
        isNonNegativeInt(v.version) &&
        isSerChangeArray(v.changes) &&
        v.origin === 'external'
      )
    case 'doc.resync':
      return isNonNegativeInt(v.version) && isString(v.text)
    case 'session.suspended':
      return (
        isNonNegativeInt(v.version) &&
        (v.reason === 'conflict' || v.reason === 'host-error')
      )
    case 'view.state.request':
      return true
    default:
      return false
  }
}
