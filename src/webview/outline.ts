// 大纲模块（#54）：右侧栏「大纲」面板的数据与 DOM。
//
// 数据源单一职责：extractOutline 以 CM6 全文文本（webview LF 坐标，含未
// 保存编辑）为唯一依据，经 markdownTreeParser（与 liveDecorations 同一
// 解析器、同一 frontmatter 判定）产出标题序列——与视口渲染无关、与
// live/reading 模式无关（CM6 doc 在两模式下都是权威文本模型）。解析树
// 可由调用方传入（syncController 复用 liveDecorationsField 的增量树，
// 免去大文档的全量 parse；树与文档须来自同一 state）。
//
// 本期（#66 起）：条目可点击跳转与常驻高亮（交互装配在 syncController，
// 经面板容器的事件委托——条目 DOM 重建不丢监听）；折叠与搜索不在范围。
import type { Text } from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
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
  /** 标题文字（ATX 去标记与关闭序列；Setext 多行内容以空格连接） */
  text: string
  /** 标题起始行（1 基；Setext 为内容首行） */
  line: number
}

/** 大纲面板的稳定类名（样式与断言的公共锚点） */
export const OUTLINE_CLASS_NAMES = {
  panel: 'vsidian-outline-panel',
  item: 'vsidian-outline-item',
  empty: 'vsidian-outline-empty',
  /** 级别类名（level-1..6）：CSS 缩进与集成断言的锚点 */
  level: (n: number) => `vsidian-outline-level-${n}`,
  /** #66 当前控制域条目的常驻高亮类（半透明横条的唯一差异来源） */
  located: 'vsidian-outline-located',
} as const

/** 大纲面板可访问名称（按钮 aria-label 与面板 aria-label 共用文案） */
export const OUTLINE_LABEL = '大纲'

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
 * 全文大纲提取：标题序列（级别 + 文字 + 起始行）。frontmatter 头块内的
 * 伪标题排除（判定与 live 装饰/阅读切块同源，两视图语义一致）；代码围栏
 * 内不产生标题节点，天然排除。跨级与同名标题逐项保留。
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
    if (mark && mark.from === node.from) {
      // ATX：# 标记在头部，文字 = 标记后空格到行尾（clamp 去块尾换行）
      const lineEnd = doc.lineAt(node.from).to
      const raw = doc.sliceString(skipSpaces(doc, mark.to), Math.min(node.to, lineEnd))
      text = stripAtxClosing(raw)
    } else {
      // Setext：内容 = 下划线标记之前的行（可多行，空格连接）
      const underlineLine = mark ? doc.lineAt(mark.from).number : doc.lineAt(node.to).number
      const contentTo = mark
        ? doc.line(Math.max(1, underlineLine - 1)).to
        : node.to
      text = doc.sliceString(node.from, contentTo).replace(/\n/g, ' ').trim()
    }
    items.push({ level, text, line: doc.lineAt(node.from).number })
  })
  return items
}

/** 级别 + 文字序列相等（DOM 重建判据）：行号偏移不改变用户可见大纲 */
export function outlineItemsEqual(a: readonly OutlineItem[], b: readonly OutlineItem[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.level !== b[i]!.level || a[i]!.text !== b[i]!.text) {
      return false
    }
  }
  return true
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

/**
 * 重建面板条目（数据变化时全量替换：条目是无状态纯展示节点，重建成本
 * 与标题数线性且仅在序列变化时发生；正文编辑不触发）。无标题时渲染
 * 空态占位（保持面板有可读内容与高度语义）。
 */
export function renderOutlineItems(panel: HTMLElement, items: readonly OutlineItem[]): void {
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = OUTLINE_CLASS_NAMES.empty
    empty.textContent = '无标题'
    panel.replaceChildren(empty)
    return
  }
  const nodes: HTMLElement[] = []
  for (const item of items) {
    const el = document.createElement('div')
    el.className = `${OUTLINE_CLASS_NAMES.item} ${OUTLINE_CLASS_NAMES.level(item.level)}`
    el.dataset['vsidianLevel'] = String(item.level)
    el.textContent = item.text
    nodes.push(el)
  }
  panel.replaceChildren(...nodes)
}

const SVG_NS = 'http://www.w3.org/2000/svg'

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
