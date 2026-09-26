// 阅读视图代码块卡片契约测试（工单 #84）：朴素 pre/code 增强为卡片
// （头部徽标+标签+折叠+复制）、卡内行号、tok-* 着色、形态矩阵（卡片/
// 高亮独立开关）、折叠收起、复制回调、幂等重装饰与源码保真。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  READING_CODE_CARD_CLASS,
  READING_CODE_CARD_FOLDED_CLASS,
  READING_CODE_LINE_CLASS,
  decorateReadingCodeCard,
  isReadingCodeBlock,
} from '../../src/webview/readingCodeCard'
import { CODE_CARD_CLASS_NAMES } from '../../src/webview/liveCodeCard'

const CODE = 'const a = 1;\nfunction hi() {'

function makeBlock(
  info = 'js',
  code = CODE,
  chunk?: { start: number; total: number },
): HTMLElement {
  const block = document.createElement('div')
  block.className = 'vsidian-reading-block vsidian-reading-code-block'
  block.dataset['vsidianSrcStart'] = '0'
  const pre = document.createElement('pre')
  if (chunk) {
    // 大围栏分块（FENCE_CHUNK_LINES）片的跨片行号契约（readingBlocks 落位）
    pre.setAttribute('data-vsidian-code-start', String(chunk.start))
    pre.setAttribute('data-vsidian-code-total', String(chunk.total))
  }
  const codeEl = document.createElement('code')
  codeEl.className = info ? `language-${info}` : ''
  codeEl.textContent = code
  pre.appendChild(codeEl)
  block.appendChild(pre)
  return block
}

function decorate(block: HTMLElement, over: Partial<Parameters<typeof decorateReadingCodeCard>[1]> = {}) {
  decorateReadingCodeCard(block, {
    config: { card: true, lineNumbers: true, copyButton: true, highlight: true },
    folded: false,
    onCopy: () => {},
    onFoldToggle: () => {},
    ...over,
  })
}

describe('阅读代码块卡片（#84）', () => {
  it('卡片 + 高亮：头部（徽标/标签/折叠/复制）、行结构与行号、tok 着色齐备', () => {
    const block = makeBlock('js')
    decorate(block)
    expect(block.classList.contains(READING_CODE_CARD_CLASS)).toBe(true)
    const header = block.querySelector(`:scope > .${CODE_CARD_CLASS_NAMES.header}`)!
    expect(header).not.toBeNull()
    const label = header.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)!
    expect(label.querySelector(`.${CODE_CARD_CLASS_NAMES.headerIcon}`)?.textContent).toBe('JS')
    expect(label.textContent).toContain('JavaScript')
    expect(header.querySelector(`.${CODE_CARD_CLASS_NAMES.fold}`)).not.toBeNull()
    expect(header.querySelector(`.${CODE_CARD_CLASS_NAMES.copy}`)).not.toBeNull()
    const rows = block.querySelectorAll(`.${READING_CODE_LINE_CLASS}`)
    expect(rows).toHaveLength(2)
    const numbers = block.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`)
    expect([...numbers].map((n) => n.textContent)).toEqual(['1', '2'])
    expect(block.querySelectorAll('[class*="tok-"]').length).toBeGreaterThan(0)
    expect(block.querySelector('code')!.getAttribute('data-vsidian-code-src')).toBe(CODE)
  })

  it('行文本拼合与源码逐字节一致（token 化不改内容）', () => {
    const block = makeBlock('js')
    decorate(block)
    const rows = [...block.querySelectorAll(`.${READING_CODE_LINE_CLASS}`)]
    const text = rows.map((r) => {
      const spans = [...r.children].filter((c) => !c.classList.contains(CODE_CARD_CLASS_NAMES.linenumber))
      return spans.map((s) => s.textContent).join('')
    }).join('\n')
    expect(text).toBe(CODE)
  })

  it('朴素形态（仅高亮）：无卡片结构，code 内直接注入 token span', () => {
    const block = makeBlock('js')
    decorate(block, { config: { card: false, lineNumbers: false, copyButton: false, highlight: true } })
    expect(block.querySelector(`.${CODE_CARD_CLASS_NAMES.header}`)).toBeNull()
    expect(block.classList.contains(READING_CODE_CARD_CLASS)).toBe(false)
    const codeEl = block.querySelector('code')!
    expect(codeEl.textContent).toBe(CODE)
    expect(codeEl.querySelectorAll('[class*="tok-"]').length).toBeGreaterThan(0)
  })

  it('两者皆关：不触碰（朴素 markdown-it 产物）', () => {
    const block = makeBlock('js')
    decorate(block, { config: { card: false, lineNumbers: false, copyButton: false, highlight: false } })
    expect(block.querySelector('code')!.textContent).toBe(CODE)
    expect(block.querySelector(`.${CODE_CARD_CLASS_NAMES.header}`)).toBeNull()
    expect(block.querySelectorAll('[class*="tok-"]')).toHaveLength(0)
  })

  it('行号子开关关闭：行结构保留但无行号', () => {
    const block = makeBlock('js')
    decorate(block, { config: { card: true, lineNumbers: false, copyButton: true, highlight: true } })
    expect(block.querySelectorAll(`.${READING_CODE_LINE_CLASS}`)).toHaveLength(2)
    expect(block.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`)).toHaveLength(0)
  })

  it('折叠：块级收起类 + chevron 转向；展开无类', () => {
    const folded = makeBlock('js')
    decorate(folded, { folded: true })
    expect(folded.classList.contains(READING_CODE_CARD_FOLDED_CLASS)).toBe(true)
    expect(folded.querySelector(`.${CODE_CARD_CLASS_NAMES.fold}`)!.classList.contains(CODE_CARD_CLASS_NAMES.foldCollapsed)).toBe(true)
    const expanded = makeBlock('js')
    decorate(expanded, { folded: false })
    expect(expanded.classList.contains(READING_CODE_CARD_FOLDED_CLASS)).toBe(false)
  })

  it('折叠收起态头部无复制按钮、展开态有（与 Live 的收起态不发射口径一致）', () => {
    const folded = makeBlock('js')
    decorate(folded, { folded: true })
    expect(folded.querySelector(`.${CODE_CARD_CLASS_NAMES.fold}`)).not.toBeNull()
    expect(folded.querySelector(`.${CODE_CARD_CLASS_NAMES.copy}`)).toBeNull()
    const expanded = makeBlock('js')
    decorate(expanded, { folded: false })
    expect(expanded.querySelector(`.${CODE_CARD_CLASS_NAMES.copy}`)).not.toBeNull()
  })

  it('复制与折叠回调：点击按钮携带代码体/触发切换', () => {
    const block = makeBlock('js')
    let copied = ''
    let toggles = 0
    decorate(block, { onCopy: (code) => { copied = code }, onFoldToggle: () => { toggles += 1 } })
    ;(block.querySelector(`.${CODE_CARD_CLASS_NAMES.copy}`) as HTMLButtonElement).click()
    expect(copied).toBe(CODE)
    ;(block.querySelector(`.${CODE_CARD_CLASS_NAMES.fold}`) as HTMLButtonElement).click()
    expect(toggles).toBe(1)
  })

  it('幂等重装饰：结构重建不重复、源码取自首捕快照', () => {
    const block = makeBlock('js')
    decorate(block)
    decorate(block)
    expect(block.querySelectorAll(`:scope > .${CODE_CARD_CLASS_NAMES.header}`)).toHaveLength(1)
    expect(block.querySelectorAll(`.${READING_CODE_LINE_CLASS}`)).toHaveLength(2)
    expect(block.querySelector('code')!.getAttribute('data-vsidian-code-src')).toBe(CODE)
  })

  it('语言映射：text → Plain text；未知语言回退原文且不着色', () => {
    const plain = makeBlock('text', 'hello')
    decorate(plain)
    expect(plain.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)!.textContent).toContain('Plain text')
    expect(plain.querySelectorAll('[class*="tok-"]')).toHaveLength(0)
    const zzz = makeBlock('zzz', 'x')
    decorate(zzz)
    expect(zzz.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)!.textContent).toContain('zzz')
    expect(zzz.querySelectorAll('[class*="tok-"]')).toHaveLength(0)
  })

  it('isReadingCodeBlock：代码块命中，mermaid 块与其他不命中', () => {
    expect(isReadingCodeBlock(makeBlock('js'))).toBe(true)
    const mermaid = document.createElement('div')
    mermaid.className = 'vsidian-reading-block vsidian-reading-mermaid'
    expect(isReadingCodeBlock(mermaid)).toBe(false)
    const para = document.createElement('div')
    para.className = 'vsidian-reading-block vsidian-reading-paragraph'
    expect(isReadingCodeBlock(para)).toBe(false)
  })

  it('大围栏分块行号连续：片携带 start/total → 行号 1..60 与 61..120、列宽一致按整块 3 位', () => {
    // 模拟 readingBlocks 60 行分块产物：120 行围栏切成两片，各 60 内容行
    const lines60 = Array.from({ length: 60 }, (_, i) => `line-${i}`).join('\n')
    const first = makeBlock('js', lines60, { start: 0, total: 120 })
    const second = makeBlock('js', lines60, { start: 60, total: 120 })
    decorate(first)
    decorate(second)
    const numsOf = (b: HTMLElement) =>
      [...b.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`)].map((n) => n.textContent)
    expect(numsOf(first)).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)))
    expect(numsOf(second)).toEqual(Array.from({ length: 60 }, (_, i) => String(61 + i)))
    // 两片列宽一致：按整块 total（120 → 3 位）而非片行数（60 → 2 位）
    const widths = [...first.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`), ...second.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`)]
      .map((n) => (n as HTMLElement).style.width)
    expect(new Set(widths)).toEqual(new Set(['3ch']))
  })

  it('无分块 data 属性时回退现行为：每片独立从 1 编号、列宽按片行数（幂等兼容旧 DOM）', () => {
    const block = makeBlock('js', 'a\nb\nc')
    decorate(block)
    const nums = [...block.querySelectorAll(`.${CODE_CARD_CLASS_NAMES.linenumber}`)]
    expect(nums.map((n) => n.textContent)).toEqual(['1', '2', '3'])
    expect((nums[0] as HTMLElement).style.width).toBe('2ch')
  })

  it('c++ 片块类提取后命中 cpp（类名正则可提取 + 注册表别名路由一致）', () => {
    const block = makeBlock('c++', 'int main() {}')
    decorate(block)
    expect(block.querySelector(`.${CODE_CARD_CLASS_NAMES.headerLabel}`)!.textContent).toContain('C++')
  })
})
