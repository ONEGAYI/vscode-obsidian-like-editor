import { RangeSet, type EditorState, type Text } from '@codemirror/state'
import { lineNumbers, gutterLineClass, GutterMarker, type EditorView } from '@codemirror/view'
import { liveDecorationsField, LIVE_CLASS_NAMES, type GridTableSegment } from './liveDecorations'

/** 表格行行首装饰分类（#116 收敛）：'delimiter'（分隔行）/ 'header'（表头
 *  行）/ 'data'（数据行）/ null（非表格行装饰）。deco.spec.class 字符串解析
 *  与类组合解释的单一事实源——行号显隐（分隔行与数据行隐藏）和 gutter
 *  行格分类（delimiter/header 挂补偿类）两处消费同一判定，永不脱钩。
 *  delimiter 判定优先：装饰同时命中多组类时按分隔行解释（与原两处独立
 *  实现的判定顺序一致）。 */
type TableLineNumberKind = 'delimiter' | 'header' | 'data'

function tableLineNumberKind(specClass: string | undefined): TableLineNumberKind | null {
  const classes: string[] = specClass?.split(' ') ?? []
  if (classes.includes(LIVE_CLASS_NAMES.tableGridDelimiter)) return 'delimiter'
  if (!classes.includes(LIVE_CLASS_NAMES.tableGridRow)) return null
  return classes.includes(LIVE_CLASS_NAMES.tableHeaderLine) ? 'header' : 'data'
}

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
    const kind = tableLineNumberKind(deco.spec.class)
    if (kind === 'delimiter' || kind === 'data') hidden = true
  })
  return hidden ? '' : String(lineNumber)
}

/** 表格行号格稳定类（#116）：行号格的内联记账高度/位置由 CM6 heightmap
 * 驱动，通用 padding-top 半差补偿在 border-box 下有两个表格特例——
 * 分隔行格记账高 0，padding 会把 0 高盒撑开（表后行号逐表下移）；表头行
 * 文字因单元格 padding+border 下移，行号需补同量。两条特化补偿规则在
 * main.css 按这些类命中（契约：lineNumberCssContract）。刻意不导出：
 * lineNumbers.test.ts（DOM 侧）与 lineNumberCssContract.test.ts（CSS 侧）
 * 各自以字面量钉住类名，两侧独立互证——改此常量必红其中一侧，把测试
 * 改为消费常量会让改名静默通过、CSS 规则脱钩无人报警。 */
const LINE_NUMBER_GUTTER_CLASS_NAMES = {
  tableDelimiter: 'vsidian-ln-table-delimiter',
  tableHeader: 'vsidian-ln-table-header',
} as const

const delimiterGutterMarker = new class extends GutterMarker {
  elementClass = LINE_NUMBER_GUTTER_CLASS_NAMES.tableDelimiter
}()
const headerGutterMarker = new class extends GutterMarker {
  elementClass = LINE_NUMBER_GUTTER_CLASS_NAMES.tableHeader
}()

/** 行格分类扫描观测（#116 性能）：computes = 实际执行扫描的计算次数，
 *  memoHits = memo 命中直接复用结果的次数，scannedChars = between 扫描
 *  的累计字符跨度（收窄前每次计算都全文 doc.length，收窄后为 0 或表段
 *  跨度）。测试据此断言「无表格文档零遍历」「表外事务不重扫」。 */
const gutterClassStats = {
  computes: 0,
  memoHits: 0,
  scannedChars: 0,
}

export function getLineNumberGutterStats(): Readonly<typeof gutterClassStats> {
  return { ...gutterClassStats }
}

/** 行格分类结果 memo（#116 性能双保险）：键为 (doc 引用, 段数组引用)。
 *  正确性依赖 liveDecorations 的不变量——任何可能改动段内装饰的更新
 *  路径都会产生新的段数组引用（见 updateGridSegments 注释），键不变即
 *  结果必然未变；doc 变更则文档引用同步变化。不以 memo 替代收窄：
 *  memo 未命中时扫描仍只落在表段内。 */
let gutterResultMemo: {
  doc: Text
  segments: readonly GridTableSegment[]
  result: RangeSet<GutterMarker>
} | null = null

/** 表格行号格分类与行号显隐同源（liveDecorationsField 行首装饰，判定式
 *  收敛在 tableLineNumberKind）：光标进入分隔行时装饰撤下，
 *  分类与行号显隐同步变化。扫描按 liveDecorationsField 维护的网格表段
 *  收窄（#116 性能）：无表格零遍历返回共享空集（RangeSet.empty 单例，
 *  引用稳定）；有表格只扫表段；段内装饰未变的后续事务（如表外纯选区
 *  移动）由 memo 直接复用结果。分类事实源仍是行装饰，段只是索引。 */
const tableLineNumberGutterClasses = gutterLineClass.compute([liveDecorationsField], (state) => {
  const live = state.field(liveDecorationsField, false)
  if (!live) return RangeSet.empty as RangeSet<GutterMarker>
  if (live.gridSegments.length === 0) {
    return RangeSet.empty as RangeSet<GutterMarker>
  }
  const memo = gutterResultMemo
  if (memo && memo.doc === state.doc && memo.segments === live.gridSegments) {
    gutterClassStats.memoHits += 1
    return memo.result
  }
  gutterClassStats.computes += 1
  let scannedChars = 0
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
  for (const segment of live.gridSegments) {
    scannedChars += segment.to - segment.from
    live.decos.between(segment.from, segment.to, (from, to, deco) => {
      if (to !== from) return // 行装饰为行首点区间，与行号显隐判定同口径
      if (from !== pendingFrom) {
        flush()
        pendingFrom = from
      }
      const kind = tableLineNumberKind(deco.spec.class)
      if (kind === 'delimiter') pendingDelimiter = true
      else if (kind === 'header') pendingHeader = true
    })
  }
  flush()
  gutterClassStats.scannedChars += scannedChars
  const result = ranges.length ? RangeSet.of(ranges) : (RangeSet.empty as RangeSet<GutterMarker>)
  gutterResultMemo = { doc: state.doc, segments: live.gridSegments, result }
  return result
})

/** 行号格选择器：绘制探针（paintedLineNumbers）与 syncController 的
 *  行号观测/几何采样（collectLineGutter / collectGutterAlignment）共用，
 *  选择器字符串单一事实源。 */
export const LINE_NUMBER_GUTTER_SELECTOR = '.cm-lineNumbers .cm-gutterElement'

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
    for (const element of view.dom.querySelectorAll<HTMLElement>(LINE_NUMBER_GUTTER_SELECTOR)) {
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
