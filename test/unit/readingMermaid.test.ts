// 阅读模式 Mermaid 块契约测试（工单 #60）：mermaid 围栏独立成块、60 行
// 切片豁免、容器 html（data 属性携带源码）、净化层通过、块类名与挂载渲染。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { splitReadingBlocks } from '../../src/webview/readingBlocks'
import { createReadingBlockElement } from '../../src/webview/readingView'
import { READING_CLASS_NAMES } from '../../src/webview/readingView'
import { createMarkdownRenderer, sanitizeReadingDom } from '../../src/webview/readingMarkdown'
import { estimateBlockHeightPx } from '../../src/webview/readingViewport'
import { MERMAID_CLASS_NAMES, MERMAID_CODE_ATTR, MERMAID_STATE_ATTR } from '../../src/shared/mermaid'
import type { VsCodeBridge } from '../../src/webview/syncController'

const FLOW = '```mermaid\ngraph TD\nA-->B\n```'

describe('阅读切块：mermaid 围栏独立成块', () => {
  it('标准围栏产出 kind=mermaid 的单块，html 为携带源码的容器', () => {
    const blocks = splitReadingBlocks(`前言\n\n${FLOW}\n\n结尾`)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'mermaid', 'paragraph'])
    const m = blocks[1]!
    const text = `前言\n\n${FLOW}\n\n结尾`
    expect(m.start).toBe(text.indexOf('```mermaid'))
    expect(m.end).toBe(text.indexOf('```', 14) + 3)
    expect(m.html).toContain(`class="${MERMAID_CLASS_NAMES.diagram}"`)
    expect(m.html).toContain(`${MERMAID_CODE_ATTR}="graph TD&#10;A--&gt;B"`)
    expect(m.html).toContain(`${MERMAID_STATE_ATTR}="pending"`)
  })

  it('大围栏豁免 60 行切片：70 行 mermaid 图仍是单块（不被拆碎）', () => {
    const lines = ['```mermaid', ...Array.from({ length: 68 }, (_, i) => `N${i}-->N${i + 1}`), '```']
    const blocks = splitReadingBlocks(lines.join('\n'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('mermaid')
    // 对照：普通语言大围栏仍切片（既有行为不变）
    const jsLines = ['```js', ...Array.from({ length: 68 }, (_, i) => `// line ${i}`), '```']
    const jsBlocks = splitReadingBlocks(jsLines.join('\n'))
    expect(jsBlocks.length).toBeGreaterThan(1)
    expect(jsBlocks.every((b) => b.kind === 'code-block')).toBe(true)
  })

  it('非 mermaid 围栏保持既有 code-block 渲染（不改写现有语义）', () => {
    const blocks = splitReadingBlocks('```js\nlet a = 1\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('code-block')
    expect(blocks[0]!.html).toContain('<pre><code class="language-js">')
  })

  it('外层长围栏内的伪 mermaid 围栏是普通代码内容（不渲染容器）', () => {
    const text = ['````md', '```mermaid', 'graph TD', 'A-->B', '```', '````'].join('\n')
    const blocks = splitReadingBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('code-block')
    expect(blocks[0]!.html).not.toContain(MERMAID_CLASS_NAMES.diagram)
  })

  it('源码含引号与 & 时属性转义可逆（dataset 读回原文）', () => {
    const text = '```mermaid\nA["说 \\"hi\\" & <b>"]-->B\n```'
    const blocks = splitReadingBlocks(text)
    const el = createReadingBlockElement(blocks[0]!, text)
    const container = el.querySelector<HTMLElement>(`.${MERMAID_CLASS_NAMES.diagram}`)!
    expect(container).not.toBeNull()
    expect(container.getAttribute(MERMAID_CODE_ATTR)).toBe('A["说 \\"hi\\" & <b>"]-->B')
  })
})

describe('阅读容器净化与类名', () => {
  it('createReadingBlockElement：块类名 vsidian-reading-mermaid，容器经净化层保留 data 属性', () => {
    const text = `# 标题\n\n${FLOW}`
    const blocks = splitReadingBlocks(text)
    const el = createReadingBlockElement(blocks[1]!, text)
    expect(el.className).toContain(READING_CLASS_NAMES.mermaidBlock)
    expect(el.className).toContain(READING_CLASS_NAMES.block)
    expect(el.querySelector(`.${MERMAID_CLASS_NAMES.diagram}`)).not.toBeNull()
    // 净化二次执行不破坏容器（防御性：与 sanitizeReadingDom 兼容）
    sanitizeReadingDom(el)
    expect(el.querySelector(`[${MERMAID_CODE_ATTR}]`)).not.toBeNull()
  })

  it('列表内嵌套 mermaid 围栏经 fence 渲染规则输出容器（renderer 规则覆盖所有层级）', () => {
    const text = '- 项一\n  ```mermaid\n  graph TD\n  A-->B\n  ```\n- 项二'
    const blocks = splitReadingBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('list')
    expect(blocks[0]!.html).toContain(MERMAID_CLASS_NAMES.diagram)
  })
})

describe('渲染器 fence 规则（直接驱动机）', () => {
  it('mermaid fence 渲染容器；其他 fence 走默认 pre/code', () => {
    const md = createMarkdownRenderer()
    const html = md.render(`\`\`\`mermaid\nA-->B\n\`\`\`\n\n\`\`\`js\nlet a\n\`\`\``)
    expect(html).toContain(MERMAID_CLASS_NAMES.diagram)
    expect(html).toContain('<pre><code class="language-js">')
  })

  it('Tab 缩进围栏在阅读侧同为缩进代码块（与 live 折算口径一致，D-4）', () => {
    const md = createMarkdownRenderer()
    const html = md.render('\t```mermaid\n\tgraph TD\n\tA-->B\n\t```')
    // markdown-it 按 CommonMark 把行首 Tab 折算到 4 列制表位 → 缩进代码块
    expect(html).not.toContain(MERMAID_CLASS_NAMES.diagram)
    expect(html).toContain('<pre><code')
  })
})

describe('高度估计：mermaid 块初始估计放大', () => {
  it('同源行数的 mermaid 块估计高于 code-block（渲染后高度远超源行高）', () => {
    const text = FLOW
    const calib = { lineHeightPx: 20 }
    const mermaid = splitReadingBlocks(text)[0]!
    const code = splitReadingBlocks('```\ngraph TD\nA-->B\n```')[0]!
    expect(mermaid.kind).toBe('mermaid')
    expect(code.kind).toBe('code-block')
    expect(estimateBlockHeightPx(mermaid, text, calib))
      .toBeGreaterThan(estimateBlockHeightPx(code, '```\ngraph TD\nA-->B\n```', calib))
  })
})

describe('控制器装配链路：阅读模式挂载钩子渲染 mermaid', () => {
  it('init → 切阅读模式：挂载块内 pending 容器完成渲染（mock mermaid）', async () => {
    const { WebviewSyncController } = await import('../../src/webview/syncController')
    const { __setMermaidApiForTest, __resetMermaidRenderStateForTest } = await import('../../src/webview/mermaidRender')
    __setMermaidApiForTest({
      initialize() {},
      async render() {
        return { svg: '<svg id="m"><g><text>A-->B</text></g></svg>' }
      },
    })
    const sent: unknown[] = []
    const bridge: VsCodeBridge = {
      postMessage: (m) => sent.push(m),
      getState: () => undefined,
      setState: () => undefined,
    }
    const controller = new WebviewSyncController(bridge)
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    controller.mount(parent)
    const text = `# 标题\n\n${FLOW}\n\n结尾段落。`
    controller.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: 'file:///m.md', version: 1, text })
    controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
    const container = parent.querySelector(`.${MERMAID_CLASS_NAMES.diagram}`)!
    expect(container).not.toBeNull()
    expect(container.getAttribute(MERMAID_STATE_ATTR)).toBe('rendered')
    expect(container.querySelector('svg')).not.toBeNull()
    controller.dispose?.()
    __resetMermaidRenderStateForTest()
  })
})
