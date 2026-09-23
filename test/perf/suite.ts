// 性能测量套件（工单 #5）：在真实 VSCode 1.86 宿主内对 1千/1万/10万行样例
// 执行性能探针并把报告写盘。由 test/perf/runPerf.mjs 启动，不经 npm test。
//
// 测量项（对应 mvp.md「MVP 性能契约」）：
// - 打开装载后的基线 DOM 数（view.state 快照）
// - 输入延迟（50 轮逐字符插入+删除，每轮含 2×rAF 稳定等待）
// - 长任务（PerformanceObserver longtask）
// - 滚动回收（10 次往返滚动后回顶的 DOM 快照对比）
import * as vscode from 'vscode'

const VIEW_TYPE = 'onegayi.obsidian-like-markdown-editor'
const CMD = {
  sessionState: 'onegayi.obsidian-like-editor._test.getSessionState',
  viewState: 'onegayi.obsidian-like-editor._test.requestViewState',
  perfProbe: 'onegayi.obsidian-like-editor._test.perfProbe',
  readingPerf: 'onegayi.obsidian-like-editor._test.readingPerf',
  toggleViewMode: 'onegayi.obsidian-like-editor.toggleViewMode',
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
    await new Promise((r) => setTimeout(r, 150))
  }
}

export async function run(): Promise<void> {
  const samples = process.env['PERF_SIZES']?.split(',').map((s) => s.trim()) ?? ['1k', '10k', '100k']
  const results: Record<string, unknown> = { startedAt: new Date().toISOString(), samples: {} }
  const sampleStore = results['samples'] as Record<string, Record<string, unknown>>

  for (const size of samples) {
    const file = `perf-${size}.md`
    const uri = vscode.Uri.file(`${wsDir}/${file}`)
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
    await poll(`会话就绪 ${file}`, async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, uri.toString())) as
        | { found: boolean; panels: Array<{ ready: boolean }> }
        | undefined
      return state?.found && state.panels.some((p) => p.ready) ? state : undefined
    })
    // 装载后的基线快照（view.state 含 DOM 计数）
    const view = await poll(`视图状态 ${file}`, async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, uri.toString())) as ViewState | undefined
      return v && (v.contentDomCount ?? -1) > 0 ? v : undefined
    })
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
      lineCount: view.lineCount,
      docLength: view.docLength,
      baselineViewState: {
        renderedLines: view.renderedLines,
        contentDomCount: view.contentDomCount,
        headingLineCount: view.headingLineCount,
      },
      report,
    }
    console.log(`[perf] ${size} 完成：基线 DOM ${report.baseline.contentDomCount}，输入 avg ${report.inputDelayMs.avgMs.toFixed(1)}ms / max ${report.inputDelayMs.maxMs.toFixed(1)}ms`)

    // #7 阅读视图按需挂载：同体量的每行一块样例，切换 reading 后测量
    const readingFile = `reading-${size}.md`
    const readingUri = vscode.Uri.file(`${wsDir}/${readingFile}`)
    await vscode.commands.executeCommand('vscode.openWith', readingUri, VIEW_TYPE)
    await poll(`会话就绪 ${readingFile}`, async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, readingUri.toString())) as
        | { found: boolean; panels: Array<{ ready: boolean }> }
        | undefined
      return state?.found && state.panels.some((p) => p.ready) ? state : undefined
    })
    await vscode.commands.executeCommand(CMD.toggleViewMode)
    const readingView = await poll(`阅读模式虚拟化 ${readingFile}`, async () => {
      const v = (await vscode.commands.executeCommand(CMD.viewState, readingUri.toString())) as
        | (ViewState & ReadingViewState)
        | undefined
      return v?.viewMode === 'reading' && v.readingVirtualized === true ? v : undefined
    })
    const readingReport = (await vscode.commands.executeCommand(
      CMD.readingPerf,
      readingUri.toString(),
      { scrollRounds: 10 },
    )) as ReadingPerfReport | undefined
    if (!readingReport || readingReport.ok !== true) {
      throw new Error(`阅读探针无报告：${readingFile}`)
    }
    sampleStore[size]!['reading'] = {
      file: readingFile,
      totalBlocks: readingView.readingTotalBlocks,
      mountedBaseline: readingView.readingMountedBlocks,
      domBaseline: readingView.readingContentDomCount,
      parseCount: readingView.readingParseCount,
      report: readingReport,
    }
    console.log(`[perf] ${size} 阅读视图：块模型 ${readingReport.totalBlocks}，挂载基线 ${readingReport.baseline.mountedBlocks}，滚动后 ${readingReport.afterScroll.mountedBlocks}，解析 ${readingReport.parseCount} 次，最大挂载 ${readingReport.maxMountedBlocks}`)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }

  // #7 超大单块限制记录：2 万行未拆分围栏的实测（窗口无法在块内拆分）
  {
    const file = 'reading-giant.md'
    const uri = vscode.Uri.file(`${wsDir}/${file}`)
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE)
    await poll(`会话就绪 ${file}`, async () => {
      const state = (await vscode.commands.executeCommand(CMD.sessionState, uri.toString())) as
        | { found: boolean; panels: Array<{ ready: boolean }> }
        | undefined
      return state?.found && state.panels.some((p) => p.ready) ? state : undefined
    })
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
    console.log(`[perf] 超大单块：块模型 ${giantView.readingTotalBlocks}，挂载 ${giantView.readingMountedBlocks}（含 2 万行围栏整体一块），容器元素 ${giantView.readingContentDomCount}，进入 reading 轮询耗时 ${mountMs}ms`)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }

  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const outPath = join(outDir, 'perf-report.json')
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8')
  console.log(`[perf] 报告已写入 ${outPath}`)
}
