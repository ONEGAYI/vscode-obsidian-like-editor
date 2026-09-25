// 性能测量套件（工单 #5）：在真实 VSCode 1.86 宿主内对 1千/1万/10万行样例
// 执行性能探针并把报告写盘。由 test/perf/runPerf.mjs 启动，不经 npm test。
//
// 测量项（对应 mvp.md「MVP 性能契约」）：
// - 打开耗时：分别记录 webview ready、init 后有内容 DOM、首次探针输入完成
//   （前两者为宿主轮询，第三项为 webview 内 Date.now 时间戳）
// - 打开装载后的基线 DOM 数（view.state 快照）
// - 输入延迟（50 轮逐字符插入+删除，每轮含 2×rAF 稳定等待）
// - 长任务（PerformanceObserver longtask）
// - 滚动回收（10 次往返滚动后回顶的 DOM 快照对比）
import * as vscode from 'vscode'

const VIEW_TYPE = 'onegayi.vsidian.editor'
const CMD = {
  sessionState: 'onegayi.vsidian._test.getSessionState',
  viewState: 'onegayi.vsidian._test.requestViewState',
  cachedViewState: 'onegayi.vsidian._test.getCachedViewState',
  perfProbe: 'onegayi.vsidian._test.perfProbe',
  readingPerf: 'onegayi.vsidian._test.readingPerf',
  toggleViewMode: 'onegayi.vsidian.toggleViewMode',
}

const wsDir = process.env['WORKSPACE_DIR'] ?? ''
const outDir = process.env['PERF_REPORT_DIR'] ?? ''
if (!wsDir || !outDir) {
  throw new Error('环境变量 WORKSPACE_DIR / PERF_REPORT_DIR 未设置（由 runPerf.mjs 注入）')
}

interface ViewState {
  text: string
  docLength: number
  lineCount: number
  renderedLines: number
  contentDomCount?: number
  headingLineCount?: number
  viewMode?: 'live' | 'reading'
  imageStates?: { loading: number; loaded: number; error: number }
}

interface PerfSnapshot {
  renderedLines: number
  contentDomCount: number
  headingLineCount: number
  inviewHeadingCount: number
}

interface PerfReport {
  typingRounds: number
  scrollRounds: number
  docLines: number
  firstInputSettledEpochMs: number
  baseline: PerfSnapshot
  afterTyping: PerfSnapshot
  afterScroll: PerfSnapshot
  inputDelayMs: { samples: number[]; avgMs: number; maxMs: number }
  longTasks: { count: number; maxMs: number; totalMs: number } | null
  headingStats: { totalUpdates: number; lastUpdateScannedLines: number; fullBuildLines: number }
}

/** #7 阅读视图观测（view.state 挂载字段 + reading.perf.report） */
interface ReadingViewState {
  readingTotalBlocks?: number
  readingMountedBlocks?: number
  readingContentDomCount?: number
  readingParseCount?: number
  readingVirtualized?: boolean
}

interface ReadingPerfReport {
  scrollRounds: number
  totalBlocks: number
  baseline: { mountedBlocks: number; contentDomCount: number; scrollTopPx: number; scrollHeightPx: number }
  afterScroll: { mountedBlocks: number; contentDomCount: number; scrollTopPx: number; scrollHeightPx: number }
  parseCount: number
  maxMountedBlocks: number
  ok: boolean
}

async function poll<T>(
  label: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 30000,
  intervalMs = 150,
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== undefined) {
      return value
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * 打开档位：分别等待宿主 ready 握手与 webview 装载非空全文、产生内容
 * DOM，再实际执行一次探针输入。首次输入经 CM6 dispatch 与两个 rAF 稳定
 * 等待，属于真实编辑路径的可用性代理，包含测试命令调度开销。
 */
async function openWithTiming(
  file: string,
): Promise<{
  uri: vscode.Uri
  view: ViewState
  byteSize: number
  openToReadyMs: number
  openToEditableMs: number
  openToFirstInputMs: number
  pollIntervalMs: number
}> {
  const uri = vscode.Uri.file(`${wsDir}/${file}`)
  const pollMs = 25
  const t0 = Date.now()
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
  await poll(
    `会话就绪 ${file}`,
    async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, uri.toString())) as
        | { found: boolean; panels: Array<{ ready: boolean }> }
        | undefined
      return state?.found && state.panels.some((p) => p.ready) ? state : undefined
    },
    30000,
    pollMs,
  )
  const openToReadyMs = Date.now() - t0
  const view = await poll(`全文可编辑 ${file}`, async () => {
    const v = (await vscode.commands.executeCommand(CMD.cachedViewState, uri.toString())) as ViewState | undefined
    return v && v.docLength > 0 && (v.contentDomCount ?? 0) > 0 ? v : undefined
  }, 30000, pollMs)
  const openToEditableMs = Date.now() - t0
  const byteSize = (await vscode.workspace.fs.stat(uri)).size
  const firstProbe = (await vscode.commands.executeCommand(CMD.perfProbe, uri.toString(),
    { typingRounds: 1, scrollRounds: 1 })) as PerfReport | undefined
  if (!firstProbe || firstProbe.firstInputSettledEpochMs < t0) {
    throw new Error(`首次输入探针无有效时间戳：${file}`)
  }
  const openToFirstInputMs = firstProbe.firstInputSettledEpochMs - t0
  return { uri, view, byteSize, openToReadyMs, openToEditableMs, openToFirstInputMs, pollIntervalMs: pollMs }
}

export async function run(): Promise<void> {
  const samples = process.env['PERF_SIZES']?.split(',').map((s) => s.trim()) ?? ['1k', '10k', '100k']
  const results: Record<string, unknown> = { startedAt: new Date().toISOString(), samples: {} }
  const sampleStore = results['samples'] as Record<string, Record<string, unknown>>

  for (const size of samples) {
    const file = `perf-${size}.md`
    const { uri, view, byteSize, openToReadyMs, openToEditableMs, openToFirstInputMs, pollIntervalMs } = await openWithTiming(file)
    const report = (await vscode.commands.executeCommand(
      CMD.perfProbe,
      uri.toString(),
      { typingRounds: 50, scrollRounds: 10 },
    )) as PerfReport | undefined
    if (!report) {
      throw new Error(`性能探针无报告：${file}`)
    }
    sampleStore[size] = {
      file,
      byteSize,
      open: { openToReadyMs, openToEditableMs, openToFirstInputMs, pollIntervalMs },
      lineCount: view.lineCount,
      docLength: view.docLength,
      baselineViewState: {
        renderedLines: view.renderedLines,
        contentDomCount: view.contentDomCount,
        headingLineCount: view.headingLineCount,
      },
      report,
    }
    console.log(`[perf] ${size} 打开：${byteSize} bytes，ready ${openToReadyMs}ms，内容装载 ${openToEditableMs}ms，首次输入 ${openToFirstInputMs}ms（轮询粒度 ${pollIntervalMs}ms）`)
    console.log(`[perf] ${size} 完成：基线 DOM ${report.baseline.contentDomCount}，输入 avg ${report.inputDelayMs.avgMs.toFixed(1)}ms / max ${report.inputDelayMs.maxMs.toFixed(1)}ms`)

    // #7 阅读视图按需挂载：同体量的每行一块样例，切换 reading 后测量
    const readingFile = `reading-${size}.md`
    const {
      uri: readingUri,
      byteSize: readingByteSize,
      openToReadyMs: readingOpenMs,
      openToEditableMs: readingEditableMs,
      openToFirstInputMs: readingFirstInputMs,
      pollIntervalMs: readingPollMs,
    } = await openWithTiming(readingFile)
    // #15 模式切换档位：live → reading（细粒度轮询压缩计时量化误差）
    const switchPollMs = 25
    const tToReading = Date.now()
    await vscode.commands.executeCommand(CMD.toggleViewMode)
    const readingView = await poll(
      `阅读模式虚拟化 ${readingFile}`,
      async () => {
        const v = (await vscode.commands.executeCommand(CMD.viewState, readingUri.toString())) as
          | (ViewState & ReadingViewState)
          | undefined
        return v?.viewMode === 'reading' && v.readingVirtualized === true ? v : undefined
      },
      30000,
      switchPollMs,
    )
    const toReadingMs = Date.now() - tToReading
    const readingReport = (await vscode.commands.executeCommand(
      CMD.readingPerf,
      readingUri.toString(),
      { scrollRounds: 10 },
    )) as ReadingPerfReport | undefined
    if (!readingReport || readingReport.ok !== true) {
      throw new Error(`阅读探针无报告：${readingFile}`)
    }
    // #15 模式切换档位：reading → live（CM6 重建完成判据：viewMode=live 且已渲染行）
    const tToLive = Date.now()
    await vscode.commands.executeCommand(CMD.toggleViewMode)
    await poll(
      `切回 live ${readingFile}`,
      async () => {
        const v = (await vscode.commands.executeCommand(CMD.viewState, readingUri.toString())) as
          | (ViewState & ReadingViewState)
          | undefined
        return v?.viewMode === 'live' && (v.renderedLines ?? 0) > 0 ? v : undefined
      },
      30000,
      switchPollMs,
    )
    const toLiveMs = Date.now() - tToLive
    sampleStore[size]!['reading'] = {
      file: readingFile,
      byteSize: readingByteSize,
      open: { openToReadyMs: readingOpenMs, openToEditableMs: readingEditableMs, openToFirstInputMs: readingFirstInputMs, pollIntervalMs: readingPollMs },
      totalBlocks: readingView.readingTotalBlocks,
      mountedBaseline: readingView.readingMountedBlocks,
      domBaseline: readingView.readingContentDomCount,
      parseCount: readingView.readingParseCount,
      report: readingReport,
    }
    sampleStore[size]!['modeSwitch'] = { toReadingMs, toLiveMs, pollIntervalMs: switchPollMs }
    console.log(`[perf] ${size} 阅读视图：块模型 ${readingReport.totalBlocks}，挂载基线 ${readingReport.baseline.mountedBlocks}，滚动后 ${readingReport.afterScroll.mountedBlocks}，解析 ${readingReport.parseCount} 次，最大挂载 ${readingReport.maxMountedBlocks}`)
    console.log(`[perf] ${size} 模式切换：→reading ${toReadingMs}ms，→live ${toLiveMs}ms（轮询粒度 ${switchPollMs}ms）；${readingFile} 打开 ${readingOpenMs}ms`)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }

  // #8 起：大围栏按行细分（FENCE_CHUNK_LINES=60）。2 万行围栏切块后的实测——
  // 块模型从 3 块变为约 336 块，挂载窗口只覆盖视口附近的片，进入 reading 的
  // 首屏挂载成本与整块文本布局成本解耦（对照 #7 的整块实测记录）
  {
    const file = 'reading-giant.md'
    const { uri } = await openWithTiming(file) // 打开等待统一走计时辅助（耗时字段本段不采用）
    await vscode.commands.executeCommand(CMD.toggleViewMode)
    const t0 = Date.now()
    const giantView = await poll(`阅读模式虚拟化 ${file}`, async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri.toString())) as
        | (ViewState & ReadingViewState)
        | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? v : undefined
    })
    const mountMs = Date.now() - t0
    results['giantBlock'] = {
      file,
      totalBlocks: giantView.readingTotalBlocks,
      mountedBlocks: giantView.readingMountedBlocks,
      contentDomCount: giantView.readingContentDomCount,
      virtualizedMountPollMs: mountMs,
    }
    console.log(`[perf] 大围栏细分：块模型 ${giantView.readingTotalBlocks}（2 万行围栏切为多片），挂载 ${giantView.readingMountedBlocks}，容器元素 ${giantView.readingContentDomCount}，进入 reading 轮询耗时 ${mountMs}ms`)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }

  // #23：超长行与图片密集文档分别测两种视图。两类不是同构短行档，
  // 数据单列，避免把大块布局例外混入 1k/10k/100k 的 DOM 比率比较。
  const boundaryShapes: Record<string, unknown> = {}
  for (const [shape, file] of [
    ['longLine', 'perf-longline.md'],
    ['imageDense', 'perf-images.md'],
    // #59 公式密集档：与图片档同构的两种视图探针（渲染缓存的宿主车道数据）
    ['mathDense', 'perf-math.md'],
    // #60 图表密集档：懒加载/串行渲染/缓存克隆与挂载回收的宿主车道数据
    ['mermaidDense', 'perf-mermaid.md'],
  ]) {
    const { uri, view, byteSize, openToReadyMs, openToEditableMs, openToFirstInputMs, pollIntervalMs } = await openWithTiming(file)
    const liveReport = (await vscode.commands.executeCommand(CMD.perfProbe, uri.toString(),
      { typingRounds: 10, scrollRounds: 6 })) as PerfReport | undefined
    if (!liveReport) {
      throw new Error(`边界形态 live 探针无报告：${file}`)
    }
    const toReadingStart = Date.now()
    await vscode.commands.executeCommand(CMD.toggleViewMode)
    const readingView = await poll(`边界形态阅读装载 ${file}`, async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri.toString())) as
        | (ViewState & ReadingViewState) | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? v : undefined
    }, 30000, 25)
    const toReadingMs = Date.now() - toReadingStart
    const loadedImages = shape === 'imageDense'
      ? await poll(`图片密集样例加载 ${file}`, async () => {
        const v = (await vscode.commands.executeCommand(CMD.viewState, uri.toString())) as ViewState | undefined
        const states = v?.imageStates
        return states && states.loaded > 0 && states.loading === 0 ? states : undefined
      }, 10000, 100)
      : undefined
    const readingReport = (await vscode.commands.executeCommand(CMD.readingPerf, uri.toString(),
      { scrollRounds: 6 })) as ReadingPerfReport | undefined
    if (!readingReport?.ok) {
      throw new Error(`边界形态 reading 探针无报告：${file}`)
    }
    const toLiveStart = Date.now()
    await vscode.commands.executeCommand(CMD.toggleViewMode)
    await poll(`边界形态返回 live ${file}`, async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri.toString())) as ViewState | undefined
      return v?.viewMode === 'live' && v.renderedLines > 0 ? v : undefined
    }, 30000, 25)
    boundaryShapes[shape] = {
      file, byteSize, lineCount: view.lineCount,
      open: { openToReadyMs, openToEditableMs, openToFirstInputMs, pollIntervalMs },
      live: liveReport,
      reading: {
        totalBlocks: readingView.readingTotalBlocks,
        imageStatesAfterLoad: loadedImages,
        report: readingReport,
      },
      modeSwitch: { toReadingMs, toLiveMs: Date.now() - toLiveStart, pollIntervalMs: 25 },
    }
    console.log(`[perf] ${shape}：${byteSize} bytes；live DOM ${liveReport.baseline.contentDomCount}→${liveReport.afterScroll.contentDomCount}；reading 挂载 ${readingReport.baseline.mountedBlocks}→${readingReport.afterScroll.mountedBlocks}`)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }
  results['boundaryShapes'] = boundaryShapes

  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const outPath = join(outDir, 'perf-report.json')
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8')
  console.log(`[perf] 报告已写入 ${outPath}`)
}
