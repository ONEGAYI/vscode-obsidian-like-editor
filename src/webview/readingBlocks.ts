// 阅读块切分（工单 #6）：把 LF 全文切成携带源区间的块序列。
//
// 坐标契约（#7/#8/#9 依赖，改动需同步这三票的设计）：
// - start/end 为 LF 全文 UTF-16 code unit offset（与协议 SerChange、
//   CodeMirror 文档定位同构），end 不含块尾换行符
// - 阅读视图的每个块元素以 data-oile-src-start/end 携带该区间；#7 按需
//   挂载以块为最小单位创建/回收 DOM，#9 任务勾选经 task.marker 区间构造
//   精确的 edit.request（走共同保存/历史/冲突链路）
// - 本模块为 #6 基础版：段落级手工切分，不解析完整 Markdown 语义；
//   #8 引入 markdown-it 后由其 token 流取代，但源区间坐标约定不变
//
// 切分规则（基础版）：
// - 代码围栏（```/~~~ ≥3）之间整体一个 code-block（含围栏行）；未闭合
//   持续到文档末尾；围栏内的伪标题/伪任务不解析
// - ATX 标题行（复用 live 装饰的 parseHeadingLine，保证两视图标题判定
//   一致）单独成块
// - 列表标记行（≤3 空格缩进 + -/*/+ + 空白）单独成块；带 `[ ]`/`[x]`/
//   `[X]` + 空白/行尾的为任务项，task.marker 恰为方括号三字符区间
// - 其余连续非空行合并为一个 paragraph（空行分隔；标题/列表行打断）
// - 深缩进（>3 空格）列表标记按普通段落处理（切片限制，#8 修正）
import { parseHeadingLine, type HeadingLineInfo } from './headings'

/** 阅读块种类（基础版；#8 由完整 Markdown 语义细分） */
export type ReadingBlockKind = 'heading' | 'paragraph' | 'list-item' | 'code-block'

/** 任务语义入口：#9 据此把 `[ ]`/`[x]` 区间替换为勾选状态 */
export interface TaskMarker {
  /** `[` 字符的源 offset */
  markerStart: number
  /** `]` 之后（markerStart + 3） */
  markerEnd: number
  checked: boolean
}

/** 一个阅读块：源文本的 [start, end) 区间及其渲染身份 */
export interface ReadingBlock {
  kind: ReadingBlockKind
  start: number
  end: number
  /** heading 专用：1-6 */
  level?: HeadingLineInfo['level']
  /** list-item 专用：任务项的标记区间 */
  task?: TaskMarker
}

/** 列表标记行：前缀长度与是否任务 */
const LIST_RE = /^( {0,3})([-*+])(\s+)/
const TASK_RE = /^( {0,3})[-*+] \[([ xX])\]( |$)/

/** 围栏行：``` 或 ~~~（≥3 个），返回围栏字符与缩进 */
function fenceOf(line: string): { ch: string; indent: string } | null {
  const m = /^( {0,3})(`{3,}|~{3,})/.exec(line)
  if (!m) {
    return null
  }
  return { ch: m[2]!.charAt(0), indent: m[1]! }
}

/**
 * 把 LF 全文切分为阅读块序列（单调有序、互不重叠、互不相邻）。
 */
export function splitReadingBlocks(text: string): ReadingBlock[] {
  const blocks: ReadingBlock[] = []
  const lines = text.split('\n')
  // 每行行尾（不含换行）的累计 offset，供段落 flush O(1) 取末行 end
  const lineEnds: number[] = []
  let offset = 0 // 当前行首的全文 offset
  let fence: { ch: string; start: number } | null = null
  let paragraph: { start: number; endLine: number } | null = null

  const flushParagraph = (): void => {
    if (!paragraph) {
      return
    }
    blocks.push({ kind: 'paragraph', start: paragraph.start, end: lineEnds[paragraph.endLine]! })
    paragraph = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineStart = offset
    const lineEnd = lineStart + line.length
    lineEnds.push(lineEnd)
    offset = lineEnd + 1

    // 围栏态：累积到闭合围栏（同字符）或文档末尾
    if (fence) {
      const f = fenceOf(line)
      if (f && f.ch === fence.ch) {
        blocks.push({ kind: 'code-block', start: fence.start, end: lineEnd })
        fence = null
      }
      continue
    }

    const f = fenceOf(line)
    if (f) {
      flushParagraph()
      fence = { ch: f.ch, start: lineStart }
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      continue
    }

    const heading = parseHeadingLine(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'heading', start: lineStart, end: lineEnd, level: heading.level })
      continue
    }

    const task = TASK_RE.exec(line)
    if (task) {
      flushParagraph()
      const markerStart = lineStart + task[1]!.length + 2 // 缩进 + "- "
      blocks.push({
        kind: 'list-item',
        start: lineStart,
        end: lineEnd,
        task: { markerStart, markerEnd: markerStart + 3, checked: task[2] !== ' ' },
      })
      continue
    }

    if (LIST_RE.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'list-item', start: lineStart, end: lineEnd })
      continue
    }

    // 普通行：并入相邻段落（行号连续）
    if (paragraph && paragraph.endLine === i - 1) {
      paragraph.endLine = i
    } else {
      flushParagraph()
      paragraph = { start: lineStart, endLine: i }
    }
  }

  flushParagraph()
  if (fence) {
    // 未闭合围栏：持续到文档末尾
    blocks.push({ kind: 'code-block', start: fence.start, end: text.length })
  }
  return blocks
}

/**
 * 源 offset → 块身份：
 * - offset 落在块区间内返回该块
 * - 落在块间缝隙（换行/空行）返回其前最近的内容块（floor 语义——
 *   光标停在行尾换行处应定位到刚离开的段落）
 * - 超出末块 end（文档尾部换行/越界）返回末块
 * - 空列表返回 null
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
