// Live 视图链接与图片（工单 #10）：间接装饰（按 visibleRanges）+ Ctrl/Cmd
// 单击跳转意图上报。
//
// 装饰语义（与既有间接装饰同类，ADR-0005 / #8 分工沿用）：
// - 链接内容 span：oile-link 稳定类名（Obsidian .cm-link 方向）——活动与
//   非活动行都标记（样式语义）；仅非活动行隐藏首尾标记与 URL 尾部
//   （源码可编辑语义：光标所在行显示原文）
// - 图片：非活动行整体替换为 LiveImageWidget（进入视口才创建 DOM，
//   离开视口由 CM6 移除、经 ImageResourceManager.sweep 释放）；活动行
//   保持源码
// - 引用式链接/图片（[t][ref]）：本票不解析引用定义，保持源码降级
//   （阅读视图由 markdown-it 完整解析——差异见选择器映射表已知限制）
// - 自动链接 <https://…>：URL 即内容，标记 span + 非活动行隐藏尖括号
//
// 点击语义：单击 = CM6 默认（光标编辑）；Ctrl/Cmd+单击 = 跳转意图上报
// （原始 URI + 源区间），执行归宿主（URI 解析与白名单在宿主侧）。
import { EditorSelection, RangeSet, Text, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { chainAt, visitRange } from './markdownDoc'
import { liveDecorationsField, isLineActive } from './liveDecorations'
import { IMAGE_CLASS_NAMES, type ImageResourceManager } from './imageResource'

/** #10 链接稳定类名（图片类名复用 IMAGE_CLASS_NAMES.image） */
export const LINK_CLASS_NAMES = {
  /** 链接内容 span（Obsidian `.cm-link`） */
  link: 'oile-link',
} as const

const linkMarkDeco = Decoration.mark({ class: LINK_CLASS_NAMES.link })
const hideDeco = Decoration.replace({})

/** 无管理器形态（纯构建直驱）的缓存键（模块级常量对象） */
const NO_MANAGER = {}

/** live 图片 widget 装饰缓存：按管理器实例隔离（同 src/alt 复用同一实例，
 *  RangeSet.eq 成立；不同管理器/会话不得共享 widget 实例） */
const imageWidgetDecos = new WeakMap<object, Map<string, ReturnType<typeof Decoration.replace>>>()

function imageWidgetDeco(src: string, alt: string, images: ImageResourceManager | undefined) {
  const holder: object = images ?? NO_MANAGER
  let cache = imageWidgetDecos.get(holder)
  if (!cache) {
    cache = new Map()
    imageWidgetDecos.set(holder, cache)
  }
  const key = `${src}\u0000${alt}`
  let deco = cache.get(key)
  if (!deco) {
    deco = Decoration.replace({ widget: new LiveImageWidget(src, alt, images) })
    cache.set(key, deco)
  }
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
    span.dataset['oileImgState'] = 'loading'
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
 * 构建视口内链接/图片间接装饰（纯数据输入，可单测直驱）。
 * visitRange 相交访问可能重复命中跨区间边界的节点——以节点 from 去重。
 */
export function buildLinkImageDecorations(
  doc: Text,
  tree: Tree,
  selection: EditorSelection,
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  images?: ImageResourceManager,
): DecorationSet {
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
      const lineNo = doc.lineAt(Math.min(node.from, doc.length)).number
      const active = isLineActive(selection, doc, lineNo)
      switch (node.name) {
        case 'Autolink': {
          seen.add(node)
          const url = childNamed(node, 'URL')
          if (url && url.to > url.from) {
            out.push(linkMarkDeco.range(url.from, url.to))
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
              out.push(linkMarkDeco.range(run.from, run.to))
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
            return // 活动行显示源码（可编辑）
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
  return RangeSet.of(out, true)
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

/** mousedown 语义：Ctrl/Cmd 按下且命中链接才激活（preventDefault 并吞掉
 *  CM6 默认处理）；其余交还编辑器（普通单击 = 光标编辑） */
export function makeLinkMouseDownHandler(
  postActivate: (href: string, srcStart: number, srcEnd: number) => void,
): (event: MouseEvent, view: EditorView) => boolean {
  return (event, view) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return false
    }
    // 6.43 API 面：posAtCoords 直接返回 number | null
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) {
      return false
    }
    if (activateLinkAtPos(view, pos, postActivate)) {
      event.preventDefault()
      return true
    }
    return false
  }
}

/** live 链接/图片扩展装配：视口间接装饰 + 图片资源管理器 + Ctrl/Cmd 单击 */
export function createLinkInteractions(opts: {
  postActivate: (href: string, srcStart: number, srcEnd: number) => void
  images: ImageResourceManager
}): Extension {
  const onMouseDown = makeLinkMouseDownHandler(opts.postActivate)
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
        return buildLinkImageDecorations(
          view.state.doc,
          field.tree,
          view.state.selection,
          view.visibleRanges,
          opts.images,
        )
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(event: MouseEvent, view: EditorView) {
          return onMouseDown(event, view)
        },
      },
    },
  )
}
