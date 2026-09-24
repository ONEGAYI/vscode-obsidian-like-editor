// 表格单元格输入钩子（工单 #12）：live 视图中表格编辑面的 CM6 扩展。
//
// 形态（架构约定：单元格编辑完全跑在既有出站同步链路上）：
// - 表格编辑面即 CM6 源文本行：表格装饰（liveDecorations）只做样式标记
//   （管道符/单元格/对齐稳定类），不隐藏源文、不建覆盖层——点击列区域
//   即光标落位，IME 组合、出站暂缓、冲突暂停全部复用既有链路
//   （syncController），无旁路直改文档
// - 本模块只补一条输入语义：在表格行内（非行内代码、非已转义后）键入 |
//   时自动写为 \|——保证「单元格输入含管道符 → 保存回读 → 再渲染」
//   仍是单格语义（验收标准）；其余位置返回 false 走默认插入
// - 转义以普通 CM6 事务 dispatch：单次按键 = 单次单元格文本变更 =
//   单笔 edit.request，宿主撤销一次即撤销一次转义插入
import { EditorView, keymap } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import { liveDecorationsField } from './liveDecorations'
import { needsPipeEscapeAt } from './tableCells'

/** 表格行身份的解析树节点名（分隔行整体是一个 TableDelimiter 节点） */
const TABLE_LINE_NODE_NAMES = new Set(['TableHeader', 'TableRow', 'TableDelimiter'])

/** 判定 pos 所在行是否为表格行（表头/数据/分隔行；依据解析树，前序下降） */
function isTableRowLine(state: EditorState, pos: number, tree: Tree): boolean {
  const line = state.doc.lineAt(pos)
  const walk = (node: SyntaxNode): boolean => {
    if (node.from > line.to || node.to < line.from) {
      return false
    }
    if (TABLE_LINE_NODE_NAMES.has(node.name)) {
      // Lezer 块节点区间含尾换行：按去掉尾换行后的行界判定相交
      let end = node.to
      if (end > node.from && state.doc.sliceString(end - 1, end) === '\n') {
        end -= 1
      }
      if (node.from <= line.to && end >= line.from) {
        return true
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (walk(c)) {
        return true
      }
    }
    return false
  }
  return walk(tree.topNode)
}

/**
 * | 键处理：光标各 range 所在位置若需转义，则以一个事务插入 \|；
 * 任一 range 无需转义即整体返回 false（交默认行为，避免多光标语义分裂）。
 */
export const tablePipeKeyHandler: Command = (view: EditorView): boolean => {
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return false
  }
  const changes: Array<{ from: number; to?: number; insert: string }> = []
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.from)
    if (!isTableRowLine(state, range.from, field.tree)) {
      return false
    }
    if (needsPipeEscapeAt(line.text, range.from - line.from)) {
      changes.push(
        range.empty
          ? { from: range.from, insert: '\\|' }
          : { from: range.from, to: range.to, insert: '\\|' },
      )
    } else {
      return false
    }
  }
  if (changes.length === 0) {
    return false
  }
  view.dispatch({ changes })
  return true
}

/** 装配扩展：绑定 | 键（优先于默认字符插入） */
export const tableEditing = [keymap.of([{ key: '|', run: tablePipeKeyHandler }])]
