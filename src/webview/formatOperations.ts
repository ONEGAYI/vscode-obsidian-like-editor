import type { SyntaxNode } from '@lezer/common'
import type { FormatOperationId } from '../shared/formatOperations'
import { markdownTreeParser } from './markdownDoc'
import { parseTableDelimiter, tableRowCellsForColumns } from './tableCells'
import type { TableRegion } from './tableRegion'

export interface FormatSelection { from: number; to: number }
export interface FormatChange { from: number; to: number; insert: string }
export interface FormatPlan {
  changes: FormatChange[]
  selection?: { anchor: number; head?: number }
}
export type FormatAction = 'toggle' | 'add' | 'remove'

/** 行内围栏单一登记表（#103 两处登记约定）：包裹规划在此消费，
 *  quickActionState 的节点名、mark 字符与包裹判定也一律从本表派生——
 *  新增围栏只登记此处 + shared 注册表，即自动继承全部行为 */
export const INLINE: Partial<Record<FormatOperationId, { mark: string; node: string }>> = {
  bold: { mark: '**', node: 'StrongEmphasis' },
  italic: { mark: '*', node: 'Emphasis' },
  strikethrough: { mark: '~~', node: 'Strikethrough' },
  inlineCode: { mark: '`', node: 'InlineCode' },
  highlight: { mark: '==', node: 'Highlight' },
}

function nodesAt(root: SyntaxNode, pos: number): SyntaxNode[] {
  const result: SyntaxNode[] = []
  for (let node: SyntaxNode | null = root; node; node = node.parent) result.unshift(node)
  // Lezer resolveInner 在边界处有方向性：优先右侧可编辑文本。
  const resolved = root.resolveInner(pos, 1)
  result.length = 0
  for (let node: SyntaxNode | null = resolved; node; node = node.parent) result.unshift(node)
  return result
}

function matchingSpan(root: SyntaxNode, name: string, from: number, to: number): SyntaxNode | null {
  const ancestors = nodesAt(root, from)
  return ancestors.reverse().find((node) => node.name === name &&
    node.from < from && node.to > to) ?? null
}

function blockedInline(root: SyntaxNode, from: number, to: number, target: string): boolean {
  const blocked = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock'])
  if (target !== 'InlineCode') blocked.add('InlineCode')
  for (const pos of [from, Math.max(from, to - 1)]) {
    if (nodesAt(root, pos).some((node) => blocked.has(node.name))) return true
  }
  return false
}

function inlineSpans(root: SyntaxNode, name: string, from: number, to: number): SyntaxNode[] {
  const spans: SyntaxNode[] = []
  const walk = (node: SyntaxNode): void => {
    if (node.to < from || node.from > to) return
    if (node.name === name && node.from >= from && node.to <= to) spans.push(node)
    for (let child = node.childAfter(from - 1); child && child.from <= to; child = child.nextSibling) {
      walk(child)
    }
  }
  walk(root)
  return spans.sort((a, b) => a.from - b.from)
}

function mergeIntervals(intervals: FormatSelection[]): FormatSelection[] {
  const merged: FormatSelection[] = []
  for (const interval of intervals.sort((a, b) => a.from - b.from)) {
    if (interval.from >= interval.to) continue
    const last = merged.at(-1)
    if (last && interval.from <= last.to) last.to = Math.max(last.to, interval.to)
    else merged.push({ ...interval })
  }
  return merged
}

function codeSpanMarkers(content: string): { open: string; close: string } {
  const delimiter = codeDelimiter(content)
  // CommonMark 在内容以反引号起止时要求用空格隔开定界符；两侧均有
  // 原始空格时也要各补一个，抵消代码段解析器对首尾各一个空格的裁剪。
  const padding = content.startsWith('`') || content.endsWith('`') ||
    content.startsWith(' ') && content.endsWith(' ') ? ' ' : ''
  return { open: delimiter + padding, close: padding + delimiter }
}

function rewriteInlineLine(text: string, root: SyntaxNode, name: string, mark: string,
  lineFrom: number, lineTo: number, from: number, to: number,
  action: FormatAction): FormatChange | null {
  const touched = inlineSpans(root, name, lineFrom, lineTo).filter((span) =>
    span.firstChild && span.lastChild && span.firstChild.to < to && span.lastChild.from > from)
  const changeFrom = Math.min(from, ...touched.map((span) => span.from))
  const changeTo = Math.max(to, ...touched.map((span) => span.to))
  const line = text.slice(changeFrom, changeTo)
  const spans = inlineSpans(root, name, changeFrom, changeTo)
  const masked = new Array<boolean>(line.length).fill(false)
  for (const span of spans) {
    if (!span.firstChild || !span.lastChild || span.firstChild === span.lastChild) continue
    for (const marker of [span.firstChild, span.lastChild]) {
      for (let i = marker.from; i < marker.to; i++) masked[i - changeFrom] = true
    }
  }
  const positions = new Array<number>(line.length + 1).fill(0)
  let plain = ''
  for (let i = 0; i < line.length; i++) {
    positions[i + 1] = positions[i] + (masked[i] ? 0 : 1)
    if (!masked[i]) plain += line[i]
  }
  const selected = { from: positions[from - changeFrom]!, to: positions[to - changeFrom]! }
  if (selected.from >= selected.to) return null
  const existing = mergeIntervals(spans.map((span) => ({
    from: positions[span.firstChild!.to - changeFrom]!,
    to: positions[span.lastChild!.from - changeFrom]!,
  })))
  const allApplied = existing.some((span) => span.from <= selected.from && span.to >= selected.to)
  const shouldRemove = action === 'remove' || action === 'toggle' && allApplied
  const next = shouldRemove
    ? mergeIntervals(existing.flatMap((span) => span.to <= selected.from || span.from >= selected.to
      ? [span] : [
        { from: span.from, to: Math.min(span.to, selected.from) },
        { from: Math.max(span.from, selected.to), to: span.to },
      ]))
    : mergeIntervals([...existing, selected])
  let rendered = ''
  let cursor = 0
  for (const span of next) {
    const content = plain.slice(span.from, span.to)
    const markers = name === 'InlineCode'
      ? codeSpanMarkers(content) : { open: mark, close: mark }
    rendered += plain.slice(cursor, span.from) + markers.open + content + markers.close
    cursor = span.to
  }
  rendered += plain.slice(cursor)
  return rendered === line ? null : { from: changeFrom, to: changeTo, insert: rendered }
}

function clearInlineLine(text: string, root: SyntaxNode, lineFrom: number, lineTo: number,
  from: number, to: number): FormatChange | null {
  const found: Array<{ node: SyntaxNode; first: SyntaxNode; last: SyntaxNode }> = []
  for (const config of Object.values(INLINE)) {
    if (!config) continue
    for (const node of inlineSpans(root, config.node, lineFrom, lineTo)) {
      if (node.firstChild && node.lastChild && node.firstChild !== node.lastChild) {
        found.push({ node, first: node.firstChild, last: node.lastChild })
      }
    }
  }
  const touched = found.filter((span) => span.first.to < to && span.last.from > from)
  if (!touched.length) return null
  const changeFrom = Math.min(from, ...touched.map((span) => span.node.from))
  const changeTo = Math.max(to, ...touched.map((span) => span.node.to))
  const line = text.slice(changeFrom, changeTo)
  const masked = new Array<boolean>(line.length).fill(false)
  const styles: Array<{ from: number; to: number; open: string; close: string; kind: string }> = []
  for (const span of found) {
    if (span.node.from < changeFrom || span.node.to > changeTo) continue
    for (const marker of [span.first, span.last]) {
      for (let i = marker.from; i < marker.to; i++) masked[i - changeFrom] = true
    }
    styles.push({ from: span.first.to, to: span.last.from,
      open: text.slice(span.first.from, span.first.to),
      close: text.slice(span.last.from, span.last.to), kind: span.node.name })
  }
  const positions = new Array<number>(line.length + 1).fill(0)
  let plain = ''
  for (let i = 0; i < line.length; i++) {
    positions[i + 1] = positions[i] + (masked[i] ? 0 : 1)
    if (!masked[i]) plain += line[i]
  }
  const chosen = { from: positions[from - changeFrom]!, to: positions[to - changeFrom]! }
  const remaining = styles.flatMap((style) => {
    const start = positions[style.from - changeFrom]!
    const end = positions[style.to - changeFrom]!
    if (end <= chosen.from || start >= chosen.to) return [{ from: start, to: end,
      open: style.open, close: style.close }]
    return [
      { from: start, to: Math.min(end, chosen.from) },
      { from: Math.max(start, chosen.to), to: end },
    ].filter((item) => item.from < item.to)
      .map((item) => ({ ...item, ...(
        style.kind === 'InlineCode' ? codeSpanMarkers(plain.slice(item.from, item.to))
          : { open: style.open, close: style.close }) }))
  })
  const opens = new Map<number, typeof remaining>()
  const closes = new Map<number, typeof remaining>()
  for (const style of remaining) {
    opens.set(style.from, [...(opens.get(style.from) ?? []), style])
    closes.set(style.to, [...(closes.get(style.to) ?? []), style])
  }
  let rendered = ''
  for (let pos = 0; pos <= plain.length; pos++) {
    for (const style of (closes.get(pos) ?? []).sort((a, b) => b.from - a.from)) rendered += style.close
    for (const style of (opens.get(pos) ?? []).sort((a, b) => b.to - a.to)) rendered += style.open
    if (pos < plain.length) rendered += plain[pos]
  }
  return rendered === line ? null : { from: changeFrom, to: changeTo, insert: rendered }
}

function clearInlinePlan(text: string, range: FormatSelection, root: SyntaxNode): FormatPlan | null {
  let { from, to } = range
  if (from === to) {
    const active = nodesAt(root, from).find((node) =>
      Object.values(INLINE).some((config) => config?.node === node.name))
    if (!active?.firstChild || !active.lastChild) return null
    from = active.firstChild.to
    to = active.lastChild.from
  }
  const changes: FormatChange[] = []
  let lineFrom = text.lastIndexOf('\n', from - 1) + 1
  while (lineFrom <= to) {
    const eol = text.indexOf('\n', lineFrom)
    const lineTo = eol < 0 ? text.length : eol
    const partFrom = Math.max(lineFrom, from)
    const partTo = Math.min(lineTo, to)
    if (partFrom < partTo) {
      const change = clearInlineLine(text, root, lineFrom, lineTo, partFrom, partTo)
      if (change) changes.push(change)
    }
    if (eol < 0 || eol >= to) break
    lineFrom = eol + 1
  }
  return changes.length ? { changes } : null
}

function wordRange(text: string, pos: number): FormatSelection | null {
  const lineFrom = text.lastIndexOf('\n', pos - 1) + 1
  const breakAt = text.indexOf('\n', pos)
  const lineTo = breakAt < 0 ? text.length : breakAt
  const line = text.slice(lineFrom, lineTo)
  const offset = pos - lineFrom
  const Segmenter = Intl.Segmenter
  if (Segmenter) {
    const segments = [...new Segmenter(undefined, { granularity: 'word' }).segment(line)]
      .filter((segment) => segment.isWordLike)
    const right = segments.find((segment) => segment.index <= offset &&
      segment.index + segment.segment.length > offset || segment.index === offset)
    const left = segments.find((segment) => segment.index + segment.segment.length === offset)
    const picked = right ?? (offset === line.length ? left : null)
    if (picked) return { from: lineFrom + picked.index, to: lineFrom + picked.index + picked.segment.length }
  }
  // 仅旧运行时缺少 Segmenter 时降级；VSCode 1.86 的 Chromium 运行时有该 API。
  const regex = /[\p{L}\p{N}_]+/gu
  for (const match of line.matchAll(regex)) {
    const start = match.index
    const end = start + match[0].length
    if (start <= offset && offset < end || offset === line.length && end === offset) {
      return { from: lineFrom + start, to: lineFrom + end }
    }
  }
  return null
}

function codeDelimiter(content: string): string {
  return '`'.repeat(Math.max(1, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length + 1)))
}

function inlinePlan(text: string, op: FormatOperationId, range: FormatSelection,
  root: SyntaxNode, action: FormatAction): FormatPlan | null {
  const config = INLINE[op]!
  let { from, to } = range
  if (blockedInline(root, from, to, config.node)) return null
  const isCursor = from === to
  const active = matchingSpan(root, config.node, from, to)
  if (isCursor && active) {
    if (action === 'add') return null
    const first = active.firstChild
    const last = active.lastChild
    if (!first || !last) return null
    return { changes: [{ from: active.from, to: active.to,
      insert: text.slice(first.to, last.from) }] }
  }
  if (isCursor) {
    if (action === 'remove') return null
    const word = wordRange(text, from)
    if (word) { from = word.from; to = word.to }
  }
  const mark = op === 'inlineCode' ? codeDelimiter(text.slice(from, to)) : config.mark
  if (from === to) {
    return { changes: [{ from, to, insert: mark + mark }],
      selection: { anchor: from + mark.length } }
  }
  const changes: FormatChange[] = []
  let lineFrom = text.lastIndexOf('\n', from - 1) + 1
  while (lineFrom <= to) {
    const lineBreak = text.indexOf('\n', lineFrom)
    const lineTo = lineBreak < 0 ? text.length : lineBreak
    const partFrom = Math.max(from, lineFrom)
    const partTo = Math.min(to, lineTo)
    if (partFrom < partTo) {
      const line = text.slice(lineFrom, lineTo)
      const prefix = /^(\s*(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s*))/u.exec(line)?.[0].length ?? 0
      const start = Math.max(partFrom, lineFrom + prefix)
      if (start < partTo && !blockedInline(root, start, partTo, config.node)) {
        let change: FormatChange | null = null
        if (inlineSpans(root, config.node, lineFrom, lineTo).some((span) =>
          span.from <= partTo && span.to >= start)) {
          change = rewriteInlineLine(text, root, config.node, mark,
            lineFrom, lineTo, start, partTo, action)
        } else if (action !== 'remove') {
          const content = text.slice(start, partTo)
          const markers = op === 'inlineCode' ? codeSpanMarkers(content)
            : { open: mark, close: mark }
          change = { from: start, to: partTo,
            insert: markers.open + content + markers.close }
        }
        if (change) changes.push(change)
      }
    }
    if (lineBreak < 0 || lineBreak >= to) break
    lineFrom = lineBreak + 1
  }
  return changes.length ? { changes } : null
}

function linePlan(text: string, op: FormatOperationId, range: FormatSelection): FormatPlan | null {
  const lines: FormatChange[] = []
  let start = text.lastIndexOf('\n', range.from - 1) + 1
  while (start <= range.to) {
    const eol = text.indexOf('\n', start)
    const end = eol < 0 ? text.length : eol
    if (start < range.to || range.from === range.to) {
      const line = text.slice(start, end)
      if (line.trim()) {
        const indent = /^\s*/u.exec(line)![0]
        const body = line.slice(indent.length)
        const heading = /^(?:#{1,6}\s+|[^\n]+\n[=-]+$)/u.exec(body)
        const clean = body.replace(/^#{1,6}\s+/u, '')
          .replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, '')
          .replace(/^>\s?/u, '')
        let next = line
        if (op.startsWith('heading')) {
          const level = op === 'headingNone' ? 0 : Number(op.slice(7))
          next = indent + (level ? '#'.repeat(level) + ' ' : '') +
            (op === 'headingNone' ? clean : clean)
          if (op === 'headingNone' && !heading) next = line
        } else if (op === 'bulletList') next = indent +
          (/^[-+*]\s+(?!\[[ xX]\]\s)/u.test(body) ? clean : '- ' + clean)
        else if (op === 'orderedList') next = indent +
          (/^\d+[.)]\s+/u.test(body) ? clean : '1. ' + clean)
        else if (op === 'taskList') next = indent +
          (/^[-+*]\s+\[[ xX]\]\s+/u.test(body) ? clean : '- [ ] ' + clean)
        else if (op === 'quote') next = indent +
          (/^>\s?/u.test(body) ? clean : '> ' + clean)
        if (next !== line) lines.push({ from: start, to: end, insert: next })
      }
    }
    if (eol < 0 || eol >= range.to) break
    start = eol + 1
  }
  return lines.length ? { changes: lines } : null
}

function fencePlan(text: string, op: 'codeBlock' | 'blockMath', range: FormatSelection, root: SyntaxNode): FormatPlan | null {
  let { from, to } = range
  const selected = from !== to
  const initialNodes = nodesAt(root, from)
  const inTable = initialNodes.some((node) => node.name === 'TableCell' || node.name === 'TableHeader' || node.name === 'Table')
  if (inTable) return null
  const inList = initialNodes.some((node) => node.name === 'ListItem')
  const inQuote = initialNodes.some((node) => node.name === 'Blockquote')
  const unwrap = (node: SyntaxNode): FormatPlan | null => {
    const lines = text.slice(node.from, node.to).split('\n')
    if (lines.length < 3) return null
    const lineStart = text.lastIndexOf('\n', node.from - 1) + 1
    const prefix = text.slice(lineStart, node.from)
    const continuation = inQuote ? prefix : inList ? ' '.repeat(prefix.length) : ''
    const content = lines.slice(1, -1).map((line) =>
      line.startsWith(continuation) ? line.slice(continuation.length) : line)
    return { changes: [{ from: node.from, to: node.to,
      insert: content.join('\n' + continuation) }] }
  }
  if (op === 'codeBlock' && selected) {
    const fence = initialNodes.find((node) => node.name === 'FencedCode')
    if (fence && from === fence.from && to === fence.to) return unwrap(fence)
  }
  if (!selected) {
    if (op === 'blockMath') {
      const math = [...initialNodes].reverse().find((node) => node.name === 'Paragraph')
      if (math) {
        const lines = text.slice(math.from, math.to).split('\n')
        const last = lines.at(-1)?.replace(/^\s*>\s?|^\s+/u, '')
        if (lines.length >= 3 && lines[0] === '$$' && last === '$$') return unwrap(math)
      }
    }
    const fence = initialNodes.find((node) => node.name === 'FencedCode')
    if (op === 'codeBlock' && fence) {
      const plan = unwrap(fence)
      if (plan) return plan
    }
    const paragraph = [...initialNodes].reverse().find((node) => node.name === 'Paragraph')
    if (paragraph) { from = paragraph.from; to = paragraph.to }
  }
  if (selected && (inList || inQuote)) {
    const kind = inList ? 'ListItem' : 'Blockquote'
    const startContainer = initialNodes.find((node) => node.name === kind)
    const endContainer = nodesAt(root, Math.max(from, to - 1)).find((node) => node.name === kind)
    if (!startContainer || !endContainer || startContainer.from !== endContainer.from ||
        startContainer.to !== endContainer.to) return null
    const sourceFrom = text.lastIndexOf('\n', from - 1) + 1
    const eol = text.indexOf('\n', to)
    const sourceTo = eol < 0 ? text.length : eol
    const source = text.slice(sourceFrom, sourceTo)
    const match = /^(\s*(?:[-+*]|\d+[.)])\s+|\s*>\s?)/u.exec(source)
    if (match && from >= sourceFrom + match[0].length) {
      const prefix = match[0]
      const continuation = inQuote ? '> ' : ' '.repeat(prefix.length)
      const separator = inQuote ? '\n>\n' : '\n\n'
      const left = text.slice(sourceFrom + prefix.length, from)
      const picked = text.slice(from, to)
      const right = text.slice(to, sourceTo)
      const marker = op === 'blockMath' ? '$$' : '`'.repeat(Math.max(3,
        ...[...picked.matchAll(/`+/gu)].map((m) => m[0].length + 1)))
      const replacement = (left ? prefix + left + separator + continuation + marker : prefix + marker) +
        '\n' + continuation + picked + '\n' + continuation + marker +
        (right ? separator + continuation + right : '')
      return { changes: [{ from: sourceFrom, to: sourceTo, insert: replacement }] }
    }
  }
  if (!selected && (inList || inQuote)) {
    const sourceFrom = text.lastIndexOf('\n', from - 1) + 1
    const source = text.slice(sourceFrom, to)
    const match = /^(\s*(?:[-+*]|\d+[.)])\s+|\s*>\s?)/u.exec(source)
    if (match) {
      const prefix = match[0]
      const content = source.slice(prefix.length)
      const marker = op === 'blockMath' ? '$$' : '`'.repeat(Math.max(3,
        ...[...content.matchAll(/`+/gu)].map((m) => m[0].length + 1)))
      const continuation = inQuote ? prefix : ' '.repeat(prefix.length)
      return { changes: [{ from: sourceFrom, to,
        insert: prefix + marker + '\n' + continuation + content + '\n' + continuation + marker }] }
    }
  }
  const content = text.slice(from, to)
  const marker = op === 'blockMath' ? '$$' : '`'.repeat(Math.max(3, ...[...content.matchAll(/`+/gu)].map((m) => m[0].length + 1)))
  const left = text.slice(0, from)
  const right = text.slice(to)
  const lineFrom = left.lastIndexOf('\n') + 1
  const leading = left.slice(lineFrom)
  const nextBreak = right.indexOf('\n')
  const trailing = nextBreak < 0 ? right : right.slice(0, nextBreak)
  const atLineStart = leading.length === 0
  const atLineEnd = trailing.length === 0
  const leftBreak = atLineStart ? (left && !left.endsWith('\n\n') ? '\n' : '') : '\n\n'
  const rightBreak = atLineEnd ? (right && !right.startsWith('\n\n') ? '\n' : '') : '\n\n'
  const wrapped = marker + '\n' + content + '\n' + marker
  return { changes: [{ from, to, insert: leftBreak + wrapped + rightBreak }],
    ...(content ? {} : { selection: { anchor: from + leftBreak.length + marker.length + 1 } }) }
}

/** 分割线插入（#106）：块级插入、无两态语义。光标所在行的左右文字各自
 *  成段，分割线前后各留一空行（已有空行不叠加，口径对齐 tableCreate）；
 *  选区折叠到起点——选区内容（含跨行选区的中间行）保留在分割线之后，
 *  与 fencePlan 等兄弟插入操作的保留口径一致；光标落在分割线行尾——
 *  该行是控制域（触及显源码），插入后立即可续改。 */
function horizontalRulePlan(text: string, range: FormatSelection): FormatPlan {
  const lineStart = text.lastIndexOf('\n', range.from - 1) + 1
  const nextBreak = text.indexOf('\n', range.to)
  const lineEnd = nextBreak < 0 ? text.length : nextBreak
  const before = text.slice(0, lineStart)
  const after = text.slice(lineEnd)
  const left = text.slice(lineStart, range.from)
  const right = text.slice(range.from, lineEnd)
  const leftText = left.trim() ? left : ''
  const rightText = right.trim() ? right : ''
  const previousLine = before.endsWith('\n') ? before.slice(0, -1).split('\n').at(-1) ?? '' : ''
  const nextLine = after.startsWith('\n') ? after.slice(1).split('\n', 1)[0] ?? '' : ''
  const prefix = leftText ? `${leftText}\n\n` : previousLine.trim() ? '\n' : ''
  const suffix = rightText ? `\n\n${rightText}` : nextLine.trim() ? '\n' : ''
  const marker = '---'
  return {
    changes: [{ from: lineStart, to: lineEnd, insert: prefix + marker + suffix }],
    selection: { anchor: lineStart + prefix.length + marker.length },
  }
}

/** 纯文本规划：所有 changes 按原文 UTF-16 坐标，调用方一次 CM6 事务提交。 */
export function planFormatOperation(
  text: string, op: FormatOperationId, range: FormatSelection, region?: TableRegion | null,
  action: FormatAction = 'toggle',
): FormatPlan | null {
  if (range.from < 0 || range.to < range.from || range.to > text.length) return null
  // 与 liveDecorations/outline 同一解析器（markdownTreeParser 含 #105
  // Highlight 扩展）：两态切换按节点命中依赖同一语义源
  const root = markdownTreeParser.parse(text).topNode
  if (region) {
    if (!INLINE[op] && op !== 'clearInline' && op !== 'link' && op !== 'inlineMath' && op !== 'wikilink') return null
    const offsets: number[] = []
    let cursor = region.tableFrom
    while (cursor <= text.length && offsets.length < region.rowTo + 3) {
      offsets.push(cursor)
      const eol = text.indexOf('\n', cursor)
      if (eol < 0) break
      cursor = eol + 1
    }
    const delimiter = offsets[1] === undefined ? '' : text.slice(offsets[1], text.indexOf('\n', offsets[1]) < 0
      ? text.length : text.indexOf('\n', offsets[1]))
    const columns = parseTableDelimiter(delimiter)?.length
    if (!columns || region.columnTo >= columns) return null
    const changes: FormatChange[] = []
    for (let row = region.rowFrom; row <= region.rowTo; row++) {
      const at = offsets[row === 0 ? 0 : row + 1]
      if (at === undefined) return null
      const eol = text.indexOf('\n', at)
      const line = text.slice(at, eol < 0 ? text.length : eol)
      const cells = tableRowCellsForColumns(line, at, columns)
      if (!cells) return null
      for (let col = region.columnFrom; col <= region.columnTo; col++) {
        const cell = cells[col]
        if (!cell) return null
        const cellText = text.slice(cell.contentFrom, cell.contentTo)
        const plan = planFormatOperation(cellText, op, { from: 0, to: cellText.length }, null, action)
        if (plan?.changes.length) {
          let rewritten = cellText
          for (const change of [...plan.changes].reverse()) {
            rewritten = rewritten.slice(0, change.from) + change.insert + rewritten.slice(change.to)
          }
          changes.push({ from: cell.contentFrom, to: cell.contentTo, insert: rewritten })
        }
      }
    }
    return changes.length ? { changes: changes.sort((a, b) => a.from - b.from) } : null
  }
  if (INLINE[op]) return inlinePlan(text, op, range, root, action)
  if (op === 'clearInline') return clearInlinePlan(text, range, root)
  if (op === 'codeBlock' || op === 'blockMath') return fencePlan(text, op, range, root)
  if (op === 'horizontalRule') return horizontalRulePlan(text, range)
  if (op.startsWith('heading')) {
    const setext = nodesAt(root, range.from).find((node) => /^SetextHeading[12]$/u.test(node.name))
    if (setext && (range.from === range.to || range.to <= setext.to)) {
      const level = Number(setext.name.at(-1))
      const target = op === 'headingNone' ? 0 : Number(op.slice(7))
      if (level === target) return null
      const heading = text.slice(setext.from, setext.to).split('\n')[0]!
      return { changes: [{ from: setext.from, to: setext.to,
        insert: target ? '#'.repeat(target) + ' ' + heading : heading }] }
    }
  }
  if (op.startsWith('heading') || op === 'bulletList' || op === 'orderedList' ||
      op === 'taskList' || op === 'quote') return linePlan(text, op, range)
  if (op === 'link' || op === 'inlineMath' || op === 'wikilink') {
    let { from, to } = range
    if (op === 'link') {
      const link = nodesAt(root, from).find((node) => node.name === 'Link')
      if (link && (from === to || from === link.from && to === link.to)) {
        const closeLabel = link.firstChild?.nextSibling
        if (closeLabel?.name === 'LinkMark') {
          return { changes: [{ from: link.from, to: link.to,
            insert: text.slice(link.from + 1, closeLabel.from) }] }
        }
      }
      if (from === to) {
        const word = wordRange(text, from)
        if (word) { from = word.from; to = word.to }
      }
    }
    const value = text.slice(from, to)
    const open = op === 'link' ? '[' : op === 'wikilink' ? '[[' : '$'
    const close = op === 'link' ? ']()' : op === 'wikilink' ? ']]' : '$'
    return { changes: [{ from, to, insert: open + value + close }],
      selection: value ? op === 'link' ? { anchor: from + open.length + value.length + 2 }
        : { anchor: from + open.length, head: from + open.length + value.length }
        : { anchor: from + open.length } }
  }
  return null
}
