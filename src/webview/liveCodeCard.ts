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
import { Facet, RangeSet, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import type { EditorSelection } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { liveDecorationsField, selectionTouchesRange } from './liveDecorations'
import { mermaidFencesField } from './liveMermaid'
import type { FenceSpan } from '../shared/mermaid'
import { resolveCodeLanguage } from '../shared/codeLangs'
import { hasHighlightEngine, highlightCodeRanges, splitRangeAtLineBreaks } from './codeHighlight'

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
  /** 复制按钮（#81：悬停显现，点击复制代码体；编辑态不发射） */
  copy: 'vsidian-code-card-copy',
  /** 复制按钮 ✓ 反馈修饰（点击后约 1.2s） */
  copyDone: 'vsidian-code-card-copy-done',
  /** 复制按钮内的复制/对勾图标 span 修饰 */
  copyIconCopy: 'vsidian-code-card-copy-icon-copy',
  copyIconCheck: 'vsidian-code-card-copy-icon-check',
  /** 折叠 chevron（#82：点击收起/展开代码体；收起态转向） */
  fold: 'vsidian-code-card-fold',
  /** 折叠收起态修饰（chevron 转向；头部仍保留） */
  foldCollapsed: 'vsidian-code-card-fold-collapsed',
  /** 语言徽标（#83：头部标签左侧的彩色字形徽标，两视图共用） */
  headerIcon: 'vsidian-code-card-header-icon',
} as const

/**
 * 语言徽标（#83，Q8-B 共识）：注册表语言的彩色字形徽标——等宽缩写 +
 * 品牌近似色，随头部标签显示。v1 为字形徽标（typographic badge），
 * 非 Code Styler 的矢量 logo 集；升级为真实 logo 属后续工单（体积与
 * 素材来源另行决策）。键 = codeLangs 语言 id。
 */
const CODE_LANG_ICONS: Readonly<Record<string, { text: string; color: string }>> = {
  javascript: { text: 'JS', color: '#f0db4f' },
  typescript: { text: 'TS', color: '#3178c6' },
  json: { text: '{ }', color: '#a8b9cc' },
  html: { text: '<>', color: '#e34c26' },
  css: { text: 'CSS', color: '#563d7c' },
  python: { text: 'PY', color: '#3572a5' },
  shell: { text: 'SH', color: '#89e051' },
  powershell: { text: 'PS', color: '#012456' },
  c: { text: 'C', color: '#a8b9cc' },
  cpp: { text: 'C++', color: '#00599c' },
  java: { text: 'J', color: '#b07219' },
  go: { text: 'GO', color: '#00add8' },
  rust: { text: 'RS', color: '#dea584' },
  sql: { text: 'SQL', color: '#e38c00' },
  yaml: { text: 'YML', color: '#cb171e' },
  markdown: { text: 'MD', color: '#519aba' },
  verilog: { text: 'V', color: '#8a2be2' },
  text: { text: 'TXT', color: '#8a8a8a' },
}

/**
 * 复制请求 effect（#81）：按钮点击 → 零写回事务携带代码体原文，由
 * syncController 的 updateListener 转发 codeblock.copy 出站（宿主剪贴板）。
 * 不落文档、不产生撤销历史。
 */
export const codeCardCopyRequest = StateEffect.define<string>()

/**
 * 折叠切换 effect（#82）：chevron 点击 → 零写回事务携带围栏起始位置，
 * 由 codeCardFoldField 消费（视图态，不写源文件、不跨会话持久化）。
 */
export const codeCardFoldToggle = StateEffect.define<number>()

/**
 * 折叠状态（#82）：已收起围栏的起始位置集合。视图态——重开文档后全展开。
 * 值按围栏起始位置标识，docChanged 时随 ChangeSet 映射；映射后不匹配任何
 * 当前围栏起始位置的条目修剪掉（围栏删除后残留不至于误伤后来者）。
 */
export const codeCardFoldField = StateField.define<ReadonlySet<number>>({
  create: () => new Set<number>(),
  update(value, tr) {
    let next = value
    let changed = false
    for (const eff of tr.effects) {
      if (eff.is(codeCardFoldToggle)) {
        const toggled = new Set(next)
        if (!toggled.delete(eff.value)) {
          toggled.add(eff.value)
        }
        next = toggled
        changed = true
      }
    }
    if (tr.docChanged) {
      const mapped = new Set<number>()
      for (const pos of next) {
        mapped.add(tr.changes.mapPos(pos, 1))
      }
      next = mapped
      changed = true
    }
    if (!changed) {
      return value
    }
    // 修剪：不再是任何围栏起始位置的条目（围栏被删/改写后自愈）
    const fences = tr.state.field(mermaidFencesField, false)
    if (fences) {
      const starts = new Set(fences.spans.map((s) => s.from))
      const pruned = new Set<number>()
      for (const pos of next) {
        if (starts.has(pos)) {
          pruned.add(pos)
        }
      }
      next = pruned
    }
    return next
  },
})

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
 * 头部横带 widget：语言标签 + 右侧按钮区（复制按钮 #81；折叠 chevron #82）。
 * ignoreEvent=false 交给 CM6 定位；复制按钮自行拦截 mousedown 防 CM6 落选区
 * 进块（进入即切编辑态撤走按钮）。copy=false（编辑态或设置关闭）时不渲染
 * 按钮——eq 含 copy/code，状态切换时 CM6 重建 DOM。
 */
export class CodeCardHeaderWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly languageId: string | null,
    readonly copy: boolean,
    readonly code: string,
    readonly folded = false,
  ) {
    super()
  }

  eq(other: CodeCardHeaderWidget): boolean {
    return (
      other.label === this.label &&
      other.languageId === this.languageId &&
      other.copy === this.copy &&
      other.code === this.code &&
      other.folded === this.folded
    )
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div')
    div.className = CODE_CARD_CLASS_NAMES.header
    div.setAttribute('data-vsidian-code-lang', this.languageId ?? '')
    const label = document.createElement('span')
    label.className = CODE_CARD_CLASS_NAMES.headerLabel
    const icon = this.languageId ? CODE_LANG_ICONS[this.languageId] : undefined
    if (icon) {
      const badge = document.createElement('span')
      badge.className = CODE_CARD_CLASS_NAMES.headerIcon
      badge.textContent = icon.text
      badge.style.color = icon.color
      badge.setAttribute('aria-hidden', 'true')
      label.appendChild(badge)
    }
    label.appendChild(document.createTextNode(this.label))
    const actions = document.createElement('span')
    actions.className = CODE_CARD_CLASS_NAMES.headerActions
    actions.appendChild(buildFoldButton(this.folded))
    if (this.copy) {
      actions.appendChild(buildCopyButton(this.code))
    }
    div.append(label, actions)
    return div
  }

  ignoreEvent(): boolean {
    return false
  }
}

/** 折叠 chevron（#82）：两态常驻（收起态转向）；点击派发零写回折叠切换
 *  effect（携带围栏起始位置）。mousedown 阻断 CM6 落位（同复制按钮）。 */
function buildFoldButton(folded: boolean): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = folded
    ? `${CODE_CARD_CLASS_NAMES.fold} ${CODE_CARD_CLASS_NAMES.foldCollapsed}`
    : CODE_CARD_CLASS_NAMES.fold
  btn.setAttribute('aria-label', folded ? '展开代码块' : '折叠代码块')
  btn.setAttribute('aria-expanded', folded ? 'false' : 'true')
  btn.title = folded ? '展开代码块' : '折叠代码块'
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"></path></svg>'
  btn.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  btn.addEventListener('click', () => {
    const root = btn.closest(`.${CODE_CARD_CLASS_NAMES.header}`) as HTMLElement | null
    const view = root ? EditorView.findFromDOM(root) : EditorView.findFromDOM(btn)
    if (view) {
      // 块 widget 的 posAtDOM 即其挂点位置 = 围栏起始 offset
      const pos = view.posAtDOM(root ?? btn)
      view.dispatch({ effects: codeCardFoldToggle.of(pos) })
    }
  })
  return btn
}

/** 复制按钮 DOM（#81）：悬停显现由 CSS 承担；点击派发零写回 effect，
 *  ✓ 反馈本地切换（约 1.2s 后复原）。mousedown 阻断 CM6 的点击落位。 */
function buildCopyButton(code: string): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = CODE_CARD_CLASS_NAMES.copy
  btn.setAttribute('aria-label', '复制代码')
  btn.title = '复制代码'
  const copyIcon = document.createElement('span')
  copyIcon.className = CODE_CARD_CLASS_NAMES.copyIconCopy
  copyIcon.setAttribute('aria-hidden', 'true')
  copyIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">' +
    '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"></rect>' +
    '<path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7"></path></svg>'
  const checkIcon = document.createElement('span')
  checkIcon.className = CODE_CARD_CLASS_NAMES.copyIconCheck
  checkIcon.setAttribute('aria-hidden', 'true')
  checkIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">' +
    '<path d="M3.5 8.5l3 3 6-7"></path></svg>'
  btn.append(copyIcon, checkIcon)
  btn.addEventListener('mousedown', (event) => {
    // 头部是块 widget，落位点会进围栏区间（切编辑态撤走按钮）——阻断落位
    event.preventDefault()
  })
  btn.addEventListener('click', () => {
    // findFromDOM 只认携带 cmTile 的节点（本版本 CM6 的 Tile.get 语义）：
    // 按钮自身是头部 widget 的子孙、无标记，须从头部根节点查找
    const root = btn.closest(`.${CODE_CARD_CLASS_NAMES.header}`) as HTMLElement | null
    const view = root ? EditorView.findFromDOM(root) : EditorView.findFromDOM(btn)
    if (view) {
      view.dispatch({ effects: codeCardCopyRequest.of(code) })
    }
    btn.classList.add(CODE_CARD_CLASS_NAMES.copyDone)
    setTimeout(() => {
      btn.classList.remove(CODE_CARD_CLASS_NAMES.copyDone)
    }, 1200)
  })
  return btn
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
function headerDeco(
  label: string,
  languageId: string | null,
  copy: boolean,
  code: string,
  folded: boolean,
): ReturnType<typeof Decoration.widget> {
  const key = `${label}\u0000${languageId ?? ''}\u0000${copy ? 1 : 0}\u0000${code}\u0000${folded ? 1 : 0}`
  let deco = headerDecos.get(key)
  if (!deco) {
    deco = Decoration.widget({
      widget: new CodeCardHeaderWidget(label, languageId, copy, code, folded),
      block: true,
      side: -1,
    })
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

/** tok-* 高亮 mark 实例缓存（同类复用，RangeSet.eq 前提；#83） */
const tokenMarkDecos = new Map<string, ReturnType<typeof Decoration.mark>>()
function tokenMarkDeco(cls: string): ReturnType<typeof Decoration.mark> {
  let deco = tokenMarkDecos.get(cls)
  if (!deco) {
    deco = Decoration.mark({ class: cls })
    tokenMarkDecos.set(cls, deco)
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
/**
 * 卡片装饰构建（#79–#83 契约入口；纯数据输入，可单测直驱、阅读侧对拍复用）：
 * 语法高亮 mark（config.highlight，独立于卡片开关——朴素围栏仍可着色）；
 * 卡片形态（config.card）：头部 block widget、卡片行类（首/尾圆角修饰）、
 * 呈现态围栏行内容清空、卡内行号（每块从 1、围栏行不占号）；编辑态不清空、
 * 外壳保留；折叠块整块收起（行类/行号/高亮均不发射）。跨行 token 按换行
 * 切段（mark 装饰不跨行约束）。
 */
export function buildCodeCardDecorations(
  doc: Text,
  selection: EditorSelection,
  fm: { end: number } | null,
  fences: readonly FenceSpan[],
  config: Pick<CodeCardConfig, 'card' | 'lineNumbers' | 'copyButton' | 'highlight'> = {
    card: true,
    lineNumbers: true,
    copyButton: true,
    highlight: true,
  },
  folded: ReadonlySet<number> = new Set<number>(),
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
    const editing = selectionTouchesRange(selection, fence.from, fence.to)
    // 折叠收起（#82）：光标在块内时临时展开；收起态无复制按钮（规格）。
    // 折叠只在卡片开启时呈现（朴素围栏无头部可挂 chevron）
    const isFolded = config.card && folded.has(fence.from) && !editing
    // 语法高亮（#83）：卡片关闭时朴素围栏仍可着色；折叠块不可见跳过
    if (config.highlight && !isFolded && lang && hasHighlightEngine(lang.id)) {
      const contentStart = openLine.to + 1
      for (const token of highlightCodeRanges(lang.id, fence.code)) {
        for (const seg of splitRangeAtLineBreaks(fence.code, token.from, token.to)) {
          const from = contentStart + seg.from
          const to = contentStart + seg.to
          if (to > from && to <= closeLine.from) {
            out.push(tokenMarkDeco(token.cls).range(from, to))
          }
        }
      }
    }
    if (!config.card) {
      continue
    }
    const trimmed = fence.info.trim()
    const label = lang?.displayName ?? (trimmed === '' ? 'Plain text' : trimmed)
    const copy = config.copyButton && !editing && !isFolded
    out.push(headerDeco(label, lang?.id ?? null, copy, fence.code, isFolded).range(fence.from, fence.from))
    if (isFolded) {
      // 整块收起：replace 覆盖开围栏行行首到闭围栏行行尾含换行（行完全
      // 消失，仅留上方头部横带）；行类/行号/围栏清空装饰均不再发射
      out.push(fenceHideDeco.range(openLine.from, Math.min(closeLine.to + 1, doc.length)))
      continue
    }
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
    if (!editing) {
      out.push(fenceHideDeco.range(openLine.from, openLine.to))
      out.push(fenceHideDeco.range(closeLine.from, closeLine.to))
    }
  }
  return out
}

/** 卡片装饰 StateField：docChanged / 选区变化 / 配置或折叠状态变化时对围栏表全量重建 */
export const codeCardDecorations = StateField.define<DecorationSet>({
  create(state) {
    const decoField = state.field(liveDecorationsField, false)
    const fences = state.field(mermaidFencesField, false)
    const config = state.facet(codeCardConfigFacet)
    if ((!config.card && !config.highlight) || !decoField || !fences) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildCodeCardDecorations(
        state.doc, state.selection, decoField.fm, fences.spans,
        state.facet(codeCardConfigFacet), state.field(codeCardFoldField, false) ?? new Set<number>(),
      ),
      true,
    )
  },
  update(value, tr) {
    const nextConfig = tr.state.facet(codeCardConfigFacet)
    if (!nextConfig.card && !nextConfig.highlight) {
      return RangeSet.empty
    }
    const configChanged = tr.startState.facet(codeCardConfigFacet) !== tr.state.facet(codeCardConfigFacet)
    const foldChanged = tr.startState.field(codeCardFoldField, false) !== tr.state.field(codeCardFoldField, false)
    if (!tr.docChanged && tr.selection === undefined && !configChanged && !foldChanged) {
      return value
    }
    const decoField = tr.state.field(liveDecorationsField, false)
    const fences = tr.state.field(mermaidFencesField, false)
    if (!decoField || !fences) {
      return RangeSet.empty
    }
    return RangeSet.of(
      buildCodeCardDecorations(
        tr.state.doc, tr.state.selection, decoField.fm, fences.spans,
        tr.state.facet(codeCardConfigFacet), tr.state.field(codeCardFoldField, false) ?? new Set<number>(),
      ),
      true,
    )
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** Live 代码块卡片扩展装配（随 codeCardConfigFacet 经 Compartment 装配） */
export const liveCodeCard: Extension = codeCardDecorations
