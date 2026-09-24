// 阅读块切分（工单 #8）：markdown-it token 流驱动的块模型。
//
// 坐标契约（#6 确立，#7/#9 依赖，本票保持不变）：
// - start/end 为 LF 全文 UTF-16 code unit offset（与协议 SerChange、
//   CodeMirror 文档定位同构），end 不含块尾换行符
// - 每个块元素携带 data-vsidian-src-start/end；#7 按需挂载以块为最小单位，
//   #9 任务勾选经 li/checkbox 的 marker 区间锚点构造精确 edit.request
//
// #8 语义升级（取代 #6 的手工行切分）：
// - 语义来源换成 markdown-it token 流（规格「阅读渲染用 markdown-it」）：
//   嵌套引用/列表、setext 标题、围栏语言等按真实 Markdown 语义切块渲染；
//   行内粗斜体/行内代码经渲染器输出语义标签（em/strong/code）
// - 安全：html:false + 渲染后 DOM 纵深净化（见 readingMarkdown.ts）；
//   frontmatter 手工提取为源码块（两视图共用 markdownDoc.frontmatterRange，
//   头块内 `#` 等不作为 Markdown 解析——语义一致的边界）
// - 大围栏按行细分：超过 FENCE_CHUNK_LINES 行的围栏按块切分为多个挂载
//   单位（#7「超大单块」限制的缓解；细分后仍按 #7 机制挂载/回收）
// - 未支持语法（脚注 [^1]、定义列表等）由 markdown-it 按普通段落文本
//   渲染——保留原文的局部源码降级，不触发整篇改写
import { frontmatterRange } from './markdownDoc'
import { maskCodeSpanPipes } from './tableCells'
import {
  buildLineBounds,
  createMarkdownRenderer,
  renderTokenHtml,
  type ReadingRenderEnv,
} from './readingMarkdown'
import type { Env, Token } from 'markdown-it'

/** 阅读块种类（#8：完整 Markdown 语义；#12 表格独立成块） */
export type ReadingBlockKind =
  | 'frontmatter'
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'blockquote'
  | 'code-block'
  | 'hr'
  | 'table'

/** 一个阅读块：源文本的 [start, end) 区间、渲染身份与内部 HTML */
export interface ReadingBlock {
  kind: ReadingBlockKind
  start: number
  end: number
  /** 该块的内部 HTML（markdown-it 渲染产物或转义源码；进 DOM 前再净化） */
  html: string
  /** heading 专用：1-6 */
  level?: 1 | 2 | 3 | 4 | 5 | 6
  /** 块内子锚点（升序；列表块为各 li 的源 start）：锚点映射按最细粒度
   *  归位（live↔reading 光标恢复到项级），挂载单位仍是整块（#7 语义） */
  itemAnchors?: number[]
}

/** 超过该行数的围栏代码块按行细分为多个挂载单位（#7 超大单块缓解） */
export const FENCE_CHUNK_LINES = 60

/** 单例渲染器（规则链一次装配；渲染是同步纯函数，实例可安全复用） */
const md = createMarkdownRenderer()

/** 表格块规则早于 inline code 切格；等长替身避免改变 token.map 与源锚点。 */
function protectCodePipes(body: string): { parseText: string; marker: string | null } {
  if (!body.includes('|') || !body.includes('`')) {
    return { parseText: body, marker: null }
  }
  let code = 0xe000
  while (code <= 0xf8ff && (
    body.includes(String.fromCharCode(code)) ||
    body.toLowerCase().includes(encodeURIComponent(String.fromCharCode(code)).toLowerCase())
  )) {
    code += 1
  }
  if (code > 0xf8ff) {
    return { parseText: body, marker: null }
  }
  const marker = String.fromCharCode(code)
  const parseText = body.split('\n').map((line) => maskCodeSpanPipes(line, marker)).join('\n')
  return { parseText, marker: parseText === body ? null : marker }
}

function restoreCodePipes(tokens: Token[], marker: string): void {
  const encodedMarker = new RegExp(encodeURIComponent(marker), 'gi')
  for (const token of tokens) {
    if (token.content.includes(marker)) {
      token.content = token.content.replaceAll(marker, '|')
    }
    if (token.attrs) {
      for (const attr of token.attrs) {
        if (typeof attr[1] === 'string') {
          attr[1] = attr[1].replaceAll(marker, '|').replace(encodedMarker, '%7C')
        }
      }
    }
    if (token.children) {
      restoreCodePipes(token.children, marker)
    }
  }
}

function escapeHtml(s: string): string {
  return md.utils.escapeHtml(s)
}

/** heading_open 的 tag（h1..h6）→ 级别；其他返回 null */
function headingLevelOfTag(tag: string): 1 | 2 | 3 | 4 | 5 | 6 | null {
  const m = /^h([1-6])$/.exec(tag)
  return m ? (Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6) : null
}

/** 围栏 chunk 的内部 HTML（转义源码 + 语言类） */
function fenceChunkHtml(text: string, from: number, to: number, info: string): string {
  const lang = /^[\w-]+/.exec(info.trim())?.[0]
  const cls = lang ? ` class="language-${lang}"` : ''
  return `<pre><code${cls}>${escapeHtml(text.slice(from, to))}</code></pre>`
}

/**
 * 把 LF 全文切分为阅读块序列（单调有序、互不重叠）。
 * 解析与渲染在切块时一次完成（块携带 html），#7 挂载路径不再解析。
 */
export function splitReadingBlocks(text: string): ReadingBlock[] {
  const blocks: ReadingBlock[] = []
  const env = buildLineBounds(text)
  const fm = frontmatterRange(text)

  if (fm) {
    const fmEndLine = lineNumberOfOffset(env, fm.end)
    blocks.push({
      kind: 'frontmatter',
      start: 0,
      end: fm.end,
      html: `<pre class="vsidian-reading-frontmatter-text">${escapeHtml(text.slice(0, fm.end))}</pre>`,
    })
    return splitBody(text, env, fmEndLine + 1, blocks)
  }
  return splitBody(text, env, 0, blocks)
}

/** offset → 0 基行号（env.lineEnds 上的线性定位；仅 frontmatter 边界用） */
function lineNumberOfOffset(env: ReadingRenderEnv, offset: number): number {
  for (let i = env.lineEnds.length - 1; i >= 0; i--) {
    if ((env.lineEnds[i] ?? 0) <= offset) {
      return i
    }
  }
  return 0
}

/** body 切分：baseLine 为 body 首行的 0 基行号（token.map 加该基值） */
function splitBody(
  text: string,
  env: ReadingRenderEnv,
  baseLine: number,
  blocks: ReadingBlock[],
): ReadingBlock[] {
  const bodyStart = env.lineStarts[baseLine] ?? text.length
  const body = text.slice(bodyStart)
  // 渲染规则的 li 锚点换算需要 body 基行（渲染是同步的，env 变更不外泄）
  env.baseLine = baseLine
  if (body.trim() === '') {
    return blocks
  }
  const { parseText, marker } = protectCodePipes(body)
  const tokens = md.parse(parseText, env as unknown as Env)
  if (marker) {
    restoreCodePipes(tokens, marker)
  }
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i]!
    if (token.level !== 0 || token.hidden) {
      i += 1
      continue
    }
    if (token.nesting === 1) {
      // 复合块：找到配对的 close（nesting 归零）
      let depth = 0
      let j = i
      for (; j < tokens.length; j++) {
        depth += tokens[j]!.nesting
        if (depth === 0) {
          break
        }
      }
      const group = tokens.slice(i, j + 1)
      const map = token.map
      if (map) {
        pushBlock(text, env, baseLine, blocks, group, map, token)
      }
      i = j + 1
      continue
    }
    // 叶子块（fence / hr / code_block / html_block 等）
    const map = token.map
    if (map && token.type !== 'html_block') {
      pushBlock(text, env, baseLine, blocks, [token], map, token)
    }
    i += 1
  }
  return blocks
}

/** 按块种类落块（围栏超过阈值时按行细分） */
function pushBlock(
  text: string,
  env: ReadingRenderEnv,
  baseLine: number,
  blocks: ReadingBlock[],
  group: Token[],
  map: [number, number],
  opener: Token,
): void {
  const startLine = baseLine + map[0]
  let endLine = baseLine + map[1] - 1 // map 的 end 为下一块首行
  // 列表等复合块的 map 可能吞并尾随空行：锚点收缩到内容末行
  while (endLine > startLine && (env.lineStarts[endLine] ?? 0) === (env.lineEnds[endLine] ?? 0)) {
    endLine -= 1
  }
  const start = env.lineStarts[startLine] ?? 0
  const end = env.lineEnds[endLine] ?? Math.max(start, text.length - 1)

  if (opener.type === 'fence') {
    const fenceLines = endLine - startLine + 1
    if (fenceLines > FENCE_CHUNK_LINES) {
      // 按行细分：每片 ≤ FENCE_CHUNK_LINES 行；首片含开围栏行、末片含闭围栏行
      const info = opener.info ?? ''
      const hasClose = text.slice(env.lineStarts[endLine] ?? 0, end).trimStart().startsWith(opener.markup)
      let idx = 0
      for (let l = startLine; l <= endLine; l += FENCE_CHUNK_LINES) {
        const chunkEnd = Math.min(l + FENCE_CHUNK_LINES - 1, endLine)
        const cs = env.lineStarts[l] ?? start
        const ce = env.lineEnds[chunkEnd] ?? end
        // 内容行去掉围栏标记行（首片去首行、末片去尾行）
        const contentFrom = l === startLine ? (env.lineEnds[l] ?? cs) + 1 : cs
        const contentTo = chunkEnd === endLine && hasClose ? (env.lineStarts[chunkEnd] ?? ce) : ce
        blocks.push({
          kind: 'code-block',
          start: cs,
          end: ce,
          html: fenceChunkHtml(text, contentFrom, contentTo, info),
        })
        idx += 1
        void idx
      }
      return
    }
    blocks.push({ kind: 'code-block', start, end, html: renderTokenHtml(md, group, env) })
    return
  }

  switch (opener.type) {
    case 'heading_open': {
      const level = headingLevelOfTag(opener.tag)
      blocks.push({ kind: 'heading', start, end, level: level ?? 1, html: renderTokenHtml(md, group, env) })
      return
    }
    case 'paragraph_open':
      blocks.push({ kind: 'paragraph', start, end, html: renderTokenHtml(md, group, env) })
      return
    case 'blockquote_open':
      blocks.push({ kind: 'blockquote', start, end, html: renderTokenHtml(md, group, env) })
      return
    case 'bullet_list_open':
    case 'ordered_list_open': {
      const itemAnchors: number[] = []
      for (const t of group) {
        if (t.type === 'list_item_open' && t.map) {
          const s = env.lineStarts[(env.baseLine ?? 0) + t.map[0]]
          if (typeof s === 'number' && s >= start) {
            itemAnchors.push(s)
          }
        }
      }
      blocks.push({ kind: 'list', start, end, html: renderTokenHtml(md, group, env), itemAnchors })
      return
    }
    case 'hr':
      blocks.push({ kind: 'hr', start, end, html: renderTokenHtml(md, group, env) })
      return
    case 'table_open':
      // #12：表格独立成块（markdown-it GFM 渲染真实 <table>，列对齐保留在
      // th/td 的内联 style；块整体只读，与挂载/回收机制同构）
      blocks.push({ kind: 'table', start, end, html: renderTokenHtml(md, group, env) })
      return
    default:
      // code_block（缩进代码）与其他形态：按段落语义渲染（局部降级）
      blocks.push({ kind: 'paragraph', start, end, html: renderTokenHtml(md, group, env) })
      return
  }
}

/**
 * 源 offset → 块身份（#6 语义保持）：
 * - offset 落在块区间内返回该块
 * - 落在块间缝隙（换行/空行）返回其前最近的内容块（floor 语义）
 * - 超出末块 end 返回末块；空列表返回 null
 */
export function blockForOffset(
  blocks: ReadingBlock[],
  offset: number,
): ReadingBlock | null {
  if (blocks.length === 0) {
    return null
  }
  let result: ReadingBlock | null = null
  for (const b of blocks) {
    if (b.start <= offset && offset < b.end) {
      return b
    }
    if (offset >= b.end) {
      result = b // 记录最后越过的块
    } else {
      break // 已到 offset 之前的缝隙
    }
  }
  return result ?? blocks[blocks.length - 1]!
}
