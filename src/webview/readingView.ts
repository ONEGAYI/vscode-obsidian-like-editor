// 阅读视图 DOM 构建（工单 #6 基础版）：
// 从 LF 全文构建带源位置锚点的块级 DOM，供 #7 按需挂载（以块为单位）与
// #9 任务勾选（marker 区间）消费。
//
// 结构契约（稳定样式入口 ADR-0004 + 源锚点）：
// <div class="oile-view-reading" data-oile-mode="reading">
//   <div class="oile-reading-block oile-reading-heading-1"
//        data-oile-src-start="0" data-oile-src-end="5">…</div>
//   <div class="oile-reading-block oile-reading-paragraph" …>
//   <div class="oile-reading-block oile-reading-list-item oile-reading-task" …>
//     <input class="oile-reading-task-checkbox" type="checkbox" disabled
//            data-oile-src-start="…" data-oile-src-end="…">…text…
//   </div>
// </div>
//
// - data-oile-src-start/end：LF 全文 UTF-16 offset（协议 SerChange 同构）；
//   checkbox 的锚点指向源文 `[ ]`/`[x]` 标记区间，#9 以此构造精确替换
// - 源文本一律经 textContent 注入（不作为 HTML 解析，CSP 与注入安全边界）
// - 本票全量渲染（#7 改为按需挂载，块结构与锚点字段不变）
// - 类名映射 Obsidian 同款选择器，见 docs/design/obsidian-selector-map.md
import { splitReadingBlocks, type ReadingBlock } from './readingBlocks'

/** 稳定类名常量：一期 CSS 契约入口（ADR-0004），风格沿 `oile-` 前缀 */
export const READING_CLASS_NAMES = {
  view: 'oile-view-reading',
  block: 'oile-reading-block',
  heading: (lv: number) => `oile-reading-heading-${lv}`,
  paragraph: 'oile-reading-paragraph',
  listItem: 'oile-reading-list-item',
  task: 'oile-reading-task',
  taskCheckbox: 'oile-reading-task-checkbox',
  codeBlock: 'oile-reading-code-block',
  /** #7 视口占位 spacer（屏外块的高度占位，非内容节点） */
  spacer: 'oile-reading-spacer',
  spacerTop: 'oile-reading-spacer-top',
  spacerBottom: 'oile-reading-spacer-bottom',
} as const

/** 创建阅读视图容器（稳定类名 + 模式标记；初始由调用方控制显隐） */
export function createReadingContainer(): HTMLElement {
  const el = document.createElement('div')
  el.className = READING_CLASS_NAMES.view
  el.dataset['oileMode'] = 'reading'
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
    case 'list-item':
      names.push(READING_CLASS_NAMES.listItem)
      if (block.task) {
        names.push(READING_CLASS_NAMES.task)
      }
      break
    case 'code-block':
      names.push(READING_CLASS_NAMES.codeBlock)
      break
  }
  return names
}

/**
 * 创建单个阅读块元素（#6 结构契约：稳定类名 + data-oile-src-start/end 锚点；
 * 任务项带 marker 区间锚点的 disabled checkbox）。
 * #7 起全量渲染（renderReadingBlocks）与按需挂载（readingVirtualView）
 * 共用此构建器，保证两种路径的块结构逐字节一致。
 */
export function createReadingBlockElement(block: ReadingBlock, text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = blockClassNames(block).join(' ')
  el.dataset['oileSrcStart'] = String(block.start)
  el.dataset['oileSrcEnd'] = String(block.end)
  if (block.task) {
    // #9 语义入口：disabled checkbox 携带标记区间锚点；勾选写回由 #9 实现
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = READING_CLASS_NAMES.taskCheckbox
    box.disabled = true
    box.checked = block.task.checked
    box.dataset['oileSrcStart'] = String(block.task.markerStart)
    box.dataset['oileSrcEnd'] = String(block.task.markerEnd)
    el.appendChild(box)
    el.appendChild(document.createTextNode(' '))
    el.appendChild(document.createTextNode(text.slice(block.start, block.end)))
  } else {
    el.textContent = text.slice(block.start, block.end)
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
 * 当前阅读锚点：视口内首个可见块的源 start。
 * 判定：首个"块顶到达视口顶"或"块底越过视口顶"的块。
 * 布局不可用（jsdom/初始未排版，offsetTop 全 0）时首块自然命中——
 * 保守但仍是源码位置锚点，不是滚动百分比。
 */
export function findReadingAnchor(container: HTMLElement): number | null {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}[data-oile-src-start]`),
  )
  if (blocks.length === 0) {
    return null
  }
  const scrollTop = container.scrollTop
  for (const el of blocks) {
    if (el.offsetTop >= scrollTop || el.offsetTop + el.offsetHeight > scrollTop) {
      return Number(el.dataset['oileSrcStart'])
    }
  }
  return Number(blocks[blocks.length - 1]!.dataset['oileSrcStart'])
}

/**
 * 源 offset → 锚点块 start：包含（或前邻）该 offset 的块。
 * 供 live→reading 切换时把光标 offset 映射为块身份。
 */
export function readingAnchorStartFor(container: HTMLElement, offset: number): number | null {
  const blocks = Array.from(
    container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}[data-oile-src-start]`),
  )
  if (blocks.length === 0) {
    return null
  }
  let last: HTMLElement = blocks[0]!
  for (const el of blocks) {
    const start = Number(el.dataset['oileSrcStart'])
    const end = Number(el.dataset['oileSrcEnd'])
    if (offset < end) {
      return start <= offset ? start : Number(last.dataset['oileSrcStart'])
    }
    last = el
  }
  return Number(last.dataset['oileSrcStart'])
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
    `.${READING_CLASS_NAMES.block}[data-oile-src-start="${srcStart}"]`,
  )
  if (el) {
    container.scrollTop = el.offsetTop
  }
}
