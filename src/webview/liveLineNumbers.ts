import type { EditorState } from '@codemirror/state'
import { lineNumbers, type EditorView } from '@codemirror/view'
import { liveDecorationsField, LIVE_CLASS_NAMES } from './liveDecorations'

/** 安全网格表格只标段首源行号；源码回退表格仍逐行编号。 */
function formatLiveLineNumber(lineNumber: number, state: EditorState): string {
  // CM6 用超出文档的 9/99/... 测量列宽，测量值不能走 doc.line。
  if (lineNumber > state.doc.lines) return String(lineNumber)
  const live = state.field(liveDecorationsField, false)
  if (!live) return String(lineNumber)
  const line = state.doc.line(lineNumber)
  // 以实际网格行装饰为准。gridPlans 只是本次局部重建的缓存，不能代表
  // 未受编辑影响、仍由映射后的装饰正常显示的其他表格。
  let hidden = false
  live.decos.between(line.from, line.from + 1, (from, to, deco) => {
    if (from !== line.from || to !== from) return
    const classes: string[] = deco.spec.class?.split(' ') ?? []
    if (classes.includes(LIVE_CLASS_NAMES.tableGridDelimiter) ||
        (classes.includes(LIVE_CLASS_NAMES.tableGridRow) &&
         !classes.includes(LIVE_CLASS_NAMES.tableHeaderLine))) hidden = true
  })
  return hidden ? '' : String(lineNumber)
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
