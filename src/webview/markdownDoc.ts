// Markdown 文档工具（工单 #8）：live 装饰与阅读视图共用的文档级判定与
// 语法树查询。
//
// 职责：
// - frontmatterRange：`---` 头块的边界判定。live 装饰与阅读切块必须用同
//   一判定——frontmatter 内的 `#`、列表等不作为 Markdown 语法呈现（两视
//   图语义一致的边界来源），frontmatter 本体按源码呈现（局部降级语义）
// - markdownTreeParser：@codemirror/lang-markdown 的 markdownLanguage 解析
//   器（GFM 默认启用：任务列表 TaskMarker / 表格 / 删除线），live 装饰的
//   唯一语义来源（#5 行级正则判定由此取代，代码围栏内的伪标题不再误判）；
//   #105 起追加 Highlight 扩展（`==高亮==`，lezer 默认不产该节点）
// - docInput：CM6 Text → @lezer Input（lineChunks 形态）。解析直接读
//   Text 的行结构，不为每次解析复制整篇字符串
// - visitRange / chainAt：语法树区间查询，基于 childAfter（TreeBuffer 上
//   为二分查找）的下降遍历——查询成本与区间大小和树深度相关，不随文档
//   体量线性增长（装饰增量维护的性能前提，见 ADR-0005）
import type { Text } from '@codemirror/state'
import { markdownLanguage } from '@codemirror/lang-markdown'
import type { InlineContext, MarkdownParser } from '@lezer/markdown'
import type { Input, SyntaxNode, Tree } from '@lezer/common'

/** 源文本区间（UTF-16 offset，end 不含）——与协议 SerChange 坐标同构 */
export interface SourceRange {
  start: number
  end: number
}

/** 高亮定界符（#105）：配对解析为 Highlight 节点、定界符转 HighlightMark。
 *  形态为结构化字面量（DelimiterType 兼容），避免为本扩展引入未声明的
 *  @lezer/markdown 直接依赖 */
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' }

/** Unicode 标点类（CommonMark flanking 判定用；@lezer/markdown 内部同款）。
 *  \p{S}/\p{P} 属性转义自 ES2018 起受支持，宿主（node18/chrome118）恒可用 */
const PUNCTUATION = /[\p{S}\p{P}]/u

/**
 * live 装饰使用的 Markdown 解析器（#105）：markdownLanguage 已含 GFM 扩展
 * （任务列表 / 表格 / 删除线），此处 configure 在既有扩展链上合并追加
 * `==高亮==` 行内标记——照 GFM Strikethrough 的 delimiter 机制，连续两个
 * `=` 按两侧紧贴空白/标点判定 open/close（flanking），配对产 Highlight
 * 节点（首末 HighlightMark 夹内容区间）。残缺与空格紧贴形态不配对（普通
 * 文本降级）；`=` 的块级语义（Setext 下划线）在块层先行解析，不受 inline
 * 扩展影响；代码上下文（行内/围栏）内容为字面文本天然不产节点。live
 * 装饰、大纲透传与 webview/formatOperations 的两态切换共用本语义来源
 * （AGENTS.md「行内围栏扩展约定」的 node 登记）。
 */
export const markdownTreeParser: MarkdownParser =
  (markdownLanguage.parser as MarkdownParser).configure({
  defineNodes: [
    { name: 'Highlight' },
    { name: 'HighlightMark' },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61) {
          return -1
        }
        // flanking 判定与 Strikethrough 同款：紧贴空白禁配，标点按
        // 左右附着性放宽（CommonMark emphasis 的通用口径）
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = before === '' || /\s/u.test(before)
        const sAfter = after === '' || /\s/u.test(after)
        const pBefore = PUNCTUATION.test(before)
        const pAfter = PUNCTUATION.test(after)
        return cx.addDelimiter(HighlightDelim, pos, pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter))
      },
      after: 'Emphasis',
    },
  ],
})

/** frontmatter 判定的有界扫描长度（B-3 截断口径单一事实源：live 装饰与
 *  阅读切块共用——结束行落在界限外时不识别，两视图一致降级为普通 Markdown） */
export const FM_SCAN_LIMIT = 8192

/**
 * frontmatter 边界：文档首行恰为 `---`（容许行尾空格），且在第 2 行之后
 * 存在 `---` 或 `...` 结束行时，返回 [0, 结束行行尾) 区间；否则 null
 * （未闭合不视为 frontmatter，按普通 Markdown 处理——两视图同判定）。
 * 扫描有界（FM_SCAN_LIMIT）：超长头块按未识别降级，两视图同源同判定。
 */
export function frontmatterRange(text: string): SourceRange | null {
  if (text.length > FM_SCAN_LIMIT) {
    text = text.slice(0, FM_SCAN_LIMIT)
  }
  const lines = text.split('\n')
  const isFenceLine = (line: string): boolean => /^(-{3}|\.{3})\s*$/.test(line)
  if (lines.length < 3 || !isFenceLine(lines[0]!)) {
    return null
  }
  let end = -1
  for (let i = 2; i < lines.length; i++) {
    if (isFenceLine(lines[i]!)) {
      end = i
      break
    }
  }
  if (end < 0) {
    return null
  }
  let offset = 0
  for (let i = 0; i < end; i++) {
    offset += lines[i]!.length + 1
  }
  return { start: 0, end: offset + lines[end]!.length }
}

/**
 * CM6 Text 的 @lezer Input 适配（lineChunks 契约）：chunk 返回
 * [pos, 行尾) 的内容（不含换行），pos 恰在换行处时返回单个 "\n"。
 */
export function docInput(doc: Text): Input {
  return {
    length: doc.length,
    lineChunks: true,
    chunk(pos: number): string {
      const line = doc.lineAt(pos)
      if (pos < line.to) {
        return doc.sliceString(pos, line.to)
      }
      return pos < doc.length ? '\n' : ''
    },
    read(from: number, to: number): string {
      return doc.sliceString(from, to)
    },
  }
}

/** [from, to] 相交的命名节点（前序访问，path 为不含自身的祖先链） */
export function visitRange(
  tree: Tree,
  from: number,
  to: number,
  visit: (node: SyntaxNode, path: SyntaxNode[]) => void,
): void {
  const rec = (node: SyntaxNode, path: SyntaxNode[]): void => {
    visit(node, path)
    const children = intersectingChildren(node, from, to)
    const nextPath = [...path, node]
    for (const child of children) {
      rec(child, nextPath)
    }
  }
  rec(tree.topNode, [])
}

/**
 * ATXHeading{1..6} / SetextHeading{1..2} → 级别；其余 null。标题级判定的
 * 单一事实源（live 装饰与大纲共用，两处语义须一致——曾为两份重复实现，
 * 漂移会造成装饰与大纲的层级判定分叉）。
 */
export function headingLevelOf(name: string): number | null {
  let m = /^ATXHeading([1-6])$/.exec(name)
  if (m) {
    return Number(m[1])
  }
  m = /^SetextHeading([1-2])$/.exec(name)
  if (m) {
    return Number(m[1])
  }
  return null
}

/** node 的子节点中与 [from, to] 相交者（升序） */
function intersectingChildren(node: SyntaxNode, from: number, to: number): SyntaxNode[] {
  const out: SyntaxNode[] = []
  // childAfter：首个结束位置越过 from 的子节点（TreeBuffer 上为二分查找）
  let cur = node.childAfter(from)
  while (cur && cur.from <= to) {
    out.push(cur)
    cur = cur.nextSibling
  }
  return out
}

/** pos 处的命名节点链（根→叶） */
export function chainAt(tree: Tree, pos: number): SyntaxNode[] {
  const chain: SyntaxNode[] = []
  let node = tree.topNode
  for (;;) {
    const child = node.childAfter(pos - 1)
    if (!child || child.from > pos || child.to < pos) {
      break
    }
    chain.push(child)
    node = child
  }
  return chain
}
