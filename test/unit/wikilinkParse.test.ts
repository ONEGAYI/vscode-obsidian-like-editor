// 双链形态学契约（工单 #11）：`[[…]]` 内部结构解析与单行扫描——
// live 装饰（webview）、阅读渲染（webview）与宿主目标解析共用同一形态学：
// - 支持形态：[[笔记]]、[[目录/笔记]]、[[笔记|显示文字]]、[[笔记#标题]]、
//   组合 [[目录/笔记#标题|显示]]；路径可含中文与空格
// - 不支持形态（返回 null，按原文降级显示）：块引用 ^（二期）、嵌入 ![[…]]（二期，
//   由扫描层前置 ! 守卫）、空路径 [[#标题]]、空标题 [[笔记#]]、空别名 [[笔记|]]、
//   多级标题 [[a#b#c]]、含 [ ] 的残缺括号形态
// - 规范化：path/heading/alias 各自 trim（内部空格保留）；
//   显示文字 = 别名 ??（路径 + (#标题)）
import { describe, it, expect } from 'vitest'
import {
  parseWikilinkInner,
  scanWikilinksInLine,
  wikilinkAtCol,
} from '../../src/shared/wikilink'

describe('parseWikilinkInner：目标结构解析', () => {
  it('基础形态：笔记名 / 目录路径 / 显示文字 / 标题目标', () => {
    expect(parseWikilinkInner('笔记')).toEqual({
      path: '笔记',
      heading: null,
      alias: null,
      display: '笔记',
    })
    expect(parseWikilinkInner('目录/笔记')).toEqual({
      path: '目录/笔记',
      heading: null,
      alias: null,
      display: '目录/笔记',
    })
    expect(parseWikilinkInner('笔记|显示文字')).toEqual({
      path: '笔记',
      heading: null,
      alias: '显示文字',
      display: '显示文字',
    })
    expect(parseWikilinkInner('笔记#标题')).toEqual({
      path: '笔记',
      heading: '标题',
      alias: null,
      display: '笔记#标题',
    })
  })

  it('组合形态：[[目录/笔记#标题|显示]] 各字段独立', () => {
    expect(parseWikilinkInner('目录/笔记#标题|显示')).toEqual({
      path: '目录/笔记',
      heading: '标题',
      alias: '显示',
      display: '显示',
    })
  })

  it('中文与空格路径原样保留；各字段首尾空白 trim', () => {
    expect(parseWikilinkInner('子 目录/目标 二')).toMatchObject({
      path: '子 目录/目标 二',
    })
    expect(parseWikilinkInner('  笔记 # 标题 | 显  示 ')).toEqual({
      path: '笔记',
      heading: '标题',
      alias: '显  示',
      display: '显  示',
    })
  })

  it('无别名时显示文字为「路径#标题」原文拼接（trim 后）', () => {
    expect(parseWikilinkInner('目录/笔记#标题')!.display).toBe('目录/笔记#标题')
  })

  it('不支持形态返回 null：块引用/空路径/空标题/空别名/多级标题/空串', () => {
    expect(parseWikilinkInner('笔记^块ID')).toBeNull()
    expect(parseWikilinkInner('目录/笔记^abc#标题')).toBeNull()
    expect(parseWikilinkInner('#标题')).toBeNull()
    expect(parseWikilinkInner('')).toBeNull()
    expect(parseWikilinkInner('   ')).toBeNull()
    expect(parseWikilinkInner('笔记#')).toBeNull()
    expect(parseWikilinkInner('笔记#标题#小节')).toBeNull()
    expect(parseWikilinkInner('笔记#标题^x')).toBeNull()
    expect(parseWikilinkInner('笔记|')).toBeNull()
    expect(parseWikilinkInner('|别名')).toBeNull()
  })

  it('首个 | 恒为别名分割（Obsidian 语义）：其后内容（含 |）全归别名', () => {
    expect(parseWikilinkInner('笔记#标题含|竖线')).toEqual({
      path: '笔记',
      heading: '标题含',
      alias: '竖线',
      display: '竖线',
    })
    expect(parseWikilinkInner('笔记#A|B|C')).toEqual({
      path: '笔记',
      heading: 'A',
      alias: 'B|C',
      display: 'B|C',
    })
  })
})

describe('scanWikilinksInLine：单行出现扫描（live/reading 共用语义）', () => {
  it('一行多个合法双链，from/to 覆盖含括号的完整区间', () => {
    const line = '前缀 [[甲笔记]] 中间 [[乙/笔记#节|显示]] 结尾'
    const hits = scanWikilinksInLine(line)
    expect(hits.map((h) => h.inner)).toEqual(['甲笔记', '乙/笔记#节|显示'])
    expect(hits[0]!.from).toBe(line.indexOf('[[甲笔记]]'))
    expect(hits[0]!.to).toBe(line.indexOf('[[甲笔记]]') + '[[甲笔记]]'.length)
    expect(hits[1]!.from).toBe(line.indexOf('[[乙/笔记#节|显示]]'))
    expect(hits[1]!.to).toBe(line.indexOf('[[乙/笔记#节|显示]]') + '[[乙/笔记#节|显示]]'.length)
  })

  it('嵌入 ![[…]]（二期）不匹配：前置 ! 守卫', () => {
    const hits = scanWikilinksInLine('嵌入 ![[目标笔记]] 与 [[真目标]]')
    expect(hits.map((h) => h.inner)).toEqual(['真目标'])
  })

  it('三连括号 [[[x]]] 不匹配（前置 [ 守卫，保持源文）', () => {
    expect(scanWikilinksInLine('[[[x]]')).toHaveLength(0)
  })

  it('块引用与非法形态不匹配，同行的合法双链照常命中', () => {
    const hits = scanWikilinksInLine('[[笔记^块]] 与 [[好笔记]] 与 [[坏#]]')
    expect(hits.map((h) => h.inner)).toEqual(['好笔记'])
  })

  it('内部含 [ 或 ] 的形态不匹配（残缺嵌套按原文降级）', () => {
    expect(scanWikilinksInLine('[[a[b]]')).toHaveLength(0)
    expect(scanWikilinksInLine('[[a]b]]')).toHaveLength(0)
  })

  it('未闭合 [[x] 不匹配；紧邻合法形态仍命中', () => {
    const hits = scanWikilinksInLine('[[未闭合 [x] 后 [[合法]]')
    expect(hits.map((h) => h.inner)).toEqual(['合法'])
  })

  it('base 偏移：全文行内扫描时 from/to 换算为全文 offset', () => {
    const line = '[[甲]]'
    const hits = scanWikilinksInLine(line, 100)
    expect(hits[0]!.from).toBe(100)
    expect(hits[0]!.to).toBe(100 + line.length)
  })
})

describe('wikilinkAtCol：按列定位出现（Ctrl/Cmd+单击命中判定）', () => {
  const line = '看这 [[甲笔记#节]] 尾'

  it('区间内任意列命中（含替换装饰后的坐标）', () => {
    const from = line.indexOf('[[甲笔记#节]]')
    const hit = wikilinkAtCol(line, from + 1)
    expect(hit?.inner).toBe('甲笔记#节')
    expect(wikilinkAtCol(line, from + '[[甲笔记#节]]'.length - 1)?.inner).toBe('甲笔记#节')
  })

  it('区间外（含紧邻前后）不命中', () => {
    const from = line.indexOf('[[甲笔记#节]]')
    const to = from + '[[甲笔记#节]]'.length
    expect(wikilinkAtCol(line, from - 1)).toBeNull()
    expect(wikilinkAtCol(line, to)).toBeNull()
    expect(wikilinkAtCol(line, 0)).toBeNull()
  })
})
