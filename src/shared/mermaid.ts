// Mermaid 围栏形态学单一事实源（工单 #60）：语言标记为 `mermaid` 的围栏
// 代码块识别 + CommonMark 围栏状态机行扫描。live 装饰（liveMermaid.ts 的
// 增量行扫描）与阅读渲染（readingBlocks/readingMarkdown 的 fence 判定）
// 共用——两处对「什么算 mermaid 围栏」的判定必须一致，否则同一文本在
// 两种视图呈现不同语义。
//
// 判定规则（CommonMark 围栏代码块语义的子集 + mermaid 语言过滤）：
// - info string 精确匹配 `mermaid`（trim 后全等）：前后空白容忍、大小写
//   敏感（CommonMark info 惯例——`Mermaid` 是另一语言）；`mermaid xxx`
//   多词不命中（与 GitHub/Obsidian 口径一致，见 #60 实施记录）。
// - 围栏标记：3 个及以上反引号或波浪线，缩进 0-3 视觉列（≥4 为缩进代码块，
//   不是围栏——伪围栏不误渲染的判定口径；Tab 按 CommonMark 折算到下一 4 倍
//   制表位，行首 Tab 起步即 ≥4 列）。反引号围栏的 info 不得含反引号。
// - 闭合围栏：同字符、run ≥ 开启 run、缩进 0-3 视觉列、行内不得有其他内容。
// - 开启围栏之后、闭合之前的所有行是内容——内层伪围栏（更长外层围栏、
//   或非 mermaid 围栏内的 ```mermaid 文本）不产出（状态机天然抑制）。
// - 未闭合围栏（EOF）不产出：稳定降级为源码显示。
//
// 本模块不依赖 vscode/DOM/CM6（node 单测直驱；宿主与 webview 双产物共用）。
// 已知差异（记录于 docs/perf/2026-09-mermaid-rendering.md）：阅读侧由
// markdown-it 解析，列表/引用容器内嵌套围栏会渲染 mermaid；live 侧行扫描
// 同样识别 0-3 缩进围栏（嵌套列表场景对齐），引用行（> 前缀）不识别——
// live 显源码、阅读渲染图，降级方向安全。

/** #60 Mermaid 稳定类名（live widget 与阅读 fence 容器共用；Obsidian
 *  对应 `.mermaid`，见选择器映射表） */
export const MERMAID_CLASS_NAMES = {
  /** 渲染容器：live widget 外层与阅读围栏容器（挂载后内含 mermaid SVG 或降级内容） */
  diagram: 'vsidian-mermaid',
  /** 语法/渲染失败的降级态（错误信息 + 源码展示，可读可回到源码编辑） */
  error: 'vsidian-mermaid-error',
} as const

/** 容器 data 属性：围栏源码（转义后随块 html 输出，挂载钩子读取渲染） */
export const MERMAID_CODE_ATTR = 'data-vsidian-mermaid-code'

/** 容器 data 属性：渲染状态（loading/rendered/error；探针与重复渲染防护） */
export const MERMAID_STATE_ATTR = 'data-vsidian-mermaid-state'

/** 容器 data 属性：图形化渲染语言（#111 阅读容器标注，按钮组与弹窗消费） */
export const GRAPHIC_LANG_ATTR = 'data-vsidian-graphic-lang'

/** info string 是否标记渲染型围栏（trim 后全等、大小写敏感；判定源 =
 *  RENDERED_FENCE_LABELS 注册表——#111 起为图形化代码块注册表的共享侧
 *  事实源，webview 侧管线注册表见 graphicRenderers.ts，两侧键集一致性
 *  由契约测试钉住）。当前仅 mermaid；新增图形化渲染语言在此登记 */
export function isRenderedFenceInfo(info: string): boolean {
  return Object.prototype.hasOwnProperty.call(RENDERED_FENCE_LABELS, info.trim())
}

/**
 * 渲染型围栏的语言显示名（卡片编辑态的头部标签；键 = trim 后的 info）。
 * 当前仅 mermaid——未来新增「会被渲染成图形的围栏语言」（图表 DSL 等）
 * 时，在此登记显示名，并在围栏标志判定（FenceSpan.rendered 的渲染型
 * 语义）同步扩展；这类围栏编辑态走代码块卡片、呈现态让位专属渲染管线。
 */
export const RENDERED_FENCE_LABELS: Readonly<Record<string, string>> = {
  mermaid: 'Mermaid',
}

/** 一次围栏出现（无论语言；非 mermaid 围栏由增量重建消费以抑制嵌套伪围栏）。
 *  from/to 为 LF 全文 UTF-16 code unit offset：from 含开围栏行行首、
 *  to 含闭围栏行行尾（不含换行），与 MathOccurrence 的映射语义同构 */
export interface FenceSpan {
  from: number
  to: number
  /** 围栏字符（反引号或波浪线） */
  char: '`' | '~'
  /** 开围栏 run 长度（≥3） */
  run: number
  /** 是否渲染型围栏（RENDERED_FENCE_LABELS 命中；#111 起驱动图形化
   *  代码块交互：live widget 发射、卡片让位、阅读容器输出） */
  rendered: boolean
  /** 开围栏 info string 原文（#79 代码块卡片消费：语言路由与标签） */
  info: string
  /** 围栏内容（内容行以 \n 拼接，不含围栏标记行） */
  code: string
}

/** 窗口末尾仍开放的围栏（增量重建延伸扫描的驱动信息；也作为续扫输入——
 *  下一批行段以它为 initialOpen 传入，开放状态跨批延续） */
export interface OpenFence {
  from: number
  char: '`' | '~'
  run: number
  rendered: boolean
  /** 开围栏 info string 原文（闭合时随 FenceSpan 产出） */
  info: string
  /** 已累积的内容行（\n 拼接） */
  code: string
}

/** 窗口行扫描结果：已闭合围栏 + 末尾开放状态 */
export interface FenceScanResult {
  spans: FenceSpan[]
  open: OpenFence | null
}

/** 围栏开启/闭合匹配（rest 为剥缩进后的行内容）；返回 run 与 info，无则 null */
function matchFenceOpen(rest: string): { run: number; info: string; char: '`' | '~' } | null {
  const m = /^(`{3,}|~{3,})(.*)$/.exec(rest)
  if (!m) {
    return null
  }
  return { run: m[1]!.length, info: m[2] ?? '', char: m[1]![0]! as '`' | '~' }
}

/** rest 是否为闭合围栏（同字符 run ≥ openRun 且余文全空白） */
function isFenceClose(rest: string, char: '`' | '~', openRun: number): boolean {
  const m = new RegExp(`^(${char === '`' ? '`' : '~'}{${openRun},})(\\s*)$`).exec(rest)
  return m !== null
}

/** 行首缩进的视觉列数与剥除点（CommonMark 口径：Tab 折算到下一 4 倍制表位，
 *  一个 Tab = 推进到下一个 4 列边界——`\t```mermaid` 是 4 列缩进的缩进代码
 *  块，不开启围栏，与阅读侧 markdown-it 一致）；仅空格与 Tab 计入缩进 */
function indentColumns(line: string): { cols: number; restStart: number } {
  let col = 0
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === ' ') {
      col += 1
      i += 1
    } else if (ch === '\t') {
      col += 4 - (col % 4)
      i += 1
    } else {
      break
    }
  }
  return { cols: col, restStart: i }
}

/**
 * 扫描连续行集合中的全部围栏（CommonMark 围栏状态机；含非 mermaid 围栏）。
 * firstLineStart 为首行行首的全文 offset（围栏区间以全文坐标产出）。
 * initialOpen 为窗口起点之前已处的开放围栏（增量续扫时传入上一批的终态
 * open——只扫新行段、开放状态延续，闭合时产出含窗口外前缀的完整 code）。
 * 仅产出已闭合围栏；未闭合（EOF/窗口截断）不产出。
 * 纯函数，node 单测直驱；live 增量与阅读语义对照共用。
 */
export function scanFenceSpans(lines: readonly string[], firstLineStart: number): FenceSpan[] {
  return scanFencesDetailed(lines, firstLineStart).spans
}

/** 同 scanFenceSpans，另回报窗口末尾的开放围栏状态（增量重建延伸用） */
export function scanFencesDetailed(
  lines: readonly string[],
  firstLineStart: number,
  initialOpen: OpenFence | null = null,
): FenceScanResult {
  const spans: FenceSpan[] = []
  let open: { from: number; char: '`' | '~'; run: number; rendered: boolean; info: string; code: string[] } | null =
    initialOpen
      ? {
          from: initialOpen.from,
          char: initialOpen.char,
          run: initialOpen.run,
          rendered: initialOpen.rendered,
          info: initialOpen.info,
          code: initialOpen.code === '' ? [] : initialOpen.code.split('\n'),
        }
      : null
  let lineStart = firstLineStart
  for (const line of lines) {
    const { cols, restStart } = indentColumns(line)
    if (open) {
      if (cols <= 3) {
        const rest = line.slice(restStart)
        if (isFenceClose(rest, open.char, open.run)) {
          spans.push({
            from: open.from,
            to: lineStart + line.length,
            char: open.char,
            run: open.run,
            rendered: open.rendered,
            info: open.info,
            code: open.code.join('\n'),
          })
          open = null
          lineStart += line.length + 1
          continue
        }
      }
      open.code.push(line)
      lineStart += line.length + 1
      continue
    }
    if (cols <= 3) {
      const hit = matchFenceOpen(line.slice(restStart))
      if (hit && !(hit.char === '`' && hit.info.includes('`'))) {
        open = { from: lineStart, char: hit.char, run: hit.run, rendered: isRenderedFenceInfo(hit.info), info: hit.info, code: [] }
      }
    }
    lineStart += line.length + 1
  }
  return {
    spans,
    open: open ? { from: open.from, char: open.char, run: open.run, rendered: open.rendered, info: open.info, code: open.code.join('\n') } : null,
  }
}
