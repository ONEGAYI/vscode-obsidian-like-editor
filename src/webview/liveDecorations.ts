// 语法树驱动的 Live Preview 装饰（工单 #8，取代 #5 的行级正则判定）。
//
// 架构（依据 ADR-0005、mvp.md「MVP 性能契约」，#5 的直接/间接分类沿用）：
// - 语义来源：@codemirror/lang-markdown 的 markdownLanguage 解析器（GFM）。
//   解析树在 StateField 内自持，经 @lezer TreeFragment 做增量解析——
//   正常键入只重解析变更附近（实测 10 万行文档中部键入 ≈1ms），整篇
//   解析仅发生在 create 与全文替换（必要初始化/重同步）
// - 直接装饰（影响块高度）→ StateField 常驻 RangeSet 整篇维护：
//   · 行级类：标题（#5 类名不变）、围栏/缩进代码、引用、列表（含嵌套
//     深度与有序/子弹区分）、水平线、frontmatter
//   · 标记隐藏（replace）：标题标记在标题范围内显形；列表与引用前缀仅在
//     标记及相邻空格附近显形；任务 [x] 在标记范围外显示 checkbox widget
//   · 内容 span：vsidian-header-{n} / vsidian-strong / vsidian-emphasis / vsidian-inline-code
// - 间接装饰（纯视口内）→ ViewPlugin 按直接装饰集合与 visibleRanges 计算
//   标题行强调与活动提示（不触碰 view/DOM 测量，防布局循环）
// - 增量策略：键入路径的重建区间 = 变更行 ∪ 旧树相交装饰节点（映射后）
//   ∪ 选区旧行/新行；结构编辑（围栏开闭、列表吸收等）经「容器分类差异
//   探测」扩展重建范围至受影响容器边界——正确性优先，触发频率低
// - frontmatter：与阅读视图共用 markdownDoc.frontmatterRange（有界扫描），
//   头块内不产生 Markdown 装饰（伪标题/伪列表按源码呈现）
// - 未支持语法（脚注、定义列表等）：无装饰即局部源码降级，不整篇改写
// - #42 表格：安全表格始终以原文区间 mark + CSS grid 呈现，活动单元格
//   继续在 CM6 源区间输入。没有独立单元格输入模型，DOM 由视口回收
import {
  Annotation,
  EditorSelection,
  RangeSet,
  StateField,
  Text,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { TreeFragment, type SyntaxNode, type Tree } from '@lezer/common'
import {
  chainAt,
  docInput,
  FM_SCAN_LIMIT,
  frontmatterRange,
  markdownTreeParser,
  visitRange,
  type SourceRange,
} from './markdownDoc'
import { resolveTaskToggleAtMarker } from './taskToggle'
import {
  barePipeAt,
  escapedPipeBackslashes,
  parseTableDelimiter,
  splitTableRowCells,
  tableRowCellsForColumns,
  tableCellBreaks,
  type TableAlign,
} from './tableCells'

/** 标题类名（#5 契约保持不变） */
export const HEADING_CLASS_NAMES = {
  line: 'vsidian-heading-line',
  level: (lv: number) => `vsidian-heading-line-${lv}`,
  inview: 'vsidian-heading-inview',
  active: 'vsidian-heading-active',
} as const

/** #8 新增稳定类名（Obsidian 对应选择器见 docs/design/obsidian-selector-map.md） */
export const LIVE_CLASS_NAMES = {
  /** 标题内容 span（Obsidian `.cm-header-{n}`） */
  headerSpan: (lv: number) => `vsidian-header-${Math.min(6, Math.max(1, lv))}`,
  /** 粗体内容 span（`.cm-strong`） */
  strong: 'vsidian-strong',
  /** 斜体内容 span（`.cm-emphasis`） */
  emphasis: 'vsidian-emphasis',
  /** 行内代码内容 span（`.cm-inline-code`） */
  inlineCode: 'vsidian-inline-code',
  /** 引用行（`.HyperMD-quote` / `.cm-quote`） */
  quoteLine: 'vsidian-quote-line',
  /** 围栏/缩进代码行（`.HyperMD-codeblock`） */
  codeLine: 'vsidian-code-line',
  /** 列表项行（`.HyperMD-list-line`，本项目自有组合形态） */
  listLine: 'vsidian-list-line',
  /** 无序列表行修饰（标记隐藏后以 ::before 呈现圆点） */
  listBullet: 'vsidian-list-bullet',
  /** 无序列表源码标记显形时抑制行首伪圆点，避免重复 */
  listMarkerVisible: 'vsidian-list-marker-visible',
  /** 有序列表行修饰（编号保留可见） */
  listOrdered: 'vsidian-list-ordered',
  /** 任务 checkbox（input，#9 可交互：点击/Enter 切换勾选态） */
  taskCheckbox: 'vsidian-task-checkbox',
  /** 已勾选修饰类（配合 :checked 伪类的稳定类入口） */
  taskChecked: 'vsidian-task-checked',
  /** 水平线行（`.cm-hr`） */
  hrLine: 'vsidian-hr-line',
  /** frontmatter 行（`.cm-hmd-frontmatter` 方向） */
  frontmatterLine: 'vsidian-frontmatter-line',
  /** ---- 表格：源文本为唯一编辑面，安全表格保持可编辑网格（#42）---- */
  /** 表格行（表头/分隔/数据行通用；Obsidian 对应 .cm-table 方向） */
  tableLine: 'vsidian-table-line',
  /** 表头行修饰 */
  tableHeaderLine: 'vsidian-table-header-line',
  /** 分隔行修饰 */
  tableDelimiterLine: 'vsidian-table-delimiter-line',
  /** 单元格内容 span（trim 后区间） */
  tableCell: 'vsidian-table-cell',
  /** 表头单元格修饰 */
  tableCellHeader: 'vsidian-table-cell-header',
  /** 管道符 span（含首尾边界管道） */
  tablePipe: 'vsidian-table-pipe',
  /** 安全表格的网格行和单元格；行身份另见 data-vsidian-table-row */
  tableGridRow: 'vsidian-table-grid-row',
  tableGridCell: 'vsidian-table-grid-cell',
  tableGridDelimiter: 'vsidian-table-grid-delimiter',
  tableEscapedPipe: 'vsidian-table-escaped-pipe',
  /** 列对齐修饰（分隔行声明的对齐落到各单元格） */
  tableAlign: (a: TableAlign) => `vsidian-table-align-${a}`,
} as const

// ---- 装饰实例缓存：增量与全量构建产出相同实例，使 RangeSet.eq 成立 ----

const hideDeco = Decoration.replace({})

const lineDecoCache = new Map<string, ReturnType<typeof Decoration.line>>()
function lineDeco(cls: string): ReturnType<typeof Decoration.line> {
  let deco = lineDecoCache.get(cls)
  if (!deco) {
    deco = Decoration.line({ class: cls })
    lineDecoCache.set(cls, deco)
  }
  return deco
}

const headerSpanDecos = [1, 2, 3, 4, 5, 6].map((lv) =>
  Decoration.mark({ class: LIVE_CLASS_NAMES.headerSpan(lv) }),
)
const strongDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.strong })
const emphasisDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.emphasis })
const inlineCodeDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.inlineCode })

/**
 * 任务 checkbox widget（#9）：input[type=checkbox] 替换任务标记 [ ]/[x]。
 * 点击/Enter 经 posAtDOM 定位当前文档坐标（装饰随文档同步，位置无过期），
 * 经 taskToggle 校验后派发替换事务——事务走编辑器标准出站链路
 * （syncController updateListener → edit.request），不旁路直改。
 * 空格键依赖浏览器原生激活（checkbox 上按 Space 触发 click），不另行
 * 拦截，避免与原生行为双重切换。
 */
class TaskCheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = this.checked
      ? `${LIVE_CLASS_NAMES.taskCheckbox} ${LIVE_CLASS_NAMES.taskChecked}`
      : LIVE_CLASS_NAMES.taskCheckbox
    box.setAttribute('aria-label', this.checked ? '取消任务勾选' : '勾选任务')
    const toggle = (): void => {
      const view = EditorView.findFromDOM(box)
      if (!view) {
        return
      }
      const doc = view.state.doc.toString()
      const pos = view.posAtDOM(box)
      const target = resolveTaskToggleAtMarker(doc, pos, pos + 3, this.checked)
      if (target) {
        view.dispatch({
          changes: { from: target.from, to: target.to, insert: target.nextText },
        })
      }
    }
    box.addEventListener('click', (event) => {
      // 取消原生翻转：勾选态始终由文档驱动重绘（校验失败时不改显示）
      event.preventDefault()
      toggle()
    })
    box.addEventListener('keydown', (event) => {
      // Enter 在 checkbox 上无原生激活：手动触发切换；阻断冒泡避免编辑器
      // 把 Enter 解释为插入换行
      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        toggle()
      }
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}
const taskCheckboxDecos = [
  Decoration.replace({ widget: new TaskCheckboxWidget(false) }),
  Decoration.replace({ widget: new TaskCheckboxWidget(true) }),
]

// ---- 表格装饰（#12）：单元格边界来自 tableCells 的 GFM 语义拆分 ----
// （lezer 的 TableCell 节点不识别 \| 与行内代码内管道，不作定位依据）

const tablePipeDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.tablePipe })
const tableEscapedPipeDeco = Decoration.mark({ class: LIVE_CLASS_NAMES.tableEscapedPipe })
// 行尾一个 Markdown 填充空格保留文字节点供原生输入/IME 使用，但不参与
// 可见排版。不要替换成零宽 widget：删空格再输入曾使光标显示在后一列。
const tableGridPaddingDeco = Decoration.mark({ class: 'vsidian-table-grid-padding' })
class TableCellBreakWidget extends WidgetType {
  eq(): boolean { return true }
  // 文档仍只有一个源行，CM6 必须得知 widget 在视觉上增加一行，
  // 否则格内上下方向键与光标测量会停留在原行。
  get lineBreaks(): number { return 1 }
  toDOM(): HTMLElement {
    const br = document.createElement('br')
    br.className = 'vsidian-table-cell-break'
    return br
  }
}
const tableCellBreakDeco = Decoration.replace({ widget: new TableCellBreakWidget(), tableCellBreak: true })
/** 仅无边界空白格的 IME 候选事务：源文暂变但沿用原网格装饰。 */
export const tableCompositionPreview = Annotation.define<boolean>()
export const tableCompositionSettled = Annotation.define<boolean>()
const tableGridCellDecos = new Map<string, ReturnType<typeof Decoration.mark>>()
function tableGridCellDeco(align: TableAlign | null): ReturnType<typeof Decoration.mark> {
  const cls = align
    ? `${LIVE_CLASS_NAMES.tableGridCell} vsidian-table-grid-align-${align}`
    : LIVE_CLASS_NAMES.tableGridCell
  let deco = tableGridCellDecos.get(cls)
  if (!deco) {
    // 内容恰好填满单元格区间时，网格 span 仍须包在内容 span 外层；
    // 双端 inclusive 给 CM6 稳定的外层优先级，也让边界输入留在当前格。
    deco = Decoration.mark({ class: cls, inclusiveStart: true, inclusiveEnd: true })
    tableGridCellDecos.set(cls, deco)
  }
  return deco
}

/** 零宽空格仍须占一列；widget 仅在该行进入 CM6 视口时生成 DOM。 */
class EmptyTableCellWidget extends WidgetType {
  constructor(private readonly active = false) { super() }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = this.active
      ? `${LIVE_CLASS_NAMES.tableGridCell} vsidian-table-grid-empty-active`
      : LIVE_CLASS_NAMES.tableGridCell
    span.setAttribute('aria-label', '空单元格')
    span.addEventListener('mousedown', (event) => {
      const view = EditorView.findFromDOM(span)
      if (!view) return
      const pos = view.posAtDOM(span)
      view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(pos, -1)]), scrollIntoView: true })
      view.focus()
      event.preventDefault()
    })
    return span
  }
  ignoreEvent(): boolean {
    return false
  }
}
const emptyTableCellDeco = Decoration.widget({ widget: new EmptyTableCellWidget() })
const activeEmptyTableCellDeco = Decoration.widget({ widget: new EmptyTableCellWidget(true) })

type GridRowKind = 'header' | 'row'
interface TableGridPlan {
  columns: number
  rows: Map<number, GridRowKind>
  delimiterLine: number
}

const tableGridStats = { planCalls: 0, rowsScanned: 0 }
export function getTableGridStats(): Readonly<typeof tableGridStats> {
  return { ...tableGridStats }
}

/**
 * 仅对源区间与显示格一一对应的表格启用网格。缺列/多列以及无法解析的
 * 分隔行保持源码形态，避免视觉点击落到错误列。
 */
function tableGridPlan(doc: Text, table: SyntaxNode): TableGridPlan | null {
  tableGridStats.planCalls += 1
  const rows = new Map<number, GridRowKind>()
  let delimiterLine = 0
  let columns = 0
  let headers = 0
  for (let c = table.firstChild; c; c = c.nextSibling) {
    tableGridStats.rowsScanned += 1
    if (c.name !== 'TableHeader' && c.name !== 'TableDelimiter' && c.name !== 'TableRow') {
      return null
    }
    const line = doc.lineAt(c.from)
    if (c.name === 'TableDelimiter') {
      const aligns = parseTableDelimiter(line.text)
      if (!aligns || delimiterLine !== 0) {
        return null
      }
      delimiterLine = line.number
      columns = aligns.length
    } else {
      const kind: GridRowKind = c.name === 'TableHeader' ? 'header' : 'row'
      if (kind === 'header') headers += 1
      rows.set(line.number, kind)
    }
  }
  if (headers !== 1 || delimiterLine === 0 || columns === 0 || rows.size === 0) {
    return null
  }
  for (const lineNo of rows.keys()) {
    tableGridStats.rowsScanned += 1
    if (!tableRowCellsForColumns(doc.line(lineNo).text, 0, columns)) {
      return null
    }
  }
  return { columns, rows, delimiterLine }
}

const gridLineDecos = new Map<string, ReturnType<typeof Decoration.line>>()
function tableGridLineDeco(cls: string, kind: GridRowKind, plan: TableGridPlan): ReturnType<typeof Decoration.line> {
  const key = `${cls}\u0000${kind}\u0000${plan.columns}`
  let deco = gridLineDecos.get(key)
  if (!deco) {
    deco = Decoration.line({
      class: cls,
      attributes: {
        'data-vsidian-table-row': kind,
        style: `--vsidian-table-columns: ${plan.columns}`,
      },
    })
    gridLineDecos.set(key, deco)
  }
  return deco
}

/** 单元格 mark 实例缓存：header × 对齐的有限组合，增量与全量产出相同实例 */
const tableCellDecos = new Map<string, ReturnType<typeof Decoration.mark>>()

function tableCellDeco(header: boolean, align: TableAlign | null): ReturnType<typeof Decoration.mark> {
  const cls = [
    LIVE_CLASS_NAMES.tableCell,
    header ? LIVE_CLASS_NAMES.tableCellHeader : '',
    align ? LIVE_CLASS_NAMES.tableAlign(align) : '',
  ]
    .filter(Boolean)
    .join(' ')
  let deco = tableCellDecos.get(cls)
  if (!deco) {
    deco = Decoration.mark({ class: cls })
    tableCellDecos.set(cls, deco)
  }
  return deco
}

/** 表格祖先（path 反向查找；Table 不可嵌套，命中即唯一） */
function tableAncestor(path: SyntaxNode[]): SyntaxNode | null {
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.name === 'Table') {
      return path[i]!
    }
  }
  return null
}

/** 表格的列对齐：解析 Table 直接子 TableDelimiter 中覆盖整行的那一个（分隔行） */
function tableAlignsOf(doc: Text, table: SyntaxNode | null): Array<TableAlign | null> | null {
  if (!table) {
    return null
  }
  for (let c = table.firstChild; c; c = c.nextSibling) {
    if (c.name !== 'TableDelimiter') {
      continue
    }
    const line = doc.lineAt(c.from)
    if (c.to > line.from && c.to <= line.to) {
      const aligns = parseTableDelimiter(line.text)
      if (aligns) {
        return aligns
      }
    }
  }
  return null
}

/** 一行表格行的管道符 mark（全部裸管道：含首尾边界） */
function emitTablePipeMarks(out: Array<Range<Decoration>>, doc: Text, lineFrom: number): void {
  const line = doc.lineAt(lineFrom)
  for (let i = 0; i < line.text.length; i++) {
    // 转义/代码内管道不切分单元格，同样不作为分隔管道呈现
    if (barePipeAt(line.text, i)) {
      out.push(tablePipeDeco.range(lineFrom + i, lineFrom + i + 1))
    }
  }
}

/** 表头/数据行的单元格 mark + 管道 mark（GFM 语义拆分） */
function emitTableRowMarks(
  out: Array<Range<Decoration>>,
  doc: Text,
  node: SyntaxNode,
  path: SyntaxNode[],
  selection: EditorSelection,
  grid: boolean,
  columns?: number,
): void {
  const line = doc.lineAt(node.from)
  const header = node.name === 'TableHeader'
  const aligns = tableAlignsOf(doc, tableAncestor(path))
  const cells = grid && columns
    ? tableRowCellsForColumns(line.text, line.from, columns) ?? []
    : splitTableRowCells(line.text, line.from)
  for (let col = 0; col < cells.length; col++) {
    const cell = cells[col]!
    if (grid) {
      out.push(cell.to > cell.from
        ? tableGridCellDeco(aligns?.[col] ?? null).range(cell.from, cell.to)
        : (selection.ranges.some((range) => range.empty && range.head === cell.from)
          ? activeEmptyTableCellDeco : emptyTableCellDeco).range(cell.from))
      if (cell.to > cell.from && doc.sliceString(cell.to - 1, cell.to) === ' ') {
        out.push(tableGridPaddingDeco.range(cell.to - 1, cell.to))
      }
      // 只替换裸 br；代码片段或转义后的 br 要保持可见字面文本。
      for (const lineBreak of tableCellBreaks(doc.sliceString(cell.from, cell.to))) {
        out.push(tableCellBreakDeco.range(cell.from + lineBreak.from, cell.from + lineBreak.to))
      }
    }
    if (cell.contentTo > cell.contentFrom) {
      const deco = tableCellDeco(header, aligns && col < aligns.length ? aligns[col]! : null)
      out.push(deco.range(cell.contentFrom, cell.contentTo))
    }
  }
  if (grid) {
    for (const pos of escapedPipeBackslashes(line.text)) {
      out.push(tableEscapedPipeDeco.range(line.from + pos, line.from + pos + 1))
    }
  }
  emitTablePipeMarks(out, doc, line.from)
}

/** 行是否被选区覆盖（仅用于标题行视口强调；mark 显形用 selectionTouchesRange）。 */
export function isLineActive(selection: EditorSelection, doc: Text, lineNumber: number): boolean {
  for (const r of selection.ranges) {
    if (doc.lineAt(r.from).number <= lineNumber && lineNumber <= doc.lineAt(r.to).number) {
      return true
    }
  }
  return false
}

/** 光标或非空选区是否触及语法范围；折叠光标包含两端边界，便于在 mark 左右编辑。 */
export function selectionTouchesRange(selection: EditorSelection, from: number, to: number): boolean {
  for (const range of selection.ranges) {
    if (range.empty ? range.head >= from && range.head <= to : range.from < to && range.to > from) {
      return true
    }
  }
  return false
}

/** ATXHeading{1..6} / SetextHeading{1..2} → 级别；其余 null */
function headingLevelOf(name: string): number | null {
  let m = /^ATXHeading([1-6])$/.exec(name)
  if (m) {
    return Number(m[1])
  }
  m = /^SetextHeading([1-2])$/.exec(name)
  if (m) {
    return Number(m[1])
  }
  return null
}

/** 名为 name 的直接子节点（mark 查找用） */
function childNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) {
      return c
    }
  }
  return null
}

/** 跳过 pos 起的连续空格（ATX 标记后的分隔空格） */
function skipSpaces(doc: Text, pos: number): number {
  let p = pos
  while (p < doc.length) {
    const ch = doc.sliceString(p, p + 1)
    if (ch !== ' ' && ch !== '\t') {
      break
    }
    p += 1
  }
  return p
}

/** 区间行号集合：把节点/区间限制到 [fromLine, toLine] 后逐行回调。
 *  节点结束位置含块尾换行（Lezer 块节点常态），行号按去掉尾换行计算 */
function eachNodeLine(
  doc: Text,
  node: { from: number; to: number },
  fromLine: number,
  toLine: number,
  fn: (lineNo: number) => void,
): void {
  const first = Math.max(fromLine, doc.lineAt(Math.min(node.from, doc.length)).number)
  let endPos = Math.min(node.to, doc.length)
  if (endPos > node.from && doc.sliceString(endPos - 1, endPos) === '\n') {
    endPos -= 1
  }
  const last = Math.min(toLine, doc.lineAt(endPos).number)
  for (let n = first; n <= last; n++) {
    fn(n)
  }
}

function emitForRange(
  tree: Tree,
  doc: Text,
  selection: EditorSelection,
  fm: SourceRange | null,
  fromLine: number,
  toLine: number,
  gridPlans: Map<number, TableGridPlan | null> = new Map(),
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  const lineCls: Array<Set<string> | undefined> = new Array(toLine - fromLine + 1).fill(undefined)
  const gridLines = new Map<number, { kind: GridRowKind; plan: TableGridPlan }>()
  const addLineCls = (lineNo: number, cls: string): void => {
    const idx = lineNo - fromLine
    let set = lineCls[idx]
    if (!set) {
      set = new Set()
      lineCls[idx] = set
    }
    set.add(cls)
  }
  const touches = (from: number, to: number): boolean => selectionTouchesRange(selection, from, to)
  const markerEnd = (node: SyntaxNode): number =>
    node.to < doc.length && doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to

  // frontmatter：按行给类（树发射被裁剪到 fm 之后）
  if (fm) {
    const fmLast = doc.lineAt(Math.min(fm.end, doc.length)).number
    for (let n = Math.max(1, fromLine); n <= Math.min(toLine, fmLast); n++) {
      addLineCls(n, LIVE_CLASS_NAMES.frontmatterLine)
    }
  }

  const emitFrom = Math.max(doc.line(fromLine).from, fm ? fm.end : 0)
  const emitTo = doc.line(toLine).to

  visitRange(tree, emitFrom, emitTo, (node, path) => {
    // frontmatter 区域内的树节点不发射（头块按源码呈现）
    if (fm && node.from < fm.end) {
      return
    }
    const level = headingLevelOf(node.name)
    if (level !== null) {
      const mark = childNamed(node, 'HeaderMark')
      let contentFrom = node.from
      let contentTo = node.to
      if (mark && mark.from === node.from) {
        // ATX：# 标记在头部（HeaderMark 仅覆盖 # 字符），内容跳过标记后的空格
        contentFrom = skipSpaces(doc, mark.to)
        addLineCls(doc.lineAt(node.from).number, `${HEADING_CLASS_NAMES.line} ${HEADING_CLASS_NAMES.level(level)}`)
      } else {
        // Setext：内容行 = 下划线标记之前的行；下划线行不套标题行级类
        const underlineLine = mark ? doc.lineAt(mark.from).number : doc.lineAt(node.to).number
        contentTo = mark
          ? doc.line(Math.max(1, underlineLine - 1)).to
          : node.to
        eachNodeLine(doc, { from: node.from, to: contentTo }, fromLine, toLine, (n) => {
          if (n < underlineLine) {
            addLineCls(n, `${HEADING_CLASS_NAMES.line} ${HEADING_CLASS_NAMES.level(level)}`)
          }
        })
      }
      if (contentTo > contentFrom && contentFrom >= emitFrom) {
        out.push(headerSpanDecos[level - 1]!.range(contentFrom, contentTo))
      }
      return
    }
    switch (node.name) {
      case 'FencedCode':
      case 'CodeBlock':
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.codeLine))
        return
      case 'Blockquote':
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.quoteLine))
        return
      case 'HorizontalRule':
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.hrLine))
        return
      // 安全表格在光标进入单元格后仍保留网格；原文编辑由 CM6 承担。
      case 'Table': {
        eachNodeLine(doc, node, fromLine, toLine, (n) => addLineCls(n, LIVE_CLASS_NAMES.tableLine))
        let plan = gridPlans.get(node.from)
        if (plan === undefined && !gridPlans.has(node.from)) {
          plan = tableGridPlan(doc, node)
          gridPlans.set(node.from, plan)
        }
        if (plan) {
          const first = Math.max(fromLine, doc.lineAt(node.from).number)
          const last = Math.min(toLine, doc.lineAt(Math.min(node.to, doc.length)).number)
          for (let lineNo = first; lineNo <= last; lineNo++) {
            const kind = plan.rows.get(lineNo)
            if (!kind) continue
            addLineCls(lineNo, LIVE_CLASS_NAMES.tableGridRow)
            gridLines.set(lineNo, { kind, plan })
          }
          // 只有光标直接停在分隔行才显露可编辑源码。跨行选区即使覆盖该行，
          // 也继续隐藏结构标记，避免把 `| --- |` 当可选正文显示。
          const editingDelimiter = selection.ranges.some((range) => range.empty &&
            doc.lineAt(range.head).number === plan.delimiterLine)
          if (plan.delimiterLine >= fromLine && plan.delimiterLine <= toLine &&
              !editingDelimiter) {
            addLineCls(plan.delimiterLine, LIVE_CLASS_NAMES.tableGridDelimiter)
          }
        }
        return
      }
      case 'TableHeader': {
        const lineNo = doc.lineAt(node.from).number
        if (lineNo >= fromLine && lineNo <= toLine) {
          addLineCls(lineNo, LIVE_CLASS_NAMES.tableHeaderLine)
          const grid = gridPlans.get(tableAncestor(path)?.from ?? -1)
          emitTableRowMarks(out, doc, node, path, selection, Boolean(grid && gridLines.has(lineNo)), grid?.columns)
        }
        return
      }
      case 'TableRow': {
        const lineNo = doc.lineAt(node.from).number
        if (lineNo >= fromLine && lineNo <= toLine) {
          const grid = gridPlans.get(tableAncestor(path)?.from ?? -1)
          emitTableRowMarks(out, doc, node, path, selection, Boolean(grid && gridLines.has(lineNo)), grid?.columns)
        }
        return
      }
      case 'TableDelimiter': {
        // 分隔行是覆盖整行的 TableDelimiter 节点；表头/数据行内的单字符
        // 管道节点同名，按区间是否独占整行区分
        const line = doc.lineAt(node.from)
        if (node.from === line.from && node.to === line.to) {
          const lineNo = line.number
          if (lineNo >= fromLine && lineNo <= toLine) {
            addLineCls(lineNo, LIVE_CLASS_NAMES.tableDelimiterLine)
            emitTablePipeMarks(out, doc, line.from)
          }
        }
        return
      }
      case 'TableCell':
        // lezer 的 cell 切分不识别 \| 与代码内管道，装饰用 emitTableRowMarks
        // 的自研拆分；此处跳过（cell 内行内节点经 visitRange 递归照常发射）
        return
      case 'ListItem': {
        const depth = 1 + path.filter((p) => p.name === 'ListItem').length
        const nearestList = [...path].reverse().find((p) => p.name === 'BulletList' || p.name === 'OrderedList')
        const ordered = nearestList?.name === 'OrderedList'
        const cls = `${LIVE_CLASS_NAMES.listLine} ${ordered ? LIVE_CLASS_NAMES.listOrdered : LIVE_CLASS_NAMES.listBullet} ${LIVE_CLASS_NAMES.listLine}-d${Math.min(8, depth)}`
        eachNodeLine(doc, node, fromLine, toLine, (n) => {
          for (const part of cls.split(' ')) {
            addLineCls(n, part)
          }
        })
        return
      }
      case 'Emphasis':
        pushInnerSpan(out, node, 'EmphasisMark', emphasisDeco)
        return
      case 'StrongEmphasis':
        pushInnerSpan(out, node, 'EmphasisMark', strongDeco)
        return
      case 'InlineCode':
        pushInnerSpan(out, node, 'CodeMark', inlineCodeDeco)
        return
      case 'HeaderMark': {
        const heading = [...path].reverse().find((parent) => headingLevelOf(parent.name) !== null)
        const to = markerEnd(node)
        if (!heading || !touches(heading.from, heading.to)) {
          out.push(hideDeco.range(node.from, to))
        }
        return
      }
      case 'QuoteMark': {
        const to = markerEnd(node)
        if (!touches(node.from, to)) {
          out.push(hideDeco.range(node.from, to))
        }
        return
      }
      case 'ListMark': {
        // 有序列表编号保留；无序标记隐藏（吞并其后一个空格）
        const ordered =
          [...path].reverse().find((p) => p.name === 'BulletList' || p.name === 'OrderedList')
            ?.name === 'OrderedList'
        if (ordered) {
          return
        }
        const to = markerEnd(node)
        if (!touches(node.from, to)) {
          out.push(hideDeco.range(node.from, to))
        } else {
          addLineCls(doc.lineAt(node.from).number, LIVE_CLASS_NAMES.listMarkerVisible)
        }
        return
      }
      case 'EmphasisMark': {
        const scope = path[path.length - 1]
        if (!scope || !touches(scope.from, scope.to)) {
          out.push(hideDeco.range(node.from, node.to))
        }
        return
      }
      case 'CodeMark': {
        // 仅行内代码的反引号隐藏；围栏 ``` 保留可见
        if (path[path.length - 1]?.name === 'InlineCode') {
          const scope = path[path.length - 1]!
          if (!touches(scope.from, scope.to)) {
            out.push(hideDeco.range(node.from, node.to))
          }
        }
        return
      }
      case 'TaskMarker': {
        if (!touches(node.from, node.to)) {
          const checked = doc.sliceString(node.from + 1, Math.min(node.from + 2, node.to)) !== ' '
          out.push(taskCheckboxDecos[checked ? 1 : 0]!.range(node.from, node.to))
        }
        return
      }
      default:
        return
    }
  })

  for (let i = 0; i < lineCls.length; i++) {
    const set = lineCls[i]
    if (set && set.size > 0) {
      const line = doc.line(fromLine + i)
      const cls = [...set].sort().join(' ')
      const grid = gridLines.get(line.number)
      out.push((grid ? tableGridLineDeco(cls, grid.kind, grid.plan) : lineDeco(cls)).range(line.from))
    }
  }
  return out
}

/** 节点首尾 mark 之间的内容 span */
function pushInnerSpan(
  out: Array<Range<Decoration>>,
  node: SyntaxNode,
  markName: string,
  deco: Decoration,
): void {
  let first: SyntaxNode | null = null
  let last: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === markName) {
      if (!first) {
        first = c
      }
      last = c
    }
  }
  if (first && last && last.from > first.to) {
    out.push(deco.range(first.to, last.from))
  }
}

// ---- 增量观测（单测与性能探针；字段名沿用 #5 的协议通道） ----

const stats = {
  fullBuildLines: 0,
  lastUpdateScannedLines: 0,
  totalUpdates: 0,
  totalScannedLines: 0,
}

export interface HeadingStats {
  fullBuildLines: number
  lastUpdateScannedLines: number
  totalUpdates: number
  totalScannedLines: number
}

export function getHeadingStats(): HeadingStats {
  return { ...stats }
}

// ---- 解析与装饰状态 ----

interface LiveDecoState {
  decos: DecorationSet
  tree: Tree
  fragments: readonly TreeFragment[]
  fm: SourceRange | null
  gridPlans: Map<number, TableGridPlan | null>
  compositionPreview: boolean
}

function parseTree(doc: Text, fragments?: readonly TreeFragment[]): Tree {
  return markdownTreeParser.parse(docInput(doc), fragments)
}

function frontmatterOf(doc: Text): SourceRange | null {
  // 有界扫描：frontmatter 判定只依赖文档头部（markdownDoc 内限制扫描长度）
  return frontmatterRange(headText(doc))
}

/** 文档头部字符串（frontmatter 判定的输入，有界；截断口径同源 markdownDoc） */
function headText(doc: Text): string {
  return doc.sliceString(0, Math.min(doc.length, FM_SCAN_LIMIT))
}

/** 全量构建（create / 全文替换 / 探针对拍） */
export function buildLivePreviewDecorations(doc: Text, selection: EditorSelection): DecorationSet {
  const tree = parseTree(doc)
  const fm = frontmatterOf(doc)
  stats.fullBuildLines = doc.lines
  return RangeSet.of(emitForRange(tree, doc, selection, fm, 1, doc.lines), true)
}

/** 变更行区间（新文档坐标，行扩展） */
interface LineSpan {
  fromLine: number
  toLine: number
}

interface ChangedRange4 {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

/** 选区驱动的重建行：旧选区行映射 + 新选区行 */
function selectionSpans(tr: Transaction): LineSpan[] {
  const doc = tr.state.doc
  const spans: LineSpan[] = []
  for (const r of tr.startState.selection.ranges) {
    const from = tr.changes.mapPos(r.from, -1)
    const to = tr.changes.mapPos(r.to, 1)
    spans.push({ fromLine: doc.lineAt(from).number, toLine: doc.lineAt(to).number })
  }
  for (const r of tr.state.selection.ranges) {
    spans.push({ fromLine: doc.lineAt(r.from).number, toLine: doc.lineAt(r.to).number })
  }
  return spans
}

/** 装饰承载节点名（旧侧种子收集用——不含巨型容器，见模块头注释） */
const SEED_NODE_NAMES = new Set([
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
  'HeaderMark', 'EmphasisMark', 'QuoteMark', 'ListMark', 'TaskMarker',
  'Emphasis', 'StrongEmphasis', 'InlineCode', 'HorizontalRule', 'ListItem',
  'Table', 'TableHeader', 'TableRow', 'TableCell', 'TableDelimiter',
])

/** 分类容器（尾部差异探测用） */
const CONTAINER_NAMES = new Set(['FencedCode', 'CodeBlock', 'Blockquote', 'ListItem', 'Table'])

/**
 * 一次 docChanged 事务的重建行区间计算：
 * 1. 种子：变更行（新坐标行扩展）+ 旧树相交装饰节点（映射后的行区间）+
 *    选区旧行/新行 + frontmatter 变化时的头块行
 * 2. 容器差异扩展：种子末行的下一行处比较新旧树的容器分类（名字集合与
 *    映射后范围）；分类变化（围栏开闭、列表吸收等）时扩展到容器边界，
 *    迭代至不动点——正常键入在首轮即收敛
 */
function planRebuildSpans(
  tr: Transaction,
  oldTree: Tree,
  newTree: Tree,
  changed: readonly ChangedRange4[],
  oldFm: SourceRange | null,
  newFm: SourceRange | null,
): LineSpan[] {
  const doc = tr.state.doc
  const oldDoc = tr.startState.doc
  const spans: LineSpan[] = []
  const pushSpan = (from: number, to: number): void => {
    if (to < from || from > doc.length) {
      return
    }
    spans.push({
      fromLine: doc.lineAt(Math.min(from, doc.length)).number,
      toLine: doc.lineAt(Math.min(Math.max(to, from), doc.length)).number,
    })
  }
  for (const c of changed) {
    pushSpan(c.fromB, c.toB)
    // 旧侧：变更旧行区间内相交的装饰承载节点 → 映射为新坐标
    const oldFrom = oldDoc.lineAt(Math.min(c.fromA, oldDoc.length)).from
    const oldTo = oldDoc.lineAt(Math.min(c.toA, oldDoc.length)).to
    visitRange(oldTree, oldFrom, oldTo, (node) => {
      if (SEED_NODE_NAMES.has(node.name)) {
        pushSpan(tr.changes.mapPos(node.from, -1), tr.changes.mapPos(node.to, 1))
      }
    })
  }
  // 选区显式变化才扩展重建行（编辑事务的默认选区映射不触发）
  if (tr.selection !== undefined) {
    spans.push(...selectionSpans(tr))
  }

  if (!sameRange(newFm, oldFm)) {
    const lastLine = Math.max(
      newFm ? doc.lineAt(Math.min(newFm.end, doc.length)).number : 0,
      oldFm ? oldDoc.lineAt(Math.min(oldFm.end, oldDoc.length)).number : 0,
    )
    spans.push({ fromLine: 1, toLine: Math.max(1, Math.min(lastLine, doc.lines)) })
  }

  mergeSpans(spans, doc.lines)
  expandSpansByContainerDiff(spans, tr, oldTree, newTree, changed)
  return spans
}

function sameRange(a: SourceRange | null, b: SourceRange | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return a.start === b.start && a.end === b.end
}

/** 就地合并重叠/相邻区间并裁剪到文档行界 */
function mergeSpans(spans: LineSpan[], totalLines: number): void {
  for (const s of spans) {
    s.fromLine = Math.max(1, Math.min(s.fromLine, totalLines))
    s.toLine = Math.max(1, Math.min(s.toLine, totalLines))
  }
  spans.sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine)
  const merged: LineSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.fromLine <= last.toLine + 1) {
      last.toLine = Math.max(last.toLine, s.toLine)
    } else {
      merged.push({ ...s })
    }
  }
  spans.length = 0
  spans.push(...merged)
}

/** 容器分类差异探测：扩展 spans 至受影响容器边界（迭代至不动点） */
function expandSpansByContainerDiff(
  spans: LineSpan[],
  tr: Transaction,
  oldTree: Tree,
  newTree: Tree,
  changed: readonly ChangedRange4[],
): void {
  const doc = tr.state.doc
  const oldDoc = tr.startState.doc
  const inverted = tr.changes.invertedDesc
  for (let iter = 0; iter < 128 && spans.length > 0; iter++) {
    let grew = false
    for (const span of spans) {
      if (span.toLine >= doc.lines) {
        continue
      }
      const probePos = doc.line(span.toLine + 1).from
      const newChain = chainAt(newTree, probePos)
      const oldPos = Math.min(inverted.mapPos(probePos, -1), oldDoc.length)
      const oldChain = chainAt(oldTree, oldPos)
      const newKinds = new Set(newChain.filter((c) => CONTAINER_NAMES.has(c.name)).map((c) => c.name))
      const oldKinds = new Set(oldChain.filter((c) => CONTAINER_NAMES.has(c.name)).map((c) => c.name))
      let needExpand = !setEquals(newKinds, oldKinds)
      if (!needExpand) {
        // 同名容器范围差异（列表吸收等）：新范围越过映射旧范围且增量不来自变更
        for (const kind of newKinds) {
          const n = newChain.find((c) => c.name === kind)!
          const o = oldChain.find((c) => c.name === kind)!
          const mappedOFrom = tr.changes.mapPos(o.from, -1)
          const mappedOTo = tr.changes.mapPos(o.to, 1)
          if (n.to > mappedOTo && !changedCovers(changed, mappedOTo, n.to)) {
            needExpand = true
            break
          }
          if (n.from < mappedOFrom && !changedCovers(changed, n.from, mappedOFrom)) {
            needExpand = true
            break
          }
        }
      }
      if (!needExpand) {
        continue
      }
      let fromLine = span.fromLine
      let toLine = span.toLine
      for (const c of newChain) {
        if (CONTAINER_NAMES.has(c.name)) {
          fromLine = Math.min(fromLine, doc.lineAt(c.from).number)
          toLine = Math.max(toLine, doc.lineAt(Math.min(c.to, doc.length)).number)
        }
      }
      for (const c of oldChain) {
        if (CONTAINER_NAMES.has(c.name)) {
          fromLine = Math.min(fromLine, doc.lineAt(tr.changes.mapPos(c.from, -1)).number)
          toLine = Math.max(toLine, doc.lineAt(Math.min(tr.changes.mapPos(c.to, 1), doc.length)).number)
        }
      }
      if (toLine > span.toLine || fromLine < span.fromLine) {
        span.fromLine = Math.max(1, fromLine)
        span.toLine = Math.min(doc.lines, toLine)
        grew = true
      }
    }
    if (!grew) {
      return
    }
    mergeSpans(spans, doc.lines)
  }
}

function setEquals<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const v of a) {
    if (!b.has(v)) {
      return false
    }
  }
  return true
}

/** [from, to) 与任一变更区间（新坐标）相交 */
function changedCovers(changed: readonly ChangedRange4[], from: number, to: number): boolean {
  for (const c of changed) {
    if (c.fromB < to && c.toB > from) {
      return true
    }
  }
  return false
}

// ---- StateField ----

export const liveDecorationsField = StateField.define<LiveDecoState>({
  create(state) {
    const tree = parseTree(state.doc)
    const fm = frontmatterOf(state.doc)
    stats.fullBuildLines = state.doc.lines
    const gridPlans = new Map<number, TableGridPlan | null>()
    return {
      decos: RangeSet.of(emitForRange(tree, state.doc, state.selection, fm, 1, state.doc.lines, gridPlans), true),
      tree,
      fragments: TreeFragment.addTree(tree),
      fm,
      gridPlans,
      compositionPreview: false,
    }
  },
  update(value, tr) {
    if (!tr.docChanged && tr.selection === undefined) {
      return value
    }
    if (!tr.docChanged) {
      if (tr.annotation(tableCompositionSettled)) {
        const doc = tr.state.doc
        const lineNo = doc.lineAt(tr.state.selection.main.head).number
        let oldKey: number | undefined
        let oldPlan: TableGridPlan | null | undefined
        for (const [key, plan] of value.gridPlans) {
          if (plan?.rows.has(lineNo)) { oldKey = key; oldPlan = plan; break }
        }
        if (oldPlan && oldKey !== undefined) {
          const currentLine = doc.line(lineNo)
          const pipe = currentLine.text.indexOf('|')
          const stillRow = pipe >= 0 &&
            chainAt(value.tree, currentLine.from + pipe + 1).some((node) => node.name === 'TableRow')
          if (stillRow && tableRowCellsForColumns(currentLine.text, currentLine.from, oldPlan.columns)) {
            // 取消等仍符合列数的净结果，只需恢复当前行的普通装饰。
            const decos = value.decos.update({
              filterFrom: currentLine.from,
              filterTo: currentLine.to,
              filter: () => false,
              add: emitForRange(value.tree, doc, tr.state.selection, value.fm, lineNo, lineNo, value.gridPlans),
              sort: true,
            })
            return { ...value, decos, compositionPreview: false }
          }
          let first = oldPlan.delimiterLine
          let last = oldPlan.delimiterLine
          for (const rowNo of oldPlan.rows.keys()) {
            first = Math.min(first, rowNo)
            last = Math.max(last, rowNo)
          }
          const gridPlans = new Map(value.gridPlans)
          gridPlans.delete(oldKey)
          const decos = value.decos.update({
            filterFrom: doc.line(first).from,
            filterTo: doc.line(last).to,
            filter: () => false,
            add: emitForRange(value.tree, doc, tr.state.selection, value.fm, first, last, gridPlans),
            sort: true,
          })
          return { ...value, decos, gridPlans, compositionPreview: false }
        }
      }
      if (value.compositionPreview && !tr.annotation(tableCompositionSettled)) return value
      // 纯选区移动：树不变，仅重建旧/新选区所在行的 mark 显形
      const doc = tr.state.doc
      let decos = value.decos
      let scanned = 0
      for (const span of selectionSpans(tr)) {
        const from = doc.line(span.fromLine).from
        const to = doc.line(span.toLine).to
        decos = decos.update({
          filterFrom: from,
          filterTo: to,
          filter: () => false,
          add: emitForRange(value.tree, doc, tr.state.selection, value.fm, span.fromLine, span.toLine, value.gridPlans),
          sort: true,
        })
        scanned += span.toLine - span.fromLine + 1
      }
      stats.totalUpdates += 1
      stats.lastUpdateScannedLines = scanned
      stats.totalScannedLines += scanned
      return { ...value, decos, compositionPreview: false }
    }

    const doc = tr.state.doc
    const changed: ChangedRange4[] = []
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      changed.push({ fromA, toA, fromB, toB })
    })
    const fragments = TreeFragment.applyChanges(value.fragments, changed)
    const tree = parseTree(doc, fragments)
    const fmTouched = changed.some((c) => c.fromA < FM_SCAN_LIMIT || c.fromB < FM_SCAN_LIMIT)
    const fm = fmTouched ? frontmatterOf(doc) : value.fm
    if (tr.annotation(tableCompositionPreview)) {
      // 候选文字由 CM6 原生 DOM 管理；只平移网格装饰，避免解析暂态列数
      // 导致整表闪退源码。结束后正常事务或 settled 选区事务重新计算。
      return {
        ...value,
        decos: value.decos.map(tr.changes),
        tree,
        fragments: TreeFragment.addTree(tree),
        fm,
        compositionPreview: true,
      }
    }
    const spans = planRebuildSpans(tr, value.tree, tree, changed, value.fm, fm)
    const gridPlans = new Map<number, TableGridPlan | null>()
    let decos = value.decos.map(tr.changes)
    let scanned = 0
    for (const span of spans) {
      const from = doc.line(span.fromLine).from
      const to = doc.line(span.toLine).to
      decos = decos.update({
        filterFrom: from,
        filterTo: to,
        filter: () => false,
        add: emitForRange(tree, doc, tr.state.selection, fm, span.fromLine, span.toLine, gridPlans),
        sort: true,
      })
      scanned += span.toLine - span.fromLine + 1
    }
    stats.totalUpdates += 1
    stats.lastUpdateScannedLines = scanned
    stats.totalScannedLines += scanned
    if (scanned >= doc.lines) {
      stats.fullBuildLines = doc.lines
    }
    return { decos, tree, fragments: TreeFragment.addTree(tree), fm, gridPlans, compositionPreview: false }
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => s.decos),
    // `<br>` 的四个源字符是一个可见换行。将其设为原子范围，退格时
    // 一次合行，方向键也不会钻进不可见的 <、b、r、> 中间。
    EditorView.atomicRanges.of((view) => {
      const breaks: Array<Range<Decoration>> = []
      for (const visible of view.visibleRanges) {
        view.state.field(f).decos.between(visible.from, visible.to, (from, to, deco) => {
          if (deco.spec.tableCellBreak) breaks.push(deco.range(from, to))
        })
      }
      return Decoration.set(breaks, true)
    }),
  ],
})

// ---- 间接装饰（视口内纯样式） ----

/**
 * 间接装饰构建（纯数据输入：doc/visibleRanges/selection/直接装饰集）：
 * 视口内标题行的强调与光标所在标题行的强调提示。标题行身份来自直接装饰集
 * （树驱动），围栏内伪标题天然不参与。
 */
export function buildViewportLiveDecorations(
  doc: Text,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  selection: EditorSelection,
  direct: DecorationSet,
): DecorationSet {
  const ranges: Array<Range<Decoration>> = []
  for (const range of visibleRanges) {
    direct.between(range.from, range.to, (from, _to, value) => {
      const cls = value.spec['class']
      if (typeof cls !== 'string' || !cls.includes(HEADING_CLASS_NAMES.line) || cls.includes(HEADING_CLASS_NAMES.inview)) {
        return
      }
      const lineNo = doc.lineAt(from).number
      const active = isLineActive(selection, doc, lineNo)
      ranges.push(
        (active ? inviewActiveDeco : inviewDeco).range(doc.line(lineNo).from),
      )
    })
  }
  return RangeSet.of(ranges, true)
}

const inviewDeco = Decoration.line({ class: HEADING_CLASS_NAMES.inview })
const inviewActiveDeco = Decoration.line({
  class: `${HEADING_CLASS_NAMES.inview} ${HEADING_CLASS_NAMES.active}`,
})

/** CSS grid 的留白可能让 CM6 默认点击命中隐藏管道，甚至把中格点击映射
 * 到右格；先按实际点击的格 DOM 约束源位置。mouseup 再核对一次，处理
 * 浏览器默认选区定位晚于 mousedown 的情况，空格也必须可点可编辑。 */
const gridPointerDown = new WeakMap<EditorView, { x: number; y: number }>()

/**
 * #57：把落在安全表格隐藏结构（管道 / 分隔行 / 格间空白）上的选区端点
 * 收缩到最近的可见内容边界；端点已在可见格内容或表外文本上时返回 null。
 * 方向口径（与 tableEditing 的 protectGridPointerSelection 一致，#57 评审
 * B-5 统一）：forward = 该端点是选区的文档序**右端**——收缩取 ≤pos 的
 * 最近边界（不吞入右前方格）；左端（forward=false）取 ≥pos 的最近边界。
 * 两端各自向选区内侧收缩，选区因此可以跨格、跨行与跨进表格，而删除
 * 防护由 tableEditing 的选区级规划承担。
 */
export function snapGridSelectionHead(state: EditorState, pos: number, forward: boolean): number | null {
  const field = state.field(liveDecorationsField, false)
  if (!field) return null
  const line = state.doc.lineAt(pos)
  const table = chainAt(field.tree, Math.min(line.from + 1, state.doc.length))
    .find((node) => node.name === 'Table')
  if (!table) return null
  // 网格行装饰存在即意味着 plan 已缓存（装饰发射与缓存同源）；未缓存视为
  // 非网格表，不干预（视口外调用理论不可达，posAtCoords 只产生可见位置）。
  const plan = field.gridPlans.get(table.from)
  if (!plan) return null
  const columns = plan.columns
  const isDelimiter = line.number === plan.delimiterLine
  const isContent = plan.rows.has(line.number)
  if (!isDelimiter && !isContent) return null
  const boundariesOf = (lineNo: number): number[] | null => {
    const target = state.doc.line(lineNo)
    const cells = tableRowCellsForColumns(target.text, target.from, columns)
    return cells ? cells.flatMap((cell) => [cell.contentFrom, cell.contentTo]) : null
  }
  if (isContent) {
    const cells = tableRowCellsForColumns(line.text, line.from, columns)
    if (!cells) return null
    // 格区间（含首尾空白/填充）归属该格：clamp 到内容区间
    for (const cell of cells) {
      if (pos >= cell.from && pos <= cell.to) {
        return cell.contentFrom === cell.contentTo && cell.from < cell.to
          ? cell.from
          : Math.max(cell.contentFrom, Math.min(cell.contentTo, pos))
      }
    }
    // 行首/行间/行尾管道：收缩到本行最近的可见内容边界
    const boundaries = cells.flatMap((cell) => [cell.contentFrom, cell.contentTo])
    if (forward) {
      const before = boundaries.filter((b) => b <= pos)
      if (before.length) return Math.max(...before)
    } else {
      const after = boundaries.filter((b) => b >= pos)
      if (after.length) return Math.min(...after)
    }
  }
  // 分隔行或行首管道之前：跨行取相邻内容行的末/首内容边界
  const numbers = [...plan.rows.keys()].sort((a, b) => a - b)
  if (forward) {
    for (let i = numbers.length - 1; i >= 0; i--) {
      if (numbers[i]! > line.number) continue
      const boundaries = boundariesOf(numbers[i]!)
      const before = boundaries?.filter((b) => b <= pos) ?? []
      if (before.length) return Math.max(...before)
    }
  } else {
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i]! < line.number) continue
      const boundaries = boundariesOf(numbers[i]!)
      const after = boundaries?.filter((b) => b >= pos) ?? []
      if (after.length) return Math.min(...after)
    }
  }
  return null
}

/** 鼠标拖选可跨格延伸（#57）；双击和三击仍只在起始格的内容区间内定位。 */
const gridCellMouseSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return null
  const target = event.target instanceof Element ? event.target : null
  const cell = target?.closest<HTMLElement>('.vsidian-table-grid-row > .vsidian-table-grid-cell')
  const row = cell?.parentElement
  if (!cell || !row) return null
  const cells = [...row.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')]
  const line = view.state.doc.lineAt(view.posAtDOM(row, 0))
  const range = tableRowCellsForColumns(line.text, line.from, cells.length)?.[cells.indexOf(cell)]
  if (!range) return null
  // 空格子的源码填充不属于用户内容。再次点击时落在填充前，避免把
  // 保留的输入节点变成下一次键入文字的前置空格。
  const empty = range.contentFrom === range.contentTo && range.from < range.to
  let from = empty ? range.from : range.contentFrom, to = empty ? range.from : range.contentTo
  // #57：落点在起始格内容上原样使用；越出起始格时收缩到最近的可见
  // 内容边界（隐藏管道 / 分隔行 / 格间空白不作选区端点），表外文本原样。
  const hit = (e: MouseEvent) => {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? from
    if (pos >= from && pos <= to) return pos
    return snapGridSelectionHead(view.state, pos, pos > from) ?? pos
  }
  const start = hit(event)
  const previousAnchor = view.state.selection.main.anchor
  // snap 方向口径（#57 评审 B-5）：forward = 端点是选区的文档序右端
  // （收缩取 ≤pos 的边界、向选区内侧收）；与 tableEditing 的
  // protectGridPointerSelection（anchor<head / head<anchor 判右端）一致。
  // shift+点击时锚点是相对新点击点 start 的另一端：锚点在右侧才传 true。
  let anchor = event.shiftKey
    ? (previousAnchor >= from && previousAnchor <= to ? previousAnchor
      : snapGridSelectionHead(view.state, previousAnchor, previousAnchor > start) ?? previousAnchor)
    : start
  const selection = (head: number) => anchor === head
    ? EditorSelection.create([EditorSelection.cursor(head, empty ? 1 : head === to ? -1 : head === from ? 1 : 0)])
    : EditorSelection.single(anchor, head)
  const word = event.detail === 2 ? view.state.wordAt(start) : null
  let startFrom = event.detail >= 3 ? from : word ? Math.max(from, Math.min(to, word.from)) : start
  let startTo = event.detail >= 3 ? to : word ? Math.max(from, Math.min(to, word.to)) : start
  gridPointerDown.set(view, { x: event.clientX, y: event.clientY })
  return {
    get(current, extend) {
      const end = hit(current)
      if (extend) return selection(end)
      if (event.detail >= 3) return EditorSelection.single(from, to)
      if (word) {
        // 双击的起始词对齐保留；拖动侧按落点收缩（wordAt 的词不跨隐藏管道）
        const currentWord = view.state.wordAt(end)
        return end < startFrom
          ? EditorSelection.single(startTo, currentWord?.from ?? end)
          : EditorSelection.single(startFrom, currentWord?.to ?? end)
      }
      return selection(end)
    },
    update(update) {
      if (!update.docChanged) return
      from = update.changes.mapPos(from, -1)
      to = update.changes.mapPos(to, 1)
      anchor = update.changes.mapPos(anchor)
      startFrom = update.changes.mapPos(startFrom)
      startTo = update.changes.mapPos(startTo)
    },
  }
})

function clampGridCellPointer(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  const target = event.target instanceof Element ? event.target : null
  const cell = target?.closest<HTMLElement>('.vsidian-table-grid-row > .vsidian-table-grid-cell')
  if (!cell) return false
  const down = gridPointerDown.get(view)
  gridPointerDown.delete(view)
  if (!down || event.detail > 1 ||
      Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return false
  const row = cell.parentElement
  if (!row) return false
  const column = [...row.querySelectorAll<HTMLElement>(':scope > .vsidian-table-grid-cell')].indexOf(cell)
  if (column < 0) return false
  const line = view.state.doc.lineAt(view.posAtDOM(row, 0))
  const range = tableRowCellsForColumns(line.text, line.from,
    row.querySelectorAll(':scope > .vsidian-table-grid-cell').length)?.[column]
  if (!range) return false
  const empty = range.contentFrom === range.contentTo && range.from < range.to
  const from = empty ? range.from : range.contentFrom
  const to = empty ? range.from : range.contentTo
  const hit = view.state.selection.main.head
  if (hit >= from && hit < to) return false
  const pos = hit < from ? from : to
  const assoc = empty ? 1 : pos === to ? -1 : 1
  if (hit === to && view.state.selection.main.assoc === assoc) return false
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(pos, assoc)]) })
  event.preventDefault()
  return true
}

/** 间接装饰 ViewPlugin：仅按 visibleRanges 更新，update 内不触发 DOM 测量 */
const viewportLivePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildViewportLiveDecorations(
        view.state.doc,
        view.visibleRanges,
        view.state.selection,
        view.state.field(liveDecorationsField).decos,
      )
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildViewportLiveDecorations(
          update.state.doc,
          update.view.visibleRanges,
          update.state.selection,
          update.state.field(liveDecorationsField).decos,
        )
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mouseup(event: MouseEvent, view: EditorView) {
        return clampGridCellPointer(event, view)
      },
    },
  },
)

/** Live Preview 装饰装配：直接（StateField）+ 间接（ViewPlugin） */
export const livePreviewDecorations: Extension = [liveDecorationsField, gridCellMouseSelection, viewportLivePlugin]
