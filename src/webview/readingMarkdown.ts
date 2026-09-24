// 阅读视图 markdown-it 渲染层（工单 #8）：安全配置 + 源锚点 + DOM 净化。
//
// 安全边界（规格「不将 Markdown 原文作为可执行 HTML」）：
// - html:false：Markdown 内联 HTML 一律转义为纯文本（不产生可执行节点）
// - linkify/typographer 关闭：URL 自动发现与排版替换均不启用
// - markdown-it 默认 validateLink 拦截 javascript:/vbscript: 等危险协议
// - sanitizeReadingDom：进入 DOM 后的防御性二次清洗（纵深防御——清洗
//   script/iframe/style、行内事件属性、javascript: 链接）
//
// 源锚点：list_item_open 渲染规则把 token.map 行区间换算为全文 UTF-16
// offset 写入 data-oile-src-start/end（与协议坐标同构）；任务项标记的更细
// 锚点在 convertTaskItems 中按 li 首行源文计算（#9 勾选写回的定位依据）。
import MarkdownIt, { type Env, type Token } from 'markdown-it'

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
  taskItem: 'oile-reading-task',
  taskCheckbox: 'oile-reading-task-checkbox',
} as const

/** 创建阅读渲染器（安全配置锁定；渲染规则一次性装配，实例应复用） */
export function createMarkdownRenderer(): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
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
    return `<li data-oile-src-start="${start}" data-oile-src-end="${end}">`
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
 * checkbox（携带 marker 区间锚点与渲染态）并给 li 加 oile-reading-task 类。
 * marker 锚点 = li 首行内 `[` 字符起的三字符区间；data-oile-checked 记录
 * 渲染时勾选态（#9 点击意图的确定性来源——不受浏览器原生 checkbox
 * 激活时序影响）。点击交互由阅读容器的事件委托处理（syncController）。
 */
export function convertTaskItems(root: HTMLElement, text: string): void {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const anchorStart = Number(li.dataset['oileSrcStart'])
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
    box.dataset['oileChecked'] = String(checked)
    box.dataset['oileSrcStart'] = String(markerStart)
    box.dataset['oileSrcEnd'] = String(markerStart + 3)
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
