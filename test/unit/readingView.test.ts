// @vitest-environment jsdom
// 阅读视图 DOM 结构契约（工单 #8：markdown-it 渲染形态）：
// - 稳定类名入口（vsidian-view-reading / vsidian-reading-block / 细分类）
// - 源位置锚点 data-vsidian-src-start|end（LF 全文 UTF-16 offset，与协议
//   SerChange 坐标同构；#7 按需挂载与 #9 任务定位依赖此结构）
// - 块内容为语义标签（h1/p/blockquote/ul/pre…），行内语义（em/strong/code）
//   随 markdown-it 渲染；Obsidian 片段的标签选择器可命中
// - 任务语义入口：disabled checkbox + marker 区间锚点（#9 实现写回）
// - 源文中的 HTML 形态按纯文本呈现（html:false + DOM 净化）
import { describe, it, expect } from 'vitest'
import {
  READING_CLASS_NAMES,
  renderReadingBlocks,
  findReadingAnchor,
  scrollReadingToSrcStart,
  createReadingContainer,
} from '../../src/webview/readingView'

const DOC = '# 顶部标题\n\n第一段文本\n\n- [ ] 未完成任务\n- [x] 已完成任务\n\n```code\n伪内容\n```\n\n结尾段\n'

function rendered() {
  const container = createReadingContainer()
  const count = renderReadingBlocks(container, DOC)
  return { container, count }
}

describe('createReadingContainer：稳定容器类名', () => {
  it('容器带 vsidian-view-reading 稳定类名与模式标记', () => {
    const container = createReadingContainer()
    expect(container.classList.contains(READING_CLASS_NAMES.view)).toBe(true)
    expect(container.dataset['vsidianMode']).toBe('reading')
  })
})

describe('renderReadingBlocks：块结构与源锚点', () => {
  it('返回块数并生成对应块元素（列表整体一块）', () => {
    const { container, count } = rendered()
    const els = container.querySelectorAll(`.${READING_CLASS_NAMES.block}`)
    expect(els.length).toBe(count)
    // 标题 / 段落 / 列表（整体） / 代码块 / 结尾段
    expect(count).toBe(5)
  })

  it('每块带 data-vsidian-src-start/end，区间内容与源文本一致', () => {
    const { container } = rendered()
    const els = Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`))
    for (const el of els) {
      const start = Number(el.dataset['vsidianSrcStart'])
      const end = Number(el.dataset['vsidianSrcEnd'])
      expect(Number.isInteger(start)).toBe(true)
      expect(end).toBeGreaterThan(start)
      expect(DOC.slice(start, end).length).toBe(end - start)
    }
  })

  it('标题块带级别细分类名，内容为语义 h1（无 # 源码标记）', () => {
    const { container } = rendered()
    const h1 = container.querySelector(`.${READING_CLASS_NAMES.heading(1)}`)
    expect(h1).not.toBeNull()
    expect(h1!.classList.contains(READING_CLASS_NAMES.block)).toBe(true)
    expect(h1!.querySelector('h1')?.textContent).toBe('顶部标题')
    expect(h1!.textContent).not.toContain('#')
  })

  it('段落与代码块的语义标签；代码内容不含围栏标记', () => {
    const { container } = rendered()
    expect(container.querySelector(`.${READING_CLASS_NAMES.paragraph} p`)).not.toBeNull()
    const code = container.querySelector(`.${READING_CLASS_NAMES.codeBlock}`)
    expect(code).not.toBeNull()
    expect(code!.querySelector('pre code')?.textContent).toContain('伪内容')
    expect(code!.textContent).not.toContain('```')
  })

  it('重入渲染先清空旧块（外部变更后的重建路径）', () => {
    const container = createReadingContainer()
    renderReadingBlocks(container, DOC)
    const count2 = renderReadingBlocks(container, '新文本\n')
    expect(container.querySelectorAll(`.${READING_CLASS_NAMES.block}`).length).toBe(1)
    expect(count2).toBe(1)
  })
})

describe('任务语义入口（#9：可交互勾选）', () => {
  it('任务项渲染启用 checkbox，勾选状态映射，带 marker 区间锚点', () => {
    const { container } = rendered()
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>(`.${READING_CLASS_NAMES.taskCheckbox}`))
    expect(boxes.length).toBe(2)
    expect(boxes[0]!.disabled).toBe(false) // #9 起启用：点击走勾选写回链路
    expect(boxes[0]!.checked).toBe(false)
    expect(boxes[1]!.checked).toBe(true)
    // checkbox 的 data 锚点指向源文 [ ]/[x] 标记区间（#9 写回定位依据）
    const s = Number(boxes[1]!.dataset['vsidianSrcStart'])
    const e = Number(boxes[1]!.dataset['vsidianSrcEnd'])
    expect(DOC.slice(s, e)).toBe('[x]')
    // 渲染态锚点（data-vsidian-checked）：点击意图的确定性来源（不受原生
    // checkbox 激活时序影响）
    expect(boxes[0]!.dataset['vsidianChecked']).toBe('false')
    expect(boxes[1]!.dataset['vsidianChecked']).toBe('true')
    // 任务 li 带任务语义类与自身锚点
    const tasks = container.querySelectorAll(`li.${READING_CLASS_NAMES.task}`)
    expect(tasks.length).toBe(2)
    expect(DOC.slice(Number(tasks[0]!.querySelector('input')!.dataset['vsidianSrcStart']), Number(tasks[0]!.querySelector('input')!.dataset['vsidianSrcEnd']))).toBe('[ ]')
  })
})

describe('源文本安全注入', () => {
  it('HTML 形态的源文本按纯文本呈现，不产生元素节点', () => {
    const container = createReadingContainer()
    renderReadingBlocks(container, '<script>alert(1)</script>\n\n<b>加粗</b>\n')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<b>加粗</b>')
  })

  it('javascript: 链接不产生可执行 href', () => {
    const container = createReadingContainer()
    renderReadingBlocks(container, '[点我](javascript:alert(1))\n')
    const anchors = Array.from(container.querySelectorAll('a'))
    for (const a of anchors) {
      expect(a.getAttribute('href')).not.toContain('javascript:')
    }
  })
})

describe('frontmatter 呈现（局部源码降级）', () => {
  it('frontmatter 块按源码呈现，内部 # 不渲染为标题', () => {
    const container = createReadingContainer()
    renderReadingBlocks(container, '---\ntitle: 元\n# 伪\n---\n\n# 真标题\n')
    const fm = container.querySelector(`.${READING_CLASS_NAMES.frontmatter}`)
    expect(fm).not.toBeNull()
    expect(fm!.textContent).toContain('title: 元')
    expect(fm!.textContent).toContain('# 伪')
    expect(fm!.querySelector('h1')).toBeNull()
    const headings = Array.from(container.querySelectorAll(`.${READING_CLASS_NAMES.block} h1`))
    expect(headings.length).toBe(1)
    expect(headings[0]!.textContent).toBe('真标题')
  })
})

describe('阅读锚点定位', () => {
  it('findReadingAnchor：无布局信息（jsdom offsetTop 全 0）回退第一个块', () => {
    const { container } = rendered()
    const first = container.querySelector<HTMLElement>(`.${READING_CLASS_NAMES.block}`)!
    expect(findReadingAnchor(container)).toBe(Number(first.dataset['vsidianSrcStart']))
  })

  it('findReadingAnchor：有布局时返回视口内首个可见块的源 start', () => {
    const { container } = rendered()
    const els = Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`))
    els.forEach((el, i) => {
      Object.defineProperty(el, 'offsetTop', { value: i * 100 })
      Object.defineProperty(el, 'offsetHeight', { value: 50 })
    })
    container.scrollTop = 150 // 视口顶在 150：第一块 [0,50) 第二块 [100,150) 第三块 [200,250)
    const anchor = findReadingAnchor(container)
    expect(anchor).toBe(Number(els[2]!.dataset['vsidianSrcStart']))
  })

  it('scrollReadingToSrcStart：滚动到目标块（按源 start 定位元素）', () => {
    const { container } = rendered()
    const els = Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`))
    els.forEach((el, i) => {
      Object.defineProperty(el, 'offsetTop', { value: i * 100 })
    })
    const target = els[3]!
    scrollReadingToSrcStart(container, Number(target.dataset['vsidianSrcStart']))
    expect(container.scrollTop).toBe(300)
  })

  it('scrollReadingToSrcStart：目标不存在时不抛错（锚点失效防御）', () => {
    const { container } = rendered()
    expect(() => scrollReadingToSrcStart(container, 99999)).not.toThrow()
  })

  it('空容器 findReadingAnchor 返回 null', () => {
    expect(findReadingAnchor(createReadingContainer())).toBeNull()
  })
})
