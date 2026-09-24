// @vitest-environment jsdom
// 性能探针契约（工单 #5）：DOM 数、输入延迟、长任务与滚动回收的测量通道。
// - 探针编辑带 externalSync 注解：走渲染路径（状态→装饰增量→DOM 同步）
//   但不产生 edit.request 写回（测量不污染宿主文档）
// - 探针结束后文档文本还原
// - jsdom 无 PerformanceObserver 时长任务为 null（真宿主 Chromium 有值）
// - syncController 经 perf.probe 消息驱动探针并回报 perf.report
import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { runPerfProbe } from '../../src/webview/perfProbe'
import { livePreviewDecorations } from '../../src/webview/liveDecorations'
import { WebviewSyncController, externalSync, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：为 CM6 的视口测量（measureTextSize → Range.getClientRects）
// 提供零值 polyfill，真宿主 Chromium 有真实实现
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

function makeDoc(): string {
  const lines: string[] = []
  for (let i = 1; i <= 400; i++) {
    lines.push(i % 20 === 0 ? `## 第 ${i} 节 标题样本` : `第 ${i} 行 普通段落样本，固定宽度文本。`)
  }
  return lines.join('\n') + '\n'
}

function makeView(doc: string): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [livePreviewDecorations, EditorView.lineWrapping],
      selection: EditorSelection.single(0),
    }),
  })
}

describe('runPerfProbe：测量与还原', () => {
  it('报告结构完整，快照字段为非负整数', async () => {
    const doc = makeDoc()
    const view = makeView(doc)
    const report = await runPerfProbe(view, { typingRounds: 3, scrollRounds: 2 })
    expect(report.typingRounds).toBe(3)
    expect(report.scrollRounds).toBe(2)
    expect(report.docLines).toBe(view.state.doc.lines)
    for (const snap of [report.baseline, report.afterTyping, report.afterScroll]) {
      for (const value of [snap.renderedLines, snap.contentDomCount, snap.headingLineCount, snap.inviewHeadingCount]) {
        expect(Number.isInteger(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
      }
    }
    expect(report.inputDelayMs.samples).toHaveLength(3)
    expect(report.inputDelayMs.avgMs).toBeGreaterThan(0)
    expect(report.inputDelayMs.maxMs).toBeGreaterThanOrEqual(report.inputDelayMs.avgMs)
    view.destroy()
  })

  it('探针编辑全部带 externalSync 注解（不进入写回路径）且结束后文本还原', async () => {
    const doc = makeDoc()
    const seen: boolean[] = []
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [
          livePreviewDecorations,
          EditorView.updateListener.of((update) => {
            for (const tr of update.transactions) {
              if (tr.docChanged) {
                seen.push(tr.annotation(externalSync) === true)
              }
            }
          }),
        ],
      }),
    })
    await runPerfProbe(view, { typingRounds: 4, scrollRounds: 2 })
    expect(seen.length).toBeGreaterThanOrEqual(5) // 4 次插入 + 1 次清理删除
    expect(seen.every(Boolean)).toBe(true)
    expect(view.state.doc.toString()).toBe(doc)
    view.destroy()
  })

  it('长任务观测在不支持 PerformanceObserver 的环境为 null', async () => {
    const view = makeView(makeDoc())
    const report = await runPerfProbe(view, { typingRounds: 1, scrollRounds: 1 })
    if (typeof PerformanceObserver === 'undefined') {
      expect(report.longTasks).toBeNull()
    } else {
      expect(report.longTasks === null || typeof report.longTasks.count === 'number').toBe(true)
    }
    view.destroy()
  })
})

describe('syncController 集成：perf.probe 消息驱动', () => {
  function makeBridge() {
    const sent: WebviewToHost[] = []
    const bridge: VsCodeBridge = {
      postMessage: (m) => sent.push(m as WebviewToHost),
      getState: () => undefined,
      setState: () => undefined,
    }
    return { bridge, sent }
  }

  it('收到 perf.probe 后回报 perf.report，期间不发送任何 edit.request', async () => {
    const { bridge, sent } = makeBridge()
    const c = new WebviewSyncController(bridge)
    c.mount(document.createElement('div'))
    c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: 'file:///a.md', version: 1, text: makeDoc() })
    // 探针异步执行（含 rAF 等待），消息回报经轮询收集
    c.handleHostMessage({ kind: 'perf.probe', typingRounds: 2, scrollRounds: 1 })
    const deadline = Date.now() + 15000
    while (!sent.some((m) => m.kind === 'perf.report') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const report = sent.find((m) => m.kind === 'perf.report')
    expect(report).toBeDefined()
    expect(sent.filter((m) => m.kind === 'edit.request')).toEqual([])
    // 探针后视图文本与装载时一致（测量未污染文档）
    expect(c.getView()!.state.doc.lines).toBe(401)
  })
})
