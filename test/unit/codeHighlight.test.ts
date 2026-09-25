// 代码块语法高亮引擎契约测试（工单 #83）：语言路由（Lezer + legacy-modes
// StreamLanguage）、classHighlighter 的 tok-* 词表、(languageId, code) LRU
// 缓存（键入路径只重解析被编辑块）、超大围栏降级、跨行 token 切段。
import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_MAX_LINES,
  getHighlightStats,
  hasHighlightEngine,
  highlightCodeRanges,
  splitRangeAtLineBreaks,
} from '../../src/webview/codeHighlight'
import { CODE_LANGUAGES } from '../../src/shared/codeLangs'

const JS_SAMPLE = 'const x: number = 42; // hi\nfunction f() { return "s" }'

describe('语言路由（#83）', () => {
  it('注册表全部语言有着色引擎；text 与未知语言无', () => {
    for (const entry of CODE_LANGUAGES) {
      expect(hasHighlightEngine(entry.id), `${entry.id} 应有引擎`).toBe(true)
    }
    expect(hasHighlightEngine('text')).toBe(false)
    expect(hasHighlightEngine(null)).toBe(false)
    expect(hasHighlightEngine('zzz')).toBe(false)
  })

  it('legacy-modes 四语言（shell/powershell/yaml/verilog）真实产出 token', () => {
    expect(highlightCodeRanges('shell', 'echo hi # c').length).toBeGreaterThan(0)
    expect(highlightCodeRanges('powershell', 'Get-Item x # c').length).toBeGreaterThan(0)
    expect(highlightCodeRanges('yaml', 'k: v # c').length).toBeGreaterThan(0)
    const verilog = highlightCodeRanges('verilog', 'module foo; // c\nendmodule')
    expect(verilog.some((r) => r.cls.includes('tok-keyword'))).toBe(true)
  })
})

describe('token 产出与词表（#83）', () => {
  it('JS/TS 样本产出 keyword/string/comment/number 等稳定类', () => {
    const ranges = highlightCodeRanges('javascript', JS_SAMPLE)
    const classes = ranges.map((r) => r.cls)
    expect(classes.some((c) => c.includes('tok-keyword'))).toBe(true)
    expect(classes.some((c) => c.includes('tok-string'))).toBe(true)
    expect(classes.some((c) => c.includes('tok-comment'))).toBe(true)
    expect(classes.some((c) => c.includes('tok-number'))).toBe(true)
    for (const r of ranges) {
      expect(r.from).toBeLessThan(r.to)
      expect(r.to).toBeLessThanOrEqual(JS_SAMPLE.length)
    }
  })

  it('别名路由同引擎：ts 产出与 javascript 等价（TS 方言 parser 超集）', () => {
    const a = highlightCodeRanges('javascript', 'let x = 1')
    const b = highlightCodeRanges('typescript', 'let x = 1')
    expect(a).toEqual(b)
  })
})

describe('缓存与降级（#83）', () => {
  it('同 (语言, 源码) 命中缓存不重解析；新源码触发解析', () => {
    const before = getHighlightStats()
    highlightCodeRanges('javascript', 'let cacheProbe = 1')
    highlightCodeRanges('javascript', 'let cacheProbe = 1')
    highlightCodeRanges('javascript', 'let cacheProbe = 2')
    const after = getHighlightStats()
    expect(after.parserCalls - before.parserCalls).toBe(2)
    expect(after.cacheHits - before.cacheHits).toBe(1)
  })

  it('超大围栏（> 4096 行）跳过着色降级纯文本', () => {
    const big = Array.from({ length: HIGHLIGHT_MAX_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(highlightCodeRanges('javascript', big)).toHaveLength(0)
    const atLimit = Array.from({ length: HIGHLIGHT_MAX_LINES }, (_, i) => `line ${i}`).join('\n')
    expect(highlightCodeRanges('javascript', atLimit).length).toBeGreaterThan(0)
  })
})

describe('跨行 token 切段（#83）', () => {
  it('多行区间按换行切段；空段（连续换行处）不产出', () => {
    expect(splitRangeAtLineBreaks('ab\ncd\nef', 1, 7)).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 7 },
    ])
    expect(splitRangeAtLineBreaks('a\n\nb', 0, 4)).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ])
    expect(splitRangeAtLineBreaks('abc', 1, 2)).toEqual([{ from: 1, to: 2 }])
  })

  it('多行块注释是单区间，切段后逐行发射（mark 装饰不跨行）', () => {
    const code = '/* one\ntwo */ let x = 1'
    const ranges = highlightCodeRanges('javascript', code)
    const comments = ranges.filter((r) => r.cls.includes('tok-comment'))
    expect(comments.length).toBeGreaterThanOrEqual(1)
    const spanning = comments.find((r) => r.to - r.from > 1 && code.slice(r.from, r.to).includes('\n'))
    expect(spanning).toBeDefined()
    expect(splitRangeAtLineBreaks(code, spanning!.from, spanning!.to)).toEqual([
      { from: 0, to: 6 },
      { from: 7, to: 13 },
    ])
  })
})
