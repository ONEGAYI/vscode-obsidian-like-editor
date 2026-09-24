// 任务勾选点击 → 安全编辑解析（工单 #9）：两种视图共用的纯函数层。
//
// 定位安全契约（工单 #9 要点 1）：
// - 校验按源位置区间精确匹配当前文档，绝不做文本内容查找——重复任务行
//   内容相同，按文本查找会改错目标
// - 过期点击（点击到派发之间文档被外部修改）：live 路径的 widget 位置
//   随文档同步、天然无过期；reading 路径的 checkbox 锚点可能过期——
//   严格再校验（锚点区间仍是标记三字符 + 所在行仍是任务行且标记恰在
//   锚点位置），任一失败即放弃（零编辑、视图保持一致），绝不改错行
// - 「无内容变化的重渲染不新增历史」：权威内容已是目标态时返回 null，
//   不产生文档变更与撤销条目
// - 勾选写为 [x]、取消写为 [ ]；[X] 视为已勾选（与阅读渲染正则一致）
import { TASK_ITEM_RE } from './readingMarkdown'

/** 一次任务勾选编辑：把 [from, to) 替换为 nextText（'[x]' 或 '[ ]'） */
export interface TaskToggleEdit {
  from: number
  to: number
  nextText: string
}

const MARKER_RE = /^\[([ xX])\]$/

function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(v, max))
}

/**
 * 区间是任务标记且需要翻转时返回替换编辑。
 * displayedChecked 是渲染时（用户所见）的勾选态——点击意图 = 翻转显示态；
 * 权威已是目标态时返回 null（无内容变化，不新增历史）。
 */
function markerEdit(doc: string, from: number, to: number, displayedChecked: boolean): TaskToggleEdit | null {
  const slice = doc.slice(from, to)
  if (!MARKER_RE.test(slice)) {
    return null
  }
  const currentChecked = slice[1] !== ' '
  const intentChecked = !displayedChecked
  if (currentChecked === intentChecked) {
    return null // 权威已是目标态：不改文档（重渲染不新增历史）
  }
  return { from, to, nextText: intentChecked ? '[x]' : '[ ]' }
}

/**
 * live 路径解析：widget 位置来自当前文档的装饰（posAtDOM），与文档同步，
 * 只需字符区间校验。返回 null 表示放弃（区间非标记或已是目标态）。
 */
export function resolveTaskToggleAtMarker(
  doc: string,
  from: number,
  to: number,
  displayedChecked: boolean,
): TaskToggleEdit | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to - from !== 3) {
    return null
  }
  return markerEdit(doc, clamp(from, doc.length), clamp(to, doc.length), displayedChecked)
}

/**
 * reading 路径解析：checkbox 携带的源锚点（marker 区间）严格再校验。
 * 三重防线：
 * 1. 锚点区间内仍是任务标记三字符（行漂移后位置落入其他内容即失败）
 * 2. 所在行仍是任务行（TASK_ITEM_RE；外部把行改成普通文本即失败——
 *    仅字符匹配会把勾选写进普通文本）
 * 3. 行内标记恰好在锚点位置（行仍是任务行但标记移动了即失败）
 * 任一失败返回 null（放弃点击），绝不退化为按文本查找。
 */
export function resolveStaleTaskToggle(
  doc: string,
  anchorStart: number,
  anchorEnd: number,
  displayedChecked: boolean,
): TaskToggleEdit | null {
  if (
    !Number.isInteger(anchorStart) ||
    !Number.isInteger(anchorEnd) ||
    anchorStart < 0 ||
    anchorEnd - anchorStart !== 3 ||
    anchorStart > doc.length
  ) {
    return null
  }
  const edit = markerEdit(doc, anchorStart, anchorEnd, displayedChecked)
  if (!edit) {
    return null
  }
  // 所在行严格校验：行首起匹配任务行，且标记位置恰为锚点
  const lineStart = doc.lastIndexOf('\n', anchorStart - 1) + 1
  const nl = doc.indexOf('\n', lineStart)
  const line = doc.slice(lineStart, nl < 0 ? doc.length : nl)
  const m = TASK_ITEM_RE.exec(line)
  if (!m) {
    return null
  }
  const markerFrom = lineStart + m[0].indexOf('[')
  if (markerFrom !== anchorStart) {
    return null
  }
  return edit
}
