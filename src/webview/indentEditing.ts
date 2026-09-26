// Tab/Shift+Tab 实时预览正文通用行缩进（工单 #120）：live 正文中
// 光标行（无选区）或选区覆盖各行的整行缩进。
//
// 行为（缩进单位的单一事实源在 shared/listPrefix.ts）：
// - Tab：每受影响行在缩进落点插入一级宽度；Shift+Tab 从落点删除至多
//   一级宽度的连续空白（不足全删）。列表行一级宽度取标记总宽（对齐
//   父项内容起点），普通行（含纯引用行、代码块围栏内）固定 2 空格
// - 光标/选区随缩进平移（锚点与头均向右关联映射，对齐 CM6 命令）
// - 不自动携带子孙项；整体移动由用户用选区覆盖表达
// - 不接管（return false 交默认）：表格行——Tab/Shift+Tab 归
//   tableEditing 的单元格导航，边界放行也不缩进表格行（不破坏表格
//   结构与「表格内导航语义优先」）；frontmatter（按源码呈现）；
//   IME 组合进行中
// - Shift+Tab 无可删空白时仍吞键（return true）：Tab 族按键一旦在
//   Live 正文消费域内放行到 keydown 默认路径，会被宿主 webview 预加
//   载脚本转发为工作台焦点导航（焦点逃逸），故无变化也不放行
//
// 装配顺序约定：置于 tableEditing 之后、defaultKeymap（extraExtensions）
// 之前——表格上下文优先。变换单笔事务派发（一次撤销整体回退）。
import { EditorSelection } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { Command, EditorView } from '@codemirror/view'
import { dedentCutOf, indentUnitOf, parseLinePrefix } from '../shared/listPrefix'
import { liveDecorationsField } from './liveDecorations'
import { chainAt } from './markdownDoc'

/** 表格节点：行落在其中即不接管（单元格导航优先；边界放行不缩进表格行） */
const TABLE_NODES = new Set([
  'Table', 'TableHeader', 'TableRow', 'TableDelimiter', 'TableCell',
])
/** 代码块节点：围栏/缩进代码块内同普通行语义（不做列表智能对齐） */
const CODE_NODES = new Set(['FencedCode', 'CodeText', 'CodeBlock'])

/** Tab/Shift+Tab 共用主体。dir 为 +1 缩进 / -1 反缩进 */
function indentByDirection(view: EditorView, dir: 1 | -1): boolean {
  if (view.compositionStarted) return false
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) return false
  // 受影响行：各 range 覆盖行取并集；选区末端恰在行首不含该行
  // （对齐 CM6 changeBySelectedLine 的选区行口径）
  const lineNumbers = new Set<number>()
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos)
      if (range.empty || range.to > line.from) lineNumbers.add(line.number)
      pos = line.to + 1
    }
  }
  const changes: { from: number; to?: number; insert?: string }[] = []
  for (const num of [...lineNumbers].sort((a, b) => a - b)) {
    const line = state.doc.line(num)
    const fm = field.fm
    if (fm && line.from < fm.end && line.to > fm.start) return false
    // 行内探测点（行首后一字符，空行取行首）的容器链判定上下文
    const chain = chainAt(field.tree, Math.min(line.to, line.from + 1))
    if (chain.some((node) => TABLE_NODES.has(node.name))) return false
    const plain = chain.some((node) => CODE_NODES.has(node.name))
    const unit = indentUnitOf(plain ? null : parseLinePrefix(line.text))
    if (dir > 0) {
      changes.push({ from: line.from + unit.offset, insert: ' '.repeat(unit.width) })
    } else {
      const cut = dedentCutOf(line.text, unit)
      if (cut) changes.push({ from: line.from + cut.from, to: line.from + cut.to })
    }
  }
  if (changes.length > 0) {
    const changeSet = state.changes(changes)
    view.dispatch({
      changes: changeSet,
      selection: EditorSelection.create(
        state.selection.ranges.map((range) =>
          EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1))),
        state.selection.mainIndex,
      ),
      userEvent: dir > 0 ? 'input.indent' : 'delete.dedent',
      scrollIntoView: true,
    })
  }
  return true
}

/** Tab：整行缩进一级（列表行对齐父项内容起点） */
export const indentLine: Command = (view) => indentByDirection(view, 1)

/** Shift+Tab：整行反向缩进一级（至多删一级，不足全删） */
export const dedentLine: Command = (view) => indentByDirection(view, -1)

/** 装配入口：置于 tableEditing 之后、defaultKeymap 之前（顺序约束见头注释） */
export const indentEditing = [
  keymap.of([{ key: 'Tab', run: indentLine, shift: dedentLine }]),
]
