// 公式（math）形态学单一事实源（工单 #59）：`$…$` 行内公式与 `$$…$$`
// 块级公式的边界判定与行序列扫描。live 装饰（liveMath.ts 行扫描）与
// 阅读渲染语义对照共用——两处对「什么算公式」的判定必须一致，否则同一
// 文本在两种视图呈现不同语义。
//
// 判定规则与 @vscode/markdown-it-katex（阅读侧渲染插件）逐条对齐：
// - 行内 `$…$`：开 `$` 的左侧不得是 `$`/`\`/词字符（[\w]，即紧贴拉丁字母
//   数字下划线不开启）；闭 `$` 的右侧不得是 `$`/词字符。内容为空不命中。
// - `$$…$$`：左侧不得是 `$`/`\`，右侧不得是 `$`；`$` 优先级高于 `$$`
//   （扫描先消费 `$$` 对）。
// - 转义：前置奇数个反斜杠的 `$` 不是定界符（找闭合时跳过；开定界符
//   紧邻一个 `\` 即不开启——与插件 isValidDelim 的判定一致）。
// - 行内代码 span：反引号配对内的 `$` 不参与扫描（markdown-it 的
//   backticks 规则在数学规则之后，span 优先消费；未配对反引号按普通
//   字符处理）。
// - 块级 `$$`：行首（剥缩进）`$$` 开启；单行闭合要求 `$$` 后余文恰在
//   行尾有一对 `$$`；余文含多对时按段内 `$$…$$` 处理；多行闭合在首个
//   出现 `$$` 的行（行尾 `$$` 取行内最后一对，否则取 trim 后首对）。
//   未闭合块不产出（稳定降级为源码）。
//
// 本模块不依赖 vscode/DOM/CM6（node 单测直驱；宿主与 webview 双产物共用）。
// 已知差异（记录于 docs/perf/2026-09-math-rendering.md）：markdown-it 的
// 段落内联文本允许跨行 `$…$`（软换行），本扫描以行为单位不识别跨行行内
// 公式——live 显源码、阅读渲染公式，降级方向安全。

/** #59 公式稳定类名（live widget/mark 与阅读渲染共用；Obsidian 对应
 *  `.cm-math` / `.math-block`，见选择器映射表） */
export const MATH_CLASS_NAMES = {
  /** live 渲染态 widget 外层与阅读 KaTeX 容器（颜色探针入口） */
  math: 'vsidian-math',
  /** 块级（displayMode）变体 */
  mathBlock: 'vsidian-math-block',
  /** 语法/渲染失败的原文降级态（可读、可编辑） */
  mathError: 'vsidian-math-error',
  /** 光标进入公式范围时的源码态 mark（$ 定界符着色） */
  mathSource: 'vsidian-math-source',
} as const

/** 一次公式出现（全文 offset 语义；from 含开定界符，to 含闭定界符） */
export interface MathOccurrence {
  from: number
  to: number
  /** `inline` = `$…$`；`block` = `$$…$$`（displayMode 渲染） */
  kind: 'inline' | 'block'
  /** 定界符之间的原文（未 trim——KaTeX 对首尾空白不敏感，渲染层自理） */
  tex: string
}

/** 词字符（[\w]：拉丁字母/数字/下划线）——贴字规则的判定口径 */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w\d]/u.test(ch)
}

function isWsChar(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch)
}

/** pos 处的 `$` 是否被前置反斜杠转义（奇数个连续 `\` 前置） */
function isEscapedDollar(line: string, pos: number): boolean {
  let backslashes = 0
  let at = pos - 1
  while (at >= 0 && line[at] === '\\') {
    backslashes += 1
    at -= 1
  }
  return backslashes % 2 === 1
}

/** 从 from 起找下一个未转义的 `$$`；返回其起始 index，无则 -1 */
function findDollarPair(line: string, from: number): number {
  let at = from
  for (;;) {
    const hit = line.indexOf('$$', at)
    if (hit < 0 || hit + 2 > line.length) {
      return -1
    }
    if (!isEscapedDollar(line, hit) && line[hit + 2] !== '$') {
      return hit
    }
    at = hit + 2
  }
}

/**
 * 扫描单行文本中的行内公式与段内 `$$…$$`（base 为该行首的全文 offset，
 * 缺省 0）。反引号 span 内的 `$` 跳过；未闭合/非法形态不产出。
 * 纯函数，与跨行块扫描（scanMathRanges 的块模式）共用同一贴字/转义规则。
 */
export function scanMathInLine(line: string, base = 0): MathOccurrence[] {
  const out: MathOccurrence[] = []
  const len = line.length
  let at = 0
  while (at < len) {
    const ch = line[at]!
    if (ch === '`') {
      // 行内代码 span：配对反引号 run 内的 $ 不参与（与 markdown-it 的
      // backticks 规则先于后续 $ 消费一致）；未配对按普通字符跳过
      let run = 1
      while (line[at + run] === '`') {
        run += 1
      }
      const close = findBacktickRun(line, at + run, run)
      at = close < 0 ? at + 1 : close + run
      continue
    }
    if (ch !== '$') {
      at += 1
      continue
    }
    if (isEscapedDollar(line, at)) {
      at += 1
      continue
    }
    const prev = at > 0 ? line[at - 1] : undefined
    if (line[at + 1] === '$') {
      // `$$…$$`（段内 inline block 形态）
      if (prev === '$' || prev === '\\') {
        at += 2
        continue
      }
      const close = findDollarPair(line, at + 2)
      // 未闭合 / 空内容（$$$$）按原文降级
      if (close < 0 || close === at + 2) {
        at += 2
        continue
      }
      const closePrev = line[close - 1]
      if (closePrev === '$' || closePrev === '\\') {
        at += 2
        continue
      }
      out.push({ from: base + at, to: base + close + 2, kind: 'block', tex: line.slice(at + 2, close) })
      at = close + 2
      continue
    }
    // 单 `$…$`：开定界符贴字判定（$、\ 与词字符之后不开启）
    if (prev === '$' || prev === '\\' || (prev !== undefined && !isWsChar(prev) && isWordChar(prev))) {
      at += 1
      continue
    }
    const close = findClosingDollar(line, at + 1)
    if (close < 0) {
      at += 1
      continue
    }
    out.push({ from: base + at, to: base + close + 1, kind: 'inline', tex: line.slice(at + 1, close) })
    at = close + 1
  }
  return out
}

/** 从 from 起找可作为闭合的单 `$`（未转义且右侧非 $/词字符）；无则 -1 */
function findClosingDollar(line: string, from: number): number {
  let at = from
  while (at < line.length) {
    if (line[at] !== '$') {
      at += 1
      continue
    }
    if (isEscapedDollar(line, at)) {
      at += 1
      continue
    }
    const next = line[at + 1]
    if (next === '$' || (next !== undefined && !isWsChar(next) && isWordChar(next))) {
      return -1 // 与插件一致：首个候选不可闭合即放弃本次开启
    }
    return at
  }
  return -1
}

/** 从 from 起找长度为 run 的反引号 run；返回起始 index，无则 -1 */
function findBacktickRun(line: string, from: number, run: number): number {
  let at = from
  while (at < line.length) {
    if (line[at] !== '`') {
      at += 1
      continue
    }
    let size = 1
    while (line[at + size] === '`') {
      size += 1
    }
    if (size === run) {
      return at
    }
    at += size
  }
  return -1
}

/**
 * 扫描连续行集合中的全部公式出现（跨行 `$$` 块 + 各行行内公式）。
 * firstLineStart 为首行行首的全文 offset（区块区间以全文坐标产出）。
 *
 * 块模式状态机：行首（剥缩进）`$$` 开启块，首个出现 `$$` 的行闭合；
 * 行首 `$$` 后余文含多对 `$$` 时该行按段内形态处理（与插件 blockMath 的
 * 单行判定一致）。窗口首行已在某个未闭合块内时，本扫描以非块态起步，
 * 不会把窗口内的闭合定界符误配为新块（闭合判定要求先有开启行）。
 */
export function scanMathRanges(lines: readonly string[], firstLineStart: number): MathOccurrence[] {
  if (!lines.some((line) => line.includes('$'))) {
    return []
  }
  const out: MathOccurrence[] = []
  let lineStart = firstLineStart
  let blockOpen: { from: number; tex: string } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (blockOpen) {
      if (!trimmed.includes('$$')) {
        blockOpen.tex += `\n${line}`
        lineStart += line.length + 1
        continue
      }
      // 行尾 `$$` 取行内最后一对，否则取（去首空白后的）首对——与插件
      // blockMath 两个闭合分支的定位一致
      const closeAt = trimmed.endsWith('$$')
        ? line.lastIndexOf('$$')
        : line.indexOf('$$', line.length - trimmed.length)
      out.push({
        from: blockOpen.from,
        to: lineStart + closeAt + 2,
        kind: 'block',
        tex: blockOpen.tex + '\n' + line.slice(0, closeAt),
      })
      blockOpen = null
      lineStart += line.length + 1
      continue
    }
    const indent = line.length - line.trimStart().length
    if (trimmed.startsWith('$$')) {
      const rest = trimmed.slice(2)
      const pairs = [...rest.matchAll(/\$\$/g)]
      if (pairs.length === 1 && pairs[0]!.index === rest.length - 2 && rest.slice(0, -2).trim() !== '') {
        // 行首单行块 `$$x$$`
        out.push({
          from: lineStart + indent,
          to: lineStart + line.length,
          kind: 'block',
          tex: rest.slice(0, -2),
        })
        lineStart += line.length + 1
        continue
      }
      if (pairs.length > 1) {
        // 首行多对 `$$`：不是块级，按段内形态处理（下诉行内扫描）
        out.push(...scanMathInLine(line, lineStart))
        lineStart += line.length + 1
        continue
      }
      // 多行块开始（rest 无 $$；rest 非空时为块首行内容）
      blockOpen = { from: lineStart + indent, tex: rest }
      lineStart += line.length + 1
      continue
    }
    out.push(...scanMathInLine(line, lineStart))
    lineStart += line.length + 1
  }
  // 未闭合块不产出（稳定降级为源码）
  return out
}
