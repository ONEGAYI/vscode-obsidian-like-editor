import type { EditorState } from '@codemirror/state'
import { lineNumbers, type EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { liveDecorationsField } from './liveDecorations'

/** 安全网格表格只标段首源行号；源码回退表格仍逐行编号。 */
function formatLiveLineNumber(lineNumber: number, state: EditorState): string {
  // CM6 用超出文档的 9/99/... 测量列宽，测量值不能走 doc.line。
  if (lineNumber > state.doc.lines) return String(lineNumber)
  const live = state.field(liveDecorationsField, false)
  if (!live) return String(lineNumber)
  const line = state.doc.line(lineNumber)
  for (let node: SyntaxNode | null = live.tree.resolveInner(line.from, 1); node; node = node.parent) {
    if (node.name !== 'Table') continue
    const plan = live.gridPlans.get(node.from)
    if (plan && (plan.delimiterLine === lineNumber || plan.rows.get(lineNumber) === 'row')) return ''
    break
  }
  return String(lineNumber)
}

export function liveLineNumbers() {
  return lineNumbers({ formatNumber: formatLiveLineNumber })
}

/** 真宿主绘制探针：只记录文字有面积、可见且命中本元素的行号。 */
export function paintedLineNumbers(view: EditorView): string[] {
  const numbers: string[] = []
  try {
    for (const element of view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')) {
      if (!element.textContent?.trim()) continue
      const style = getComputedStyle(element)
      if (style.visibility !== 'visible' || style.display === 'none' || style.opacity === '0' ||
          style.color === 'transparent' || style.color === 'rgba(0, 0, 0, 0)') continue
      const range = document.createRange()
      range.selectNodeContents(element)
      const rect = range.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      if (hit && element.contains(hit)) numbers.push(element.textContent)
    }
  } catch {
    // jsdom 不提供布局，不能据此声称行号可见。
  }
  return numbers
}
