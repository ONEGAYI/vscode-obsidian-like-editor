// 列表与引用的 Enter 前缀延续与退格清层（工单 #119）：live 正文中
// 列表/引用行的 CM6 键位扩展。
//
// 行为（形态学细节的单一事实源在 shared/listPrefix.ts）：
// - Enter：光标在结构前缀之后时，换行并延续完整结构前缀（引用前缀 +
//   缩进 + 标记；有序 +1 保宽、任务重置未勾选）；正文中间回车为分行
//   延续。空项（无正文且无子内容）再回车删除最内层结构前缀，逐层
//   退出还原普通段落；空项带子内容不接管（保守交默认，边界待实测调整）
// - Backspace：折叠光标紧邻前缀右端（正文起点）时分层剥除——嵌套项
//   先升一级（缩进对齐父项标记列，父项信息取自语法树）、顶级一次清
//   整段标记（保留引用前缀）、纯引用行逐层剥除；任务标记与列表标记
//   是一个单元。其余位置（前缀中间、选区、多光标、IME 组合中）不接管
//
// 装配顺序约定：置于 tableEditing 之后、defaultKeymap（extraExtensions）
// 之前——表格上下文优先（格内 Enter 仍为 <br> 语义），且先于通用键位
// 拦截 Enter/Backspace。变换全部单笔事务派发（一次撤销整体回退）。
import type { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import {
  blankExitCut,
  continuePrefix,
  parseLinePrefix,
  prefixLength,
  stripLayer,
  type LinePrefix,
} from '../shared/listPrefix'
import { liveDecorationsField } from './liveDecorations'
import { chainAt } from './markdownDoc'

/** 键位不接管的表格/代码上下文节点名（树判定，含独立装配无 tableEditing 的兜底） */
const NON_LIST_CONTEXT_NODES = new Set([
  'Table', 'TableHeader', 'TableRow', 'TableDelimiter', 'TableCell',
  'FencedCode', 'CodeText',
])

interface ListKeyContext {
  prefix: LinePrefix
  /** 光标处下降的节点链（根→叶）；光标不越行尾，链不进下一行节点 */
  chain: SyntaxNode[]
  /** 前缀右端（正文起点，绝对坐标） */
  prefixEnd: number
  lineFrom: number
  lineTo: number
}

/** 键位上下文：frontmatter/表格/代码上下文与无结构前缀的行返回 null */
function listKeyContext(state: EditorState, pos: number): ListKeyContext | null {
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return null
  }
  const line = state.doc.lineAt(pos)
  const fm = field.fm
  if (fm && line.from < fm.end && line.to > fm.start) {
    return null // frontmatter 按源码呈现，不参与列表语义
  }
  const chain = chainAt(field.tree, pos)
  if (chain.some((node) => NON_LIST_CONTEXT_NODES.has(node.name))) {
    return null
  }
  const prefix = parseLinePrefix(line.text)
  if (!prefix) {
    return null
  }
  return { prefix, chain, prefixEnd: line.from + prefixLength(prefix), lineFrom: line.from, lineTo: line.to }
}

/** 链上最深的结构节点（ListItem 优先于 Blockquote）——空项子内容的载体 */
function deepestStructNode(chain: SyntaxNode[]): SyntaxNode | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const name = chain[i]!.name
    if (name === 'ListItem' || name === 'Blockquote') {
      return chain[i]!
    }
  }
  return null
}

/** 空项是否带真子内容：结构节点越过行尾且首个非空后续行的前缀列达内容列 */
function blankItemHasChild(state: EditorState, ctx: ListKeyContext): boolean {
  const owner = deepestStructNode(ctx.chain)
  if (!owner || owner.to <= ctx.lineTo) {
    return false
  }
  const contentCol = ctx.prefixEnd - ctx.lineFrom
  let pos = ctx.lineTo + 1
  while (pos < state.doc.length) {
    const line = state.doc.lineAt(pos)
    if (line.text.trim() === '') {
      pos = line.to + 1
      continue
    }
    const prefix = parseLinePrefix(line.text)
    return (prefix ? prefixLength(prefix) : /^\s*/u.exec(line.text)![0].length) >= contentCol
  }
  return false
}

/** 父项标记列（相对引用前缀之后的缩进宽度）；顶级或跨结构返回 null */
function parentIndentWidth(state: EditorState, chain: SyntaxNode[], prefix: LinePrefix): number | null {
  const lists = chain.filter((node) => node.name === 'BulletList' || node.name === 'OrderedList')
  if (!lists.length) {
    return null
  }
  const parentItem = lists[lists.length - 1]!.parent
  if (!parentItem || parentItem.name !== 'ListItem') {
    return null // 父级是 Blockquote/Document：当前项即（引用内的）顶级
  }
  const parentMark = parentItem.getChild('ListMark')
  if (!parentMark) {
    return null
  }
  const parentLineFrom = state.doc.lineAt(parentItem.from).from
  const width = parentMark.from - parentLineFrom - prefix.quote.length
  return width >= 0 ? width : null
}

/** Enter：列表/引用前缀延续与空项退出 */
export const continueListMarkup: Command = (view) => {
  if (view.compositionStarted || view.state.selection.ranges.length !== 1) return false
  const range = view.state.selection.main
  if (!range.empty) return false
  const ctx = listKeyContext(view.state, range.head)
  if (!ctx || range.head < ctx.prefixEnd) return false
  // 结构合法性：行须确实在列表项/引用内（`- - -` 这类伪前缀由树排除）
  const hasStruct = ctx.chain.some((node) => node.name === 'ListItem' || node.name === 'Blockquote')
  if (!hasStruct) return false
  // 空项：无正文时看子内容。Lezer 的项/引用节点越过行尾只是 lazy
  // continuation 的宽容（如 `- [ ] \nnext` 的 next 缩进 0 达不到内容列），
  // 再按首个非空后续行的前缀列复核——达内容列才算真子内容
  if (view.state.doc.sliceString(ctx.prefixEnd, ctx.lineTo).trim() === '') {
    if (blankItemHasChild(view.state, ctx)) return false
    const cut = blankExitCut(ctx.prefix)
    const cursor = ctx.lineFrom + cut.cursor
    view.dispatch({
      changes: { from: ctx.lineFrom + cut.from, to: ctx.lineFrom + cut.to },
      selection: { anchor: cursor },
      userEvent: 'input.type', scrollIntoView: true,
    })
    return true
  }
  const insert = continuePrefix(ctx.prefix)
  view.dispatch({
    changes: { from: range.head, insert: '\n' + insert },
    selection: { anchor: range.head + 1 + insert.length },
    userEvent: 'input.type', scrollIntoView: true,
  })
  return true
}

/** Backspace：折叠光标紧邻前缀右端时分层剥除结构 */
export const stripListLayer: Command = (view) => {
  if (view.compositionStarted || view.state.selection.ranges.length !== 1) return false
  const range = view.state.selection.main
  if (!range.empty) return false
  const ctx = listKeyContext(view.state, range.head)
  if (!ctx || range.head !== ctx.prefixEnd) return false
  // 结构合法性：列表项行须在 ListItem 内，纯引用行须在 Blockquote 内
  const hasStruct = ctx.prefix.mark
    ? ctx.chain.some((node) => node.name === 'ListItem')
    : ctx.chain.some((node) => node.name === 'Blockquote')
  if (!hasStruct) return false
  const plan = stripLayer(ctx.prefix, parentIndentWidth(view.state, ctx.chain, ctx.prefix))
  if (plan.kind === 'clear') {
    const from = ctx.lineFrom + ctx.prefix.quote.length
    view.dispatch({
      changes: { from, to: ctx.prefixEnd },
      selection: { anchor: from },
      userEvent: 'delete.backward', scrollIntoView: true,
    })
    return true
  }
  if (plan.kind === 'dedent') {
    view.dispatch({
      changes: { from: ctx.lineFrom, to: ctx.prefixEnd, insert: plan.insert },
      selection: { anchor: ctx.lineFrom + plan.insert.length },
      userEvent: 'delete.backward', scrollIntoView: true,
    })
    return true
  }
  view.dispatch({
    changes: { from: ctx.lineFrom, to: ctx.lineFrom + plan.width },
    selection: { anchor: range.head - plan.width },
    userEvent: 'delete.backward', scrollIntoView: true,
  })
  return true
}

/** 装配入口：置于 tableEditing 之后、defaultKeymap 之前（顺序约束见头注释） */
export const listEditing = [
  keymap.of([
    { key: 'Enter', run: continueListMarkup, shift: continueListMarkup },
    { key: 'Backspace', run: stripListLayer },
  ]),
]
