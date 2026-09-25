// 阅读模式公式渲染契约测试（工单 #59）：markdown-it + @vscode/markdown-it-katex
// 集成（解析语义与 live 的 shared/math.ts 对齐）、$$ 块独立成块（挂载/锚点
// 语义）、KaTeX 输出过净化层、非法公式原文降级不外溢。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { splitReadingBlocks } from '../../src/webview/readingBlocks'
import {
  createReadingBlockElement,
  READING_CLASS_NAMES,
} from '../../src/webview/readingView'
import { sanitizeReadingDom } from '../../src/webview/readingMarkdown'

function renderBlocks(text: string) {
  return splitReadingBlocks(text).map((b) => createReadingBlockElement(b, text))
}

describe('阅读切块：公式块的独立成块与锚点', () => {
  it('行首 $$ 块独立为 math 块，锚点覆盖定界符', () => {
    const text = '前文\n\n$$\nE=mc^2\n$$\n\n尾文'
    const blocks = splitReadingBlocks(text)
    const math = blocks.filter((b) => b.kind === 'math')
    expect(math).toHaveLength(1)
    expect(math[0]!.start).toBe('前文\n\n'.length)
    expect(math[0]!.end).toBe(text.length - '\n\n尾文'.length)
    expect(text.slice(math[0]!.start, math[0]!.end)).toBe('$$\nE=mc^2\n$$')
  })

  it('行首单行 $$x$$ 与段内 $$…$$ 均渲染 display 数学', () => {
    for (const text of ['$$x^2$$\n', '前 $$a+b$$ 后\n']) {
      const el = renderBlocks(text).find((b) => b.innerHTML.includes('katex'))
      expect(el, text).toBeTruthy()
      expect(el!.innerHTML).toContain('katex-display')
    }
  })

  it('行内公式在段落块内渲染 KaTeX span', () => {
    const [para] = renderBlocks('价格 $x^2$ 元')
    expect(para!.innerHTML).toContain('class="katex"')
    expect(para!.innerHTML).not.toContain('katex-display')
  })

  it('代码区内的 $ 不渲染公式', () => {
    const code = renderBlocks('`a $b$ c`\n\n```\n$x$\n```\n')
    for (const el of code) {
      expect(el.innerHTML).not.toContain('class="katex"')
    }
  })

  it('普通美元文本不渲染公式', () => {
    const [para] = renderBlocks('价格 $5，合计 $10 元')
    expect(para!.innerHTML).not.toContain('katex')
    expect(para!.textContent).toContain('$5')
  })

  it('相邻两个块级公式各自成块（互不吞并）', () => {
    const text = '$$\na\n$$\n$$\nb\n$$'
    const math = splitReadingBlocks(text).filter((b) => b.kind === 'math')
    expect(math).toHaveLength(2)
  })
})

describe('阅读渲染：KaTeX 输出与稳定类名', () => {
  it('math 块元素带稳定类名且 KaTeX HTML 过净化层存活', () => {
    const text = '$$\nE=mc^2\n$$'
    const [el] = renderBlocks(text)
    expect(el.classList.contains(READING_CLASS_NAMES.mathBlock)).toBe(true)
    // 净化已随 createReadingBlockElement 执行：KaTeX span/MathML/内联 style 存活
    expect(el.querySelector('.katex')).toBeTruthy()
    expect(el.querySelector('.katex-html')).toBeTruthy()
    expect(el.querySelector('math')).toBeTruthy()
    expect(el.querySelector('annotation')?.textContent).toBe('E=mc^2\n')
    const strut = el.querySelector('.strut')
    expect(strut?.getAttribute('style')).toContain('height:')
  })

  it('渲染产物带 vsidian-math 稳定入口类（live 与阅读共用探针）', () => {
    const [inline] = renderBlocks('$x$')
    expect(inline.querySelector('.vsidian-math')).toBeTruthy()
    const [block] = renderBlocks('$$x$$')
    expect(block.querySelector('.vsidian-math-block')).toBeTruthy()
  })

  it('净化层移除 KaTeX 产物中的危险注入但保留公式语义', () => {
    const text = '$$\nE=mc^2\n$$'
    const [el] = renderBlocks(text)
    // 直接构造含 script 的渲染产物验证净化不因公式内容而失效
    el.innerHTML += '<script>alert(1)</script><span onclick="x()">y</span>'
    sanitizeReadingDom(el)
    expect(el.querySelector('script')).toBeNull()
    expect(el.querySelector('[onclick]')).toBeNull()
    expect(el.querySelector('.katex')).toBeTruthy()
  })
})

describe('阅读降级：非法公式显示可读原文', () => {
  it('未定义命令渲染为降级 span：含原文、带错误类、不吞邻近内容', () => {
    const [para] = renderBlocks('前文 $\\notdefined{x}$ 后文')
    const err = para.querySelector('.vsidian-math-error')
    expect(err).toBeTruthy()
    expect(err!.textContent).toBe('$\\notdefined{x}$')
    expect(para.textContent).toContain('前文')
    expect(para.textContent).toContain('后文')
  })

  it('块级非法公式同样降级且块内其余公式不受牵连', () => {
    const [bad] = renderBlocks('$$\n\\badcmd\n$$')
    expect(bad.querySelector('.vsidian-math-error')).toBeTruthy()
    expect(bad.textContent).toContain('$$')
  })

  it('一处降级不影响同段其他合法公式', () => {
    const [para] = renderBlocks('$好$ 与 $\\bad$ 与 $也好$')
    expect(para.querySelectorAll('.katex')).toHaveLength(2)
    expect(para.querySelectorAll('.vsidian-math-error')).toHaveLength(1)
  })

  it('降级原文经 HTML 转义（含尖括号的 tex 不产生标签）', () => {
    const [para] = renderBlocks('$a < b \\bad$')
    const err = para.querySelector('.vsidian-math-error')
    expect(err).toBeTruthy()
    expect(err!.innerHTML).not.toContain('<b>')
    expect(err!.textContent).toBe('$a < b \\bad$')
  })
})

describe('双视图语义一致性：阅读渲染与 shared/math.ts 对拍', () => {
  it('同一文本的公式出现数与渲染出的 KaTeX 数一致', async () => {
    const { scanMathRanges } = await import('../../src/shared/math')
    const samples = [
      '$a$ 与 $b$\n',
      '前 $$x$$ 后\n',
      '$$\nc\n$$\n$$\nd\n$$\n',
      '`$e$` 与 $f$\n',
      '\\$g$ 普通美元\n',
    ]
    for (const text of samples) {
      const occurrences = scanMathRanges(text.split('\n'), 0)
      const els = renderBlocks(text)
      const katexCount = els.reduce(
        (n, el) => n + el.querySelectorAll('.katex:not(.katex-error)').length,
        0,
      )
      expect(katexCount, JSON.stringify(text)).toBe(occurrences.length)
    }
  })
})
