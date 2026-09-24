// @vitest-environment jsdom
// 模式切换状态机契约（工单 #6）：
// - live ↔ reading 切换入口：view.mode.set 消息与工具栏按钮
// - 切换不产生文本编辑历史：不 dispatch 文本变更、不发 edit.request、
//   不触发保存（本层无从保存，等价断言为宿主消息零写回）
// - 源码位置锚点：live 光标 offset ↔ 阅读锚点块 src-start 双向恢复
// - 模式与锚点经 bridge.setState 持久化（与 seq 合并），webview 重载后
//   init 恢复模式（retainContextWhenHidden 关闭场景）
// - 阅读模式下外部增量照常同步并重建阅读视图
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

// jsdom 无布局：为 CM6 的视口测量（measureTextSize → Range.getClientRects）
// 提供零值 polyfill，真宿主 Chromium 有真实实现
if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

const DOC_URI = 'file:///d%3A/notes/mode.md'

const DOC = [
  '# 顶部一级标题',
  '',
  '第一段：普通文本。',
  '',
  '## 中部二级标题',
  '',
  '- 普通列表项',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '结尾段落文本。',
  '',
].join('\n')

interface BridgeHarness {
  bridge: VsCodeBridge
  sent: WebviewToHost[]
  saved: () => Record<string, unknown> | undefined
}

function makeBridge(saved?: Record<string, unknown>): BridgeHarness {
  const sent: WebviewToHost[] = []
  let state = saved
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as Record<string, unknown>
    },
  }
  return { bridge, sent, saved: () => state }
}

function mountMode(h: BridgeHarness, text = DOC, version = 1): WebviewSyncController {
  const c = new WebviewSyncController(h.bridge)
  c.mount(document.createElement('div'))
  c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version, text })
  return c
}

function viewState(c: WebviewSyncController, h: BridgeHarness) {
  const before = h.sent.length
  c.handleHostMessage({ kind: 'view.state.request' })
  const msg = h.sent.slice(before).find((m) => m.kind === 'view.state')
  if (!msg) {
    throw new Error('view.state 未回报')
  }
  return msg as Extract<WebviewToHost, { kind: 'view.state' }>
}

function sentEditRequests(h: BridgeHarness): number {
  return h.sent.filter((m) => m.kind === 'edit.request').length
}

describe('初始状态与默认模式', () => {
  it('默认 live 模式，view.state 回报 viewMode 与光标 offset', () => {
    const h = makeBridge()
    const c = mountMode(h)
    const state = viewState(c, h)
    expect(state.viewMode).toBe('live')
    expect(state.selectionOffset).toBe(0)
  })
})

describe('模式变化主动回报（宿主模式缓存数据源）', () => {
  // 契约：宿主的表格结构命令按缓存的 viewMode 拦截 reading 面板（可见
  // 反馈），缓存依赖 webview 在模式变化时主动推送 view.state——不主动
  // 推送则 reading 命令被 webview 静默忽略且宿主虚报成功
  function spontaneousStates(h: BridgeHarness) {
    return h.sent.filter((m): m is Extract<WebviewToHost, { kind: 'view.state' }> => m.kind === 'view.state')
  }

  it('init 后主动回报一次（含持久化恢复的模式）', () => {
    const h = makeBridge({ viewMode: 'reading' })
    mountMode(h)
    expect(spontaneousStates(h).length).toBeGreaterThanOrEqual(1)
    expect(spontaneousStates(h)[0]).toMatchObject({ viewMode: 'reading' })
  })

  it('每次模式切换主动回报最新 viewMode', () => {
    const h = makeBridge()
    const c = mountMode(h)
    const before = spontaneousStates(h).length
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(spontaneousStates(h).at(-1)).toMatchObject({ viewMode: 'reading' })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    expect(spontaneousStates(h).at(-1)).toMatchObject({ viewMode: 'live' })
    expect(spontaneousStates(h).length).toBeGreaterThanOrEqual(before + 2)
  })
})

describe('切换入口：view.mode.set 消息', () => {
  it('toggle 消息进入 reading，view.state 回报模式与阅读锚点', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'toggle' })
    const state = viewState(c, h)
    expect(state.viewMode).toBe('reading')
    expect(state.readingBlockCount).toBeGreaterThan(0)
    expect(state.readingAnchorStart).toBe(0) // 光标 0 → 第一块（标题块 start=0）
  })

  it('显式 set reading/live 与重复 set 幂等', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' }) // 重复 set 同模式 no-op
    expect(viewState(c, h).viewMode).toBe('reading')
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    expect(viewState(c, h).viewMode).toBe('live')
  })

  it('非法 mode 被协议校验丢弃，不改变当前模式', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'preview' })
    expect(viewState(c, h).viewMode).toBe('live')
  })
})

describe('切换不产生文本编辑历史（核心契约）', () => {
  it('来回切换全程零 edit.request、文本与文档长度不变', () => {
    const h = makeBridge()
    const c = mountMode(h)
    const editsBefore = sentEditRequests(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'toggle' }) // → live
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'toggle' }) // → reading
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'toggle' }) // → live
    const state = viewState(c, h)
    expect(sentEditRequests(h)).toBe(editsBefore) // 零写回
    expect(state.viewMode).toBe('live')
    expect(state.text).toBe(DOC) // 未保存内容原样保留
    expect(state.docLength).toBe(DOC.length)
  })

  it('本地未确认输入在切换后保留（未保存内容不丢失）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    // 本地输入（乐观回显，尚未 ack）
    c.getView()!.dispatch({ changes: { from: 0, insert: '未保存前缀' } })
    expect(sentEditRequests(h)).toBe(1)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    let state = viewState(c, h)
    expect(state.text.startsWith('未保存前缀')).toBe(true)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    state = viewState(c, h)
    expect(state.text.startsWith('未保存前缀')).toBe(true)
    // 切换本身仍零新增写回（仅本地输入那一笔）
    expect(sentEditRequests(h)).toBe(1)
  })
})

describe('源码位置锚点：live ↔ reading 双向恢复', () => {
  it('live 光标 offset 映射到包含它的阅读块 start（非滚动百分比）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    // 光标移到 '- [x] 已完成任务' 行中部（源 offset）
    const cursor = DOC.indexOf('已完成') + 1
    c.getView()!.dispatch({ selection: { anchor: cursor } })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const state = viewState(c, h)
    expect(state.readingAnchorStart).toBe(DOC.indexOf('- [x] 已完成任务'))
  })

  it('reading 切回 live 恢复光标到锚点块的源 start', () => {
    const h = makeBridge()
    const c = mountMode(h)
    const cursor = DOC.indexOf('中部二级标题')
    c.getView()!.dispatch({ selection: { anchor: cursor } })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    const state = viewState(c, h)
    expect(state.selectionOffset).toBe(DOC.indexOf('## 中部二级标题'))
  })

  it('锚点越界防御：光标在文档末尾时恢复 clamp 不抛错', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.getView()!.dispatch({ selection: { anchor: DOC.length } })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    const state = viewState(c, h)
    expect(state.selectionOffset).toBeLessThanOrEqual(DOC.length)
  })
})

describe('切换入口：工具栏按钮', () => {
  it('点击 vsidian-mode-toggle 按钮触发与消息一致的切换', () => {
    const h = makeBridge()
    const parent = document.createElement('div')
    const c = new WebviewSyncController(h.bridge)
    c.mount(parent)
    c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    const btn = parent.querySelector<HTMLButtonElement>('button.vsidian-mode-toggle')
    expect(btn).not.toBeNull()
    btn!.click()
    expect(viewState(c, h).viewMode).toBe('reading')
    btn!.click()
    expect(viewState(c, h).viewMode).toBe('live')
  })

  it('按钮文案随模式更新（可发现的切换入口）', () => {
    const h = makeBridge()
    const parent = document.createElement('div')
    const c = new WebviewSyncController(h.bridge)
    c.mount(parent)
    c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    const btn = parent.querySelector<HTMLButtonElement>('button.vsidian-mode-toggle')!
    const liveLabel = btn.textContent
    expect(liveLabel).toContain('阅读')
    btn.click()
    expect(btn.textContent).not.toBe(liveLabel)
    expect(btn.textContent).toContain('实时预览')
  })
})

describe('视图容器显隐与稳定类名', () => {
  it('live 容器 vsidian-view-live 与阅读容器 vsidian-view-reading 互斥显示', () => {
    const h = makeBridge()
    const parent = document.createElement('div')
    const c = new WebviewSyncController(h.bridge)
    c.mount(parent)
    c.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    const live = parent.querySelector<HTMLElement>('.vsidian-view-live')
    const reading = parent.querySelector<HTMLElement>('.vsidian-view-reading')
    expect(live).not.toBeNull()
    expect(reading).not.toBeNull()
    expect(live!.style.display).toBe('')
    expect(reading!.style.display).toBe('none')
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(live!.style.display).toBe('none')
    expect(reading!.style.display).toBe('')
    // 阅读容器内块带源锚点
    const block = reading!.querySelector<HTMLElement>('[data-vsidian-src-start]')
    expect(block).not.toBeNull()
  })
})

describe('持久化与 webview 重载恢复', () => {
  it('模式与锚点写入 bridge state，与 seq 合并互不覆盖', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    // 之后发生的编辑写 seq：不得丢掉 viewMode
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    c.getView()!.dispatch({ changes: { from: 0, insert: 'X' } })
    const saved = h.saved() as { seq?: number; viewMode?: string }
    expect(saved.seq).toBe(1)
    expect(saved.viewMode).toBe('live')
    // 反向：先编辑再切换，seq 也不丢
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const saved2 = h.saved() as { seq?: number; viewMode?: string }
    expect(saved2.seq).toBe(1)
    expect(saved2.viewMode).toBe('reading')
  })

  it('重载后（新 controller 同一 state）init 恢复 reading 模式并渲染块', () => {
    const h = makeBridge()
    const c1 = mountMode(h)
    c1.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    // 模拟 webview 重载：同一持久化 state，全新的 controller/DOM
    const parent2 = document.createElement('div')
    const c2 = new WebviewSyncController(h.bridge)
    c2.mount(parent2)
    c2.handleHostMessage({ kind: 'init', sessionId: 's1', docUri: DOC_URI, version: 1, text: DOC })
    const state = viewState(c2, h)
    expect(state.viewMode).toBe('reading')
    expect(state.readingBlockCount).toBeGreaterThan(0)
    expect(state.text).toBe(DOC)
  })
})

describe('阅读模式下的外部变更同步', () => {
  it('doc.changed 在 reading 模式更新 CM6 文档并重建阅读视图', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const before = viewState(c, h)
    // 外部增量：文首插入新段落
    c.handleHostMessage({
      kind: 'doc.changed',
      version: 2,
      origin: 'external',
      changes: [{ offset: 0, length: 0, text: '外部新段落\n\n' }],
    })
    const after = viewState(c, h)
    expect(after.text.startsWith('外部新段落')).toBe(true)
    expect(after.readingBlockCount).toBe(before.readingBlockCount! + 1)
    // 外部同步不产生写回
    expect(sentEditRequests(h)).toBe(0)
  })

  it('doc.resync 全文重置后阅读视图跟随重建', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'doc.resync', version: 3, text: '# 重置标题\n重置段落\n' })
    const state = viewState(c, h)
    expect(state.text).toBe('# 重置标题\n重置段落\n')
    expect(state.readingBlockCount).toBe(2)
    expect(state.viewMode).toBe('reading')
  })
})

describe('view.state 的 CSS 契约探针字段', () => {
  it('cssProbe 字段存在（jsdom 无样式表计算时探针值为 null）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const state = viewState(c, h)
    expect(state.cssProbe).toBeDefined()
    // jsdom 不解析样式表：变量不可得 → null 是契约行为；真实宿主断言见集成
    expect(state.cssProbe!.readingVarProbe).toBeNull()
  })
})

describe('view.locate 定位（#10 查找跳转的前置入口）', () => {
  it('live 模式：光标移动到目标 offset，零 edit.request（定位不产生历史）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.locate', offset: DOC.indexOf('中部二级标题') })
    const state = viewState(c, h)
    expect(state.selectionOffset).toBe(DOC.indexOf('中部二级标题'))
    expect(sentEditRequests(h)).toBe(0)
  })

  it('reading 模式：滚动到目标块并把锚点更新为该块（切回 live 恢复）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'view.locate', offset: DOC.indexOf('已完成') })
    const state = viewState(c, h)
    expect(state.readingAnchorStart).toBe(DOC.indexOf('- [x] 已完成任务'))
    // 切回 live：光标恢复到定位块的源 start
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'live' })
    expect(viewState(c, h).selectionOffset).toBe(DOC.indexOf('- [x] 已完成任务'))
  })

  it('offset 越界 clamp 到文档长度，不抛错', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.locate', offset: 99999 })
    expect(viewState(c, h).selectionOffset).toBe(DOC.length)
  })
})

describe('悬挂（冲突暂停）与模式切换', () => {
  it('暂停状态下切换仍可用（保留本地文本展示，恢复后视图正确）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.getView()!.dispatch({ changes: { from: 0, insert: '未确认' } })
    c.handleHostMessage({ kind: 'edit.ack', seq: 1, ok: false, reason: 'conflict', version: 1, text: DOC })
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const state = viewState(c, h)
    expect(state.viewMode).toBe('reading')
    // 暂停保留本地输入：阅读视图展示本地文本
    expect(state.text.startsWith('未确认')).toBe(true)
    expect(state.suspended).toBe(true)
  })
})

describe('阅读视图按需挂载观测（#7；jsdom 无布局 = 回退路径）', () => {
  it('view.state 回报挂载观测字段：回退路径下挂载数 = 块模型总数', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    const state = viewState(c, h)
    expect(state.readingVirtualized).toBe(false) // jsdom 无布局：全量回退
    expect(state.readingTotalBlocks).toBeGreaterThan(0)
    expect(state.readingMountedBlocks).toBe(state.readingTotalBlocks)
    expect(state.readingParseCount).toBe(1) // 装载解析一次
    expect(state.readingContentDomCount).toBeGreaterThan(0)
  })

  it('reading.perf：非虚拟化（无布局）回报 ok=false 的完整结构', async () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    c.handleHostMessage({ kind: 'reading.perf', scrollRounds: 3 })
    // 探针异步执行（含 rAF 等待）：失败态同样经 Promise 回报，冲一拍微任务
    await new Promise((r) => setTimeout(r, 50))
    const report = h.sent.find((m) => m.kind === 'reading.perf.report') as
      | Extract<WebviewToHost, { kind: 'reading.perf.report' }>
      | undefined
    expect(report).toBeDefined()
    expect(report!.ok).toBe(false)
    expect(report!.scrollRounds).toBe(3)
    expect(report!.baseline.mountedBlocks).toBe(0)
  })

  it('reading.perf：live 模式同样回报 ok=false（探针不切模式）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'reading.perf', scrollRounds: 3 })
    const report = h.sent.find((m) => m.kind === 'reading.perf.report')
    expect(report).toBeDefined()
    expect((report as { ok: boolean }).ok).toBe(false)
  })

  it('reading.test.image：消息被接受且不产生写回/抛错（注入载体）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(() =>
      c.handleHostMessage({
        kind: 'reading.test.image',
        srcStart: 0,
        initialHeightPx: 20,
        finalHeightPx: 240,
        delayMs: 0,
      }),
    ).not.toThrow()
    expect(sentEditRequests(h)).toBe(0)
  })

  it('非法探针消息被协议校验丢弃（scrollRounds 非正整数）', () => {
    const h = makeBridge()
    const c = mountMode(h)
    c.handleHostMessage({ kind: 'reading.perf', scrollRounds: 0 })
    expect(h.sent.find((m) => m.kind === 'reading.perf.report')).toBeUndefined()
  })
})
