// 列表/引用行前缀形态学单一事实源（工单 #119/#120）：live 正文行「结构
// 前缀」的解析与重建。前缀 = 容器前缀（引用层）+ 列表缩进 + 列表标记
// （含任务标记）；Enter 前缀延续、退格清层与 Tab/Shift+Tab 行缩进三族
// 键位变换共用本模块——三处对「什么算前缀、延续成什么、剥哪一层、
// 缩进单位多宽」的判定必须逐字节一致，否则延续与清层会互相打架。
//
// 形态学规则（与 Lezer GFM 解析对齐，但不依赖树——结构合法性由调用方
// 用语法树验证，本模块只管文本形态）：
// - 引用层：一个或多个 `>`，每层吞并其前导空白与至多一个后随空格
//   （`>`、`> `、`>>`、`> > ` 均合法）
// - 缩进：引用层之后、列表标记之前的空白
// - 列表标记：`-`/`*`/`+` 或 `数字 + .`/`)`，后随空白；裸标记（`-`、
//   `1.`）仅在行尾成立（空项形态）
// - 任务标记：列表标记空白后的 `[ ]`/`[x]`/`[X]`，同样需后随空白或行尾
//   才算标记的一部分（`- [x]a` 中 `[x]a` 是正文）
//
// 本模块不依赖 vscode/DOM/CM6（node 单测直驱；宿主与 webview 双产物共用）。

/** 列表标记形态（ListPrefix.mark 的细分；mark 为空时为 null） */
export interface ListMarkShape {
  /** 无序标记字符；有序时空串 */
  bullet: '' | '-' | '*' | '+'
  /** 有序编号原文（保留前导零）；无序时空串 */
  digits: string
  /** 有序分隔符；无序时空串 */
  delim: '' | '.' | ')'
  /** 标记（或任务标记）之后的空白原文 */
  gap1: string
  /** 任务标记；无任务 null。gap2 为任务标记后空白 */
  task: { checked: boolean; gap2: string } | null
}

/** 行的结构前缀（解析形态；length = quote+indent+mark 宽） */
export interface LinePrefix {
  /** 引用前缀原文（每层含前导空白与 `>` 及至多一个空格） */
  quote: string
  /** 引用层之后的列表缩进（空白原文） */
  indent: string
  /** 列表标记原文（含标记后空白与任务标记）；无列表时空串 */
  mark: string
  /** 列表标记形态；mark 为空时 null */
  list: ListMarkShape | null
}

/** 前缀总宽（相对行首的正文起点） */
export function prefixLength(prefix: LinePrefix): number {
  return prefix.quote.length + prefix.indent.length + prefix.mark.length
}

/**
 * 解析行文本的结构前缀。无引用层且无列表标记（普通行、`-item` 这类
 * 无空格伪标记）返回 null——调用方按无结构处理（键位不接管）。
 */
export function parseLinePrefix(line: string): LinePrefix | null {
  let i = 0
  // 引用层循环：每层 = 前导空白 + `>` + 至多一个后随空格
  for (;;) {
    let j = i
    while (j < line.length && /\s/u.test(line[j]!)) j++
    if (j < line.length && line[j] === '>') {
      i = j + 1
      if (line[i] === ' ') i++
      continue
    }
    break
  }
  const quote = line.slice(0, i)
  // 列表缩进
  let k = i
  while (k < line.length && /\s/u.test(line[k]!)) k++
  const indent = line.slice(i, k)
  const rest = line.slice(k)
  const list = rest ? parseListMark(rest) : null
  if (!list) {
    return quote ? { quote, indent, mark: '', list: null } : null
  }
  return { quote, indent, mark: rest.slice(0, list.length), list }
}

/** 标记形态与总宽（输入为去掉 quote/indent 后的剩余文本） */
function parseListMark(rest: string): (ListMarkShape & { length: number }) | null {
  const bullet = /^([-+*])(\s*)/u.exec(rest)
  const ordered = /^(\d+)([.)])(\s*)/u.exec(rest)
  let head = 0
  let shape: ListMarkShape
  if (bullet) {
    // 无空格裸标记仅在行尾成立（`-` 是空项，`-item` 是普通文本）
    if (!bullet[2] && rest.length > bullet[0].length) return null
    head = bullet[0].length
    shape = { bullet: bullet[1] as '-' | '*' | '+', digits: '', delim: '', gap1: bullet[2]!, task: null }
  } else if (ordered) {
    if (!ordered[3] && rest.length > ordered[0].length) return null
    head = ordered[0].length
    shape = { bullet: '', digits: ordered[1]!, delim: ordered[2] as '.' | ')', gap1: ordered[3]!, task: null }
  } else {
    return null
  }
  // 任务标记：需后随空白或行尾，否则归正文
  const task = /^\[([ xX])\](\s*)/u.exec(rest.slice(head))
  if (task && (task[2] || head + task[0].length === rest.length)) {
    shape.task = { checked: task[1] !== ' ', gap2: task[2]! }
    head += task[0].length
  }
  return { ...shape, length: head }
}

/**
 * Enter 延续前缀：完整重建结构前缀——引用与缩进原样、有序编号 +1 保留
 * 宽度（超宽自然增长）、任务重置为未勾选。
 */
export function continuePrefix(prefix: LinePrefix): string {
  const list = prefix.list
  if (!list) {
    return prefix.quote + prefix.indent
  }
  const head = list.bullet
    ? list.bullet + list.gap1
    : bumpNumber(list.digits) + list.delim + list.gap1
  const task = list.task ? `[ ]${list.task.gap2}` : ''
  return prefix.quote + prefix.indent + head + task
}

/** 有序编号 +1，保留原宽度（`9`→`10`、`01`→`02`、`099`→`100`） */
function bumpNumber(digits: string): string {
  return String(Number(digits) + 1).padStart(digits.length, '0')
}

/** 退格清层计划（变换语义见 stripLayer） */
export type LayerStrip =
  /** 列表项升一级：整段前缀替换为 insert（quote + 父项标记列缩进 + mark） */
  | { kind: 'dedent'; insert: string }
  /** 顶级项：清除缩进与列表标记（含任务标记），保留引用前缀 */
  | { kind: 'clear' }
  /** 纯引用行：删除行首一层引用（宽度 width 字符） */
  | { kind: 'unquote'; width: number }

/**
 * 退格清层计划。parentIndentWidth 为父项标记列（相对引用前缀之后的
 * 缩进宽度；调用方从语法树取），顶级项传 null。
 * - 有列表标记：父项标记列更浅则升一级（dedent），否则一次清整段（clear）
 * - 无列表标记（纯引用行）：剥一层引用（unquote）
 */
export function stripLayer(prefix: LinePrefix, parentIndentWidth: number | null): LayerStrip {
  if (prefix.mark) {
    if (parentIndentWidth !== null && parentIndentWidth < prefix.indent.length) {
      return { kind: 'dedent', insert: prefix.quote + ' '.repeat(parentIndentWidth) + prefix.mark }
    }
    return { kind: 'clear' }
  }
  return { kind: 'unquote', width: firstQuoteLayerLength(prefix.quote) }
}

/** 引用前缀第一层的宽度（`> > ` → 2；`>>` → 1） */
function firstQuoteLayerLength(quote: string): number {
  const at = quote.indexOf('>')
  const head = at < 0 ? 0 : at
  let width = head + 1
  if (quote[head + 1] === ' ') width++
  return width
}

/**
 * 空项退出的删除区间与光标（均相对行首）：列表项删缩进+标记（保留引用
 * 前缀，引用内空列表项退化为空引用行——逐层退出）；纯引用行删一层引用
 * 连同其后的缩进（`> > ` → `> `，`>   ` → 空行）。cursor 为删除后的
 * 正文起点（剩余前缀右端）。
 */
export function blankExitCut(prefix: LinePrefix): { from: number; to: number; cursor: number } {
  if (prefix.mark) {
    return { from: prefix.quote.length, to: prefixLength(prefix), cursor: prefix.quote.length }
  }
  const layer = firstQuoteLayerLength(prefix.quote)
  return { from: 0, to: layer + prefix.indent.length, cursor: prefix.quote.length - layer }
}

/** 行缩进单位（工单 #120）：Tab 一级缩进的落点与宽度 */
export interface LineIndentUnit {
  /** 相对行首的插入/删除起点：列表行为引用前缀右端，普通行为行首 */
  offset: number
  /** 一级缩进宽度（空格数） */
  width: number
}

/** 普通行与纯引用行的固定缩进宽度（对齐 CM6 indentUnit 默认） */
const PLAIN_INDENT_WIDTH = 2

/**
 * 行的缩进单位（#120）。列表行（含引用内列表）一级缩进智能对齐父项
 * 内容起点——宽度取自身标记总宽（同级标记同宽即父项标记列的右移量；
 * 有序编号跨宽度段如 `9.`→`10.` 以行自身为准，不做跨行补齐）；普通
 * 行与纯引用行固定 2 空格。prefix 传 null 表示不按前缀解析（普通行或
 * 代码块内）。
 */
export function indentUnitOf(prefix: LinePrefix | null): LineIndentUnit {
  if (prefix && prefix.mark) {
    return { offset: prefix.quote.length, width: prefix.mark.length }
  }
  return { offset: 0, width: PLAIN_INDENT_WIDTH }
}

/**
 * Shift+Tab 的删除区间（相对行首）：从缩进单位起点删除至多一级宽度的
 * 连续空白（不足全删，对齐 CM6 indentLess 的「至多删单位」口径）。
 * 无可删空白返回 null（该行不变）。
 */
export function dedentCutOf(line: string, unit: LineIndentUnit): { from: number; to: number } | null {
  let i = unit.offset
  const end = Math.min(line.length, unit.offset + unit.width)
  while (i < end && /\s/u.test(line[i]!)) i++
  return i > unit.offset ? { from: unit.offset, to: i } : null
}
