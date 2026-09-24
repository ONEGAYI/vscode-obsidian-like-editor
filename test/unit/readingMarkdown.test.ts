// @vitest-environment jsdom
// 阅读视图 markdown-it 渲染契约（工单 #8）：
// - 安全配置：html:false（Markdown 原文不作可执行 HTML），linkify/typographer
//   关闭；javascript: 协议链接不产生可点击 href（markdown-it validateLink 默认拦截）
// - 列表项源锚点：list_item_open 自定义渲染规则写入 data-vsidian-src-start/end
//   （#9 任务写回与块内定位的依据）
// - DOM 净化：markdown-it 输出进入 DOM 后的防御性二次清洗（script/iframe/
//   行内事件属性/javascript: 链接）——规格安全边界的纵深防御层
// - 任务项转换：li 首文本 `[ ] `/`[x] ` → disabled checkbox + marker 区间锚点
//   （#8 只做显示，#9 实现勾选写回）
import { describe, it, expect } from 'vitest'
import {
  convertTaskItems,
  buildLineBounds,
  createMarkdownRenderer,
  renderTokenHtml,
  sanitizeReadingDom,
} from '../../src/webview/readingMarkdown'

function renderToDom(md: ReturnType<typeof createMarkdownRenderer>, src: string): HTMLElement {
  const env = buildLineBounds(src)
  const tokens = md.parse(src, env as unknown as Parameters<ReturnType<typeof createMarkdownRenderer>['parse']>[1])
  const host = document.createElement('div')
  host.innerHTML = renderTokenHtml(md, tokens, env)
  return host
}

describe('createMarkdownRenderer：安全配置', () => {
  it('html:false——源文中的 HTML 标签按纯文本转义，不产生元素', () => {
    const md = createMarkdownRenderer()
    const host = renderToDom(md, '<script>alert(1)</script>\n\n<b>加粗</b>\n')
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('b')).toBeNull()
    expect(host.textContent).toContain('<script>alert(1)</script>')
    expect(host.textContent).toContain('<b>加粗</b>')
  })

  it('javascript: 协议链接不产生可执行 href（validateLink 默认拦截）', () => {
    const md = createMarkdownRenderer()
    const host = renderToDom(md, '[点击](javascript:alert(1))\n')
    const anchor = host.querySelector('a')
    expect(anchor).toBeNull() // 拦截后按普通文本呈现
  })

  it('基础语义渲染：粗体/斜体/行内代码/标题/引用/围栏', () => {
    const md = createMarkdownRenderer()
    const host = renderToDom(
      md,
      '# 标题\n\n**粗** 与 *斜* 和 `码`\n\n> 引用\n\n```\ncode\n```\n',
    )
    expect(host.querySelector('h1')?.textContent).toBe('标题')
    expect(host.querySelector('strong')?.textContent).toBe('粗')
    expect(host.querySelector('em')?.textContent).toBe('斜')
    expect(host.querySelector('code')?.textContent).toBe('码')
    expect(host.querySelector('blockquote')?.textContent).toContain('引用')
    expect(host.querySelector('pre code')?.textContent).toContain('code')
  })
})

describe('行尾双空格与末尾无换行（mvp.md 文档样例清单）', () => {
  it('行尾双空格渲染为硬换行 <br>（CommonMark 语义），行尾单空格不产生', () => {
    const md = createMarkdownRenderer()
    const hard = renderToDom(md, '第一行  \n第二行\n')
    expect(hard.querySelector('p')!.innerHTML).toContain('<br')
    const soft = renderToDom(md, '第一行 \n第二行\n')
    expect(soft.querySelector('p')!.innerHTML).not.toContain('<br')
  })

  it('单行无换行文档渲染不崩、文本保真；渲染层吞块尾空格是 CommonMark 标准（保真责任在编辑路径）', () => {
    const md = createMarkdownRenderer()
    const host = renderToDom(md, 'abc')
    sanitizeReadingDom(host) // 净化层同时跑通
    expect(host.textContent!.trim()).toBe('abc') // 块级 HTML 尾随 \n 不计入
    const tail = renderToDom(md, 'a  \nb ') // 段内双空格硬换行保留，块尾单空格按标准剥离
    sanitizeReadingDom(tail)
    expect(tail.querySelector('br')).not.toBeNull()
    expect(tail.textContent!.trim()).toBe('a\nb')
  })
})

describe('列表项源锚点（list_item_open 自定义规则）', () => {
  it('每个 li 携带其首行起止 offset（含嵌套项）', () => {
    const md = createMarkdownRenderer()
    const src = '- 甲项\n- 乙项\n  - 嵌套项\n'
    const host = renderToDom(md, src)
    const items = Array.from(host.querySelectorAll('li'))
    expect(items).toHaveLength(3)
    const starts = items.map((li) => Number(li.dataset['vsidianSrcStart']))
    const ends = items.map((li) => Number(li.dataset['vsidianSrcEnd']))
    expect(src.slice(starts[0]!, ends[0]!)).toBe('- 甲项')
    // 外层 li 的源区间覆盖其嵌套列表（DOM 上嵌套 ul 在该 li 内，区间语义一致）
    expect(src.slice(starts[1]!, ends[1]!)).toBe('- 乙项\n  - 嵌套项')
    expect(src.slice(starts[2]!, ends[2]!)).toBe('  - 嵌套项')
  })
})

describe('sanitizeReadingDom：DOM 纵深净化', () => {
  it('移除 script/iframe/style 元素、行内事件属性与 javascript: 链接', () => {
    const host = document.createElement('div')
    // 模拟"渲染器被绕过"的极端输入（html:false 下不应出现；此为防御层验证）
    host.innerHTML =
      '<p onclick="evil()">文</p><script>bad()</script><iframe src="x"></iframe>' +
      '<style>body{}</style><a href="javascript:evil()">链</a><a href="https://ok">好</a>'
    sanitizeReadingDom(host)
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('iframe')).toBeNull()
    expect(host.querySelector('style')).toBeNull()
    expect(host.querySelector('p')!.getAttribute('onclick')).toBeNull()
    const links = Array.from(host.querySelectorAll('a'))
    expect(links).toHaveLength(2)
    expect(links[0]!.getAttribute('href')).toBeNull() // 危险链接摘除 href 后保留惰性元素
    expect(links[1]!.getAttribute('href')).toBe('https://ok')
  })
})

describe('convertTaskItems：任务项 checkbox（#9：启用可交互）', () => {
  it('li 首文本 [ ]/[x]/[X] → 启用的 checkbox，锚点恰为标记三字符区间', () => {
    const md = createMarkdownRenderer()
    const src = '- [ ] 未完成\n- [x] 已完成\n- [X] 大写完成\n- 普通项\n'
    const host = renderToDom(md, src)
    convertTaskItems(host, src)
    const boxes = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    expect(boxes).toHaveLength(3)
    expect(boxes.every((b) => !b.disabled)).toBe(true) // #9：启用（点击写回）
    expect(boxes.map((b) => b.checked)).toEqual([false, true, true])
    // 渲染态锚点（data-vsidian-checked）：点击意图的确定性来源
    expect(boxes.map((b) => b.dataset['vsidianChecked'])).toEqual(['false', 'true', 'true'])
    // 锚点：源文 [ ]/[x]/[X] 区间
    expect(src.slice(Number(boxes[0]!.dataset['vsidianSrcStart']), Number(boxes[0]!.dataset['vsidianSrcEnd']))).toBe('[ ]')
    expect(src.slice(Number(boxes[1]!.dataset['vsidianSrcStart']), Number(boxes[1]!.dataset['vsidianSrcEnd']))).toBe('[x]')
    expect(src.slice(Number(boxes[2]!.dataset['vsidianSrcStart']), Number(boxes[2]!.dataset['vsidianSrcEnd']))).toBe('[X]')
    // 任务项 li 带任务语义类（#9 勾选定位入口）
    expect(host.querySelectorAll('li.vsidian-reading-task')).toHaveLength(3)
    // 普通项不受影响
    const last = Array.from(host.querySelectorAll('li')).pop()!
    expect(last.textContent).toBe('普通项')
    expect(last.classList.contains('vsidian-reading-task')).toBe(false)
  })

  it('嵌套缩进的任务项锚点取自其自身首行', () => {
    const md = createMarkdownRenderer()
    const src = '- 外层\n  - [x] 嵌套任务\n'
    const host = renderToDom(md, src)
    convertTaskItems(host, src)
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box).not.toBeNull()
    const s = Number(box.dataset['vsidianSrcStart'])
    expect(src.slice(s, s + 3)).toBe('[x]')
  })
})
