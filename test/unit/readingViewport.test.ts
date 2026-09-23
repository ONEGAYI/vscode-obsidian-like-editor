// 阅读视口按需挂载的纯函数契约（工单 #7，TDD 先行）：
// - 挂载窗口计算：可见 + 缓冲区间，窗口宽度只依赖视口与缓冲、不随文档体量增长
// - 占位高度估计：按块行数 × 行高（挂载前无真实渲染时的初始估计），可由实测标定
// - 回收策略：窗口差分给出挂载/回收索引，仍在窗口内的块不出现在任一列表
// - 源 offset → 块索引映射：与 readingBlocks.blockForOffset 的 floor 语义一致
//
// 本文件不依赖 DOM（node 环境）；DOM 挂载行为见 readingVirtualView.test.ts。
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LINE_HEIGHT_PX,
  HEADING_HEIGHT_SCALES,
  blockLineCount,
  blockTops,
  estimateBlockHeightPx,
  estimateHeights,
  computeMountWindow,
  diffWindow,
  blockIndexForOffset,
  anchorIndexAtScroll,
  recalibrate,
  type MountWindow,
} from '../../src/webview/readingViewport'
import { splitReadingBlocks, type ReadingBlock } from '../../src/webview/readingBlocks'

/** 生成 n 个单行段落块（空行分隔），每块源区间已知 */
function paragraphBlocks(n: number): { text: string; blocks: ReadingBlock[] } {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      lines.push('')
    }
    lines.push(`第 ${i} 段普通文本内容`)
  }
  const text = lines.join('\n') + '\n'
  return { text, blocks: splitReadingBlocks(text) }
}

describe('blockLineCount：块内行数', () => {
  it('单行块为 1，多行块按 LF 计数 + 1', () => {
    const { text, blocks } = paragraphBlocks(3)
    expect(blockLineCount(blocks[0]!, text)).toBe(1)
    const code = '```a\nline1\nline2\nline3\n```'
    const codeBlocks = splitReadingBlocks(code)
    expect(blockLineCount(codeBlocks[0]!, code)).toBe(5)
  })
})

describe('estimateBlockHeightPx：占位高度初始估计', () => {
  it('与行数成正比（同种类块行数翻倍高度约翻倍）', () => {
    const one = '单行段落'
    const two = '第一行\n第二行'
    const b1 = splitReadingBlocks(one)[0]!
    const b2 = splitReadingBlocks(two)[0]!
    const h1 = estimateBlockHeightPx(b1, one, { lineHeightPx: DEFAULT_LINE_HEIGHT_PX })
    const h2 = estimateBlockHeightPx(b2, two, { lineHeightPx: DEFAULT_LINE_HEIGHT_PX })
    expect(h1).toBeGreaterThan(0)
    expect(h2).toBeGreaterThan(h1 * 1.5) // 两行显著高于一行（含固定间距）
    expect(h2).toBeLessThan(h1 * 3) // 但不至于三倍
  })

  it('标题按级别放大（与 CSS 缩放同向：一级 > 二级 > 普通段落）', () => {
    const h1Doc = '# 标题一内容'
    const h2Doc = '## 标题二内容'
    const pDoc = '普通段落内容'
    const e1 = estimateBlockHeightPx(splitReadingBlocks(h1Doc)[0]!, h1Doc, { lineHeightPx: 24 })
    const e2 = estimateBlockHeightPx(splitReadingBlocks(h2Doc)[0]!, h2Doc, { lineHeightPx: 24 })
    const ep = estimateBlockHeightPx(splitReadingBlocks(pDoc)[0]!, pDoc, { lineHeightPx: 24 })
    expect(e1).toBeGreaterThan(e2)
    expect(e2).toBeGreaterThan(ep)
    expect(HEADING_HEIGHT_SCALES[1]).toBeGreaterThan(HEADING_HEIGHT_SCALES[2])
  })

  it('estimateHeights 返回与块数等长的正数数组', () => {
    const { text, blocks } = paragraphBlocks(5)
    const heights = estimateHeights(blocks, text, { lineHeightPx: DEFAULT_LINE_HEIGHT_PX })
    expect(heights).toHaveLength(blocks.length)
    for (const h of heights) {
      expect(h).toBeGreaterThan(0)
    }
  })
})

describe('blockTops：块顶前缀和', () => {
  it('tops[0]=0，单调不减，末项为总高', () => {
    const heights = [10, 20, 5, 8]
    const tops = blockTops(heights)
    expect(tops).toEqual([0, 10, 30, 35, 43])
  })

  it('空数组返回 [0]', () => {
    expect(blockTops([])).toEqual([0])
  })
})

describe('computeMountWindow：可见 + 缓冲的挂载窗口', () => {
  it('空块序列返回 null', () => {
    expect(computeMountWindow([], 0, 400, 600)).toBeNull()
  })

  it('顶部滚动：窗口从块 0 开始，覆盖视口 + 两侧缓冲', () => {
    const heights = Array.from({ length: 100 }, () => 40) // 总高 4000
    const w = computeMountWindow(heights, 0, 400, 600)!
    expect(w.first).toBe(0)
    // 视口 [0,400) + 下缓冲 600 → 覆盖到 [0,1000) 相交的末块 24（[960,1000)）
    expect(w.last).toBe(24)
  })

  it('中部滚动：窗口含视口上下缓冲（first > 0）', () => {
    const heights = Array.from({ length: 100 }, () => 40)
    const w = computeMountWindow(heights, 2000, 400, 600)!
    // 缓冲区间 [1400,3000)：块 35 [1400,1440) 起相交，块 74 [2960,3000) 止
    expect(w.first).toBe(35)
    expect(w.last).toBe(74)
  })

  it('窗口宽度只依赖视口与缓冲：体量增长 10 倍窗口不变（有界性）', () => {
    const small = Array.from({ length: 100 }, () => 40)
    const large = Array.from({ length: 1000 }, () => 40)
    const wSmall = computeMountWindow(small, 2000, 400, 600)!
    const wLarge = computeMountWindow(large, 2000, 400, 600)!
    expect(wLarge).toEqual(wSmall)
    const width = (w: MountWindow) => w.last - w.first + 1
    expect(width(wLarge)).toBe(width(wSmall))
  })

  it('滚动越界 clamp 到末块', () => {
    const heights = Array.from({ length: 10 }, () => 40)
    const w = computeMountWindow(heights, 100000, 400, 600)!
    expect(w.last).toBe(9)
    expect(w.first).toBeLessThanOrEqual(9)
  })

  it('单个超大块（高度远超视口与缓冲）仍是一个窗口项（无法拆分的如实行为）', () => {
    const heights = [100000]
    const w = computeMountWindow(heights, 0, 400, 600)!
    expect(w).toEqual({ first: 0, last: 0 })
  })
})

describe('diffWindow：窗口差分（回收策略）', () => {
  it('窗口平移：只在边缘挂载/回收，窗口内保留块不出现在任一列表', () => {
    const prev: MountWindow = { first: 0, last: 25 }
    const next: MountWindow = { first: 2, last: 27 }
    const d = diffWindow(prev, next)
    expect(d.mount).toEqual([26, 27])
    expect(d.recycle).toEqual([0, 1])
  })

  it('窗口不变：无挂载无回收', () => {
    const w: MountWindow = { first: 3, last: 9 }
    expect(diffWindow(w, w)).toEqual({ mount: [], recycle: [] })
  })

  it('远跳（不相交）：旧窗口全部回收、新窗口全部挂载', () => {
    const d = diffWindow({ first: 0, last: 10 }, { first: 50, last: 60 })
    expect(d.recycle).toHaveLength(11)
    expect(d.mount).toHaveLength(11)
  })

  it('prev 为 null（初始）：全部为挂载', () => {
    const d = diffWindow(null, { first: 0, last: 5 })
    expect(d.mount).toEqual([0, 1, 2, 3, 4, 5])
    expect(d.recycle).toEqual([])
  })

  it('next 为 null（清空）：全部回收', () => {
    const d = diffWindow({ first: 1, last: 2 }, null)
    expect(d.mount).toEqual([])
    expect(d.recycle).toEqual([1, 2])
  })
})

describe('blockIndexForOffset：源 offset → 块索引（floor 语义）', () => {
  it('offset 落在块内返回该块索引', () => {
    const { blocks } = paragraphBlocks(5)
    const third = blocks[2]!
    expect(blockIndexForOffset(blocks, third.start)).toBe(2)
    expect(blockIndexForOffset(blocks, third.start + 1)).toBe(2)
    expect(blockIndexForOffset(blocks, third.end - 1)).toBe(2)
  })

  it('落在块间缝隙（空行）返回前一块（floor）', () => {
    const { text, blocks } = paragraphBlocks(5)
    const gap = blocks[1]!.end + 1 // 块 1 与块 2 之间的空行内
    expect(text[gap]).toBe('\n') // 空行的换行符：在块区间之外的缝隙
    expect(blockIndexForOffset(blocks, gap)).toBe(1)
  })

  it('越界 clamp：超过末块返回末索引；空序列返回 null', () => {
    const { text, blocks } = paragraphBlocks(3)
    expect(blockIndexForOffset(blocks, text.length + 100)).toBe(blocks.length - 1)
    expect(blockIndexForOffset(blocks, 0)).toBe(0)
    expect(blockIndexForOffset([], 0)).toBeNull()
  })
})

describe('anchorIndexAtScroll：视口锚点索引', () => {
  const heights = [40, 40, 40, 40, 40]
  const tops = blockTops(heights)

  it('返回首个与视口顶相交的块', () => {
    expect(anchorIndexAtScroll(tops, heights, 0)).toBe(0)
    expect(anchorIndexAtScroll(tops, heights, 40)).toBe(1)
    expect(anchorIndexAtScroll(tops, heights, 100)).toBe(2) // 块 2 跨越视口顶
    expect(anchorIndexAtScroll(tops, heights, 160)).toBe(4)
  })

  it('滚动超过末块底返回末索引；空序列返回 null', () => {
    expect(anchorIndexAtScroll(tops, heights, 10000)).toBe(4)
    expect(anchorIndexAtScroll([0], [], 0)).toBeNull()
  })
})

describe('recalibrate：由实测样本更新行高标定', () => {
  it('样本扣除块级间距后按行折算（与估计模型 line×行高+间距 互逆）', () => {
    // 估计模型：height = lines×lineHeight + 12 → 一行 30px 反解 18，两行 60px 反解 24
    const calib = recalibrate(
      [
        { lines: 1, heightPx: 30 },
        { lines: 2, heightPx: 60 },
        { lines: 1, heightPx: 0 }, // 退化样本：忽略
      ],
      { lineHeightPx: 24 },
    )
    expect(calib.lineHeightPx).toBe(21) // 18 与 24 的中位数
  })

  it('无有效样本保持原值', () => {
    expect(recalibrate([], { lineHeightPx: 24 })).toEqual({ lineHeightPx: 24 })
    expect(recalibrate([{ lines: 0, heightPx: 30 }], { lineHeightPx: 24 })).toEqual({ lineHeightPx: 24 })
    // 高度不足以覆盖块级间距的异常样本同样忽略
    expect(recalibrate([{ lines: 1, heightPx: 10 }], { lineHeightPx: 24 })).toEqual({ lineHeightPx: 24 })
  })

  it('标定值夹在合理区间内（防异常布局值污染估计）', () => {
    const calib = recalibrate([{ lines: 1, heightPx: 100000 }], { lineHeightPx: 24 })
    expect(calib.lineHeightPx).toBeLessThanOrEqual(64)
    const calib2 = recalibrate([{ lines: 100, heightPx: 14 }], { lineHeightPx: 24 })
    expect(calib2.lineHeightPx).toBeGreaterThanOrEqual(8)
  })
})
