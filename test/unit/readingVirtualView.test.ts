// @vitest-environment jsdom
// 阅读视图按需挂载的 DOM 层契约（工单 #7）：
// - 布局可用时虚拟化：只挂载窗口内块，屏外块以上下 spacer 占位（布局信息
//   占位，非内容节点）；挂载是真实按需创建（不是整篇渲染后隐藏）
// - 滚动不重复解析：setDocument 一次全文切块，任意次滚动 parseCount 不增
// - 回收：离开窗口的块节点移除；保留块不重建（元素身份稳定）
// - 挂载后回填实测高度（占位估计 → 实测），回收块保留最后实测值
// - 源 offset 映射与滚动定位基于块模型（目标块可在屏外，不依赖其已挂载）
// - 无布局（jsdom 隐藏容器 clientHeight=0）回退全量渲染路径
//
// 布局桩：jsdom 无排版——offsetHeight 经原型 getter 桩为定值（两种档位：
// 与估计一致 36px / 大于估计 40px），clientHeight 经实例属性桩为 400。
// 视觉布局的真实行为（spacer 稳定性、图片尺寸变化）在集成宿主验证。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VirtualReadingView } from '../../src/webview/readingVirtualView'
import { createReadingContainer, READING_CLASS_NAMES } from '../../src/webview/readingView'
import { splitReadingBlocks } from '../../src/webview/readingBlocks'
import { computeMountWindow } from '../../src/webview/readingViewport'

/** 生成 n 个单行段落块（空行分隔） */
function makeDoc(n: number): string {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      lines.push('')
    }
    lines.push(`第 ${i} 段普通文本内容`)
  }
  return lines.join('\n') + '\n'
}

/** 把容器 clientHeight 桩为指定值（0 = 无布局回退） */
function stubClientHeight(container: HTMLElement, h: number): void {
  Object.defineProperty(container, 'clientHeight', { value: h, configurable: true })
}

function mountedStarts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`)).map(
    (el) => el.dataset['oileSrcStart'] ?? '',
  )
}

describe('VirtualReadingView：按需挂载与占位', () => {
  let heightSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(36)
  })
  afterEach(() => {
    heightSpy.mockRestore()
  })

  it('布局可用：只挂载窗口内块，上下 spacer 占位屏外高度', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const stats = view.getStats()
    expect(stats.virtualized).toBe(true)
    expect(stats.totalBlocks).toBe(100)
    // 窗口 [0,1000)，单行段落估计 24+12=36px → 块 0..27（28 块）
    expect(stats.mountedBlocks).toBe(28)
    // 容器结构：spacerTop + 窗口块 + spacerBottom（屏外块无内容节点）
    const children = Array.from(container.children)
    expect(children).toHaveLength(28 + 2)
    expect(children[0]!.classList.contains(READING_CLASS_NAMES.spacerTop)).toBe(true)
    expect(children[children.length - 1]!.classList.contains(READING_CLASS_NAMES.spacerBottom)).toBe(true)
    // 顶部 spacer 高度为 0；底部 spacer = 屏外总高估计（72 块 × 36px）
    expect((children[0]! as HTMLElement).style.height).toBe('0px')
    const bottomPx = Number.parseFloat((children[children.length - 1]! as HTMLElement).style.height)
    expect(bottomPx).toBe(72 * 36)
    // 挂载块带源锚点且按块序排列
    const blocks = splitReadingBlocks(text)
    expect(mountedStarts(container)).toEqual(
      blocks.slice(0, 28).map((b) => String(b.start)),
    )
  })

  it('挂载是真实按需创建：屏外块不出现在 DOM（非隐藏整篇）', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    expect(container.querySelectorAll(`.${READING_CLASS_NAMES.block}`).length).toBe(28)
    // 屏外块既无内容节点也无 display:none 的隐藏副本
    expect(container.children.length).toBe(30)
  })

  it('滚动后重挂窗口：旧窗口外块回收、新进入块创建，解析次数不增', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const firstElements = Array.from(
      container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`),
    )
    container.scrollTop = 2000
    view.updateNow()
    // 36px × 100 块：scrollTop 2000 → 窗口 [1400,3000) → 块 38..83（46 块）
    const blocks = splitReadingBlocks(text)
    const expected = computeMountWindow(Array.from({ length: 100 }, () => 36), 2000, 400, 600)!
    expect(mountedStarts(container)).toEqual(
      blocks.slice(expected.first, expected.last + 1).map((b) => String(b.start)),
    )
    // 旧窗口内仍在新窗口的块（38..24 无交集——本次窗口整体平移）……
    // 窗口 [0,24] 与 [38,83] 不相交：首屏元素应全部被回收
    for (const el of firstElements) {
      expect(container.contains(el)).toBe(false)
    }
    expect(container.querySelectorAll(`.${READING_CLASS_NAMES.block}`).length).toBe(
      expected.last - expected.first + 1,
    )
    // 滚动不重复解析（解析与挂载分离的核心断言）
    expect(view.getStats().parseCount).toBe(1)
    container.scrollTop = 800
    view.updateNow()
    container.scrollTop = 3000
    view.updateNow()
    expect(view.getStats().parseCount).toBe(1)
  })

  it('窗口重叠平移：保留块元素身份稳定（不重建）', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const before = Array.from(
      container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`),
    )
    container.scrollTop = 500 // 窗口 [0,1500) → 块 0..41：重叠扩展
    view.updateNow()
    const after = Array.from(
      container.querySelectorAll<HTMLElement>(`.${READING_CLASS_NAMES.block}`),
    )
    // 旧窗口块 0..24 全部保留（元素身份不变），新挂载块 25..41
    for (const el of before) {
      expect(after).toContain(el)
    }
    expect(after.length).toBe(42)
  })

  it('挂载后回填实测高度并重估未测块：spacer 按实测收敛（估计 36 → 实测 40）', () => {
    heightSpy.mockReturnValue(40)
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    // 窗口按估计 36 计算（块 0..27）；实测外高 40 → 标定行高 (40-12)/1=28
    // → 漂移 >2% 触发未测块重估（1×28+12=40）→ 底部 spacer = 72 块 × 40
    const children = Array.from(container.children)
    expect((children[children.length - 1]! as HTMLElement).style.height).toBe(`${72 * 40}px`)
    expect(view.getStats().mountedBlocks).toBe(28)
  })

  it('回收块保留最后实测高度（估计不再回退）', () => {
    heightSpy.mockReturnValue(40)
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    // 首屏块 0..27 实测 40；滚动到中部：已测块以 40 计入顶部 spacer，
    // 严格大于全估计（36）基线——实测回填在回收后仍保留
    container.scrollTop = 2000
    view.updateNow()
    const blocks = splitReadingBlocks(text)
    const spacerTop = container.querySelector<HTMLElement>(`.${READING_CLASS_NAMES.spacerTop}`)!
    const topPx = Number.parseFloat(spacerTop.style.height)
    const firstStart = mountedStarts(container)[0]!
    const firstIdx = blocks.findIndex((b) => String(b.start) === firstStart)
    expect(firstIdx).toBeGreaterThan(0)
    expect(topPx).toBeGreaterThan(firstIdx * 36)
  })

  it('无布局（clientHeight=0）：回退全量渲染，锚点语义与 #6 一致', () => {
    const text = makeDoc(50)
    const container = createReadingContainer()
    stubClientHeight(container, 0)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const stats = view.getStats()
    expect(stats.virtualized).toBe(false)
    expect(stats.mountedBlocks).toBe(50)
    expect(stats.parseCount).toBe(1)
    // 全量回退路径复用 #6 的 DOM 查询语义
    expect(view.anchorStartFor(text.length)).not.toBeNull()
    expect(view.currentAnchor()).toBe(Number(splitReadingBlocks(text)[0]!.start))
  })
})

describe('VirtualReadingView：源锚点定位（屏外目标）', () => {
  let heightSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(36)
  })
  afterEach(() => {
    heightSpy.mockRestore()
  })

  it('anchorStartFor 对屏外 offset 返回其块 start（基于块模型，不依赖 DOM）', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const blocks = splitReadingBlocks(text)
    const far = blocks[90]!
    expect(view.anchorStartFor(far.start + 2)).toBe(far.start)
    // 缝隙 floor 语义
    expect(view.anchorStartFor(blocks[30]!.end + 1)).toBe(blocks[30]!.start)
  })

  it('scrollToSrcStart 滚动到屏外块估计位置并挂载该块', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const blocks = splitReadingBlocks(text)
    const target = blocks[90]!
    view.scrollToSrcStart(target.start)
    // 估计位置：36px/块 → scrollTop = 90×36
    expect(container.scrollTop).toBe(90 * 36)
    const starts = mountedStarts(container)
    expect(starts).toContain(String(target.start))
    // 目标块位于窗口内（可见 + 缓冲）
    const idx = starts.indexOf(String(target.start))
    expect(idx).toBeGreaterThan(0)
    expect(view.getStats().parseCount).toBe(1)
  })

  it('currentAnchor 返回视口顶相交块的源 start（模型版锚点）', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const blocks = splitReadingBlocks(text)
    container.scrollTop = 36 * 10
    view.updateNow()
    expect(view.currentAnchor()).toBe(blocks[10]!.start)
  })

  it('scrollToOffset：offset → 锚点块 → 滚动（#10 查找跳转的定位链）', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const blocks = splitReadingBlocks(text)
    view.scrollToOffset(blocks[70]!.start + 3)
    expect(view.currentAnchor()).toBe(blocks[70]!.start)
    expect(mountedStarts(container)).toContain(String(blocks[70]!.start))
  })
})

describe('VirtualReadingView：动态尺寸变化与生命周期', () => {
  let heightSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(36)
  })
  afterEach(() => {
    heightSpy.mockRestore()
  })

  it('图片尺寸变化：上方内容增高由滚动补偿，锚点块视觉位置稳定（#7 核心机制）', async () => {
    // offsetHeight 桩：含注入 img 的块按 img 高度叠加（模拟真实布局增长）
    heightSpy.mockImplementation(function (this: HTMLElement) {
      const img = this.querySelector?.('img') as HTMLElement | null
      const extra = img ? Number.parseFloat(img.style.height) || 0 : 0
      return 36 + extra
    })
    const text = makeDoc(400)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const blocks = splitReadingBlocks(text)
    const anchor = blocks[201]!
    view.scrollToSrcStart(anchor.start)
    const scrollTopBefore = container.scrollTop
    expect(view.currentAnchor()).toBe(anchor.start)
    // 图片注入到锚点上方 10 块：20px → 240px（延迟 20ms；jsdom 无 RO，
    // 由注入方调度的兜底 update 驱动实测与补偿）
    view.injectTestImage(blocks[191]!.start, 20, 240, 20)
    await new Promise((r) => setTimeout(r, 200)) // 尺寸变化 + rAF 窗口重算
    // 上方内容共增高 240px（初始 20 + 增长 220）：scrollTop 平移补偿同量，
    // 锚点块保持视口顶块——视觉位置不变（源位置锚点稳定的核心机制）
    expect(container.scrollTop).toBeCloseTo(scrollTopBefore + 240, 0)
    expect(view.currentAnchor()).toBe(anchor.start)
    expect(view.getStats().parseCount).toBe(1)
    view.dispose()
  })

  it('injectTestImage：向指定块注入空 src 图片元素（集成测试的尺寸变化载体）', () => {
    const text = makeDoc(100)
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(text)
    const blocks = splitReadingBlocks(text)
    view.injectTestImage(blocks[2]!.start, 20, 240, 60000)
    const img = container.querySelector<HTMLImageElement>(
      `.${READING_CLASS_NAMES.block} img`,
    )
    expect(img).not.toBeNull()
    expect(img!.style.height).toBe('20px')
    expect(img!.getAttribute('src')).toBe('') // 空 src：CSP 拦截加载，无网络请求
    expect(img!.style.display).toBe('block') // 块级替换元素：布局尺寸确定
    view.dispose()
  })

  it('setDocument 重入：文本变更后重建块模型（外部变更重建路径）', () => {
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(makeDoc(100))
    expect(view.getStats().parseCount).toBe(1)
    view.setDocument('新文本\n')
    expect(view.getStats().parseCount).toBe(2)
    expect(view.getStats().totalBlocks).toBe(1)
    expect(mountedStarts(container)).toHaveLength(1)
    view.dispose()
  })

  it('dispose 后容器清空且不再持有引用', () => {
    const container = createReadingContainer()
    stubClientHeight(container, 400)
    const view = new VirtualReadingView(container, { bufferPx: 600 })
    view.setDocument(makeDoc(100))
    view.dispose()
    expect(container.children.length).toBe(0)
  })
})
