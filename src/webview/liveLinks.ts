// Live 视图链接与图片（工单 #10/#28）：按 visibleRanges 间接装饰，
// 渲染态单击及 Ctrl/Cmd+单击上报跳转意图。
//
// 装饰语义（与既有间接装饰同类，ADR-0005 / #8 分工沿用）：
// - 链接内容 span：vsidian-link 稳定类名（Obsidian .cm-link 方向）；
//   光标或选区进入该链接范围才显示首尾标记与 URL，其余链接仍隐藏源码
// - 图片：光标在该图片范围外时替换为 LiveImageWidget（进入视口才创建
//   DOM，离开视口由 CM6 移除、经 ImageResourceManager.sweep 释放）；
//   进入图片范围才显示源码
// - 引用式链接/图片（[t][ref]）：本票不解析引用定义，保持源码降级
//   （阅读视图由 markdown-it 完整解析——差异见选择器映射表已知限制）
// - 自动链接 <https://…>：URL 即内容，标记 span + 范围外隐藏尖括号
//
// #11 双链装饰（本文件扩展）：`[[…]]` 不在 lezer Markdown 语法内（CommonMark
// 视为普通文本），装饰来源是 shared/wikilink 的行内扫描（与阅读渲染、宿主
// 解析共用同一形态学）；代码上下文（围栏/缩进/行内代码）与 frontmatter
// 内不装饰（语法树 + fm 边界判定，与 #8 的源码降级边界一致）。
//
// 点击语义：已渲染的链接单击跳转；光标进入该链接范围后的普通单击仍由 CM6 编辑；
// Ctrl/Cmd+单击在两种形态下都跳转
// （原始 URI/target + 源区间），执行归宿主（URI 解析与白名单在宿主侧；
// 双链先于普通链接判定——两者语法不重叠）。
import { EditorSelection, RangeSet, Text, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { chainAt, visitRange, type SourceRange } from './markdownDoc'
import { liveDecorationsField, selectionTouchesRange } from './liveDecorations'
import { IMAGE_CLASS_NAMES, type ImageResourceManager } from './imageResource'
import {
  WIKILINK_CLASS_NAMES,
  parseWikilinkInner,
  scanWikilinksInLine,
  wikilinkAtCol,
} from '../shared/wikilink'

/** #10 链接稳定类名（图片类名复用 IMAGE_CLASS_NAMES.image） */
export const LINK_CLASS_NAMES = {
  /** 链接内容 span（Obsidian `.cm-link`） */
  link: 'vsidian-link',
} as const

export { WIKILINK_CLASS_NAMES }

const linkMarkDeco = Decoration.mark({ class: LINK_CLASS_NAMES.link })
const renderedLinkMarkDeco = Decoration.mark({
  class: LINK_CLASS_NAMES.link,
  attributes: { 'data-vsidian-rendered-link': 'true' },
})
const hideDeco = Decoration.replace({})

// ---- #11 双链装饰实例缓存（同 display 复用同一实例，RangeSet.eq 成立） ----

const wikilinkMarkDeco = Decoration.mark({ class: WIKILINK_CLASS_NAMES.wikilink })

/** widget 装饰缓存上限：键是用户内容（双链 display / 图片 src+alt），无上限
 *  会随大文档滚动无限累积——视口内同时可见的双链/图片远小于此，超限逐最旧 */
export const WIDGET_DECO_CACHE_LIMIT = 512

/** Map 的 LRU 化访问：命中即重插到迭代序末尾（Map 迭代序 = 插入序），
 *  超限逐迭代序最旧项 */
function lruGet<V>(cache: Map<string, V>, key: string): V | undefined {
  const hit = cache.get(key)
  if (hit !== undefined) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function lruEvict<V>(cache: Map<string, V>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}

const wikilinkWidgetDecos = new Map<string, ReturnType<typeof Decoration.replace>>()

export function wikilinkWidgetDeco(display: string): ReturnType<typeof Decoration.replace> {
  const hit = lruGet(wikilinkWidgetDecos, display)
  if (hit) {
    return hit
  }
  const deco = Decoration.replace({ widget: new LiveWikilinkWidget(display) })
  wikilinkWidgetDecos.set(display, deco)
  lruEvict(wikilinkWidgetDecos, WIDGET_DECO_CACHE_LIMIT)
  return deco
}

/**
 * #11 live 双链 widget：光标在范围外时把 `[[…]]` 整体替换为显示文字（别名或
 * 链接名）。纯呈现（无加载/失败生命周期）；点击交互经编辑器级
 * 编辑器级 mousedown 的 posAtCoords 命中（替换区间仍有文档坐标）。
 */
export class LiveWikilinkWidget extends WidgetType {
  constructor(readonly displayText: string) {
    super()
  }

  eq(other: LiveWikilinkWidget): boolean {
    return other.displayText === this.displayText
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = WIKILINK_CLASS_NAMES.wikilink
    span.dataset['vsidianRenderedWikilink'] = 'true'
    span.textContent = this.displayText
    return span
  }

  ignoreEvent(): boolean {
    return false // 交给 CM6：渲染态单击跳转，其他事件仍可用于编辑
  }
}

/** 双链排除的代码上下文（lezer 节点名）：围栏/缩进代码与行内代码内按源码呈现 */
const WIKILINK_CODE_CONTEXTS = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'CodeMark',
  'CodeInfo',
  'InlineCode',
])

/** occurrence 起点是否处于代码上下文或 frontmatter 内（源码降级边界） */
function wikilinkSuppressed(tree: Tree, from: number, fm: SourceRange | null): boolean {
  if (fm && from < fm.end) {
    return true
  }
  for (const node of chainAt(tree, from)) {
    if (WIKILINK_CODE_CONTEXTS.has(node.name)) {
      return true
    }
  }
  return false
}

/** 无管理器形态（纯构建直驱）的缓存键（模块级常量对象） */
const NO_MANAGER = {}

/** live 图片 widget 装饰缓存：按管理器实例隔离（同 src/alt 复用同一实例，
 *  RangeSet.eq 成立；不同管理器/会话不得共享 widget 实例） */
const imageWidgetDecos = new WeakMap<object, Map<string, ReturnType<typeof Decoration.replace>>>()

export function imageWidgetDeco(src: string, alt: string, images: ImageResourceManager | undefined) {
  const holder: object = images ?? NO_MANAGER
  let cache = imageWidgetDecos.get(holder)
  if (!cache) {
    cache = new Map()
    imageWidgetDecos.set(holder, cache)
  }
  const key = `${src}\u0000${alt}`
  const hit = lruGet(cache, key)
  if (hit) {
    return hit
  }
  const deco = Decoration.replace({ widget: new LiveImageWidget(src, alt, images) })
  cache.set(key, deco)
  lruEvict(cache, WIDGET_DECO_CACHE_LIMIT)
  return deco
}

/** live 图片 widget：占位（alt 文本）→ 经资源管理器装载 → 失败可重试 */
export class LiveImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly images?: ImageResourceManager,
  ) {
    super()
  }

  eq(other: LiveImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = IMAGE_CLASS_NAMES.image
    span.dataset['vsidianImgState'] = 'loading'
    span.classList.add(IMAGE_CLASS_NAMES.state('loading'))
    span.title = this.alt
    span.textContent = this.alt
    this.images?.attach(span, this.src, (slot, src) => {
      slot.textContent = ''
      const image = document.createElement('img')
      image.alt = this.alt
      image.src = src
      slot.appendChild(image)
      return image
    })
    return span
  }

  /** 图片错误态重试由管理器处理；其余事件交还编辑器（光标定位） */
  ignoreEvent(): boolean {
    return false
  }
}

/** 名为 name 的直接子节点 */
function childNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === name) {
      return c
    }
  }
  return null
}

/** LinkMark 子节点序列（升序） */
function linkMarks(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'LinkMark') {
      out.push(c)
    }
  }
  return out
}

/** 内联形态（`[t](url)` / `![a](src)`）：闭括号后随 '(' 开标记。
 *  引用形态（`[t][ref]`，后随 LinkLabel）本票不装饰（源码降级） */
function isInlineForm(node: SyntaxNode, doc: Text): boolean {
  const marks = linkMarks(node)
  const closer = marks[1]
  if (!closer) {
    return false
  }
  const next = closer.nextSibling
  if (!next || next.name !== 'LinkMark') {
    return false
  }
  return doc.sliceString(next.from, next.to).startsWith('(')
}

/** URL 子节点的目标文本（剥 <> 包裹形态） */
function linkHrefOf(doc: Text, node: SyntaxNode): string | null {
  const url = childNamed(node, 'URL')
  if (!url) {
    return null
  }
  let href = doc.sliceString(url.from, url.to)
  if (href.startsWith('<') && href.endsWith('>') && href.length >= 2) {
    href = href.slice(1, -1)
  }
  return href || null
}

/** 区间裁剪：[from, to) 减去 cuts（互不重叠、已排序） */
function subtractIntervals(
  from: number,
  to: number,
  cuts: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  let at = from
  for (const cut of cuts) {
    if (cut.to <= at || cut.from >= to) {
      continue
    }
    if (cut.from > at) {
      out.push({ from: at, to: cut.from })
    }
    at = Math.max(at, cut.to)
  }
  if (at < to) {
    out.push({ from: at, to })
  }
  return out
}

/**
 * 构建视口内链接/图片间接装饰（原始区间表；#11 起与双链装饰合并为同一
 * ViewPlugin 的输出）。纯数据输入，可单测直驱。
 * visitRange 相交访问可能重复命中跨区间边界的节点——以节点 from 去重。
 */
export function buildLinkImageDecorationRanges(
  doc: Text,
  tree: Tree,
  selection: EditorSelection,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  images?: ImageResourceManager,
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  const seen = new Set<SyntaxNode>()
  const imageRangesByRange: Array<Array<{ from: number; to: number }>> = []
  for (const range of visibleRanges) {
    const imageRanges: Array<{ from: number; to: number }> = []
    imageRangesByRange.push(imageRanges)
    visitRange(tree, range.from, range.to, (node) => {
      if (node.name === 'Image' && isInlineForm(node, doc)) {
        imageRanges.push({ from: node.from, to: node.to })
      }
    })
    imageRanges.sort((a, b) => a.from - b.from)
  }
  for (let i = 0; i < visibleRanges.length; i++) {
    const range = visibleRanges[i]!
    const imageRanges = imageRangesByRange[i]!
    visitRange(tree, range.from, range.to, (node) => {
      if (seen.has(node)) {
        return
      }
      const active = selectionTouchesRange(selection, node.from, node.to)
      switch (node.name) {
        case 'Autolink': {
          seen.add(node)
          const url = childNamed(node, 'URL')
          if (url && url.to > url.from) {
            out.push((active ? linkMarkDeco : renderedLinkMarkDeco).range(url.from, url.to))
          }
          if (!active) {
            for (const mark of linkMarks(node)) {
              out.push(hideDeco.range(mark.from, mark.to))
            }
          }
          return
        }
        case 'Link': {
          if (!isInlineForm(node, doc)) {
            return // 引用式：源码降级
          }
          seen.add(node)
          const marks = linkMarks(node)
          const opener = marks[0]
          const closer = marks[1]
          if (!opener || !closer || closer.from <= opener.to) {
            return
          }
          // 内容 span：扣除内部图片（其自身是替换装饰，mark 不得跨越）
          const innerCuts = imageRanges.filter((r) => r.from >= opener.to && r.to <= closer.from)
          for (const run of subtractIntervals(opener.to, closer.from, innerCuts)) {
            if (run.to > run.from) {
              out.push((active ? linkMarkDeco : renderedLinkMarkDeco).range(run.from, run.to))
            }
          }
          if (!active) {
            out.push(hideDeco.range(opener.from, opener.to))
            // 尾部整体隐藏："]" + "(" + URL + 标题 + ")"（连续区间，mark/URL
            // 均在其中——对内联形态该区间不含正文）
            out.push(hideDeco.range(closer.from, node.to))
          }
          return
        }
        case 'Image': {
          if (!isInlineForm(node, doc)) {
            return // 引用式：源码降级
          }
          if (active) {
            return // 光标进入该图片范围，显示源码供编辑
          }
          seen.add(node)
          const marks = linkMarks(node)
          const opener = marks[0]
          const closer = marks[1]
          const src = linkHrefOf(doc, node)
          if (!opener || !closer || src === null) {
            return
          }
          const alt = doc.sliceString(opener.to, closer.from)
          out.push(imageWidgetDeco(src, alt, images).range(node.from, node.to))
          return
        }
        default:
          return
      }
    })
  }
  return out
}

/** 构建视口内链接/图片间接装饰（#10 契约入口；区间表版之上的包装） */
export function buildLinkImageDecorations(
  doc: Text,
  tree: Tree,
  selection: EditorSelection,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  images?: ImageResourceManager,
): DecorationSet {
  return RangeSet.of(
    buildLinkImageDecorationRanges(doc, tree, selection, visibleRanges, images),
    true,
  )
}

/**
 * 构建视口内双链装饰区间（#11）：逐行扫描 shared/wikilink 的出现表——
 * - 光标在该双链范围外：`[[…]]` 整体替换为显示文字 widget
 * - 光标进入该双链范围：mark 标记整个出现（源码可编辑）
 * - 代码上下文（围栏/缩进/行内代码）与 frontmatter 内不装饰（源码降级）
 * 纯数据输入，可单测直驱。
 */
export function buildWikilinkDecorationRanges(
  doc: Text,
  tree: Tree,
  selection: EditorSelection,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  fm: SourceRange | null,
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  const seenLines = new Set<number>()
  for (const range of visibleRanges) {
    let pos = range.from
    while (pos < range.to) {
      const line = doc.lineAt(pos)
      if (!seenLines.has(line.number)) {
        seenLines.add(line.number)
        for (const hit of scanWikilinksInLine(line.text, line.from)) {
          if (wikilinkSuppressed(tree, hit.from, fm)) {
            continue
          }
          const parsed = parseWikilinkInner(hit.inner)
          if (!parsed) {
            continue // 防御：扫描已过滤非法形态
          }
          out.push(
            selectionTouchesRange(selection, hit.from, hit.to)
              ? wikilinkMarkDeco.range(hit.from, hit.to)
              : wikilinkWidgetDeco(parsed.display).range(hit.from, hit.to),
          )
        }
      }
      if (line.to >= range.to) {
        break
      }
      pos = line.to + 1
    }
  }
  return out
}

/** 树上查找 pos 处链接的目标 href；非链接位置返回 null */
function hrefAtPos(doc: Text, tree: Tree, pos: number): { href: string; from: number; to: number } | null {
  const chain = chainAt(tree, pos)
  const node = chain.find((n) => n.name === 'Link' || n.name === 'Autolink')
  if (!node) {
    return null
  }
  const href = linkHrefOf(doc, node)
  if (href === null) {
    return null
  }
  return { href, from: node.from, to: node.to }
}

/** 激活指定源位置的链接：命中即上报意图并返回 true */
export function activateLinkAtPos(
  view: EditorView,
  pos: number,
  postActivate: (href: string, srcStart: number, srcEnd: number) => void,
): boolean {
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return false
  }
  const hit = hrefAtPos(state.doc, field.tree, Math.max(0, Math.min(pos, state.doc.length)))
  if (!hit) {
    return false
  }
  postActivate(hit.href, hit.from, hit.to)
  return true
}

/** 激活指定源位置的双链：命中即上报意图（原始 target：`|` 之前原文）并
 *  返回 true。替换区间（光标在范围外时的 widget）仍有文档坐标，命中判定与源码态
 *  一致。#11。 */
export function activateWikilinkAtPos(
  view: EditorView,
  pos: number,
  postActivate: (target: string, srcStart: number, srcEnd: number) => void,
): boolean {
  const state = view.state
  const field = state.field(liveDecorationsField, false)
  if (!field) {
    return false
  }
  const clamped = Math.max(0, Math.min(pos, state.doc.length))
  const line = state.doc.lineAt(clamped)
  const hit = wikilinkAtCol(line.text, clamped - line.from)
  if (!hit) {
    return false
  }
  // wikilinkAtCol 产出的是行内相对坐标：换算回全文绝对 offset（抑制检查与
  // 上报区间都以全文坐标为契约）
  const from = line.from + hit.from
  const to = line.from + hit.to
  if (parseWikilinkInner(hit.inner) === null || wikilinkSuppressed(field.tree, from, field.fm)) {
    return false
  }
  const pipeAt = hit.inner.indexOf('|')
  const target = pipeAt >= 0 ? hit.inner.slice(0, pipeAt) : hit.inner
  postActivate(target, from, to)
  return true
}

/** Ctrl/Cmd+mousedown 直接激活；普通单击在 mouseup 才确认，以免拖选时跳转。
 *  #11：双链先于普通链接判定（两者语法不重叠，先后仅是判定次序） */
export function makeLinkMouseDownHandler(
  postActivate: (href: string, srcStart: number, srcEnd: number) => void,
  postActivateWikilink?: (target: string, srcStart: number, srcEnd: number) => void,
): (event: MouseEvent, view: EditorView) => boolean {
  return (event, view) => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
    // 6.43 API 面：posAtCoords 直接返回 number | null
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) {
      return false
    }
    if (postActivateWikilink && activateWikilinkAtPos(view, pos, postActivateWikilink)) {
      event.preventDefault()
      return true
    }
    if (activateLinkAtPos(view, pos, postActivate)) {
      event.preventDefault()
      return true
    }
    return false
  }
}

/** live 链接/图片/双链扩展装配：视口间接装饰 + 图片资源管理器 + 点击 */
export function createLinkInteractions(opts: {
  postActivate: (href: string, srcStart: number, srcEnd: number) => void
  images: ImageResourceManager
  /** #11 双链激活回调（缺省不启用双链点击判定） */
  postActivateWikilink?: (target: string, srcStart: number, srcEnd: number) => void
}): Extension {
  const onMouseDown = makeLinkMouseDownHandler(opts.postActivate, opts.postActivateWikilink)
  let pendingClick: { target: 'wikilink' | 'link'; pos: number; x: number; y: number } | null = null
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = this.build(view)
      }
      update(update: import('@codemirror/view').ViewUpdate) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = this.build(update.view)
        }
        // 视口外移除的 widget 无销毁回调：以 isConnected 兜底释放图片槽位
        opts.images.sweep()
      }
      private build(view: EditorView): DecorationSet {
        const field = view.state.field(liveDecorationsField, false)
        if (!field) {
          return RangeSet.empty
        }
        // #11：链接/图片（树驱动）与双链（行扫描）的区间合并为同一装饰集
        // ——两类语法不重叠，RangeSet.of 排序去重即可
        return RangeSet.of(
          [
            ...buildLinkImageDecorationRanges(
              view.state.doc,
              field.tree,
              view.state.selection,
              view.visibleRanges,
              opts.images,
            ),
            ...buildWikilinkDecorationRanges(
              view.state.doc,
              field.tree,
              view.state.selection,
              view.visibleRanges,
              field.fm,
            ),
          ],
          true,
        )
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event: MouseEvent, view: EditorView) {
          pendingClick = null
          if (event.ctrlKey || event.metaKey) return onMouseDown(event, view)
          if (event.button !== 0) return false
          const target = event.target instanceof Element ? event.target : null
          const rendered = target?.closest('[data-vsidian-rendered-wikilink="true"]')
            ? 'wikilink'
            : target?.closest('[data-vsidian-rendered-link="true"]') ? 'link' : null
          if (!rendered) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos !== null) pendingClick = { target: rendered, pos, x: event.clientX, y: event.clientY }
          return false
        },
        mouseup(event: MouseEvent, view: EditorView) {
          const pending = pendingClick
          pendingClick = null
          if (!pending || event.button !== 0 ||
            Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 5) return false
          const hit = pending.target === 'wikilink'
            ? Boolean(opts.postActivateWikilink &&
              (activateWikilinkAtPos(view, pending.pos, opts.postActivateWikilink) ||
                (pending.pos > 0 && activateWikilinkAtPos(view, pending.pos - 1, opts.postActivateWikilink))))
            : activateLinkAtPos(view, pending.pos, opts.postActivate) ||
              (pending.pos > 0 && activateLinkAtPos(view, pending.pos - 1, opts.postActivate))
          if (hit) event.preventDefault()
          return hit
        },
      },
    },
  )
}
