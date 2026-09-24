// 查找匹配计算契约（工单 #14）：
// - 匹配基于 webview 全文文本模型（纯函数，与 DOM 无关——不是 DOM 遍历）
// - 坐标为 LF 全文 UTF-16 code unit offset（与协议/CM6 同构）
// - 语义固定：区分大小写为默认；大小写不敏感为显式选项
// - 中文/emoji（代理对）按码点边界对齐：匹配不得起止于代理对中间
// - 非重叠、从左到右；空查询无匹配；无匹配返回空数组
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import {
  computeFindMatches,
  findStateField,
  setFindMatches,
} from '../../src/webview/findSession'

describe('基础匹配语义', () => {
  it('英文多个匹配：非重叠、从左到右', () => {
    const text = 'abc abc abc'
    const ms = computeFindMatches(text, 'abc', true)
    expect(ms.map((m) => [m.from, m.to])).toEqual([
      [0, 3],
      [4, 7],
      [8, 11],
    ])
  })

  it('重叠匹配不计数：aaaa 查 aa 得 2 个（0-2、2-4）', () => {
    const ms = computeFindMatches('aaaa', 'aa', true)
    expect(ms.map((m) => [m.from, m.to])).toEqual([
      [0, 2],
      [2, 4],
    ])
  })

  it('空查询无匹配；查询长于文本无匹配；无匹配返回空数组', () => {
    expect(computeFindMatches('任意文本', '', true)).toEqual([])
    expect(computeFindMatches('短', '比文本更长 的查询', true)).toEqual([])
    expect(computeFindMatches('中文编辑测试', '不存在的词', true)).toEqual([])
  })

  it('匹配可以出现在文档任意位置（含末尾）', () => {
    const text = '前缀\n\n目标词'
    const ms = computeFindMatches(text, '目标词', true)
    expect(ms).toEqual([{ from: text.indexOf('目标词'), to: text.length }])
  })
})

describe('中文与 emoji（码点语义）', () => {
  it('中文子串按 UTF-16 offset 命中', () => {
    const ms = computeFindMatches('中文编辑测试与编辑器', '编辑', true)
    expect(ms.map((m) => [m.from, m.to])).toEqual([
      [2, 4],
      [7, 9],
    ])
  })

  it('emoji（BMP 外代理对）按完整码点命中，from/to 为 UTF-16 offset', () => {
    const ms = computeFindMatches('🎉🎉🎉', '🎉', true)
    expect(ms.map((m) => [m.from, m.to])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ])
  })

  it('组合 emoji（ZWJ 序列）内子序列命中在码点边界', () => {
    // 👨‍👩‍👧‍👦 = 👨 ZWJ 👩 ZWJ 👧 ZWJ 👦（11 个 UTF-16 单元）
    const family = '👨‍👩‍👧‍👦'
    expect(family.length).toBe(11)
    const ms = computeFindMatches(`前缀${family}后缀`, '👩‍👧', true)
    expect(ms.length).toBe(1)
    expect(ms[0]!.from).toBe('前缀'.length + 3) // 👨(2)+ZWJ(1) 之后
    expect(ms[0]!.to).toBe(ms[0]!.from + 5)
  })

  it('代理对中间不得起止：孤代理查询命中被拒绝（行为锁定）', () => {
    // '𝐀𝐁' 为两个 BMP 外字符（4 个单元）；'\uD835' 是 𝐀 的高位半区
    const text = '𝐀𝐁'
    expect(text.length).toBe(4)
    expect(computeFindMatches(text, '𝐀', true)).toEqual([{ from: 0, to: 2 }])
    // 孤立高位代理作为查询：原生 indexOf 可命中半区，语义上必须拒绝
    expect(computeFindMatches(text, '𝐀'.slice(0, 1), true)).toEqual([])
    expect(computeFindMatches(text, '𝐁'.slice(0, 1), true)).toEqual([])
  })

  it('emoji 与中文混合文档的多处命中', () => {
    const text = '第一段包含 🎉 结尾。\n\n第二段包含 🎉 结尾。\n\n第三段无。'
    const ms = computeFindMatches(text, '🎉 结尾', true)
    expect(ms.length).toBe(2)
    expect(text.slice(ms[0]!.from, ms[0]!.to)).toBe('🎉 结尾')
    expect(text.slice(ms[1]!.from, ms[1]!.to)).toBe('🎉 结尾')
    expect(ms[1]!.from).toBeGreaterThan(ms[0]!.to)
  })
})

describe('大小写敏感性（语义固定：默认区分，可选不区分）', () => {
  it('区分大小写（默认）：大小写不同不算命中', () => {
    const ms = computeFindMatches('Hello hello HELLO', 'hello', true)
    expect(ms.map((m) => m.from)).toEqual([6])
  })

  it('大小写不敏感：全部命中', () => {
    const ms = computeFindMatches('Hello hello HELLO', 'hello', false)
    expect(ms.map((m) => m.from)).toEqual([0, 6, 12])
  })

  it('大小写不敏感不改变区间长度（无大小写折叠膨胀）', () => {
    const ms = computeFindMatches('Straße STRASSE', 'strasse', false)
    // 'ß' 与 'SS' 折叠会改变长度——本实现按原文本区间对齐，拒绝跨形态折叠
    expect(ms.map((m) => [m.from, m.to])).toEqual([[7, 14]])
  })

  it('正则元字符按字面量处理', () => {
    const text = 'a.c 与 a*c 与 abc'
    expect(computeFindMatches(text, 'a.c', true).map((m) => m.from)).toEqual([0])
    expect(computeFindMatches(text, 'a*c', true).map((m) => m.from)).toEqual([6])
    expect(computeFindMatches(text, '(', true)).toEqual([])
  })
})

describe('长文档（文本模型全量计算，非 DOM）', () => {
  it('万级行文本的全量匹配与计数', () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `第 ${i} 行：查找目标样本`)
    const text = lines.join('\n')
    const ms = computeFindMatches(text, '查找目标', true)
    expect(ms.length).toBe(10_000)
    expect(ms[0]!.from).toBe(text.indexOf('查找目标'))
    expect(ms[9_999]!.from).toBe(text.lastIndexOf('查找目标'))
    // 每个匹配切片还原即查询本身（坐标正确性）
    for (const probe of [ms[0]!, ms[5_000]!, ms[9_999]!]) {
      expect(text.slice(probe.from, probe.to)).toBe('查找目标')
    }
  })
})

describe('当前匹配装饰随文档变更映射（findStateField）', () => {
  // 契约：整组替换（setFindMatches）前，文档变更事务先把既有装饰随
  // tr.changes 平移——控制器的重算在微任务中异步完成，纯映射兜底消除
  // 「重算前一帧用旧坐标渲染」的时序窗口（结构上不再依赖微任务时序闭合）
  const docText = '0123456789abcd5678'

  function currentRange(state: EditorState): { from: number; to: number } | undefined {
    // RangeCursor 非 JS iterator 协议：初始即指向首个区间，value 为空表示无区间
    const cursor = state.field(findStateField).decos.iter()
    return cursor.value ? { from: cursor.from, to: cursor.to } : undefined
  }

  it('匹配前插入文本：装饰区间随变更平移', () => {
    const state = EditorState.create({ doc: docText, extensions: [findStateField] })
    const marked = state.update({
      effects: setFindMatches.of({ matches: [{ from: 10, to: 14 }], index: 0 }),
    }).state
    expect(currentRange(marked)).toEqual({ from: 10, to: 14 })
    // 文档开头插入 3 字符：当前匹配装饰应平移到 [13,17)
    const shifted = marked.update({ changes: { from: 0, insert: '新增三' } }).state
    expect(currentRange(shifted)).toEqual({ from: 13, to: 17 })
  })

  it('删除覆盖匹配的文本：装饰区间被删除塌缩（不出越界区间）', () => {
    const state = EditorState.create({ doc: docText, extensions: [findStateField] })
    const marked = state.update({
      effects: setFindMatches.of({ matches: [{ from: 10, to: 14 }], index: 0 }),
    }).state
    const collapsed = marked.update({ changes: { from: 8, to: 16 } }).state
    expect(currentRange(collapsed)).toBeUndefined()
  })
})
