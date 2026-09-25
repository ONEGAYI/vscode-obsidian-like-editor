// Live 视图代码块卡片装饰（工单 #79–#84，规格 docs/specs/code-block-card.md）。
//
// 架构（照 liveMermaid.ts 的双层模式）：
// - 围栏表复用 mermaidFencesField（单一扫描事实源，含全部围栏与 info
//   string，增量维护在 mermaid 侧）；本模块不另建扫描器
// - codeCardDecorations（StateField）：对围栏表全量重建（成本 = 围栏数
//   × 块行数发射，远低于全树扫描；CM6 约束：跨行 replace 必须来自
//   StateField）。装饰实例全部缓存（同类名/同标签复用），RangeSet.eq 成立
// - 呈现态（光标/选区不触及围栏区间）：两条围栏行内容清空（replace 覆盖
//   行文本、不含换行——行槽保留， Decoration.replace 无 widget 即零宽）；
//   块首行上方插头部横带（block widget，标签 + 按钮区）；全部块行（含
//   围栏行）挂卡片行类（首/尾行圆角修饰——顶边圆角由头部承担）
// - 编辑态（触及围栏区间，含边界折叠光标）：不发射围栏清空 replace，
//   源码显形可编辑；头部与卡片行类保留（规格「编辑态」表）
// - 排除：mermaid 围栏（#60 专属管线）、frontmatter 内围栏（源码降级
//   边界）、未闭合围栏（状态机不产出）；缩进代码块不是围栏，天然不参与
// - 设置经 codeCardConfigFacet（syncController 的 Compartment 热重配，
//   #79 仅 card 生效；lineNumbers/copyButton 见 #80/#81，highlight 见 #83）
import { Facet, RangeSet, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import type { EditorSelection } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { liveDecorationsField, selectionTouchesRange } from './liveDecorations'
import { mermaidFencesField } from './liveMermaid'
import type { FenceSpan } from '../shared/mermaid'
import { resolveCodeLanguage } from '../shared/codeLangs'

/** #79 代码块卡片稳定类名（Obsidian/Code Styler 对应见选择器映射表） */
export const CODE_CARD_CLASS_NAMES = {
  /** 卡片覆盖行（含被清空的围栏行与全部内容行） */
  line: 'vsidian-code-card-line',
  /** 首行圆角修饰（顶边圆角实际由头部横带承担） */
  edgeTop: 'vsidian-code-card-edge-top',
  /** 尾行圆角修饰（卡片底边圆角） */
  edgeBottom: 'vsidian-code-card-edge-bottom',
  /** 头部横带（block widget 外层；阅读侧容器同源类名） */
  header: 'vsidian-code-card-header',
  /** 语言标签（首字母大写显示名） */
  headerLabel: 'vsidian-code-card-header-label',
  /** 按钮区（#81 复制按钮、#82 折叠 chevron 挂载点） */
  headerActions: 'vsidian-code-card-header-actions',
  /** 卡内行号（#80：代码行行首 widget，每块从 1，围栏行不占号） */
  linenumber: 'vsidian-code-card-linenumber',
} as const

/** 卡片运行配置（设置驱动；#79 仅消费 card） */
export interface CodeCardConfig {
  /** 卡片总开关（codeblock.card）：关闭回到朴素围栏源码外观 */
  card: boolean
  /** 卡内行号（codeblock.lineNumbers，#80） */
  lineNumbers: boolean
  /** 复制按钮（codeblock.copyButton，#81） */
  copyButton: boolean
  /** 语法高亮（codeblock.highlight，#83；卡片关闭时朴素围栏仍可着色） */
  highlight: boolean
}

const DEFAULT_CONFIG: CodeCardConfig = { card: false, lineNumbers: true, copyButton: true, highlight: true }

/** 卡片配置通道（Compartment 内静态值；变更经 reconfigure 触发全量重建） */
export const codeCardConfigFacet = Facet.define<CodeCardConfig, CodeCardConfig>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : DEFAULT_CONFIG),
})

/**
 * 头部横带 widget：语言标签 + 右侧按钮区（按钮由 #81/#82 装配）。
 * ignoreEvent=false 交给 CM6 定位；按钮事件各自处理。
 */
export class CodeCardHeaderWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly languageId: string | null,
  ) {
    super()
  }

  eq(other: CodeCardHeaderWidget): boolean {
    return other.label === this.label && other.languageId === this.languageId
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = CODE_CARD_CLASS_NAMES.header
    div.setAttribute('data-vsidian-code-lang', this.languageId ?? '')
    const label = document.createElement('span')
    label.className = CODE_CARD_CLASS_NAMES.headerLabel
    label.textContent = this.label
    const actions = document.createElement('span')
    actions.className = CODE_CARD_CLASS_NAMES.headerActions
    div.append(label, actions)
    return div
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ---- 装饰实例缓存（增量与全量产出相同实例，RangeSet.eq 前提） ----

const fenceHideDeco = Decoration.replace({})

const cardLineDecos = new Map<string, ReturnType<typeof Decoration.line>>()
function cardLineDeco(cls: string): ReturnType<typeof Decoration.line> {
  let deco = cardLineDecos.get(cls)
  if (!deco) {
    deco = Decoration.line({ class: cls })
    cardLineDecos.set(cls, deco)
  }
  return deco
}

const headerDecos = new Map<string, ReturnType<typeof Decoration.widget>>()
function headerDeco(label: string, languageId: string | null): ReturnType<typeof Decoration.widget> {
  const key = `${label}\u0000${languageId ?? ''}`
  let deco = headerDecos.get(key)
  if (!deco) {
    deco = Decoration.widget({ widget: new CodeCardHeaderWidget(label, languageId), block: true, side: -1 })
    headerDecos.set(key, deco)
  }
  return deco
}

const linenumberDecos = new Map<string, ReturnType<typeof Decoration.widget>>()
function linenumberDeco(value: number, widthCh: number): ReturnType<typeof Decoration.widget> {
  const key = `${value}\u0000${widthCh}`
  let deco = linenumberDecos.get(key)
  if (!deco) {
    deco = Decoration.widget({ widget: new CodeCardLineNumberWidget(value, widthCh), side: -1 })
    linenumberDecos.set(key, deco)
  }
  return deco
}

/**
 * 卡内行号 widget（#80）：代码行行首的右对齐数字，每块从 1 起、围栏行不占号。
 * widthCh 为本块行号列宽（末行号位数与 2 取大，ch 单位随等宽字体对齐）；
 * 两态（呈现/编辑）一致保留。ignoreEvent=true 纯展示，点击穿透编辑器。
 */
export class CodeCardLineNumberWidget extends WidgetType {
  constructor(
    readonly value: number,
    readonly widthCh: number,
  ) {
    super()
  }

  eq(other: CodeCardLineNumberWidget): boolean {
    return other.value === this.value && other.widthCh === this.widthCh
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = CODE_CARD_CLASS_NAMES.linenumber
    span.textContent = String(this.value)
    span.style.width = `${this.widthCh}ch`
    span.setAttribute('aria-hidden', 'true')
    return span
  }

  ignoreEvent(): boolean {
    return true
  }
}

/**
 * 卡片装饰构建（#79/#80 契约入口；纯数据输入，可单测直驱、阅读侧对拍复用）：
 * 围栏表逐围栏发射——头部 block widget、卡片行类（首/尾圆角修饰）、
 * 呈现态围栏行内容清空、代码行行首行号 widget（config.lineNumbers，每块
 * 从 1、围栏行不占号、列宽随末行号位数对齐）。编辑态（触及围栏区间）
 * 不清空、行号保留，外壳保留。
 */
export function buildCodeCardDecorations(
  doc: Text,
  selection: EditorSelection,
  fm: { end: number } | null,
  fences: readonly FenceSpan[],
  config: Pick<CodeCardConfig, 'lineNumbers'> = { lineNumbers: true },
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  for (const fence of fences) {
    if (fence.mermaid) {
      continue
    }
    if (fm && fence.from < fm.end) {
      continue
    }
    const openLine = doc.lineAt(fence.from)
    const closeLine = doc.lineAt(Math.min(fence.to, doc.length))
    const lang = resolveCodeLanguage(fence.info)
    const trimmed = fence.info.trim()
    const label = lang?.displayName ?? (trimmed === '' ? 'Plain text' : trimmed)
    out.push(headerDeco(label, lang?.id ?? null).range(fence.from, fence.from))
    for (let n = openLine.number; n <= closeLine.number; n++) {
      const line = doc.line(n)
      const cls = [
        CODE_CARD_CLASS_NAMES.line,
        n === openLine.number ? CODE_CARD_CLASS_NAMES.edgeTop : '',
        n === closeLine.number ? CODE_CARD_CLASS_NAMES.edgeBottom : '',
      ]
        .filter(Boolean)
        .join(' ')
      out.push(cardLineDeco(cls).range(line.from, line.from))
    }
    if (config.lineNumbers && closeLine.number > openLine.number + 1) {
      const widthCh = Math.max(2, String(closeLine.number - openLine.number - 1).length)
      for (let n = openLine.number + 1; n < closeLine.number; n++) {
        out.push(linenumberDeco(n - openLine.number, widthCh).range(doc.line(n).from))
      }
    }
    if (!selectionTouchesRange(selection, fence.from, fence.to)) {
      out.push(fenceHideDeco.range(openLine.from, openLine.to))
      out.push(fenceHideDeco.range(closeLine.from, closeLine.to))
    }
  }
  return out
}

/** 卡片装饰 StateField：docChanged / 选区变化 / 配置变化时对围栏表全量重建 */
export const codeCardDecorations = StateField.define<DecorationSet>({
  create(state) {
    const decoField = state.field(liveDecorationsField, false)
    const fences = state.field(mermaidFencesField, false)
    if (!state.facet(codeCardConfigFacet).card || !decoField || !fences) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildCodeCardDecorations(state.doc, state.selection, decoField.fm, fences.spans, state.facet(codeCardConfigFacet)),
      true,
    )
  },
  update(value, tr) {
    if (!tr.state.facet(codeCardConfigFacet).card) {
      return RangeSet.empty
    }
    const configChanged = tr.startState.facet(codeCardConfigFacet) !== tr.state.facet(codeCardConfigFacet)
    if (!tr.docChanged && tr.selection === undefined && !configChanged) {
      return value
    }
    const decoField = tr.state.field(liveDecorationsField, false)
    const fences = tr.state.field(mermaidFencesField, false)
    if (!decoField || !fences) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildCodeCardDecorations(tr.state.doc, tr.state.selection, decoField.fm, fences.spans, tr.state.facet(codeCardConfigFacet)),
      true,
    )
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Live 代码块卡片扩展装配（随 codeCardConfigFacet 经 Compartment 装配） */
export const liveCodeCard: Extension = codeCardDecorations
