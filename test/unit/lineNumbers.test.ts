// @vitest-environment jsdom
// #34 行号装配契约：源文件行号语义、设置开关 → Compartment 热重配、
// 宽编号降级（scaleX 档位）。
// - 源行编号：CM6 对 \r\n→\n 的规范化不改行数，lineNumbers() 从 doc 直算
//   即源文件行号——不写换行映射代码（共享笔记 34 号推论，此处固化契约）
// - 设置热重配：settings.snapshot/changed 到达时经 Compartment 增删
//   lineNumbers()，不重建 EditorView
// - 裸 \r 行尾不在支持范围（newline.ts 只处理 \r\n 与 \n，契约声明见
//   test/unit/newline.test.ts）
import { describe, it, expect } from 'vitest'
import { WebviewSyncController, lineNumberScale, type VsCodeBridge } from '../../src/webview/syncController'
import { SHOW_LINE_NUMBERS_DEFAULT, SHOW_LINE_NUMBERS_KEY } from '../../src/shared/settings'
import type { WebviewToHost } from '../../src/shared/protocol'

const DOC_URI = 'file:///d%3A/notes/ln.md'

function makeBridge() {
  const sent: WebviewToHost[] = []
  let state: Record<string, unknown> | undefined
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: <T,>() => state as T | undefined,
    setState: (s) => {
      state = s as Record<string, unknown>
    },
  }
  return { bridge, sent }
}

function mount(bridge: VsCodeBridge): WebviewSyncController {
  const controller = new WebviewSyncController(bridge)
  controller.mount(document.createElement('div'))
  return controller
}

function init(c: WebviewSyncController, text: string, version = 1, sessionId = 's1') {
  c.handleHostMessage({ kind: 'init', sessionId, docUri: DOC_URI, version, text })
}

/** 视口内行号单元格文本（按 DOM 序；过滤 CM6 的隐藏测量探针单元格——
 *  visibility:hidden 的 dummy 元素，真实宿主与 jsdom 均存在，不是行号） */
function gutterTexts(c: WebviewSyncController): string[] {
  const els = c.getView()?.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement') ?? []
  return Array.from(els)
    .filter((el) => (el as HTMLElement).style.visibility !== 'hidden')
    .map((el) => el.textContent ?? '')
}

/** 当前降级压缩系数（--vsidian-ln-scale；未设置为 1） */
function lnScale(c: WebviewSyncController): number {
  const raw = c.getView()?.dom.style.getPropertyValue('--vsidian-ln-scale') ?? ''
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 1
}

describe('默认装配与源行编号', () => {
  it('mount 后默认显示行号栏（定义默认 true，无需等待设置快照）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
  })

  it('init 多行文档后行号从 1 起逐行编号（空行同样编号，源行语义）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '# 标题\n\n正文行\n- 列表\n')
    // CM6 行语义：'a\nb\n' 为 3 行（末尾换行后仍有空尾行）
    expect(c.getView()!.state.doc.lines).toBe(5)
    const texts = gutterTexts(c)
    expect(texts[0]).toBe('1')
    expect(texts).toEqual(['1', '2', '3', '4', '5'])
  })

  it('宿主误发 CRLF 文本时行数与行号不变（规范化不改行数的防御记录）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\r\n乙\r\n丙')
    expect(c.getView()!.state.doc.lines).toBe(3)
    expect(gutterTexts(c)).toEqual(['1', '2', '3'])
  })

  it('编辑增删行后行号随源文更新（无换行映射代码参与）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '一行\n二行\n三行\n')
    expect(gutterTexts(c)).toEqual(['1', '2', '3', '4'])
    c.getView()!.dispatch({ changes: { from: 0, insert: '新甲\n新乙\n' } })
    expect(c.getView()!.state.doc.lines).toBe(6)
    // 行号由 CM6 从 doc 直算：dispatch 后 gutter 重建，行号序列推进
    expect(gutterTexts(c)).toEqual(['1', '2', '3', '4', '5', '6'])
  })
})

describe('设置开关热重配（Compartment）', () => {
  it('settings.snapshot 关闭 → 行号栏移除', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n乙\n')
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
    c.handleHostMessage({
      kind: 'settings.snapshot',
      values: { [SHOW_LINE_NUMBERS_KEY]: false },
    })
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).toBeNull()
  })

  it('settings.changed 重新开启 → 行号栏恢复且从 1 起', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n乙\n')
    c.handleHostMessage({
      kind: 'settings.snapshot',
      values: { [SHOW_LINE_NUMBERS_KEY]: false },
    })
    c.handleHostMessage({
      kind: 'settings.changed',
      values: { [SHOW_LINE_NUMBERS_KEY]: true },
    })
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
    expect(gutterTexts(c)).toEqual(['1', '2', '3'])
  })

  it('快照缺键时保持默认（向后兼容：宿主旧版本/未知键不下发）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n')
    c.handleHostMessage({ kind: 'settings.snapshot', values: {} })
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
  })

  it('快照值非法形态（非布尔）不改变当前装配（防御）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n')
    // 协议宽标量容器：类型语义校验归宿主，webview 侧防御性忽略
    c.handleHostMessage({
      kind: 'settings.changed',
      values: { [SHOW_LINE_NUMBERS_KEY]: 1 as never },
    })
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
  })

  it('热重配不重建 EditorView（同一 DOM 实例）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n')
    const domBefore = c.getView()!.dom
    c.handleHostMessage({
      kind: 'settings.snapshot',
      values: { [SHOW_LINE_NUMBERS_KEY]: false },
    })
    c.handleHostMessage({
      kind: 'settings.changed',
      values: { [SHOW_LINE_NUMBERS_KEY]: true },
    })
    expect(c.getView()!.dom).toBe(domBefore)
  })

  it('默认值常量与快照缺省语义一致（SHOW_LINE_NUMBERS_DEFAULT）', () => {
    expect(SHOW_LINE_NUMBERS_DEFAULT).toBe(true)
  })
})

describe('宽编号降级（留白带内 scaleX 档位）', () => {
  it('公式：≤3 位不压缩，位数越多压缩越紧，下限可控', () => {
    // 14px 基准 → 行号字号 min(0.75×14, 12) = 10.5px；可用带宽 24−2=22px
    const fontPx = Math.min(14 * 0.75, 12)
    expect(lineNumberScale(1, fontPx)).toBe(1)
    expect(lineNumberScale(3, fontPx)).toBe(1) // 3×0.6×10.5=18.9 ≤ 22
    expect(lineNumberScale(4, fontPx)).toBeLessThan(1)
    expect(lineNumberScale(4, fontPx)).toBeGreaterThan(0.8)
    expect(lineNumberScale(6, fontPx)).toBeLessThan(lineNumberScale(5, fontPx))
    expect(lineNumberScale(6, fontPx)).toBeGreaterThan(0.4) // 6 位仍可辨认
  })

  it('公式：非法入参回退 1（防御）', () => {
    expect(lineNumberScale(0, 10)).toBe(1)
    expect(lineNumberScale(-1, 10)).toBe(1)
    expect(lineNumberScale(3, 0)).toBe(1)
    expect(lineNumberScale(Number.NaN, 10)).toBe(1)
  })

  it('装配侧：视口行号 ≤3 位时 --vsidian-ln-scale 保持 1', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, Array.from({ length: 12 }, (_, i) => `第${i + 1}行`).join('\n'))
    expect(lnScale(c)).toBe(1)
  })

  it('装配侧：大文档行号 DOM 有界（视口行渲染，非全文）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    const lines = Array.from({ length: 1200 }, (_, i) => `第${i + 1}行`)
    init(c, lines.join('\n'))
    expect(c.getView()!.state.doc.lines).toBe(1200)
    // CM6 gutter 只对视口行建 DOM（工单「不为大文件创建全文行号 DOM」）
    const texts = gutterTexts(c)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.length).toBeLessThan(200)
    expect(texts[0]).toBe('1')
  })
})
