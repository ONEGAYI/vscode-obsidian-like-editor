// 大纲模块（#54）：右侧栏「大纲」面板的数据与 DOM；#65 起条目携带行内
// 样式透传结构（白名单标记区间 + 剥标记可见文本）。
//
// 数据源单一职责：extractOutline 以 CM6 全文文本（webview LF 坐标，含未
// 保存编辑）为唯一依据，经 markdownTreeParser（与 liveDecorations 同一
// 解析器、同一 frontmatter 判定）产出标题序列——与视口渲染无关、与
// live/reading 模式无关（CM6 doc 在两模式下都是权威文本模型）。解析树
// 可由调用方传入（syncController 复用 liveDecorationsField 的增量树，
// 免去大文档的全量 parse；树与文档须来自同一 state）。
//
// 条目携带标题区权威范围（headingSpan = 语法树 heading 节点范围，第 3 轮
// 复核）：重命名/调级/拖拽搬移替换的字节区间以它为准，几何启发式
// （outlineSection）只作手写/陈旧条目的兜底。
//
// #65 行内透传的形态学：白名单节点（StrongEmphasis/Emphasis/InlineCode/
// Strikethrough，节点名判定与 liveDecorations 的 pushInnerSpan 同源）压
// 栈记类型、内容区间剥两端标记；双链 [[…]] 不在树中（外层括号是普通文
// 本、内层被误判为快捷引用链接），按 live 同款行扫描形态学
// （shared/wikilink 单一事实源）替换为显示文字且不解析内部标记；行内
// 链接/图片只显示标题文字（URL 不透出，不可点），引用式链接（含
// LinkLabel）与 live 一致按原文呈现；行内代码内不做双链替换（live 双链
// 装饰同边界）。标记区间（spans）落在剥标记可见文本（plainText）坐标
// 上，供渲染与搜索/无障碍口径复用；text 保留原文（重命名等编辑场景）。
//
// 本期（#66 起）：条目可点击跳转与常驻高亮（交互装配在 syncController，
// 经面板容器的事件委托——条目 DOM 重建不丢监听）；#67 起折叠滑块（六档
// 圆点串珠）与手动折叠箭头在此装配 DOM，折叠状态机纯函数见
// outlineCollapse.ts（搜索不在本期范围）。
import type { Text } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import type { OutlineSpanInfo, OutlineSpanKind } from '../shared/protocol'
import type { OutlineSearchRange } from './outlineSearch'
import { parseWikilinkInner, scanWikilinksInLine } from '../shared/wikilink'
import {
  docInput,
  FM_SCAN_LIMIT,
  frontmatterRange,
  headingLevelOf,
  markdownTreeParser,
  visitRange,
} from './markdownDoc'

/** 大纲条目（全文标题序列的一项） */
export interface OutlineItem {
  /** 标题级别（ATX 1–6 / Setext 1–2） */
  level: number
  /** 标题原文（ATX 去标记与关闭序列；Setext 多行内容以空格连接；行内
   *  标记字符保留——重命名等编辑场景的资产不丢失） */
  text: string
  /** 剥标记可见文本：白名单标记字符、链接 URL、双链括号均不进入
   *  （搜索与无障碍口径；#68 搜索按此匹配） */
  plainText: string
  /** 行内标记区间（plainText 内偏移；白名单 strong/emphasis/code/strike，
   *  可嵌套——嵌套时同区间多类型） */
  spans: OutlineSpanInfo[]
  /** 标题起始行（1 基；Setext 为内容首行） */
  line: number
  /** 标题区权威范围（doc 偏移 [from, to)，第 3 轮复核）：语法树 heading 节点
   *  的范围——from = 标题内容起点（容器标记与缩进之后），to = 标题块末行行尾
   *  （ATX = 该行行尾，不含块尾换行；Setext = 下划线所在行行尾）。写操作
   *  （重命名/调级/拖拽搬移）优先按此范围替换，几何启发式只作兜底
   *  （见 outlineSection）；手写/合成条目可缺省（缺省即走兜底） */
  headingSpan?: { from: number; to: number }
}

/** 大纲面板的稳定类名（样式与断言的公共锚点） */
export const OUTLINE_CLASS_NAMES = {
  panel: 'vsidian-outline-panel',
  item: 'vsidian-outline-item',
  empty: 'vsidian-outline-empty',
  /** 级别类名（level-1..6）：CSS 缩进与集成断言的锚点 */
  level: (n: number) => `vsidian-outline-level-${n}`,
  /** #65 行内标记 span 类名（语义元素 strong/em/code/del 上的第二入口；
   *  Obsidian 无对应选择器，本项目自有命名空间，见选择器映射表） */
  span: {
    strong: 'vsidian-outline-strong',
    emphasis: 'vsidian-outline-emphasis',
    code: 'vsidian-outline-code',
    strike: 'vsidian-outline-strike',
  } as const,
  /** #66 当前控制域条目的常驻高亮类（半透明横条的唯一差异来源） */
  located: 'vsidian-outline-located',
  /** #67 折叠滑块行（侧栏顶栏与条目面板之间；显隐跟随 outline-active 类） */
  slider: 'vsidian-outline-slider',
  /** 滑块圆点按钮（六档：No-Expand、H1–H5；结绳串珠意象） */
  sliderDot: 'vsidian-outline-slider-dot',
  /** 当前档圆点（实心高亮）：两态差异唯一来源的类切换 */
  sliderActive: 'vsidian-outline-slider-active',
  /** #67 折叠箭头按钮（有子项条目专属；点击折叠/展开，点文字跳转） */
  chevron: 'vsidian-outline-chevron',
  /** 无子项条目的箭头占位（与 chevron 同宽，文字左缘对齐） */
  chevronSpacer: 'vsidian-outline-chevron-spacer',
  /** #67 折叠遮蔽的条目（display:none；类切换是唯一显隐开关） */
  hidden: 'vsidian-outline-hidden',
  /** #67 折叠中的父节点条目（箭头旋转的差异来源） */
  collapsed: 'vsidian-outline-collapsed',
  /** #68 工具条行（侧栏顶栏与滑块行之间；显隐跟随 outline-active 类） */
  toolbar: 'vsidian-outline-toolbar',
  /** #68 跳转到笔记末尾按钮 */
  jumpBottom: 'vsidian-outline-jump-bottom',
  /** #68 重置按钮（清搜索 + 档位回默认 + 清手动折叠） */
  reset: 'vsidian-outline-reset',
  /** #68 标题搜索输入框 */
  search: 'vsidian-outline-search',
  /** #68 命中片段 mark（只包命中子串；文本层切分，与语义元素正交） */
  searchHit: 'vsidian-outline-search-hit',
  /** #68 无匹配占位（有词条但零命中） */
  nomatch: 'vsidian-outline-nomatch',
  /** #70 拖拽中的源条目（源位置提示：拖动后原条目弱化） */
  dragging: 'vsidian-outline-dragging',
  /** #70 落点指示三态：目标上缘插入线（before 落点） */
  dropBefore: 'vsidian-outline-drop-before',
  /** #70 落点指示三态：目标下缘插入线（after 落点） */
  dropAfter: 'vsidian-outline-drop-after',
  /** #70 落点指示三态：目标包裹高亮（inside 落点 = 成为子标题） */
  dropInside: 'vsidian-outline-drop-inside',
} as const

/** 大纲面板可访问名称（按钮 aria-label 与面板 aria-label 共用文案） */
export const OUTLINE_LABEL = '大纲'

/** #68 搜索框占位文案（QO「Input to search」的中文口径） */
export const OUTLINE_SEARCH_PLACEHOLDER = '输入以搜索'

/** 白名单节点名 → 标记类型（判定与 liveDecorations 的行内 span 同源；
 *  高亮/公式 GFM 解析器不产节点，正文支持后在此接入） */
const SPAN_KIND_BY_NODE: Record<string, OutlineSpanKind> = {
  StrongEmphasis: 'strong',
  Emphasis: 'emphasis',
  InlineCode: 'code',
  Strikethrough: 'strike',
}

/** 双链替换出现（doc 坐标；display = 别名 ?? 路径(#标题)） */
interface WikilinkSubst {
  from: number
  to: number
  display: string
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

/** 跳过 pos 起的连续空格/制表符（ATX 标记后的分隔空格） */
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

/** ATX 可选关闭序列剥离（CommonMark：关闭序列前须有空白，`foo#` 不剥） */
function stripAtxClosing(raw: string): string {
  return raw.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '')
}

/**
 * 剥标记可见文本的增量构建器：按 doc 顺序入列文本段（每段携带打开中的
 * 标记栈，外→内），双链替换只发生一次（wikiIdx 单调推进）且替换文本不
 * 带标记（栈为空入列——与 live 整体替换 widget 的呈现一致）。换行归一
 * 为空格（1:1 保长，与 text 字段的 Setext 归一同口径）。
 */
class PlainTextCollector {
  private readonly segments: Array<{ text: string; kinds: readonly OutlineSpanKind[] }> = []
  private plain = ''
  private wikiIdx = 0
  /** 已替换双链的结束位置（单调；跳过被替换区间内的原文） */
  private consumedTo = 0

  constructor(
    private readonly doc: Text,
    private readonly wikis: readonly WikilinkSubst[],
  ) {}

  get plainText(): string {
    return this.plain
  }

  /** [from,to) 原文入列；subst 时先做双链替换（行内代码内 subst=false）。
   *  替换文字以无标记段入列（外层标记栈不延续——与 live 整体替换 widget
   *  一致：字面部分与替换部分各自成段，span 自然裁剪） */
  pushRange(from: number, to: number, kinds: readonly OutlineSpanKind[], subst: boolean): void {
    if (from >= to) {
      return
    }
    let pos = from
    if (subst && this.wikis.length > 0) {
      // 越过已替换区间（跳过的节点留下的区间起点可能落在已消费双链内）
      while (this.wikiIdx < this.wikis.length && this.wikis[this.wikiIdx]!.to <= pos) {
        this.wikiIdx += 1
      }
      if (pos < this.consumedTo) {
        pos = Math.min(to, this.consumedTo)
      }
      while (this.wikiIdx < this.wikis.length) {
        const w = this.wikis[this.wikiIdx]!
        if (w.from >= to) {
          break
        }
        if (w.from > pos) {
          this.pushSegment(this.normalized(pos, w.from), kinds)
        }
        this.pushSegment(w.display.replace(/\n/g, ' '), [])
        pos = Math.max(pos, w.to)
        this.consumedTo = Math.max(this.consumedTo, w.to)
        this.wikiIdx += 1
      }
    }
    if (pos < to) {
      this.pushSegment(this.normalized(pos, to), kinds)
    }
  }

  private normalized(from: number, to: number): string {
    return this.doc.sliceString(from, to).replace(/\n/g, ' ')
  }

  private pushSegment(text: string, kinds: readonly OutlineSpanKind[]): void {
    if (text === '') {
      return
    }
    this.segments.push({ text, kinds })
    this.plain += text
  }

  /** 汇出标记区间（段级展开；嵌套段产同区间多类型，按栈序外→内） */
  spans(): OutlineSpanInfo[] {
    const out: OutlineSpanInfo[] = []
    let at = 0
    for (const seg of this.segments) {
      const end = at + seg.text.length
      const seen = new Set<OutlineSpanKind>()
      for (const kind of seg.kinds) {
        if (!seen.has(kind)) {
          seen.add(kind)
          out.push({ kind, start: at, end })
        }
      }
      at = end
    }
    return out
  }

  /** 区间完整落在某双链替换内（该区间内的树节点不单独贡献文本） */
  insideWikilink(from: number, to: number): boolean {
    return this.wikis.some((w) => w.from <= from && to <= w.to)
  }
}

/** 白名单/链接节点的标记名集合（内容区间 = 首、末标记之间） */
const MARK_NAMES = /^(EmphasisMark|CodeMark|StrikethroughMark)$/

/** 白名单节点（或 Link/Image）首末标记之间的内容区间，clamp 到 [from,to] */
function markedContentRange(node: SyntaxNode, from: number, to: number): { from: number; to: number } {
  let first: SyntaxNode | null = null
  let last: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (MARK_NAMES.test(c.name)) {
      if (!first) {
        first = c
      }
      last = c
    }
  }
  const cFrom = Math.max(from, first ? first.to : from)
  const cTo = Math.min(to, last ? last.from : to)
  return cFrom < cTo ? { from: cFrom, to: cTo } : { from: cFrom, to: cFrom }
}

/** 行内链接/图片的标题文字区间：首个 LinkMark 之后到第二个 LinkMark 之前
 *  （图片首标记为 `![`；标题可为无子节点的 gap——由区间遍历补齐）。
 *  引用式链接（含 LinkLabel 子节点）返回 null（按原文呈现，与 live 一致） */
function linkTitleRange(node: SyntaxNode): { from: number; to: number } | null {
  let first: SyntaxNode | null = null
  let second: SyntaxNode | null = null
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'LinkLabel') {
      return null
    }
    if (c.name === 'LinkMark' && !first) {
      first = c
    } else if (c.name === 'LinkMark' && !second) {
      second = c
    }
  }
  if (!first || !second || second.from < first.to) {
    return null
  }
  return { from: first.to, to: second.from }
}

/**
 * 标题内容区间的行内结构遍历（gap 感知：lezer 树不为纯文本建叶节点，
 * 子节点之间的空隙按原文入列），结果写入 collector。kinds 为打开中的
 * 标记栈（外→内）；subst=false 时不做双链替换（行内代码内）。
 */
function collectInline(
  doc: Text,
  node: SyntaxNode,
  from: number,
  to: number,
  collector: PlainTextCollector,
  kinds: readonly OutlineSpanKind[],
  subst: boolean,
): void {
  let pos = from
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= from || child.from >= to) {
      continue
    }
    const lo = Math.max(child.from, from)
    const hi = Math.min(child.to, to)
    if (lo >= hi) {
      continue
    }
    if (lo > pos) {
      collector.pushRange(pos, lo, kinds, subst)
    }
    collectInlineNode(doc, child, lo, hi, collector, kinds)
    pos = hi
    if (pos >= to) {
      return
    }
  }
  if (pos < to) {
    collector.pushRange(pos, to, kinds, subst)
  }
}

/** 单个子节点的透传处理（collectInline 的分派层） */
function collectInlineNode(
  doc: Text,
  node: SyntaxNode,
  from: number,
  to: number,
  collector: PlainTextCollector,
  kinds: readonly OutlineSpanKind[],
): void {
  // 完整落在双链替换内的节点（如 [[…]] 内层被误判的快捷引用 Link）不
  // 单独贡献文本——替换文字已由区间统一入列
  if (collector.insideWikilink(node.from, node.to)) {
    return
  }
  const spanKind = SPAN_KIND_BY_NODE[node.name]
  if (spanKind) {
    const content = markedContentRange(node, from, to)
    // 行内代码内容是字面文本：不做双链替换（live 装饰同边界）
    collectInline(doc, node, content.from, content.to, collector, [...kinds, spanKind], node.name !== 'InlineCode')
    return
  }
  if (node.name === 'Link' || node.name === 'Image') {
    // 标题文字纯文本降级：URL/标题部分不透出，不可点；文字内的嵌套标记
    // 仍解析（live 视图对链接文字内的行内 span 照常装饰，两侧一致）
    const title = linkTitleRange(node)
    if (title) {
      collectInline(doc, node, title.from, title.to, collector, kinds, true)
      return
    }
    collectInline(doc, node, from, to, collector, kinds, true)
    return
  }
  if (node.firstChild) {
    collectInline(doc, node, from, to, collector, kinds, true)
    return
  }
  // 叶子（Text/Escape/URL/LinkMark 等）：原样入列（未白名单的语法按
  // 源码呈现，与 live 的局部降级语义一致）
  collector.pushRange(from, to, kinds, true)
}

/** 标题内容区间的双链出现预扫描（live 同款形态学；只取内容区间内的） */
function scanHeadingWikilinks(doc: Text, from: number, to: number): WikilinkSubst[] {
  const out: WikilinkSubst[] = []
  let pos = from
  while (pos < to) {
    const line = doc.lineAt(pos)
    const lineText = doc.sliceString(line.from, Math.min(line.to, to))
    for (const occ of scanWikilinksInLine(lineText, line.from)) {
      if (occ.from >= from && occ.to <= to) {
        // scanWikilinksInLine 已保证 parseWikilinkInner 非空（形态学单一事实源）
        out.push({ from: occ.from, to: occ.to, display: parseWikilinkInner(occ.inner)!.display })
      }
    }
    pos = line.to + 1
  }
  return out
}

/**
 * 全文大纲提取：标题序列（级别 + 原文 + 剥标记可见文本 + 标记区间 + 起始
 * 行）。frontmatter 头块内的伪标题排除（判定与 live 装饰/阅读切块同源，
 * 两视图语义一致）；代码围栏内不产生标题节点，天然排除。跨级与同名标题
 * 逐项保留。
 *
 * tree 为可选的外部解析树（须与 doc 同一 state）：传入时直接取用（增量
 * 解析复用入口，syncController 传 liveDecorationsField 维护的增量树），
 * 省略时内部全量解析。增量树与全量解析的语义等价由对照单测钉住。
 */
export function extractOutline(doc: Text, tree?: Tree): OutlineItem[] {
  const items: OutlineItem[] = []
  const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, FM_SCAN_LIMIT)))
  const parsed: Tree = tree ?? markdownTreeParser.parse(docInput(doc))
  const from = fm ? fm.end : 0
  visitRange(parsed, from, doc.length, (node) => {
    if (fm && node.from < fm.end) {
      return // frontmatter 区域内的节点不产条目（头块按源码呈现）
    }
    const level = headingLevelOf(node.name)
    if (level === null) {
      return
    }
    const mark = childNamed(node, 'HeaderMark')
    let text: string
    let contentFrom: number
    let contentEnd: number
    let headingTo: number
    if (mark && mark.from === node.from) {
      // ATX：# 标记在头部，文字 = 标记后空格到行尾（clamp 去块尾换行）
      const lineEnd = doc.lineAt(node.from).to
      const rawFrom = skipSpaces(doc, mark.to)
      const raw = doc.sliceString(rawFrom, Math.min(node.to, lineEnd))
      text = stripAtxClosing(raw)
      contentFrom = rawFrom
      contentEnd = rawFrom + text.length // 关闭序列只剥尾，text 是 raw 前缀
      headingTo = lineEnd // 标题区 = 标题行行尾（含关闭序列，不含块尾换行）
    } else {
      // Setext：内容 = 下划线标记之前的行（可多行，空格连接）
      const underlineLine = mark ? doc.lineAt(mark.from).number : doc.lineAt(node.to).number
      const contentTo = mark
        ? doc.line(Math.max(1, underlineLine - 1)).to
        : node.to
      const raw = doc.sliceString(node.from, contentTo).replace(/\n/g, ' ')
      text = raw.trim()
      // trim 只去两端空白且 \n→' ' 保长：前导偏移可映射回 doc 坐标
      const lead = raw.length - raw.trimStart().length
      contentFrom = node.from + lead
      contentEnd = contentFrom + text.length
      // 标题区 = 内容行 + 下划线行（到该行行尾；无 HeaderMark 的防御分支
      // 退化为内容结束位置所在行行尾）
      headingTo = mark ? doc.line(underlineLine).to : doc.lineAt(Math.max(0, node.to)).to
    }
    const collector = new PlainTextCollector(doc, scanHeadingWikilinks(doc, contentFrom, contentEnd))
    collectInline(doc, node, contentFrom, contentEnd, collector, [], true)
    items.push({
      level,
      text,
      plainText: collector.plainText,
      spans: collector.spans(),
      line: doc.lineAt(node.from).number,
      headingSpan: { from: node.from, to: headingTo },
    })
  })
  return items
}

/** 级别 + 原文 + 可见文本 + 标记结构序列相等（DOM 重建判据）：行号偏移
 *  不改变用户可见大纲；标记结构变化（含 plainText 相同而 span 不同）重建 */
export function outlineItemsEqual(a: readonly OutlineItem[], b: readonly OutlineItem[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x.level !== y.level || x.text !== y.text || x.plainText !== y.plainText) {
      return false
    }
    if (x.spans.length !== y.spans.length) {
      return false
    }
    for (let k = 0; k < x.spans.length; k++) {
      const p = x.spans[k]!
      const q = y.spans[k]!
      if (p.kind !== q.kind || p.start !== q.start || p.end !== q.end) {
        return false
      }
    }
  }
  return true
}

/** #65 标记类型 → 语义元素与稳定类名（双入口：语义标签 + 类名锚点） */
const OUTLINE_SPAN_ELEMENTS: Record<OutlineSpanKind, { tag: string; cls: string }> = {
  strong: { tag: 'strong', cls: OUTLINE_CLASS_NAMES.span.strong },
  emphasis: { tag: 'em', cls: OUTLINE_CLASS_NAMES.span.emphasis },
  code: { tag: 'code', cls: OUTLINE_CLASS_NAMES.span.code },
  strike: { tag: 'del', cls: OUTLINE_CLASS_NAMES.span.strike },
}

/**
 * 重建面板条目（数据变化时全量替换：条目是无状态纯展示节点，重建成本
 * 与标题数线性且仅在序列变化时发生；正文编辑不触发）。无标题时渲染
 * 空态占位（保持面板有可读内容与高度语义）。#65 起条目内容按标记结构
 * 构建（语义元素 + 稳定类名；双链/链接为纯文本，无 a 元素不可点）。
 * #67 起 hasChildren 标记父节点条目：前置折叠箭头按钮（点击目标与文字
 * 区分：箭头折叠/展开、文字跳转）；无子项条目渲染同宽占位保持文字对齐。
 * #68 起 hits（与 items 同序的命中区间）在文本层切分出命中子串包 mark
 * （片段级高亮与语义元素正交：mark 只落在文本节点内，不包裹语义元素
 * 外层）；缺省为无高亮。hidden/collapsed/located 等状态类不在此施加
 * （控制器随折叠状态机维护）。
 */
export function renderOutlineItems(
  panel: HTMLElement,
  items: readonly OutlineItem[],
  hasChildren?: readonly boolean[],
  hits?: readonly (readonly OutlineSearchRange[])[],
): void {
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = OUTLINE_CLASS_NAMES.empty
    empty.textContent = '无标题'
    panel.replaceChildren(empty)
    return
  }
  const nodes: HTMLElement[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const el = document.createElement('div')
    el.className = `${OUTLINE_CLASS_NAMES.item} ${OUTLINE_CLASS_NAMES.level(item.level)}`
    el.dataset['vsidianLevel'] = String(item.level)
    if (hasChildren?.[i]) {
      const chevron = document.createElement('button')
      chevron.type = 'button'
      chevron.className = OUTLINE_CLASS_NAMES.chevron
      chevron.setAttribute('aria-label', '折叠或展开')
      chevron.setAttribute('aria-expanded', 'true')
      chevron.appendChild(createOutlineChevronIcon())
      el.appendChild(chevron)
    } else {
      const spacer = document.createElement('span')
      spacer.className = OUTLINE_CLASS_NAMES.chevronSpacer
      spacer.setAttribute('aria-hidden', 'true')
      el.appendChild(spacer)
    }
    appendOutlineContent(el, item, hits?.[i])
    nodes.push(el)
  }
  panel.replaceChildren(...nodes)
}

/** 条目内容：plainText 文本段 + 嵌套标记区间 → 嵌套语义元素；
 *  #68 命中区间在文本层切分包 mark */
function appendOutlineContent(
  el: HTMLElement,
  item: OutlineItem,
  hits?: readonly OutlineSearchRange[],
): void {
  // 树遍历产出的区间恒为层叠（嵌套或相离）；排序后外层在前
  const spans = [...item.spans].sort((a, b) => a.start - b.start || b.end - a.end)
  appendSpanRange(el, 0, item.plainText.length, spans, item.plainText, hits)
}

/** [from,to) 文本段 + 直接子 span（spans 为层叠序）追加到 host */
function appendSpanRange(
  host: HTMLElement,
  from: number,
  to: number,
  spans: readonly OutlineSpanInfo[],
  plainText: string,
  hits?: readonly OutlineSearchRange[],
): void {
  let pos = from
  let i = 0
  while (i < spans.length && pos < to) {
    const s = spans[i]!
    if (s.end <= pos || s.start < pos) {
      i += 1 // 已越过（或异常非层叠输入）：跳过防死循环
      continue
    }
    if (s.start >= to) {
      break
    }
    if (s.start > pos) {
      appendTextWithHits(host, plainText, pos, s.start, hits)
    }
    // 直接子 span：被 s 完全包含的连续前缀（排序保证同起点外层在前）
    const children: OutlineSpanInfo[] = []
    let j = i + 1
    while (j < spans.length && spans[j]!.start < s.end) {
      if (spans[j]!.end <= s.end) {
        children.push(spans[j]!)
        j += 1
      } else {
        break
      }
    }
    const def = OUTLINE_SPAN_ELEMENTS[s.kind]
    const child = document.createElement(def.tag)
    child.className = def.cls
    appendSpanRange(child, s.start, s.end, children, plainText, hits)
    host.appendChild(child)
    pos = s.end
    i = j
  }
  if (pos < to) {
    appendTextWithHits(host, plainText, pos, to, hits)
  }
}

/** 纯文本段 [from,to) 追加到 host；#68 搜索命中区间（全局 plainText
 *  坐标，有序不重叠）与段相交处包 mark——命中子串跨语义 span 边界时在
 *  各文本节点内各自切分（两段 mark 视觉连续，语义结构不被拆改） */
function appendTextWithHits(
  host: HTMLElement,
  plainText: string,
  from: number,
  to: number,
  hits?: readonly OutlineSearchRange[],
): void {
  if (!hits || hits.length === 0) {
    host.appendChild(document.createTextNode(plainText.slice(from, to)))
    return
  }
  let pos = from
  for (const h of hits) {
    if (h.end <= pos || h.start >= to) {
      continue
    }
    const s = Math.max(h.start, pos)
    const e = Math.min(h.end, to)
    if (s > pos) {
      host.appendChild(document.createTextNode(plainText.slice(pos, s)))
    }
    const mark = document.createElement('mark')
    mark.className = OUTLINE_CLASS_NAMES.searchHit
    mark.textContent = plainText.slice(s, e)
    host.appendChild(mark)
    pos = e
  }
  if (pos < to) {
    host.appendChild(document.createTextNode(plainText.slice(pos, to)))
  }
}

/**
 * 大纲 DOM（侧栏顶栏按钮 + 面板容器）。显隐唯一开关是侧栏容器的
 * vsidian-outline-active 类（CSS 控制），DOM 上不内联样式。条目内容经
 * renderOutlineItems 维护（初始为空，首场 ensureFresh 后填充）。
 */
export function buildOutlineDom(): { toggle: HTMLButtonElement; panel: HTMLElement } {
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'vsidian-outline-toggle'
  toggle.setAttribute('aria-label', OUTLINE_LABEL)
  toggle.setAttribute('title', OUTLINE_LABEL)
  toggle.setAttribute('aria-controls', 'vsidian-outline-panel')
  toggle.setAttribute('aria-expanded', 'true')
  toggle.appendChild(createOutlineListIcon())
  const panel = document.createElement('div')
  panel.className = OUTLINE_CLASS_NAMES.panel
  panel.id = 'vsidian-outline-panel'
  panel.setAttribute('role', 'region')
  panel.setAttribute('aria-label', OUTLINE_LABEL)
  return { toggle, panel }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** #67 折叠箭头图标（chevron-down 意象，展开态朝下；折叠态由条目的
 *  collapsed 类旋转 -90° 朝右——线宽不写在 SVG 属性上，样式失效时由
 *  CSS 契约与集成绘制断言暴露，与侧栏图标同口径） */
function createOutlineChevronIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M4 6 L8 10 L12 6')
  svg.appendChild(path)
  return svg
}

/** 滑块行装配结果（dots 与档位一一对应：下标即档位 0–5） */
export interface OutlineSliderDom {
  row: HTMLElement
  dots: HTMLButtonElement[]
}

/**
 * #67 折叠滑块行（结绳记事：六个圆点 + 横线串联）。可访问口径采用
 * role=group + 六按钮组（每个圆点是独立按钮，Tab 逐个可达、Enter/空格
 * 原生激活；当前档以 aria-pressed + active 类双重表达——类是视觉差异
 * 唯一来源，契约测试钉住）。点击选档由按钮 click 天然承载；拖拽由
 * 调用方在 row 上挂 pointer 事件（outlineSliderLevelAt 换算最近档）。
 */
export function buildOutlineSlider(
  level: number,
  labelOf: (level: number) => string,
): OutlineSliderDom {
  const row = document.createElement('div')
  row.className = OUTLINE_CLASS_NAMES.slider
  row.setAttribute('role', 'group')
  row.setAttribute('aria-label', '大纲展开层级')
  const dots: HTMLButtonElement[] = []
  for (let n = 0; n <= 5; n++) {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = OUTLINE_CLASS_NAMES.sliderDot
    dot.dataset['vsidianLevel'] = String(n)
    const label = labelOf(n)
    dot.setAttribute('aria-label', label)
    dot.setAttribute('title', label)
    dots.push(dot)
    row.appendChild(dot)
  }
  applyOutlineSliderState({ row, dots }, level)
  return { row, dots }
}

/** 滑块档位落 DOM：active 类与 aria-pressed 是两态差异唯一来源（幂等） */
export function applyOutlineSliderState(slider: OutlineSliderDom, level: number): void {
  slider.dots.forEach((dot, n) => {
    const active = n === level
    dot.classList.toggle(OUTLINE_CLASS_NAMES.sliderActive, active)
    dot.setAttribute('aria-pressed', String(active))
  })
}

/** 拖拽换算：指针 X 坐标 → 最近圆点的档位（拖拽经过任意位置可选档；
 *  圆点未布局（jsdom）时回退当前档） */
export function outlineSliderLevelAt(
  slider: OutlineSliderDom,
  clientX: number,
  fallback: number,
): number {
  let best = fallback
  let bestDist = Number.POSITIVE_INFINITY
  slider.dots.forEach((dot, n) => {
    const rect = dot.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      return // 无布局环境（jsdom）：跳过，保持 fallback
    }
    const dist = Math.abs(rect.left + rect.width / 2 - clientX)
    if (dist < bestDist) {
      bestDist = dist
      best = n
    }
  })
  return best
}

/** 工具条装配结果（#68）：跳末按钮、重置按钮、搜索输入框 */
export interface OutlineToolbarDom {
  row: HTMLElement
  jumpBottom: HTMLButtonElement
  reset: HTMLButtonElement
  search: HTMLInputElement
}

/**
 * #68 大纲工具条行（侧栏顶栏与滑块行之间）：「跳转到笔记末尾」按钮、
 * 「重置」按钮、搜索输入框（flex 占余宽）。行为装配在 syncController
 * （与滑块行同分工：此处只建 DOM 与可访问属性）。图标线宽遵循侧栏图标
 * 口径——不写在 SVG 属性上，样式失效由 CSS 契约与集成绘制断言暴露。
 * 搜索用 type=search（原生清除 affordance）+ aria-label；输入即时生效
 * （无去抖，标题序列量级小，QO 同款按键即时重算口径）
 */
export function buildOutlineToolbar(): OutlineToolbarDom {
  const row = document.createElement('div')
  row.className = OUTLINE_CLASS_NAMES.toolbar
  const jumpBottom = document.createElement('button')
  jumpBottom.type = 'button'
  jumpBottom.className = OUTLINE_CLASS_NAMES.jumpBottom
  jumpBottom.setAttribute('aria-label', '跳转到笔记末尾')
  jumpBottom.setAttribute('title', '跳转到笔记末尾')
  jumpBottom.appendChild(createOutlineJumpBottomIcon())
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = OUTLINE_CLASS_NAMES.reset
  reset.setAttribute('aria-label', '重置')
  reset.setAttribute('title', '重置')
  reset.appendChild(createOutlineResetIcon())
  const search = document.createElement('input')
  search.type = 'search'
  search.className = OUTLINE_CLASS_NAMES.search
  search.setAttribute('placeholder', OUTLINE_SEARCH_PLACEHOLDER)
  search.setAttribute('aria-label', '搜索大纲标题')
  search.autocomplete = 'off'
  search.spellcheck = false
  row.appendChild(jumpBottom)
  row.appendChild(reset)
  row.appendChild(search)
  return { row, jumpBottom, reset, search }
}

/** #68 跳转到末尾图标（lucide arrow-down-to-line 的 16px 缩放意象）：
 *  竖线 + 箭头 + 底线 */
function createOutlineJumpBottomIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ['M8 2 V11.3', 'M4 7.3 L8 11.3 L12 7.3', 'M3.3 13.7 H12.7']) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/** #68 重置图标（lucide rotate-ccw 的 16px 缩放意象）：逆时针弧 + 箭头角 */
function createOutlineResetIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of ['M2.7 8 A5.3 5.3 0 1 0 8 2.7 A5.8 5.8 0 0 0 3.6 4.5 L2.7 5.3', 'M2.7 2.7 V5.3 H5.3']) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

/** 大纲按钮图标（#54：Obsidian outline / lucide list 意象）：三条横线 +
 *  左端短点。线宽不写在 SVG 属性上（样式失效时由集成绘制断言暴露的口径
 *  与 #53 侧栏图标一致） */
function createOutlineListIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const y of [4, 8, 12]) {
    const dot = document.createElementNS(SVG_NS, 'line')
    dot.setAttribute('x1', '1.5')
    dot.setAttribute('y1', String(y))
    dot.setAttribute('x2', '3')
    dot.setAttribute('y2', String(y))
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', '5.5')
    line.setAttribute('y1', String(y))
    line.setAttribute('x2', '14.5')
    line.setAttribute('y2', String(y))
    svg.appendChild(dot)
    svg.appendChild(line)
  }
  return svg
}
