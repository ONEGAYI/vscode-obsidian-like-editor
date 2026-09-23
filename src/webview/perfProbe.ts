// 性能探针（工单 #5）：在真实 webview 内测量标题装饰切片的视口渲染指标。
//
// 测量内容（对应 mvp.md「MVP 性能契约」的验收项）：
// - DOM 数：.cm-content 内元素计数（视口有界性：体量增长 10 倍 ≤ 2 倍）
// - 输入延迟：逐字符 dispatch + 等待两个 rAF（含 CM6 异步测量/视口重算），
//  与真实键入同构（同一 dispatch 路径），但带 externalSync 注解——探针
//  编辑不产生 edit.request 写回，测量不污染宿主文档
// - 长任务：PerformanceObserver('longtask')（宿主 Chromium 支持；不支持为 null）
// - 滚动回收：scrollIntoView 往返 N 次后回顶，对比基线快照（节点应回到基线附近）
//
// 探针结束后文档文本与选区还原；headingStats 一并回报（键入路径重扫行数
// 应与文档体量无关，验证增量装饰策略在真实视图中生效）。
import { EditorView } from '@codemirror/view'
import type { PerfSnapshot } from '../shared/protocol'
import { getHeadingStats } from './headings'
import { externalSync } from './syncController'

export interface PerfProbeOptions {
  typingRounds: number
  scrollRounds: number
}

export interface PerfReport {
  kind: 'perf.report'
  typingRounds: number
  scrollRounds: number
  docLines: number
  baseline: PerfSnapshot
  afterTyping: PerfSnapshot
  afterScroll: PerfSnapshot
  inputDelayMs: { samples: number[]; avgMs: number; maxMs: number }
  longTasks: { count: number; maxMs: number; totalMs: number } | null
  headingStats: { totalUpdates: number; lastUpdateScannedLines: number; fullBuildLines: number }
}

function snapshot(view: EditorView): PerfSnapshot {
  const content = view.dom.querySelector('.cm-content')
  const count = (selector: string): number =>
    content ? content.querySelectorAll(selector).length : 0
  return {
    renderedLines: count('.cm-line'),
    contentDomCount: content ? content.querySelectorAll('*').length : 0,
    headingLineCount: count('.oile-heading-line'),
    inviewHeadingCount: count('.oile-heading-inview'),
  }
}

/** 等待两个 rAF：覆盖 CM6 的异步测量与视口重算（单 rAF 内测量尚未完成） */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    } else {
      setTimeout(resolve, 32)
    }
  })
}

interface LongTaskTracker {
  stop(): { count: number; maxMs: number; totalMs: number } | null
}

function startLongTaskTracker(): LongTaskTracker {
  interface PerformanceObserverCtor {
    new (
      type: string,
      cb: (list: { getEntries(): Array<{ duration: number }> }) => void,
    ): {
      observe(options: unknown): void
      disconnect(): void
      takeRecords(): Array<{ duration: number }>
    }
  }
  const Ctor = (globalThis as Record<string, unknown>)['PerformanceObserver'] as
    | PerformanceObserverCtor
    | undefined
  if (!Ctor) {
    return { stop: () => null }
  }
  try {
    let count = 0
    let maxMs = 0
    let totalMs = 0
    const observer = new Ctor('longtask', (list) => {
      for (const entry of list.getEntries()) {
        count += 1
        maxMs = Math.max(maxMs, entry.duration)
        totalMs += entry.duration
      }
    })
    try {
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // 部分环境只接受单类型形式
      observer.observe({ type: 'longtask', buffered: false })
    }
    return {
      stop: () => ({ count, maxMs, totalMs }),
    }
  } catch {
    // 浏览器不支持 longtask 条目类型
    return { stop: () => null }
  }
}

/**
 * 执行探针。调用前提：view 已装载目标文档（init/resync 后）。
 * 步骤：基线快照 → 逐字符插入+删除（测输入延迟）→ 滚动往返（测回收）
 * → 回顶快照 → 还原文档。
 */
export async function runPerfProbe(
  view: EditorView,
  options: PerfProbeOptions,
): Promise<PerfReport> {
  const selectionBefore = view.state.selection
  const tracker = startLongTaskTracker()

  const baseline = snapshot(view)

  // 输入延迟：在视口首可见范围的中部行行尾逐字符插入（每字符一个事务，
  // 与真实键入同构；dispatch 同步完成状态更新+装饰增量+DOM 同步，
  // 两个 rAF 覆盖其后的异步测量与视口重算）
  const visible = view.visibleRanges[0] ?? { from: 0, to: view.state.doc.length }
  const anchorLine = view.state.doc.lineAt(Math.floor((visible.from + visible.to) / 2))
  const insertAt = Math.min(anchorLine.to, view.state.doc.length)
  const probeChar = '探'
  const samples: number[] = []
  for (let i = 0; i < options.typingRounds; i++) {
    const start = performance.now()
    view.dispatch({
      changes: { from: insertAt + i * probeChar.length, insert: probeChar },
      annotations: externalSync.of(true),
    })
    await settle()
    samples.push(performance.now() - start)
  }
  // 清理：一次性删除全部探针字符
  if (options.typingRounds > 0) {
    view.dispatch({
      changes: { from: insertAt, to: insertAt + options.typingRounds * probeChar.length },
      annotations: externalSync.of(true),
    })
    await settle()
  }
  const afterTyping = snapshot(view)

  // 滚动回收：在文档 25%/75% 位置往返，结束后回顶
  const doc = view.state.doc
  for (let i = 0; i < options.scrollRounds; i++) {
    const ratio = i % 2 === 0 ? 0.75 : 0.25
    const target = Math.min(Math.floor(doc.length * ratio), doc.length)
    view.dispatch({ effects: EditorView.scrollIntoView(target, { y: 'center' }) })
    await settle()
  }
  view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) })
  await settle()
  const afterScroll = snapshot(view)

  const longTasks = tracker.stop()
  // 选区还原（探针编辑已删净，文本与装载时一致）
  if (!view.state.selection.eq(selectionBefore)) {
    view.dispatch({ selection: selectionBefore, annotations: externalSync.of(true) })
  }
  const stats = getHeadingStats()

  return {
    kind: 'perf.report',
    typingRounds: options.typingRounds,
    scrollRounds: options.scrollRounds,
    docLines: view.state.doc.lines,
    baseline,
    afterTyping,
    afterScroll,
    inputDelayMs: {
      samples,
      avgMs: samples.reduce((a, b) => a + b, 0) / Math.max(samples.length, 1),
      maxMs: Math.max(...samples, 0),
    },
    longTasks,
    headingStats: {
      totalUpdates: stats.totalUpdates,
      lastUpdateScannedLines: stats.lastUpdateScannedLines,
      fullBuildLines: stats.fullBuildLines,
    },
  }
}
