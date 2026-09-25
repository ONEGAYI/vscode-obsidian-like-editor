// 大纲控制域纯函数（#69）：标题索引 → 控制域几何与写操作变更计划的
// 单一事实源。控制域（Section）定义是 #69 右键菜单与 #70 拖拽排序的
// 共用契约——一个标题的控制域 = 标题行 + 其内容，直到下一个 level≤自身
// 的标题行之前（文末兜底）；跨级挂靠语义与折叠树（outlineCollapse 的
// parents 栈算法）一致：H5 紧跟 H2 时挂 H2 下，随 H2 的控制域。
//
// 与相邻模块的分工：
// - outline.ts 产 OutlineItem 序列（数据）；本模块消费序列回答几何问题
//   （子树/同级组/行范围）并生成文本变换（调级/重命名/删除的 SerChange）
// - 标题区（写操作要替换的字节区间）以条目的语法树权威范围（OutlineItem.
//   headingSpan）为准——真条目的几何不再靠行文本启发式推断（第 3 轮复核
//   ①②③）；启发式（结构前缀 + ATX/Setext 判定）只作手写/陈旧条目的兜底，
//   且已按结构前缀口径与容器判据修正（Unicode 空白不当前缀、缩进后的容器
//   标记可识别、标记链相等即同一容器、列表项内容列续行可认）
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

/** 重命名/调级消费的完整条目形状（需要原文 text、行号与标题区权威范围） */
type RewritableItem = Pick<OutlineItem, 'level' | 'text' | 'line' | 'plainText' | 'headingSpan'>

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

/** 写回计划的约定判据：变更段按 offset 升序且互不重叠（可相邻）。CM6
 *  ChangeSet 对乱序/重叠段不报错而是 flush 合成，会静默错位写入权威文档
 *  ——全部计划生成端（调级/重命名/删除/拖拽搬移）都必须满足；写回前用它
 *  兜底断言（review-loops C3，第 2 轮抽成纯函数以便直接单测） */
export function outlineChangesOrdered(
  changes: readonly { offset: number; length: number }[],
): boolean {
  for (let i = 1; i < changes.length; i++) {
    const prev = changes[i - 1]!
    const cur = changes[i]!
    if (cur.offset < prev.offset + prev.length) {
      return false
    }
  }
  return true
}

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
  const startLine = items[index]!.line
  if (startLine > totalLines) {
    return null // 陈旧条目（行号越出文档）：不做几何推断
  }
  const level = items[index]!.level
  for (let i = index + 1; i < items.length; i++) {
    if (items[i]!.level <= level) {
      const endLine = Math.min(Math.max(startLine, items[i]!.line - 1), totalLines)
      return { startLine, endLine }
    }
  }
  return { startLine, endLine: totalLines }
}

/** ATX 行文本：`#`.repeat(level) + 空格 + 原文（含行内标记，资产不丢） */
export function outlineAtxLine(level: number, text: string): string {
  return `${'#'.repeat(Math.max(1, Math.min(6, level)))} ${text}`
}

/** ATX 标记：`#{1,6}` 后接空白或行尾。判定不改写文本（Unicode 空白不是
 *  ATX 标记前置，见 outlineSplitContainerPrefix） */
const ATX_MARK_RE = /^#{1,6}([ \t]|$)/

/** 列表标记：`-`/`*`/`+`/`1.`/`1)` + 必要空白（组 1 = 标记 token，链比较用） */
const LIST_MARKER_RE = /^([-*+]|\d+[.)])([ \t]+)/

/** 行首结构前缀扫描结果 */
interface StructuralPrefix {
  /** 行首到标题内容起点之间的原文（ASCII 缩进 + 容器标记链）：写回时逐字节
   *  保留的原样片段（`  - # T` 的 `  - `、` > # T` 的 ` > `） */
  prefix: string
  /** 容器标记链（token：`>` / `-` / `*` / `+` / `1.` / `1)`；不含缩进与标记后
   *  空白——`> T` 与 `>  ===` 同链，`- T` 与 `  ===` 则不同链） */
  markers: string[]
  /** 前缀之后的余下内容（原样；行首空白未被认作结构前缀时仍留在 rest 里） */
  rest: string
}

/**
 * 行文本 → 结构前缀（≤3 个 ASCII 空白缩进 + 容器标记链，可交错嵌套）与
 * 余下内容。**只认 ASCII 空格/制表符与容器标记**：U+3000/NBSP 等 Unicode
 * 空白是标题内容而非缩进（第 3 轮复核 ①：按 trimStart 切前缀会把它们吞进
 * 前缀，使非 ASCII 空白开头的标题被改写成非标题）。缩进计入前缀当且仅当
 * 其后是容器标记或 ATX 标记（`  - # T` 的 `  - `、`   # T` 的 `   `），否则
 * 留在 rest（`  ===` 的 rest 仍是自身，Setext 续行判定据此比较行首空白数）。
 */
export function outlineSplitContainerPrefix(text: string): StructuralPrefix {
  let pos = 0
  const markers: string[] = []
  for (;;) {
    // 每层容器标记前允许 ≤3 个 ASCII 空白的缩进（CommonMark 缩进口径；4 空格
    // 及以上不是标题——交给解析器与既有语义处理）
    let k = pos
    let indent = 0
    while (indent < 3 && (text[k] === ' ' || text[k] === '\t')) {
      k += 1
      indent += 1
    }
    if (text[k] === '>') {
      markers.push('>')
      k += 1
      while (text[k] === ' ' || text[k] === '\t') {
        k += 1 // 块引用标记后的可选空白不属于标记 token（`> T` 与 `>  ===` 同链）
      }
      pos = k
      continue
    }
    const list = LIST_MARKER_RE.exec(text.slice(k))
    if (list) {
      markers.push(list[1]!)
      pos = k + list[0]!.length
      continue
    }
    if (ATX_MARK_RE.test(text.slice(k))) {
      pos = k // 缩进后紧接 ATX 标记：缩进属于结构前缀（`   # T`）
    }
    return { prefix: text.slice(0, pos), markers, rest: text.slice(pos) }
  }
}

/**
 * 标题内容列（相对行首）= 结构前缀长度 + 前缀后紧跟的 ASCII 空白数：替换
 * 区间从内容列起（前缀字节留在原地、写回不重发，复核 ③）。`   # T` 的内容
 * 列是 3、`  - # T` 是 4、`- T` 是 2；Unicode 空白是标题内容，不计入列
 * （复核 ①）。ATX 标记前的分隔空格已含在结构前缀里（`#` 前无剩余空白）。
 */
function outlineContentColumn(lineText: string): number {
  const prefix = outlineSplitContainerPrefix(lineText).prefix
  return prefix.length + asciiIndentLen(lineText.slice(prefix.length))
}

/** 标题行的行首前缀（行首到标题内容起点的原文 = ASCII 缩进 + 容器标记链 +
 *  标记后空白）。写回不重发它——替换区间只覆盖标题内容，容器结构（`> ` /
 *  `  - ` / 缩进）按字节留在原地；Unicode 空白不属于前缀（复核 ①） */
export function outlineHeadingPrefix(doc: Text, item: { line: number }): string {
  const line = doc.line(Math.min(Math.max(1, item.line), doc.lines))
  const text = doc.sliceString(line.from, line.to)
  return text.slice(0, outlineContentColumn(text))
}

/** 标题行文本是否 ATX 形态（结构前缀之后 `#{1,6}` + 空白；非标题行不会
 *  到达——调用方传的是 OutlineItem.line 所在行，extractOutline 只产真标题。
 *  review-loops 第 2 轮：按容器标记链之后的内容判定——`> # T` / `   # T` /
 *  `- # T` 都是 ATX 标题，此前按列 0 判定会让它们落入 Setext 扫描。
 *  第 3 轮复核 ③：改为在结构前缀（含「缩进后的容器标记」）之后判定，且不
 *  做 trimStart（Unicode 空白不是 ATX 标记前置） */
function isAtxLine(lineText: string): boolean {
  return ATX_MARK_RE.test(outlineSplitContainerPrefix(lineText).rest)
}

/** 行首 ASCII 空白数（列表项内容列比较用；Unicode 空白不计） */
function asciiIndentLen(text: string): number {
  let n = 0
  while (text[n] === ' ' || text[n] === '\t') {
    n += 1
  }
  return n
}

/** 标记链全等（长度 + 逐位 token） */
function sameMarkerChain(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((marker, i) => marker === b[i])
}

/** 下划线候选行是否与标题首行同容器：标记链全等（`> T` 对 `>  ===`、`标题`
 *  对 `  ===`），或首行是列表项而候选行为其内容列上的续行——无标记且行首
 *  ASCII 空白 ≥ 首行结构前缀长度（`- T` 的内容列 2 对 `  ===`）。
 *  块引用内标题的续行必须带 `>`：`> 段落` 后的裸 `---` 是主题分隔线而非其
 *  下划线（解析器同判——该形态无 heading 节点，复核 ⑤ 事实核对）。
 *  已知限界：候选行的标记链是首行链的严格前缀的更深形态（`> - T` 的续行
 *  `>   ===`）不在此列——真条目由权威范围（headingSpan）覆盖，该限界只影响
 *  手写/陈旧条目（退化单行，不误删正文） */
function sameContainerAsHeading(first: StructuralPrefix, candidate: StructuralPrefix, candidateText: string): boolean {
  if (sameMarkerChain(first.markers, candidate.markers)) {
    return true
  }
  if (candidate.markers.length > 0 || first.markers.length === 0) {
    return false
  }
  if (first.markers[first.markers.length - 1] === '>') {
    return false
  }
  return asciiIndentLen(candidateText) >= first.prefix.length
}

/**
 * 权威标题区（outline.ts 的 headingSpan = 语法树 heading 节点范围）：
 * 越界（起点 <0 或终点 > doc.length）、倒置（from > to）、与条目行号不同源、
 * 或起点不等于标题内容列（写回会重复/丢失字节）时返回 null——调用方回退
 * 几何启发式（手写/陈旧条目）。真条目恒命中：节点范围与内容列同口径
 * （复核 ③ 的口径单一化）。
 */
function authoritativeHeadingSpan(doc: Text, item: RewritableItem): { from: number; to: number } | null {
  const span = item.headingSpan
  if (!span) {
    return null
  }
  const { from, to } = span
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > doc.length || from > to) {
    return null
  }
  const line = doc.lineAt(from)
  if (line.number !== Math.min(Math.max(1, item.line), doc.lines)) {
    return null // 条目行号与范围不同源（陈旧/异体条目）：不做几何推断
  }
  if (outlineContentColumn(doc.sliceString(line.from, line.to)) !== from - line.from) {
    return null
  }
  return { from, to }
}

/** 标题区 doc 偏移 [from, to)：优先取条目权威范围（headingSpan，语法树节点
 *  口径）；缺失或不可信时回退启发式——ATX = 单行；Setext = 内容行（可多行）
 *  + 下划线行。from 恒为标题内容起点（行首前缀之后），替换区间只覆盖标题
 *  内容本身，容器标记与缩进按字节留在原地。下划线紧随内容行（CommonMark：
 *  之间不可有空行），扫描遇空行（仅 ASCII 空白行）或容器不再相同即停止
 *  ——`> T` 之后的裸 `---` 是主题分隔线而非该标题下划线，据此不再吞并后续
 *  正文。真标题（extractOutline 只产真标题）必在停止前命中，无行数上限
 *  （review-loops A1：8 行截断使超长 Setext 的写操作落入单行回退，产生幻影
 *  标题）。行号取自条目 */
export function outlineHeadingSpan(doc: Text, item: RewritableItem): { from: number; to: number } {
  const authoritative = authoritativeHeadingSpan(doc, item)
  if (authoritative) {
    return authoritative
  }
  const startLine = Math.min(Math.max(1, item.line), doc.lines)
  const start = doc.line(startLine)
  const startText = doc.sliceString(start.from, start.to)
  const contentFrom = start.from + outlineHeadingPrefix(doc, item).length
  if (isAtxLine(startText)) {
    return { from: contentFrom, to: start.to }
  }
  const first = outlineSplitContainerPrefix(startText)
  // Setext：向下逐行找同容器的下划线行（内容行可多行；下划线行缩进 ≤3 空格
  // 属行内缩进，按结构前缀之后的余下内容判定）
  for (let n = startLine + 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    const lineText = doc.sliceString(line.from, line.to)
    if (/^[ \t]*$/.test(lineText)) {
      break // 空行 / 仅 ASCII 空白行：合法 Setext 下划线不会出现在空行之后
    }
    const candidate = outlineSplitContainerPrefix(lineText)
    if (!sameContainerAsHeading(first, candidate, lineText)) {
      break // 容器变化：本标题段已结束（后续 `---` 属分隔线/其他块）
    }
    const body = candidate.rest.replace(/^[ \t]+|[ \t]+$/g, '')
    if (/^[=]+$/.test(body) || /^-+$/.test(body)) {
      return { from: contentFrom, to: line.to }
    }
  }
  // 未找到下划线（异常输入防御）：按单行处理
  return { from: contentFrom, to: start.to }
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
    changes.push({
      offset: span.from,
      length: span.to - span.from,
      text: outlineAtxLine(level, item.text),
    })
  }
  if (changes.length === 0) {
    return null
  }
  changes.sort((a, b) => a.offset - b.offset)
  return changes
}

/** 重命名变更：整标题区（内容 + Setext 下划线行）替换为同级别 ATX 行
 *  （原文可含行内标记）。容器结构（`> `/`- `/缩进）在标题区之前，按字节
 *  原样保留。越界返回 null */
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
  return {
    offset: span.from,
    length: span.to - span.from,
    text: outlineAtxLine(item.level, newText),
  }
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
