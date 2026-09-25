// 阅读视图 markdown-it 渲染层（工单 #8）：安全配置 + 源锚点 + DOM 净化。
//
// 安全边界（规格「不将 Markdown 原文作为可执行 HTML」）：
// - html:false：Markdown 内联 HTML 转义为纯文本；仅表格内无属性 br 作为换行处理
// - linkify/typographer 关闭：URL 自动发现与排版替换均不启用
// - markdown-it 默认 validateLink 拦截 javascript:/vbscript: 等危险协议
// - sanitizeReadingDom：进入 DOM 后的防御性二次清洗（纵深防御——清洗
//   script/iframe/style、行内事件属性、javascript: 链接）
//
// 源锚点：list_item_open 渲染规则把 token.map 行区间换算为全文 UTF-16
// offset 写入 data-vsidian-src-start/end（与协议坐标同构）；任务项标记的更细
// 锚点在 convertTaskItems 中按 li 首行源文计算（#9 勾选写回的定位依据）。
import MarkdownIt, { type Env, type StateInline, type Token } from 'markdown-it'
import katexPlugin from '@vscode/markdown-it-katex'
import katex from 'katex'
import { MATH_CLASS_NAMES } from '../shared/math'
import { WIKILINK_CLASS_NAMES, parseWikilinkInner } from '../shared/wikilink'
import { tableCellBreakLength } from './tableCells'

/** 渲染环境：行首/行尾 offset 表（lineStarts[i]/lineEnds[i] 为第 i 行界） */
export interface ReadingRenderEnv {
  lineStarts: number[]
  lineEnds: number[]
  /** 渲染相对 body 的 token 时：token.map 行号加上该基值（0 基全文行号） */
  baseLine?: number
}

/** 任务标记行：缩进 + 列表标记 + 空白 + [xX ] + 空白。
 *  导出供 taskToggle 的点击严格再校验共用（同一任务行判定口径） */
export const TASK_ITEM_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s/

/** 阅读视图稳定类名（阅读侧 #8 新增；与 readingView 常量保持一致的方向） */
export const READING_MARKDOWN_CLASS_NAMES = {
  taskItem: 'vsidian-reading-task',
  taskCheckbox: 'vsidian-reading-task-checkbox',
} as const

/**
 * KaTeX 渲染（#59）：成功返回 KaTeX HTML，失败返回 null（调用方降级为
 * 原文 span——不显示英文错误消息，原文可读且源文不丢）。displayMode 的
 * 判定与 @vscode/markdown-it-katex 的 katexInline 一致（align/equation 等
 * 环境强制 display）。
 */
function renderKatex(latex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: true,
      // 中文等 Unicode 文本字符在数学模式下静默渲染（strict 警告不阻断）：
      // 中文用户在公式内夹注中文是常态，不构成降级理由
      strict: false,
    })
  } catch {
    return null
  }
}

/** HTML 转义（降级 span 的原文内容；与 markdown-it 的 default规则同覆盖面） */
function escapeHtmlText(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 公式渲染规则（#59）：覆盖插件的默认规则——
 * - 成功：KaTeX HTML 包 vsidian-math（/ vsidian-math-block）稳定类名
 *   （cssProbe 与选择器映射表的入口）
 * - 失败：vsidian-math-error span 显示 `$原文$`（可读降级，源文经转义，
 *   title 带原文便于悬停核对）
 * 块级输出对齐插件的 `<p class="katex-block">` 包裹（阅读 CSS 的 display
 * 居中挂在该容器上）。
 */
function installMathRenderers(md: InstanceType<typeof MarkdownIt>): void {
  const inline = (tokens: Token[], idx: number): string => {
    const content = tokens[idx]!.content
    // 与插件一致：$`1+1`$ 形态剥反引号
    const tex = content.length > 2 && content[0] === '`' && content[content.length - 1] === '`'
      ? content.slice(1, -1)
      : content
    const displayMode = /\\begin\{(align|equation|gather|cd|alignat)\}/i.test(tex)
    const html = renderKatex(tex, displayMode)
    return html !== null
      ? `<span class="${MATH_CLASS_NAMES.math}">${html}</span>`
      : `<span class="${MATH_CLASS_NAMES.mathError}" title="${escapeHtmlText(tex)}">${escapeHtmlText(`$${tex}$`)}</span>`
  }
  const block = (tokens: Token[], idx: number): string => {
    const tex = tokens[idx]!.content
    const html = renderKatex(tex, true)
    return html !== null
      ? `<p class="katex-block ${MATH_CLASS_NAMES.math} ${MATH_CLASS_NAMES.mathBlock}">${html}</p>\n`
      : `<p class="katex-block ${MATH_CLASS_NAMES.mathError}"><code>${escapeHtmlText(`$$${tex}$$`)}</code></p>\n`
  }
  md.renderer.rules['math_inline'] = inline
  md.renderer.rules['math_inline_block'] = block
  md.renderer.rules['math_inline_bare_block'] = block
  md.renderer.rules['math_block'] = block
}

/**
 * 双链 inline 规则（#11）：合法 `[[…]]` 渲染为 `<a class="vsidian-wikilink"
 * href="原文target">显示文字</a>`。与 live 装饰、宿主解析共用
 * shared/wikilink 形态学（三处语义逐字节一致）；嵌入 `![[…]]`、块引用 `^`、
 * 残缺形态返回 false——markdown-it 按普通文本渲染，源码保真降级。
 * href 为 `|` 之前的原文（未 trim）：单击经 syncController 的事件委托上报
 * wikilink.activate，规范化在宿主侧。
 */
function vsidianWikilinkInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src
  const start = state.pos
  if (start + 1 >= state.posMax || src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) {
    return false
  }
  // 前置 !（嵌入）与前置 [（三连括号）不匹配：二期形态按原文降级
  const prev = start > 0 ? src.charCodeAt(start - 1) : -1
  if (prev === 0x21 /* ! */ || prev === 0x5b /* [ */) {
    return false
  }
  const close = src.indexOf(']]', start + 2)
  if (close < 0 || close + 2 > state.posMax) {
    return false
  }
  const inner = src.slice(start + 2, close)
  if (/[\[\]\n]/.test(inner)) {
    return false
  }
  const parsed = parseWikilinkInner(inner)
  if (!parsed) {
    return false
  }
  if (!silent) {
    const pipeAt = inner.indexOf('|')
    const target = pipeAt >= 0 ? inner.slice(0, pipeAt) : inner
    const open = state.push('link_open', 'a', 1)
    open.attrs = [
      ['href', target],
      ['class', WIKILINK_CLASS_NAMES.wikilink],
    ]
    const text = state.push('text', '', 0)
    text.content = parsed.display
    state.push('link_close', 'a', -1)
  }
  state.pos = close + 2
  return true
}

/** 创建阅读渲染器（安全配置锁定；渲染规则一次性装配，实例应复用） */
export function createMarkdownRenderer(): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  })
  // #11 双链规则先于 link（[t](u)）：`[[…]]` 在 CommonMark 中只是普通文本，
  // 必须在文本规则消费前拦截
  md.inline.ruler.before('link', 'vsidian_wikilink', vsidianWikilinkInlineRule)
  // #59 公式：@vscode/markdown-it-katex 的解析规则（$…$ / $$…$$ 判定与
  // shared/math.ts 对齐）；渲染规则覆盖为带稳定类名 + 原文降级
  md.use(katexPlugin, { throwOnError: true })
  installMathRenderers(md)
  // 编辑态把格内回车存成 br。阅读态只在表格 inline token 里重新解析
  // 无属性 br；全局 html:false 继续转义其他 HTML，代码片段由解析器保留字面值。
  md.inline.ruler.before('html_inline', 'vsidian_table_break', (state, silent) => {
    if (!state.env.vsidianTableCell) return false
    const length = tableCellBreakLength(state.src, state.pos)
    if (!length) return false
    if (!silent) state.push('hardbreak', 'br', 0)
    state.pos += length
    return true
  })
  md.core.ruler.after('inline', 'vsidian_table_breaks', (state) => {
    let inTable = false
    for (const token of state.tokens) {
      if (token.type === 'table_open') inTable = true
      if (token.type === 'table_close') inTable = false
      if (inTable && token.type === 'inline' && /<br/i.test(token.content)) {
        token.children = []
        md.inline.parse(token.content, md, { ...state.env, vsidianTableCell: true }, token.children)
      }
    }
  })
  md.renderer.rules['list_item_open'] = (tokens, idx, _options, env) => {
    const map = (tokens[idx] as Token).map
    const bounds = env as unknown as ReadingRenderEnv | undefined
    if (!map || !bounds || !Array.isArray(bounds.lineStarts)) {
      return '<li>'
    }
    const { lineStarts, lineEnds, baseLine } = bounds
    const startLine = map[0] ?? 0
    const lastLine = Math.max(startLine, (map[1] ?? startLine + 1) - 1)
    const base = typeof baseLine === 'number' ? baseLine : 0
    const start = lineStarts[startLine + base] ?? 0
    const end = lineEnds[lastLine + base] ?? start
    return `<li data-vsidian-src-start="${start}" data-vsidian-src-end="${end}">`
  }
  return md
}

/** 渲染一段平衡的 token 流为 HTML（env 提供行界表，锚点规则读取） */
export function renderTokenHtml(
  md: InstanceType<typeof MarkdownIt>,
  tokens: Token[],
  env: ReadingRenderEnv,
): string {
  return md.renderer.render(tokens, md.options, env as unknown as Env)
}

/** 由全文构造行界表（lineStarts/lineEnds，0 基行号） */
export function buildLineBounds(text: string): ReadingRenderEnv {
  const lineStarts: number[] = []
  const lineEnds: number[] = []
  let at = 0
  for (const line of text.split('\n')) {
    lineStarts.push(at)
    lineEnds.push(at + line.length)
    at += line.length + 1
  }
  return { lineStarts, lineEnds }
}

/** DOM 纵深净化：移除 script/iframe/style 等元素、行内事件属性与危险协议链接 */
export function sanitizeReadingDom(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('script, iframe, style, object, embed'))) {
    el.remove()
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name)
      } else if ((name === 'href' || name === 'src') && isDangerousUrl(attr.value)) {
        el.removeAttribute(attr.name)
      }
    }
  }
}

function isDangerousUrl(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html')
}

/**
 * 任务项转换：li 首文本以 `[ ] `/`[x] `/`[X] ` 开头时，替换为启用
 * checkbox（携带 marker 区间锚点与渲染态）并给 li 加 vsidian-reading-task 类。
 * marker 锚点 = li 首行内 `[` 字符起的三字符区间；data-vsidian-checked 记录
 * 渲染时勾选态（#9 点击意图的确定性来源——不受浏览器原生 checkbox
 * 激活时序影响）。点击交互由阅读容器的事件委托处理（syncController）。
 */
export function convertTaskItems(root: HTMLElement, text: string): void {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const anchorStart = Number(li.dataset['vsidianSrcStart'])
    if (!Number.isInteger(anchorStart) || anchorStart < 0) {
      continue
    }
    const lineEnd = text.indexOf('\n', anchorStart)
    const line = text.slice(anchorStart, lineEnd < 0 ? text.length : lineEnd)
    const m = TASK_ITEM_RE.exec(line)
    if (!m) {
      continue
    }
    const firstText = firstTextNode(li)
    if (!firstText || !firstText.nodeValue!.startsWith(`[${m[2]}] `)) {
      continue
    }
    const markerStart = anchorStart + m[0].indexOf('[')
    const checked = m[2] !== ' '
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = READING_MARKDOWN_CLASS_NAMES.taskCheckbox
    box.checked = checked
    box.dataset['vsidianChecked'] = String(checked)
    box.dataset['vsidianSrcStart'] = String(markerStart)
    box.dataset['vsidianSrcEnd'] = String(markerStart + 3)
    firstText.parentNode!.insertBefore(box, firstText)
    firstText.nodeValue = firstText.nodeValue!.slice(4)
    li.classList.add(READING_MARKDOWN_CLASS_NAMES.taskItem)
    if (firstText.nodeValue === '') {
      firstText.remove()
    }
  }
}

/** li 的第一个文本节点（首子节点已是元素时返回 null——非任务形态） */
function firstTextNode(li: HTMLElement): Text | null {
  for (const node of Array.from(li.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').length > 0) {
      return node as Text
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      return null
    }
  }
  return null
}
