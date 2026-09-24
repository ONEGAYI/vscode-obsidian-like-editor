// 阅读视图性能探针（工单 #7）：在 reading 模式下对阅读容器执行往返滚动，
// 观测按需挂载的 DOM 有界性与回收。
//
// 测量内容（对应 mvp.md「MVP 性能契约」的阅读视图条款）：
// - 挂载块数/容器元素数：装载基线 → 往返滚动 → 回顶，对比窗口是否回到基线
// - 解析次数：探针全程 setDocument 累计调用数不因滚动增长（解析与挂载分离）
// - 最大挂载块数：窗口宽度的实测上界（与文档体量无关）
//
// 探针只改 scrollTop（纯视图滚动，不产生 edit.request 写回）；与 #5 的
// perfProbe（CM6 路径）相互独立，共用「宿主命令 → 消息 → 轮询报告」通道。
import type { ReadingPerfSnapshot } from '../shared/protocol'
import { readUsedJsHeapBytes } from './perfProbe'
import type { VirtualReadingView } from './readingVirtualView'

export interface ReadingPerfOptions {
  scrollRounds: number
}

export interface ReadingPerfReport {
  kind: 'reading.perf.report'
  scrollRounds: number
  totalBlocks: number
  baseline: ReadingPerfSnapshot
  afterScroll: ReadingPerfSnapshot
  parseCount: number
  maxMountedBlocks: number
  ok: boolean
}

/** 等待两个 rAF：覆盖滚动事件派发与窗口重算（含 ResizeObserver 回调节拍） */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    } else {
      setTimeout(resolve, 32)
    }
  })
}

function snapshot(view: VirtualReadingView, container: HTMLElement): ReadingPerfSnapshot {
  const stats = view.getStats()
  return {
    mountedBlocks: stats.mountedBlocks,
    contentDomCount: stats.contentDomCount,
    scrollTopPx: Math.round(container.scrollTop),
    scrollHeightPx: Math.round(container.scrollHeight),
    jsHeapBytes: readUsedJsHeapBytes(),
  }
}

/** 探针失败态回报（非 reading 模式调用等）：报告结构完整、ok=false */
function failureReport(scrollRounds: number): ReadingPerfReport {
  const empty: ReadingPerfSnapshot = {
    mountedBlocks: 0,
    contentDomCount: 0,
    scrollTopPx: 0,
    scrollHeightPx: 0,
    jsHeapBytes: null,
  }
  return {
    kind: 'reading.perf.report',
    scrollRounds,
    totalBlocks: 0,
    baseline: empty,
    afterScroll: empty,
    parseCount: 0,
    maxMountedBlocks: 0,
    ok: false,
  }
}

/**
 * 执行阅读视图探针。调用前提：reading 模式且阅读容器可见（虚拟化生效）。
 * 步骤：基线快照 → 容器在内容 25%/75% 处往返 N 次 → 回顶快照。
 */
export async function runReadingPerfProbe(
  view: VirtualReadingView,
  container: HTMLElement,
  options: ReadingPerfOptions,
): Promise<ReadingPerfReport> {
  const stats = view.getStats()
  if (!stats.virtualized) {
    return failureReport(options.scrollRounds)
  }
  const baseline = snapshot(view, container)
  let maxMountedBlocks = baseline.mountedBlocks

  for (let i = 0; i < options.scrollRounds; i++) {
    // spacer 撑起的 scrollHeight 即内容总高估计；比例定位驱动真实滚动路径
    const ratio = i % 2 === 0 ? 0.75 : 0.25
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.round(maxScroll * ratio)
    await settle()
    maxMountedBlocks = Math.max(maxMountedBlocks, view.getStats().mountedBlocks)
  }
  container.scrollTop = 0
  await settle()
  const afterScroll = snapshot(view, container)

  return {
    kind: 'reading.perf.report',
    scrollRounds: options.scrollRounds,
    totalBlocks: stats.totalBlocks,
    baseline,
    afterScroll,
    parseCount: view.getStats().parseCount,
    maxMountedBlocks,
    ok: true,
  }
}
