// @vitest-environment jsdom
// #34 行号装配契约：源文件行号语义、设置开关 → Compartment 热重配、
// 大文档 DOM 有界。
// - 源行编号：CM6 对 \r\n→\n 的规范化不改行数，lineNumbers() 从 doc 直算
//   即源文件行号——不写换行映射代码（共享笔记 34 号推论，此处固化契约）
// - 设置热重配：settings.snapshot/changed 到达时经 Compartment 增删
//   lineNumbers()，不重建 EditorView
// - 行号列在流内、列宽随位数自适应（无降级机制；旧 24px 带内 scaleX
//   压缩已随带宽约束移除）
// - 裸 \r 行尾不在支持范围（newline.ts 只处理 \r\n 与 \n，契约声明见
//   test/unit/newline.test.ts）
import { describe, it, expect } from 'vitest'
import { gutterLineClass } from '@codemirror/view'
import { WebviewSyncController, createFontBoundingBoxMeasurer, type VsCodeBridge } from '../../src/webview/syncController'
import { getLineNumberGutterStats } from '../../src/webview/liveLineNumbers'
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

/** 视口内行号单元格（文本 + 类名），供 #116 表格行格分类断言 */
function gutterElements(c: WebviewSyncController): Array<{ text: string; className: string }> {
  const els = c.getView()?.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement') ?? []
  return Array.from(els)
    .filter((el) => (el as HTMLElement).style.visibility !== 'hidden')
    .map((el) => ({ text: el.textContent ?? '', className: el.className }))
}

describe('默认装配与源行编号', () => {
  it('表外普通段落和另一张表编辑后，旧网格表格仍只显示段首行号', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, ['开头', '', '普通段落', '', '| A | B |', '| --- | --- |', '| 甲 | 乙 |', '',
      '间隔', '', '| C | D |', '| --- | --- |', '| 丙 | 丁 |', '', '结尾'].join('\n'))
    const expected = ['1', '2', '3', '4', '5', '8', '9', '10', '11', '14', '15']
    expect(gutterTexts(c).filter(Boolean)).toEqual(expected)
    c.getView()!.dispatch({ changes: { from: 1, insert: '新' } })
    c.handleHostMessage({ kind: 'settings.changed', values: { [SHOW_LINE_NUMBERS_KEY]: false } })
    c.handleHostMessage({ kind: 'settings.changed', values: { [SHOW_LINE_NUMBERS_KEY]: true } })
    expect(gutterTexts(c).filter(Boolean)).toEqual(expected)
    const at = c.getView()!.state.doc.toString().indexOf('丙')
    c.getView()!.dispatch({ changes: { from: at, insert: '新' } })
    expect(gutterTexts(c).filter(Boolean)).toEqual(expected)
    c.dispose()
  })

  it('安全表格只显示段首源行号，隐藏分隔行与数据行编号', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '前文\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n后文')
    expect(gutterTexts(c).filter(Boolean)).toEqual(['1', '2', '3', '6', '7'])
    c.getView()!.dispatch({ selection: { anchor: c.getView()!.state.doc.line(5).from + 2 } })
    expect(gutterTexts(c).filter(Boolean)).toEqual(['1', '2', '3', '6', '7'])
    c.dispose()
  })

  it('mount 后默认显示行号栏（定义默认 true，无需等待设置快照）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    expect(c.getView()!.dom.querySelector('.cm-lineNumbers')).not.toBeNull()
  })

  it('非安全表格保留源码行号，修复列数后切换段首策略', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '| A | B |\n| --- | --- |\n| 甲 | 乙 | 多列 |')
    expect(gutterTexts(c).filter(Boolean)).toEqual(['1', '2', '3'])
    const line = c.getView()!.state.doc.line(3)
    c.getView()!.dispatch({ changes: { from: line.from, to: line.to, insert: '| 甲 | 乙 |' } })
    expect(gutterTexts(c).filter(Boolean)).toEqual(['1'])
    c.getView()!.dispatch({ changes: { from: 0, insert: '前文\n\n' } })
    expect(gutterTexts(c).filter(Boolean)).toEqual(['1', '2', '3'])
    c.dispose()
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

describe('表格行号格分类（#116 错位修复）', () => {
  // 分隔行 gutter element 记账高度 0（行 display:none），通用 padding-top
  // 半差补偿会把 0 高盒撑开 2.625px、把表后行号逐表推下；表头行文字因
  // 单元格 padding+border 下移，行号需同步补 cell 下移量。两类行格靠
  // gutterLineClass 挂稳定类，由 main.css 契约（lineNumberCssContract）
  // 钉住对应补偿规则——本组只钉「类挂到了正确的行格上」。
  it('安全表格：分隔行格挂 delimiter 类、表头行格挂 header 类，数据行与普通行不带', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '前文\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n后文')
    const byText = new Map(gutterElements(c).map((el) => [el.text, el]))
    expect(byText.get('3')?.className).toContain('vsidian-ln-table-header')
    // 分隔行（源行 4）与数据行（源行 5）行号为空字符串，按 DOM 序取
    const empties = gutterElements(c).filter((el) => el.text === '')
    expect(empties.length).toBe(2)
    expect(empties[0]!.className).toContain('vsidian-ln-table-delimiter')
    expect(empties[1]!.className).not.toContain('vsidian-ln-table-delimiter')
    expect(byText.get('1')?.className).not.toContain('vsidian-ln-table-header')
    expect(byText.get('7')?.className).not.toContain('vsidian-ln-table-delimiter')
    c.dispose()
  })

  it('光标停分隔行（编辑态显露）时该行格撤下 delimiter 类，与行号显隐数据源一致', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '前文\n\n| A | B |\n| --- | --- |\n| 甲 | 乙 |\n\n后文')
    const view = c.getView()!
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 2 } })
    const elements = gutterElements(c)
    const line4 = elements.find((el) => el.text === '4')
    expect(line4, '光标进入后分隔行行号应显示').toBeTruthy()
    expect(line4!.className).not.toContain('vsidian-ln-table-delimiter')
    c.dispose()
  })

  it('普通文档行号格不带任何表格类', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n\n乙\n')
    for (const el of gutterElements(c)) {
      expect(el.className).not.toContain('vsidian-ln-table-header')
      expect(el.className).not.toContain('vsidian-ln-table-delimiter')
    }
    c.dispose()
  })
})

describe('大文档与列宽自适应', () => {
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

describe('行格分类扫描收窄（#116 性能）', () => {
  // liveDecorationsField 每次事务（含纯选区移动）都产生新装饰集，行格
  // 分类 facet 随之重算；收窄前 compute 对全文 decos.between 逐条回调，
  // 无表格文档也全额遍历。收窄契约：无表格零遍历（快速路径）、表外事务
  // memo 复用（结果引用稳定）、触及表段才重扫且只扫表段跨度。
  const tableDoc = (tailLines: number): string =>
    ['前文', '', '| A | B |', '| --- | --- |', '| 甲 | 乙 |', '',
      ...Array.from({ length: tailLines }, (_, i) => `第${i + 1}行尾部文字`)].join('\n')

  it('无表格文档：纯选区移动不再触发装饰扫描（零遍历快速路径）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, Array.from({ length: 60 }, (_, i) => `第${i + 1}行普通文字`).join('\n'))
    const view = c.getView()!
    const before = getLineNumberGutterStats()
    view.dispatch({ selection: { anchor: view.state.doc.line(20).from } })
    view.dispatch({ selection: { anchor: view.state.doc.line(40).from } })
    const after = getLineNumberGutterStats()
    expect(after.scannedChars - before.scannedChars).toBe(0)
    c.dispose()
  })

  it('无表格文档：纯选区移动后行格 facet 元素引用稳定（共享空集单例）', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, '甲\n\n乙\n')
    const view = c.getView()!
    const before = view.state.facet(gutterLineClass)
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    const after = view.state.facet(gutterLineClass)
    expect(after[0]).toBe(before[0])
    c.dispose()
  })

  it('有表格文档：表外纯选区移动命中 memo，结果引用稳定且不重扫', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, tableDoc(60))
    const view = c.getView()!
    const first = view.state.facet(gutterLineClass)
    const before = getLineNumberGutterStats()
    view.dispatch({ selection: { anchor: view.state.doc.line(50).from } })
    const second = view.state.facet(gutterLineClass)
    const after = getLineNumberGutterStats()
    expect(second[0]).toBe(first[0])
    expect(after.scannedChars - before.scannedChars).toBe(0)
    c.dispose()
  })

  it('有表格文档：光标进分隔行触发重扫，但扫描跨度收敛在表段内', () => {
    const { bridge } = makeBridge()
    const c = mount(bridge)
    init(c, tableDoc(60))
    const view = c.getView()!
    const before = getLineNumberGutterStats()
    view.dispatch({ selection: { anchor: view.state.doc.line(4).from + 2 } })
    const after = getLineNumberGutterStats()
    const delta = after.scannedChars - before.scannedChars
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThan(view.state.doc.length)
    c.dispose()
  })
})

describe('行号对齐探针健壮性（#116）', () => {
  /** 假 canvas 2D：jsdom 本机无 canvas 包（getContext 返回 null），桩出
   *  measureText 的 fontBoundingBox 度量，专测 measurer 对 font 串的防御 */
  function stubCanvasContext(): () => void {
    const realCreate = document.createElement.bind(document)
    const measureText = (): { fontBoundingBoxAscent: number; fontBoundingBoxDescent: number } =>
      ({ fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 })
    document.createElement = ((tag: string) =>
      (tag === 'canvas'
        ? { getContext: () => ({ measureText }) }
        : realCreate(tag))) as typeof document.createElement
    return () => {
      document.createElement = realCreate
    }
  }

  it('fontMetric：空/空白 computed font 返回 null，不落 canvas 默认字体伪度量', () => {
    const restore = stubCanvasContext()
    try {
      const fontMetric = createFontBoundingBoxMeasurer()
      // canvas 规范：无效 font 赋值被静默忽略、沿用默认 10px sans-serif——
      // 空 computed font 串若照走 canvas 会量出默认字体伪度量
      expect(fontMetric('')).toBeNull()
      expect(fontMetric('   ')).toBeNull()
      expect(fontMetric('400 16px mono')).toEqual({ ascent: 8, descent: 2 })
    } finally {
      restore()
    }
  })

  it('对齐采样：单条目异常只跳过该行，余下行号仍被采样', () => {
    const { bridge, sent } = makeBridge()
    const c = mount(bridge)
    init(c, '好甲\n坏乙\n好丙')
    // jsdom 未实现 Range.getBoundingClientRect（调用即抛错）：补桩模拟
    // 真宿主布局——正文行含「坏」的采样抛错（单条异常注入），行号格与
    // 其余正文行返回有面积的矩形
    const proto = document.defaultView!.Range.prototype as
      (Range & { getBoundingClientRect?: () => DOMRect }) | undefined
    const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'getBoundingClientRect')
    const original = proto!.getBoundingClientRect
    proto!.getBoundingClientRect = function (this: Range): DOMRect {
      const node = this.startContainer
      const host = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null
      const line = host?.closest('.cm-line') ?? null
      if (line?.textContent?.includes('坏')) throw new Error('probe boom')
      if (host?.closest('.cm-lineNumbers')) return { height: 12, bottom: 110 } as DOMRect
      return { height: 12, bottom: 100 } as DOMRect
    }
    const restoreCanvas = stubCanvasContext()
    try {
      c.handleHostMessage({ kind: 'view.state.request' } as never)
      const last = sent[sent.length - 1] as (WebviewToHost & {
        lineGutter?: { alignment?: Array<{ num: string }> | null }
      })
      expect(last.kind).toBe('view.state')
      const alignment = last.lineGutter?.alignment ?? null
      expect(alignment?.map((entry) => entry.num)).toEqual(['1', '3'])
    } finally {
      restoreCanvas()
      if (hadOwn) proto!.getBoundingClientRect = original!
      else delete (proto as { getBoundingClientRect?: unknown }).getBoundingClientRect
      c.dispose()
    }
  })
})
