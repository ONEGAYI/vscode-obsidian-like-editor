import { RangeSet, type EditorState } from '@codemirror/state'
import { lineNumbers, gutterLineClass, GutterMarker, type EditorView } from '@codemirror/view'
import { liveDecorationsField, LIVE_CLASS_NAMES } from './liveDecorations'

/** 安全网格表格只标段首源行号；源码回退表格仍逐行编号。
 * 分隔行虽然在文档里占一行，CSS 将它隐藏后 gutter 仍会占位、与网格行重叠；
 * 在网格表格内只返回表头行数字，保留源行号含义又避免视觉叠字。 */
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

/** 表格行号格稳定类（#116）：行号格的内联记账高度/位置由 CM6 heightmap
 * 驱动，通用 padding-top 半差补偿在 border-box 下有两个表格特例——
 * 分隔行格记账高 0，padding 会把 0 高盒撑开（表后行号逐表下移）；表头行
 * 文字因单元格 padding+border 下移，行号需补同量。两条特化补偿规则在
 * main.css 按这些类命中（契约：lineNumberCssContract）。 */
export const LINE_NUMBER_GUTTER_CLASS_NAMES = {
  tableDelimiter: 'vsidian-ln-table-delimiter',
  tableHeader: 'vsidian-ln-table-header',
} as const

const delimiterGutterMarker = new class extends GutterMarker {
  elementClass = LINE_NUMBER_GUTTER_CLASS_NAMES.tableDelimiter
}()
const headerGutterMarker = new class extends GutterMarker {
  elementClass = LINE_NUMBER_GUTTER_CLASS_NAMES.tableHeader
}()

/** 表格行号格分类与行号显隐同源（liveDecorationsField 行首装饰，判定式
 *  与 formatLiveLineNumber 的隐藏判定一致）：光标进入分隔行时装饰撤下，
 *  分类与行号显隐同步变化。 */
const tableLineNumberGutterClasses = gutterLineClass.compute([liveDecorationsField], (state) => {
  const live = state.field(liveDecorationsField, false)
  if (!live) return RangeSet.empty as RangeSet<GutterMarker>
  const ranges: ReturnType<GutterMarker['range']>[] = []
  let pendingFrom = -1
  let pendingDelimiter = false
  let pendingHeader = false
  const flush = (): void => {
    if (pendingFrom < 0) return
    const marker = pendingDelimiter
      ? delimiterGutterMarker
      : pendingHeader ? headerGutterMarker : null
    if (marker) ranges.push(marker.range(pendingFrom))
    pendingFrom = -1
    pendingDelimiter = false
    pendingHeader = false
  }
  live.decos.between(0, state.doc.length, (from, to, deco) => {
    if (to !== from) return // 行装饰为行首点区间，与行号显隐判定同口径
    if (from !== pendingFrom) {
      flush()
      pendingFrom = from
    }
    const classes: string[] = deco.spec.class?.split(' ') ?? []
    if (classes.includes(LIVE_CLASS_NAMES.tableGridDelimiter)) pendingDelimiter = true
    if (classes.includes(LIVE_CLASS_NAMES.tableGridRow) &&
        classes.includes(LIVE_CLASS_NAMES.tableHeaderLine)) pendingHeader = true
  })
  flush()
  return ranges.length ? RangeSet.of(ranges) : (RangeSet.empty as RangeSet<GutterMarker>)
})

export function liveLineNumbers() {
  return [
    lineNumbers({ formatNumber: formatLiveLineNumber }),
    tableLineNumberGutterClasses,
  ]
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
