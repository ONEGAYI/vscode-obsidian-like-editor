// 公式形态学契约测试（工单 #59）：src/shared/math.ts 是 `$…$` / `$$…$$`
// 判定的单一事实源（live 行扫描、阅读渲染语义对照共用）。判定规则与
// @vscode/markdown-it-katex 的 inline/block 规则逐条对齐（贴字规则、
// 转义、空内容、$$ 优先于 $、行内代码 span 排除），保证同一文本在
// 实时预览与阅读模式呈现一致语义。
import { describe, expect, it } from 'vitest'
import { opensMathBlockLine, scanMathRanges, stripInlineTexTicks } from '../../src/shared/math'

/** 文本按行拆分后扫描（行首 offset 自动累加，与 CM6 行迭代同构） */
function scan(text: string) {
  return scanMathRanges(text.split('\n'), 0)
}

function hits(text: string) {
  return scan(text).map((h) => ({ kind: h.kind, tex: h.tex }))
}

describe('行内公式 $…$（贴字规则与转义）', () => {
  it('基本行内公式命中且区间含定界符', () => {
    const out = scan('价格 $x^2$ 元')
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('inline')
    expect(out[0]!.tex).toBe('x^2')
    expect(out[0]!.from).toBe(3)
    expect(out[0]!.to).toBe(8)
  })

  it('紧邻拉丁字母的定界符不命中（贴字规则，与 markdown-it-katex 一致）', () => {
    // 闭侧：$ 后紧跟 word 字符不能闭合
    expect(hits('a $x$b c $y$')).toEqual([{ kind: 'inline', tex: 'y' }])
    // 开侧：$ 前是 word 字符不能开启
    expect(hits('a$x$ b')).toEqual([])
  })

  it('全角标点与中文视为非 word 字符，贴字命中', () => {
    expect(hits('（$x^2$）合计')).toEqual([{ kind: 'inline', tex: 'x^2' }])
  })

  it('普通美元数字不误判：闭定界符后紧跟数字时不闭合', () => {
    expect(hits('价格 $5，合计 $10 元')).toEqual([])
    // 与插件一致：首个闭候选不可闭合即放弃开启，$10$ 的 10 独立命中
    expect(hits('价格 $5，合计 $10$ 元')).toEqual([{ kind: 'inline', tex: '10' }])
  })

  it('数字包裹的 $5$ 按公式命中（与插件一致的已知歧义），$5$a 不命中', () => {
    expect(hits('花费 $5$ 元')).toEqual([{ kind: 'inline', tex: '5' }])
    expect(hits('花费 $5$a')).toEqual([])
  })

  it('转义 \\$ 不是定界符，其后公式仍独立命中', () => {
    expect(hits('花费 \\$5 和 $x$ 元')).toEqual([{ kind: 'inline', tex: 'x' }])
    expect(hits('\\$x\\$')).toEqual([])
  })

  it('空内容与相邻定界符不命中', () => {
    expect(hits('a $$ b')).toEqual([])
    expect(hits('$$$$')).toEqual([])
  })

  it('行首 $$ 后恰一对空内容 $$（$$  $$ / $$$$）不开启多行块（B-4 角案）', () => {
    // 空内容的行首闭合形态按原文降级：不产出、也不吞后续行。若当作多行
    // 块开启，后续首个 $$ 行会被误闭合成跨行块（与插件单行闭合语义分叉，
    // 且增量重建的 trailingOpenStart 不认此形态 → 增量窗口漏块）
    expect(hits('$$  $$\nb\n$$')).toEqual([])
    expect(hits('$$$$\nb\n$$')).toEqual([])
    // b 行的行内公式照常命中（不被上方角案吞入跨行块）
    expect(hits('$$$$\n$x$\n$$')).toEqual([{ kind: 'inline', tex: 'x' }])
  })

  it('行内公式 tex 剥首尾反引号谓词（$`1+1`$ 与阅读侧同语义，C5）', () => {
    // 与 @vscode/markdown-it-katex 一致：$`1+1`$ 的内容是 1+1（反引号是
    // 定界装饰不进渲染输入）。MathOccurrence.tex 保留原文，渲染层经此
    // 谓词剥离——live 与阅读共用同一实现
    expect(stripInlineTexTicks('`1+1`')).toBe('1+1')
    expect(stripInlineTexTicks('`a``')).toBe('a`')
    expect(stripInlineTexTicks('`ab')).toBe('`ab')
    expect(stripInlineTexTicks('``')).toBe('``')
    expect(stripInlineTexTicks('x')).toBe('x')
    // live 行扫描与渲染层链路：$`1+1`$ 命中且渲染输入为 1+1
    expect(hits('a $`1+1`$ b')).toEqual([{ kind: 'inline', tex: '`1+1`' }])
    expect(stripInlineTexTicks(scan('a $`1+1`$ b')[0]!.tex)).toBe('1+1')
  })

  it('开启多行块的行谓词（opensMathBlockLine，单一事实源）', () => {
    expect(opensMathBlockLine('$$')).toBe(true)
    expect(opensMathBlockLine('  $$ x')).toBe(true)
    // 最后一对 $$ 恰在行尾 = 单行闭合形态，不开启多行块
    expect(opensMathBlockLine('$$x$$')).toBe(false)
    expect(opensMathBlockLine('$$  $$')).toBe(false)
    expect(opensMathBlockLine('$$$$')).toBe(false)
    expect(opensMathBlockLine('$$x$$y$$')).toBe(false)
    // 对存在但不在行尾：多行块开启（与插件一致，tex 含那对 $$）
    expect(opensMathBlockLine('$$x$$y')).toBe(true)
    expect(opensMathBlockLine('普通行 $$')).toBe(false)
    expect(opensMathBlockLine('')).toBe(false)
  })

  it('单空格内容 $ $ 依插件语义命中（开侧右字符不参与开判定）', () => {
    expect(hits('a $ $ b')).toEqual([{ kind: 'inline', tex: ' ' }])
  })

  it('一行内多个公式互不干扰', () => {
    expect(hits('$a$ 与 $b$ 与 $c$')).toEqual([
      { kind: 'inline', tex: 'a' },
      { kind: 'inline', tex: 'b' },
      { kind: 'inline', tex: 'c' },
    ])
  })

  it('行内代码 span 内的 $ 不命中（与 markdown-it 规则顺序一致）', () => {
    expect(hits('`a $b$ c`')).toEqual([])
    expect(hits('`$x$`')).toEqual([])
    expect(hits('a `b` $x$ c')).toEqual([{ kind: 'inline', tex: 'x' }])
  })

  it('未配对的反引号按普通字符处理，其后公式仍命中', () => {
    expect(hits('`孤立反引号 $x$ 尾')).toEqual([{ kind: 'inline', tex: 'x' }])
  })
})

describe('段内与单行 $$…$$', () => {
  it('段内 $$…$$ 命中为块级语义（displayMode）', () => {
    const out = scan('前文 $$x^2$$ 后文')
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('block')
    expect(out[0]!.tex).toBe('x^2')
    expect(out[0]!.from).toBe(3)
    expect(out[0]!.to).toBe(10)
  })

  it('行首单行 $$x$$ 命中为块级', () => {
    expect(hits('$$x^2$$')).toEqual([{ kind: 'block', tex: 'x^2' }])
  })

  it('行首 $$x$$y$$ 不当块级，段内规则吃第一对', () => {
    expect(hits('$$x$$y$$')).toEqual([{ kind: 'block', tex: 'x' }])
  })

  it('$$ 与 $ 混排时 $$ 优先消费', () => {
    expect(hits('a $$b$$ c $d$ e')).toEqual([
      { kind: 'block', tex: 'b' },
      { kind: 'inline', tex: 'd' },
    ])
  })

  it('转义 \\$$ 不开启块级', () => {
    expect(hits('a \\$$b$$ c')).toEqual([])
  })
})

describe('跨行 $$ 块', () => {
  it('标准三行块命中，tex 保留定界符之间原文', () => {
    const text = '$$\nx^2 + y^2\n$$'
    const out = scan(text)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('block')
    expect(out[0]!.tex).toBe('\nx^2 + y^2\n')
    expect(out[0]!.from).toBe(0)
    expect(out[0]!.to).toBe(text.length)
  })

  it('块前后有正文时区间不含正文与前导缩进', () => {
    const text = '前文\n\n  $$\n  E=mc^2\n  $$\n后文'
    const out = scan(text)
    expect(out).toHaveLength(1)
    expect(out[0]!.tex).toBe('\n  E=mc^2\n  ')
    expect(text.slice(out[0]!.from, out[0]!.to)).toBe('$$\n  E=mc^2\n  $$')
  })

  it('首行带内容的块在末行首个 $$ 处闭合', () => {
    const text = '$$ a\nb $$ 尾文'
    const out = scan(text)
    expect(out).toHaveLength(1)
    expect(out[0]!.tex).toBe(' a\nb ')
  })

  it('未闭合块不命中（稳定降级为源码）', () => {
    expect(hits('$$\nx^2\n')).toEqual([])
    expect(hits('$$ x')).toEqual([])
  })

  it('块内的行内 $ 与反引号不参与行内扫描', () => {
    const text = '$$\n$a$ 与 `b`\n$$'
    const out = scan(text)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('block')
  })

  it('连续相邻两块各自命中', () => {
    const out = scan('$$\na\n$$\n$$\nb\n$$')
    expect(out).toHaveLength(2)
    expect(out[0]!.tex).toBe('\na\n')
    expect(out[1]!.tex).toBe('\nb\n')
  })

  it('行内代码 span 跨越块开始定界符时块不启动', () => {
    // 反引号 span 行（含 $$）不影响后续块：span 行按普通行处理
    const out = scan('`code $$ span`\nx\n$$\n闭块 $$')
    expect(out).toHaveLength(1)
    expect(out[0]!.tex).toBe('\n闭块 ') // $$ 前空格属定界符之间原文
  })
})

describe('多行输入与 offset 基值', () => {
  it('firstLineStart 基值平移全部区间', () => {
    const out = scanMathRanges(['$$', 'x', '$$'], 100)
    expect(out).toHaveLength(1)
    expect(out[0]!.from).toBe(100)
    expect(out[0]!.to).toBe(100 + '$$\nx\n$$'.length)
  })

  it('首行即块中段（上方未闭合）时不产出错误配对', () => {
    // 调用方只传入行窗口：窗口首行已在块内时，扫描以非块态起步，
    // 不得把窗口内的闭合定界符误配为新的块开始
    const out = scanMathRanges(['y $$', '后文 $a$'], 0)
    expect(out).toEqual([{ kind: 'inline', from: 8, to: 11, tex: 'a' }])
  })

  it('空输入与无 $ 文本零成本返回', () => {
    expect(scanMathRanges([], 0)).toEqual([])
    expect(scanMathRanges(['纯文本', '没有公式'], 0)).toEqual([])
  })
})
