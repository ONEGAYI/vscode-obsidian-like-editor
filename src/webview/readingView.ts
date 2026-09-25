// 阅读视图 DOM 构建（工单 #8：markdown-it 渲染的块级 DOM）：
// 从块模型（splitReadingBlocks 产出的 html）构建带源位置锚点的块级元素，
// 供 #7 按需挂载（以块为单位）与 #9 任务勾选（marker 区间）消费。
//
// 结构契约（稳定样式入口 ADR-0004 + 源锚点）：
// <div class="vsidian-view-reading" data-vsidian-mode="reading">
//   <div class="vsidian-reading-block vsidian-reading-heading-1"
//        data-vsidian-src-start="0" data-vsidian-src-end="5"><h1>…</h1></div>
//   <div class="vsidian-reading-block vsidian-reading-paragraph" …><p>…</p></div>
//   <div class="vsidian-reading-block vsidian-reading-list" …>
//     <ul><li data-vsidian-src-start…><input …>…</li></ul>
//   </div>
// </div>
//
// - data-vsidian-src-start/end：LF 全文 UTF-16 offset（协议 SerChange 同构）；
//   li 与 checkbox 另有自身锚点（#9 勾选写回经此构造精确替换）
// - 块内容来自 markdown-it 渲染（html:false）+ DOM 纵深净化 + 任务项转换
//   （checkbox 启用，#9 点击/键盘切换走 syncController 的出站链路）
// - 类名映射 Obsidian 同款选择器，见 docs/design/obsidian-selector-map.md
import { splitReadingBlocks, type ReadingBlock } from './readingBlocks'
import { convertTaskItems, sanitizeReadingDom } from './readingMarkdown'
import type { ImageResourceManager } from './imageResource'

/** 稳定类名常量：一期 CSS 契约入口（ADR-0004），风格沿 `vsidian-` 前缀 */
export const READING_CLASS_NAMES = {
  view: 'vsidian-view-reading',
  block: 'vsidian-reading-block',
  heading: (lv: number) => `vsidian-reading-heading-${lv}`,
  paragraph: 'vsidian-reading-paragraph',
  list: 'vsidian-reading-list',
  blockquote: 'vsidian-reading-blockquote',
  codeBlock: 'vsidian-reading-code-block',
  hr: 'vsidian-reading-hr',
  frontmatter: 'vsidian-reading-frontmatter',
  listItem: 'vsidian-reading-list-item',
  task: 'vsidian-reading-task',
  taskCheckbox: 'vsidian-reading-task-checkbox',
  /** #12 表格块（内含 markdown-it 渲染的真实 table/thead/tbody 标签） */
  tableBlock: 'vsidian-reading-table',
  /** #59 公式块（行首 $$ 独立成块；内含 KaTeX display 渲染） */
  mathBlock: 'vsidian-reading-math',
  /** #60 Mermaid 围栏块（内含挂载后渲染的 .vsidian-mermaid 容器） */
  mermaidBlock: 'vsidian-reading-mermaid',
  /** #7 视口占位 spacer（屏外块的高度占位，非内容节点） */
  spacer: 'vsidian-reading-spacer',
  spacerTop: 'vsidian-reading-spacer-top',
  spacerBottom: 'vsidian-reading-spacer-bottom',
  /** #14 查找当前匹配所在块的高亮（块级；面板关闭即清除） */
  findHit: 'vsidian-reading-find-hit',
} as const

/** 创建阅读视图容器（稳定类名 + 模式标记；初始由调用方控制显隐） */
export function createReadingContainer(): HTMLElement {
  const el = document.createElement('div')
  el.className = READING_CLASS_NAMES.view
  el.dataset['vsidianMode'] = 'reading'
  return el
}

function blockClassNames(block: ReadingBlock): string[] {
  const names: string[] = [READING_CLASS_NAMES.block]
  switch (block.kind) {
    case 'heading':
      names.push(READING_CLASS_NAMES.heading(block.level ?? 1))
      break
    case 'paragraph':
      names.push(READING_CLASS_NAMES.paragraph)
      break
    case 'list':
      names.push(READING_CLASS_NAMES.list)
      break
    case 'blockquote':
      names.push(READING_CLASS_NAMES.blockquote)
      break
    case 'code-block':
      names.push(READING_CLASS_NAMES.codeBlock)
      break
    case 'hr':
      names.push(READING_CLASS_NAMES.hr)
      break
    case 'frontmatter':
      names.push(READING_CLASS_NAMES.frontmatter)
      break
    case 'table':
      names.push(READING_CLASS_NAMES.tableBlock)
      break
    case 'math':
      names.push(READING_CLASS_NAMES.mathBlock)
      break
    case 'mermaid':
      names.push(READING_CLASS_NAMES.mermaidBlock)
      break
  }
  return names
}

/**
 * 创建单个阅读块元素（结构契约：稳定类名 + data-vsidian-src-start/end 锚点；
 * 内部 HTML 为 markdown-it 产物，进 DOM 前净化并转换任务项）。
 * #7 全量渲染与按需挂载共用此构建器，保证两种路径的块结构逐字节一致。
 */
export function createReadingBlockElement(block: ReadingBlock, text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = blockClassNames(block).join(' ')
  el.dataset['vsidianSrcStart'] = String(block.start)
  el.dataset['vsidianSrcEnd'] = String(block.end)
  el.innerHTML = block.html
  sanitizeReadingDom(el)
  if (block.kind === 'list') {
    convertTaskItems(el, text)
  }
  return el
}

/**
 * 全量渲染阅读块：清空容器后按块切分重建。
 * 返回渲染块数。#7 起此函数是无布局环境（jsdom/隐藏容器）的回退路径，
 * 也是虚拟化路径的对拍基线；真实布局可用时由 readingVirtualView 按需挂载。
 */
export function renderReadingBlocks(container: HTMLElement, text: string): number {
  container.textContent = ''
  const blocks = splitReadingBlocks(text)
  for (const block of blocks) {
    container.appendChild(createReadingBlockElement(block, text))
  }
  return blocks.length
}

/**
 * 阅读图片预备（#10）：markdown-it 渲染出的 <img> 剥离原生 src（相对路径
 * 在 webview origin 下不可解析，必须经宿主通道），原始地址转入
 * data-vsidian-img-src 并绑定资源管理器（块挂载即装载；卸载由 detachWithin
 * 释放）。alt 保留（加载前占位与无障碍语义）。
 */
export function prepareReadingImages(root: HTMLElement, images: ImageResourceManager): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const raw = img.getAttribute('src') ?? ''
    img.removeAttribute('src')
    images.attach(img, raw)
  }
}

/**
 * 当前阅读锚点：视口内首个可见块的源 start。
 * 判定：首个"块顶到达视口顶"或"块底越过视口顶"的块。
 * 布局不可用（jsdom/初始未排版，offsetTop 全 0）时首块自然命中——
 * 保守但仍是源码位置锚点，不是滚动百分比。
 */
export function findReadingAnchor(container: HTMLElement): number | null {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}[data-vsidian-src-start]`),
  )
  if (blocks.length === 0) {
    return null
  }
  const scrollTop = container.scrollTop
  for (const el of blocks) {
    if (el.offsetTop >= scrollTop || el.offsetTop + el.offsetHeight > scrollTop) {
      return Number(el.dataset['vsidianSrcStart'])
    }
  }
  return Number(blocks[blocks.length - 1]!.dataset['vsidianSrcStart'])
}

/**
 * 源 offset → 锚点：包含（或前邻）该 offset 的块 start；列表块内按 li
 * 子锚点归位到项级（与虚拟化路径的 anchorStartFor 同语义）。
 * 供 live→reading 切换时把光标 offset 映射为块身份。
 */
export function readingAnchorStartFor(container: HTMLElement, offset: number): number | null {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}[data-vsidian-src-start]`),
  )
  if (blocks.length === 0) {
    return null
  }
  let last: HTMLElement = blocks[0]!
  for (const el of blocks) {
    const start = Number(el.dataset['vsidianSrcStart'])
    const end = Number(el.dataset['vsidianSrcEnd'])
    if (offset < end) {
      if (start > offset) {
        return Number(last.dataset['vsidianSrcStart'])
      }
      return listItemAnchorFor(el, offset) ?? start
    }
    last = el
  }
  return listItemAnchorFor(last, offset) ?? Number(last.dataset['vsidianSrcStart'])
}

/** 块内 li 子锚点：≤ offset 的最大 li start（无 li 返回 null） */
function listItemAnchorFor(block: HTMLElement, offset: number): number | null {
  const items = block.querySelectorAll<HTMLElement>('li[data-vsidian-src-start]')
  let prev: number | null = null
  for (const li of Array.from(items)) {
    const start = Number(li.dataset['vsidianSrcStart'])
    if (start <= offset) {
      prev = start
    } else {
      break
    }
  }
  return prev
}

/** 按源 offset 滚动到对应锚点块（先经 readingAnchorStartFor 映射） */
export function scrollReadingToOffset(container: HTMLElement, offset: number): void {
  const start = readingAnchorStartFor(container, offset)
  if (start !== null) {
    scrollReadingToSrcStart(container, start)
  }
}

/** 按源 start 滚动到对应块（锚点失效时不动作，不抛错） */
export function scrollReadingToSrcStart(container: HTMLElement, srcStart: number): void {
  const el = container.querySelector<HTMLElement>(
    `.${READING_CLASS_NAMES.block}[data-vsidian-src-start="${srcStart}"]`,
  )
  if (el) {
    container.scrollTop = el.offsetTop
  }
}
