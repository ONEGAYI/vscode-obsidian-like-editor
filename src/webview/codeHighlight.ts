// 代码块语法高亮引擎装配（工单 #83，规格 docs/specs/code-block-card.md）：
// 官方 Lezer 语言包 + @codemirror/legacy-modes StreamLanguage，统一经
// @lezer/highlight 的 classHighlighter 产出 tok-* 稳定类名——live 的 mark
// 装饰与阅读渲染（#84）共用同一词表与色板（main.css 明暗两套）。
//
// - 语言路由：shared/codeLangs 的语言 id → Parser（javascript/typescript
//   共用 TS+JSX 方言 parser；shell/powershell/yaml/verilog 走 StreamLanguage）
// - 缓存：按 (languageId, code) LRU 缓存 token 区间（64 条），键入路径只
//   重解析被编辑的块；装饰实例另在 liveCodeCard 按 class 缓存
// - 超大围栏（> 4096 行）跳过着色降级纯文本（逐键全块解析不可接受；
//   已知限制随 #85 性能文档记录）
// - 本模块不做 DOM/CM6 装饰（纯区间计算），node 单测直驱
import { classHighlighter, highlightTree } from '@lezer/highlight'
import type { Parser } from '@lezer/common'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { python } from '@codemirror/lang-python'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { markdown } from '@codemirror/lang-markdown'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'

/** 超大围栏跳过着色的行数上限（降级纯文本；#85 性能文档记录） */
export const HIGHLIGHT_MAX_LINES = 4096

/** token 区间缓存上限（键 = languageId + 源码；与 mermaid 装饰缓存同量级） */
export const HIGHLIGHT_CACHE_LIMIT = 64

/** 一段高亮 token：cls 为 classHighlighter 的 tok-* 稳定类（可多词） */
export interface CodeTokenRange {
  from: number
  to: number
  cls: string
}

// 语言 id → Parser。TS 方言 parser 覆盖 js/jsx/ts/tsx（超集；方言差异由
// 词表吸收，注册表别名统一路由）。html 内嵌 css/js 由嵌套解析器承担。
const PARSERS: Readonly<Record<string, Parser>> = {
  javascript: javascript({ typescript: true, jsx: true }).language.parser,
  typescript: javascript({ typescript: true, jsx: true }).language.parser,
  json: json().language.parser,
  html: html().language.parser,
  css: css().language.parser,
  python: python().language.parser,
  cpp: cpp().language.parser,
  c: cpp().language.parser,
  java: java().language.parser,
  go: go().language.parser,
  rust: rust().language.parser,
  sql: sql().language.parser,
  markdown: markdown().language.parser,
  shell: StreamLanguage.define(shell).parser,
  powershell: StreamLanguage.define(powerShell).parser,
  yaml: StreamLanguage.define(yaml).parser,
  verilog: StreamLanguage.define(verilog).parser,
}

/** 语言 id 是否有着色引擎（text 与未知语言无） */
export function hasHighlightEngine(languageId: string | null): boolean {
  return languageId !== null && languageId !== 'text' && languageId in PARSERS
}

const EMPTY_RANGES: readonly CodeTokenRange[] = []

const stats = { parserCalls: 0, cacheHits: 0 }
/** 测试观测面：钉住缓存行为（键入路径不重解析未编辑块） */
export function getHighlightStats(): Readonly<typeof stats> {
  return { ...stats }
}

const rangeCache = new Map<string, readonly CodeTokenRange[]>()

/**
 * 代码体 → tok-* token 区间（code 内相对坐标；空数组 = 无着色）。
 * 纯文本/未识别/超大围栏返回空；结果按 (languageId, code) LRU 缓存。
 */
export function highlightCodeRanges(languageId: string | null, code: string): readonly CodeTokenRange[] {
  if (!hasHighlightEngine(languageId)) {
    return EMPTY_RANGES
  }
  let lineCount = 1
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) {
      lineCount += 1
      if (lineCount > HIGHLIGHT_MAX_LINES) {
        return EMPTY_RANGES
      }
    }
  }
  const key = `${languageId}\u0000${code}`
  const hit = rangeCache.get(key)
  if (hit) {
    // LRU：命中移到末尾
    rangeCache.delete(key)
    rangeCache.set(key, hit)
    stats.cacheHits += 1
    return hit
  }
  stats.parserCalls += 1
  const tree = PARSERS[languageId!]!.parse(code)
  const ranges: CodeTokenRange[] = []
  highlightTree(tree, classHighlighter, (from, to, cls) => {
    if (to > from) {
      ranges.push({ from, to, cls })
    }
  })
  rangeCache.set(key, ranges)
  while (rangeCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = rangeCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    rangeCache.delete(oldest)
  }
  return ranges
}

/**
 * 跨行 token 按换行切段（mark 装饰不得跨行——多行字符串/块注释逐行发射；
 * 输入为 code 内相对坐标与待切段区间，输出同坐标系）。
 */
export function splitRangeAtLineBreaks(
  code: string,
  from: number,
  to: number,
): Array<{ from: number; to: number }> {
  const segments: Array<{ from: number; to: number }> = []
  let start = from
  for (let i = from; i < to; i++) {
    if (code.charCodeAt(i) === 10) {
      if (i > start) {
        segments.push({ from: start, to: i })
      }
      start = i + 1
    }
  }
  if (to > start) {
    segments.push({ from: start, to })
  }
  return segments
}
