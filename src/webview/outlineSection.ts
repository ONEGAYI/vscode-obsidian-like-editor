// 大纲控制域纯函数（#69）：标题索引 → 控制域几何与写操作变更计划的
// 单一事实源。控制域（Section）定义是 #69 右键菜单与 #70 拖拽排序的
// 共用契约——一个标题的控制域 = 标题行 + 其内容，直到下一个 level≤自身
// 的标题行之前（文末兜底）；跨级挂靠语义与折叠树（outlineCollapse 的
// parents 栈算法）一致：H5 紧跟 H2 时挂 H2 下，随 H2 的控制域。
//
// 与相邻模块的分工：
// - outline.ts 产 OutlineItem 序列（数据）；本模块消费序列回答几何问题
//   （子树/同级组/行范围）并生成文本变换（调级/重命名/删除的 SerChange）
// - outlineCollapse.ts 的展开集合状态机消费同款父子结构（栈算法在此
//   复算 parents——两边输入同为「文档序 level 序列」，语义由契约测试对拍）
// - 变更计划全部输出 SerChange（升序互不重叠）：调用方一次 CM6 事务
//   dispatch 全部变更 = 单笔 edit.request = 宿主撤销一次（写回事务口径）
//
// Setext 标题口径：调级与重命名把标题区（内容行 + 下划线行）整体替换为
// ATX 单行（`#`.repeat(level) + 空格 + 原文）——Setext 只能表达 1–2 级，
// 增级必然离开 Setext 能力域；统一转 ATX 使变换语义单一可预测（原文
// text 字段保留行内标记，标记是资产不丢失）。删除不受影响（按控制域行
// 范围整体删除）。
import type { Text } from '@codemirror/state'
import type { SerChange } from '../shared/protocol'
import type { OutlineItem } from './outline'

/** 控制域与子树消费的最小条目形状（OutlineItem 的结构子集） */
type SectionItem = Pick<OutlineItem, 'level'>

/** 重命名/调级消费的完整条目形状（需要原文 text 与行号） */
type RewritableItem = Pick<OutlineItem, 'level' | 'text' | 'line' | 'plainText'>

/** 条目父子结构（与 outlineCollapseFacts 同算法；输入独立保持本模块自洽） */
function sectionParents(items: readonly SectionItem[]): Array<number | null> {
  const parents: Array<number | null> = new Array(items.length).fill(null)
  const stack: number[] = [] // 栈内 level 严格递减
  for (let i = 0; i < items.length; i++) {
    while (stack.length > 0 && items[stack[stack.length - 1]!]!.level >= items[i]!.level) {
      stack.pop()
    }
    parents[i] = stack.length > 0 ? stack[stack.length - 1]! : null
    stack.push(i)
  }
  return parents
}

/** 子树条目索引（含自身，文档序）：下一个 level≤自身 的标题之前全部条目。
 *  跨级挂靠与折叠树一致（H5 紧跟 H2 归 H2 子树）。越界返回空数组 */
export function outlineSubtreeIndices(items: readonly SectionItem[], index: number): number[] {
  if (index < 0 || index >= items.length) {
    return []
  }
  const level = items[index]!.level
  const out: number[] = [index]
  for (let i = index + 1; i < items.length; i++) {
    if (items[i]!.level <= level) {
      break
    }
    out.push(i)
  }
  return out
}

/** 同级组条目索引（同父直接子级，含自身；parent=null 组 = 顶层组）。
 *  跨级挂靠时组内可混合 level（同为某父的直接子级）。越界返回空数组 */
export function outlineSiblingIndices(items: readonly SectionItem[], index: number): number[] {
  if (index < 0 || index >= items.length) {
    return []
  }
  const parents = sectionParents(items)
  const parent = parents[index]
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (parents[i] === parent) {
      out.push(i)
    }
  }
  return out
}

/** 控制域行范围条目形状（行号必需） */
type RangedItem = Pick<OutlineItem, 'level' | 'line'>

/** 控制域行范围（1 基含端）：startLine = 标题起始行；endLine = 下一个
 *  level≤自身 标题行前一行，无后继时文末兜底（totalLines）。
 *  Setext 条目的 startLine 是内容首行（与 OutlineItem.line 同口径）。
 *  越界返回 null */
export function outlineSectionLineRange(
  items: readonly RangedItem[],
  index: number,
  totalLines: number,
): { startLine: number; endLine: number } | null {
  if (index < 0 || index >= items.length) {
    return null
  }
  const level = items[index]!.level
  for (let i = index + 1; i < items.length; i++) {
    if (items[i]!.level <= level) {
      return { startLine: items[index]!.line, endLine: Math.max(items[index]!.line, items[i]!.line - 1) }
    }
  }
  return { startLine: items[index]!.line, endLine: Math.max(items[index]!.line, totalLines) }
}

/** ATX 行文本：`#`.repeat(level) + 空格 + 原文（含行内标记，资产不丢） */
export function outlineAtxLine(level: number, text: string): string {
  return `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text}`
}

/** 标题行文本是否 ATX 形态（#{1,6} + 空白；非标题行不会到达——调用方传
 *  的是 OutlineItem.line 所在行，extractOutline 只产真标题） */
function isAtxLine(lineText: string): boolean {
  return /^#{1,6}([ \t]|$)/.test(lineText)
}

/** 标题区 doc 偏移 [from, to)：ATX = 单行；Setext = 内容行（可多行）+
 *  下划线行（向下扫描首个 =/- 全等行，防御上限 8 行）。行号取自条目 */
export function outlineHeadingSpan(doc: Text, item: RewritableItem): { from: number; to: number } {
  const startLine = Math.min(Math.max(1, item.line), doc.lines)
  const start = doc.line(startLine)
  if (isAtxLine(doc.sliceString(start.from, start.to))) {
    return { from: start.from, to: start.to }
  }
  // Setext：向下找下划线行（内容行可多行；真标题必命中，扫描上限防御）
  for (let n = startLine + 1; n <= Math.min(doc.lines, startLine + 8); n++) {
    const line = doc.line(n)
    if (/^[=]+\s*$/.test(doc.sliceString(line.from, line.to)) ||
        /^-+\s*$/.test(doc.sliceString(line.from, line.to))) {
      return { from: start.from, to: line.to }
    }
  }
  // 未找到下划线（异常输入防御）：按单行处理
  return { from: start.from, to: start.to }
}

/** 调级变更计划：delta=±1，level clamp 1..6（边界不动）；recursive 作用
 *  整棵子树（子树内每条独立 clamp——H6 增加跳过、H1 减少跳过，其余照动）。
 *  Setext 规范化为 ATX 单行。无可变更返回 null；否则升序 SerChange[] */
export function outlineLevelChanges(
  doc: Text,
  items: readonly OutlineItem[],
  index: number,
  delta: -1 | 1,
  recursive: boolean,
): SerChange[] | null {
  const targets = recursive ? outlineSubtreeIndices(items, index) : index >= 0 && index < items.length ? [index] : []
  const changes: SerChange[] = []
  for (const i of targets) {
    const item = items[i]!
    const level = item.level + delta
    if (level < 1 || level > 6) {
      continue // 边界钳制：该条不动（子树内其余照常）
    }
    const span = outlineHeadingSpan(doc, item)
    changes.push({ offset: span.from, length: span.to - span.from, text: outlineAtxLine(level, item.text) })
  }
  if (changes.length === 0) {
    return null
  }
  changes.sort((a, b) => a.offset - b.offset)
  return changes
}

/** 重命名变更：整标题区替换为同级别 ATX 行（原文可含行内标记）。
 *  越界返回 null */
export function outlineRenameChange(
  doc: Text,
  items: readonly OutlineItem[],
  index: number,
  newText: string,
): SerChange | null {
  if (index < 0 || index >= items.length) {
    return null
  }
  const item = items[index]!
  const span = outlineHeadingSpan(doc, item)
  return { offset: span.from, length: span.to - span.from, text: outlineAtxLine(item.level, newText) }
}

/** 删除整控制域变更：标题行 + 内容直到下一同级/更浅标题行前（文末兜底）。
 *  删除起点吃掉段前换行（startLine-1 行行尾——非首行段），终点为段尾行
 *  行尾（不含其后换行）：相邻段直接相接，不留空行残段。首行段（startLine
 *  =1）方向相反：从 0 起删到段尾并吃掉段尾换行（非文末时 +1），文档不以
 *  空行开头；文末段删到 doc.length。越界返回 null */
export function outlineDeleteChange(
  doc: Text,
  items: readonly OutlineItem[],
  index: number,
): SerChange | null {
  if (index < 0 || index >= items.length) {
    return null
  }
  const range = outlineSectionLineRange(items, index, doc.lines)
  if (!range) {
    return null
  }
  const startLine = Math.min(Math.max(1, range.startLine), doc.lines)
  const endLine = Math.min(Math.max(startLine, range.endLine), doc.lines)
  const endTo = doc.line(endLine).to
  if (startLine > 1) {
    const from = doc.line(startLine - 1).to // 前一行行尾 = 段首换行
    if (endTo <= from) {
      return null // 防御（空段）
    }
    return { offset: from, length: endTo - from, text: '' }
  }
  // 首行段：to 吃掉段尾换行（endLine 非文末时 +1），文档不以空行开头
  const to = endLine < doc.lines ? endTo + 1 : endTo
  return { offset: 0, length: to, text: '' }
}

/** 复制载荷形态（标题链接 [[笔记名#标题]] 的拼接在宿主侧，不经此） */
export type OutlineCopyKind = 'heading' | 'siblings' | 'children' | 'section'

/** 复制载荷：heading = 剥标记可见文本；siblings = 同级组（含自身）逐行
 *  plainText；children = 子树（含自身）逐行 plainText；section = 整控制域
 *  源文（含标题行与正文，标记原样；末尾连续空行剥除——复制单节不带
 *  尾部空行，与删除的几何精确口径互不影响）。越界返回 null */
export function outlineCopyText(
  kind: OutlineCopyKind,
  doc: Text,
  items: readonly OutlineItem[],
  index: number,
): string | null {
  if (index < 0 || index >= items.length) {
    return null
  }
  const item = items[index]!
  if (kind === 'heading') {
    return item.plainText
  }
  if (kind === 'siblings') {
    const siblings = outlineSiblingIndices(items, index)
    return siblings.map((i) => items[i]!.plainText).join('\n')
  }
  if (kind === 'children') {
    const subtree = outlineSubtreeIndices(items, index)
    return subtree.map((i) => items[i]!.plainText).join('\n')
  }
  const range = outlineSectionLineRange(items, index, doc.lines)
  if (!range) {
    return null
  }
  return doc
    .sliceString(doc.line(range.startLine).from, doc.line(range.endLine).to)
    .replace(/(?:\n[ \t]*)+$/, '')
}
