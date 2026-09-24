// 编辑区查找：匹配计算与 Live 侧装饰（工单 #14）。
//
// 架构（依据 ADR-0005 / mvp.md「查找与跳转必须定位屏外内容」）：
// - 匹配基于 webview 全文文本模型（CM6 doc 的字符串形态）计算——纯数据，
//   与 DOM 无关；屏外（未挂载块 / CM6 视口外）内容同样命中
// - 不为查找常驻全文 DOM：匹配数是数据不是 DOM；渲染高亮只做视口内——
//   当前匹配为直接装饰（StateField，保证滚动后始终可见），全部匹配为
//   间接装饰（ViewPlugin 按 visibleRanges 过滤，与 liveDecorations 同构）
// - 码点语义：匹配起止不得落在代理对中间（emoji 安全）；坐标为 LF 全文
//   UTF-16 code unit offset（与协议 SerChange / CM6 同构）
// - 大小写语义固定：默认区分大小写；大小写不敏感是显式选项（UI 切换），
//   不做改变区间长度的跨形态折叠（'ß'≠'SS'）
// - 查找是纯只读操作：会话不 dispatch 文本变更、不发出站消息（#14 契约）
import { RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/** 一个匹配：全文 UTF-16 code unit 的 [from, to) 区间 */
export interface FindMatch {
  from: number
  to: number
}

/** 查找稳定类名（ADR-0004 稳定样式入口；`oile-` 前缀） */
export const FIND_CLASS_NAMES = {
  /** 浮动查找面板容器（webview 内，非 VSCode 原生 find） */
  panel: 'oile-find',
  open: 'oile-find-open',
  input: 'oile-find-input',
  count: 'oile-find-count',
  countEmpty: 'oile-find-count-empty',
  caseToggle: 'oile-find-case',
  caseActive: 'oile-find-case-active',
  prev: 'oile-find-prev',
  next: 'oile-find-next',
  close: 'oile-find-close',
  /** Live 全部匹配装饰（视口内间接装饰） */
  match: 'oile-find-match',
  /** Live 当前匹配装饰（直接装饰） */
  matchCurrent: 'oile-find-match-current',
  /** 阅读视图当前匹配所在块的高亮（块级） */
  readingHit: 'oile-reading-find-hit',
} as const

// ---- 码点边界工具 ----

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 位置 p 是否是码点边界（p 处不会紧跟在高位代理之后劈开代理对） */
function isCodePointBoundary(text: string, p: number): boolean {
  if (p <= 0 || p >= text.length) {
    return true
  }
  return !(isHighSurrogate(text.charCodeAt(p - 1)) && isLowSurrogate(text.charCodeAt(p)))
}

/** 正则元字符转义（字面量查找语义） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 全文匹配计算（纯函数）：
 * - 空查询 / 无命中返回 []
 * - 从左到右、非重叠（下一轮从当前匹配 to 起扫）
 * - 匹配起止必须在码点边界上：命中落在代理对中间时丢弃该命中并前进
 *   一个单元继续扫（emoji 安全；行为由测试锁定）
 * - caseSensitive=false 时按 'i' 正则做大小写不敏感匹配，区间长度与
 *   原文本一致（不做 'ß'/'SS' 类跨形态折叠）
 */
export function computeFindMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): FindMatch[] {
  if (query === '' || query.length > text.length) {
    return []
  }
  const out: FindMatch[] = []
  if (caseSensitive) {
    // 快路径：原生 indexOf（UTF-16 精确匹配）+ 边界校验
    let at = text.indexOf(query)
    while (at !== -1) {
      if (isCodePointBoundary(text, at) && isCodePointBoundary(text, at + query.length)) {
        out.push({ from: at, to: at + query.length })
        at = text.indexOf(query, at + query.length)
      } else {
        // 命中劈开代理对：丢弃，前进一个单元重扫
        at = text.indexOf(query, at + 1)
      }
    }
    return out
  }
  // 大小写不敏感：'iu' 正则按码点迭代（构造失败——如查询含孤代理——
  // 退化为小写化 indexOf 路径，保持可用）
  try {
    const re = new RegExp(escapeRegExp(query), 'giu')
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const from = m.index
      const to = from + m[0].length
      if (isCodePointBoundary(text, from) && isCodePointBoundary(text, to)) {
        out.push({ from, to })
      }
      re.lastIndex = to
    }
    return out
  } catch {
    const lowerText = text.toLowerCase()
    const lowerQuery = query.toLowerCase()
    if (lowerQuery === '') {
      return []
    }
    let at = lowerText.indexOf(lowerQuery)
    while (at !== -1) {
      if (isCodePointBoundary(text, at) && isCodePointBoundary(text, at + query.length)) {
        out.push({ from: at, to: at + query.length })
        at = lowerText.indexOf(lowerQuery, at + query.length)
      } else {
        at = lowerText.indexOf(lowerQuery, at + 1)
      }
    }
    return out
  }
}

/**
 * 参考位置起的当前匹配序号（0 基；无匹配为 -1 语义由调用方处理）：
 * 取首个 from >= ref 的匹配；ref 之后无匹配时回绕到首个（循环导航语义）。
 */
export function matchIndexFrom(matches: readonly FindMatch[], ref: number): number {
  if (matches.length === 0) {
    return 0
  }
  for (let i = 0; i < matches.length; i++) {
    if (matches[i]!.from >= ref) {
      return i
    }
  }
  return 0
}

// ---- Live 侧装饰 ----

/** 查找状态（CM6 StateField）：匹配集 + 当前序号 + 当前匹配直接装饰。
 *  匹配坐标随计算时的文档快照固定；文档变化后由控制器重算并整组替换
 *  （版本失效策略：重算时机 = 任何查找交互前的 freshness 校验）。 */
export interface FindDecoState {
  matches: readonly FindMatch[]
  index: number
  /** 当前匹配 mark（update 时按 tr.state.doc 构建，facet 直接供给） */
  decos: DecorationSet
}

/** 匹配集替换效应（整组替换；空集即清空装饰） */
export const setFindMatches = StateEffect.define<{ matches: readonly FindMatch[]; index: number }>()

const currentMatchDeco = Decoration.mark({ class: FIND_CLASS_NAMES.matchCurrent })
const allMatchDeco = Decoration.mark({ class: FIND_CLASS_NAMES.match })

/** 当前匹配 mark（跨行匹配不可能出现：查询不含换行；防御性截到行尾） */
function currentMatchRanges(
  doc: { lineAt(p: number): { from: number; to: number } },
  s: { matches: readonly FindMatch[]; index: number },
): Array<Range<Decoration>> {
  const m = s.matches[s.index]
  if (!m) {
    return []
  }
  const line = doc.lineAt(m.from)
  const to = Math.min(m.to, line.to)
  if (to <= m.from) {
    return []
  }
  return [currentMatchDeco.range(m.from, to)]
}

const emptyDecos = RangeSet.of([] as Array<Range<Decoration>>, true)

export const findStateField = StateField.define<FindDecoState>({
  create: () => ({ matches: [], index: 0, decos: emptyDecos }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFindMatches)) {
        return {
          matches: e.value.matches,
          index: e.value.index,
          decos: RangeSet.of(currentMatchRanges(tr.state.doc, e.value), true),
        }
      }
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.decos),
})

/** 全部匹配间接装饰：仅视口内的匹配生成 mark（不为查找常驻全文 DOM） */
function viewportMatchRanges(
  doc: { length: number; lineAt(p: number): { from: number; to: number } },
  visibleRanges: ReadonlyArray<{ from: number; to: number }>,
  matches: readonly FindMatch[],
): Array<Range<Decoration>> {
  const out: Array<Range<Decoration>> = []
  for (const range of visibleRanges) {
    for (const m of matches) {
      if (m.to <= range.from) {
        continue
      }
      if (m.from >= range.to) {
        break // matches 有序，其后全在区间外
      }
      const line = doc.lineAt(m.from)
      const to = Math.min(m.to, line.to)
      if (to > m.from) {
        out.push(allMatchDeco.range(m.from, to))
      }
    }
  }
  return out
}

const findViewportPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = RangeSet.of(
        viewportMatchRanges(view.state.doc, view.visibleRanges, view.state.field(findStateField).matches),
        true,
      )
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setFindMatches)))
      ) {
        this.decorations = RangeSet.of(
          viewportMatchRanges(
            update.state.doc,
            update.view.visibleRanges,
            update.state.field(findStateField).matches,
          ),
          true,
        )
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** 查找装饰装配：当前匹配（直接，StateField 供给）+ 全部匹配（视口内间接） */
export const findDecorations: Extension = [findStateField, findViewportPlugin]
