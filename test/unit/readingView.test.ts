// @vitest-environment jsdom
// 阅读视图 DOM 结构契约（工单 #6）：
// - 稳定类名入口（oile-view-reading / oile-reading-block / 细分类）
// - 源位置锚点 data-oile-src-start|end（LF 全文 UTF-16 offset，与协议
//   SerChange 坐标同构；#7 按需挂载与 #9 任务定位依赖此结构）
// - 任务语义入口：disabled checkbox + marker 区间锚点（#9 实现写回）
// - 源文本一律经 textContent 注入，不得作为 HTML 解析
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
  it('容器带 oile-view-reading 稳定类名与模式标记', () => {
    const container = createReadingContainer()
    expect(container.classList.contains(READING_CLASS_NAMES.view)).toBe(true)
    expect(container.dataset['oileMode']).toBe('reading')
  })
})

describe('renderReadingBlocks：块结构与源锚点', () => {
  it('返回块数并在容器内生成对应块元素', () => {
    const { container, count } = rendered()
    const els = container.querySelectorAll(`.${READING_CLASS_NAMES.block}`)
    expect(els.length).toBe(count)
    // 标题 / 第一段 / 两个任务项 / 代码块 / 结尾段
    expect(count).toBe(6)
  })

  it('每块带 data-oile-src-start/end，区间内容与源文本一致', () => {
    const { container } = rendered()
    const els = Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`))
    for (const el of els) {
      const start = Number(el.dataset['oileSrcStart'])
      const end = Number(el.dataset['oileSrcEnd'])
      expect(Number.isInteger(start)).toBe(true)
      expect(end).toBeGreaterThan(start)
      expect(DOC.slice(start, end).length).toBe(end - start)
    }
  })

  it('标题块带级别细分类名 oile-reading-heading-1', () => {
    const { container } = rendered()
    const h1 = container.querySelector(`.${READING_CLASS_NAMES.heading(1)}`)
    expect(h1).not.toBeNull()
    expect(h1!.classList.contains(READING_CLASS_NAMES.block)).toBe(true)
    expect(h1!.textContent).toBe('# 顶部标题')
  })

  it('段落块带 oile-reading-paragraph；代码块带 oile-reading-code-block', () => {
    const { container } = rendered()
    expect(container.querySelector(`.${READING_CLASS_NAMES.paragraph}`)).not.toBeNull()
    const code = container.querySelector(`.${READING_CLASS_NAMES.codeBlock}`)
    expect(code).not.toBeNull()
    expect(code!.textContent).toContain('```code')
  })

  it('列表项带 oile-reading-list-item', () => {
    const { container } = rendered()
    const items = container.querySelectorAll(`.${READING_CLASS_NAMES.listItem}`)
    expect(items.length).toBe(2)
  })

  it('重入渲染先清空旧块（外部变更后的重建路径）', () => {
    const container = createReadingContainer()
    renderReadingBlocks(container, DOC)
    const count2 = renderReadingBlocks(container, '新文本\n')
    expect(container.querySelectorAll(`.${READING_CLASS_NAMES.block}`).length).toBe(1)
    expect(count2).toBe(1)
  })
})

describe('任务语义入口（#9 预留）', () => {
  it('任务项渲染 disabled checkbox，勾选状态映射，带 marker 区间锚点', () => {
    const { container } = rendered()
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>(`.${READING_CLASS_NAMES.taskCheckbox}`))
    expect(boxes.length).toBe(2)
    expect(boxes[0]!.disabled).toBe(true)
    expect(boxes[0]!.checked).toBe(false)
    expect(boxes[1]!.checked).toBe(true)
    // checkbox 的 data 锚点指向源文 [ ]/[x] 标记区间（#9 写回定位依据）
    const s = Number(boxes[1]!.dataset['oileSrcStart'])
    const e = Number(boxes[1]!.dataset['oileSrcEnd'])
    expect(DOC.slice(s, e)).toBe('[x]')
    // 任务块本体带 oile-reading-task 类
    const tasks = container.querySelectorAll(`.${READING_CLASS_NAMES.task}`)
    expect(tasks.length).toBe(2)
  })
})

describe('源文本安全注入', () => {
  it('HTML 形态的源文本按纯文本呈现，不产生元素节点', () => {
    const container = createReadingContainer()
    renderReadingBlocks(container, '<script>alert(1)</script>\n<b>加粗</b>\n')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })
})

describe('阅读锚点定位', () => {
  it('findReadingAnchor：无布局信息（jsdom offsetTop 全 0）回退第一个块', () => {
    const { container } = rendered()
    const first = container.querySelector<HTMLElement>(`.${READING_CLASS_NAMES.block}`)!
    expect(findReadingAnchor(container)).toBe(Number(first.dataset['oileSrcStart']))
  })

  it('findReadingAnchor：有布局时返回视口内首个可见块的源 start', () => {
    const { container } = rendered()
    const els = Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`))
    // stub offsetTop/offsetHeight：前两块在视口上方，第三块起可见
    els.forEach((el, i) => {
      Object.defineProperty(el, 'offsetTop', { value: i * 100 })
      Object.defineProperty(el, 'offsetHeight', { value: 50 })
    })
    container.scrollTop = 150 // 视口顶在 150：第一块 [0,50) 第二块 [100,150) 第三块 [200,250)
    const anchor = findReadingAnchor(container)
    expect(anchor).toBe(Number(els[2]!.dataset['oileSrcStart']))
  })

  it('scrollReadingToSrcStart：滚动到目标块（按源 start 定位元素）', () => {
    const { container } = rendered()
    const els = Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`))
    els.forEach((el, i) => {
      Object.defineProperty(el, 'offsetTop', { value: i * 100 })
    })
    const target = els[3]!
    scrollReadingToSrcStart(container, Number(target.dataset['oileSrcStart']))
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
