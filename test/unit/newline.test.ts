// 换行协调契约：CM6 内部把 \r\n 规范化为 \n（实测 @codemirror/state 6.7.6，
// lineSeparator facet 亦无法保真），因此 webview 侧统一使用 LF 坐标与文本，
// 由宿主侧 NewlineCoordinator 负责宿主（可能 CRLF/混合）与 LF 的双向转换：
// - 坐标映射：LF offset <-> 宿主 offset（\r\n 行尾各贡献 +1 偏移）
// - 文本转换：宿主 -> LF 一律 \r\n -> \n；LF -> 宿主仅在文档行尾全为 CRLF
//   时把 \n 还原为 \r\n（混合文档保持 LF，不破坏原有行尾风格）
import { describe, it, expect } from 'vitest'
import { NewlineCoordinator } from '../../src/shared/newline'

describe('LF 文档（无转换直通）', () => {
  const c = new NewlineCoordinator('a\nbc\nd')
  it('无 CRLF 标记，坐标与文本恒等', () => {
    expect(c.hasCrlf()).toBe(false)
    expect(c.isCrlfDoc).toBe(false)
    expect(c.hostOffsetToLf(3)).toBe(3)
    expect(c.lfOffsetToHost(3)).toBe(3)
    expect(c.lfChangesToHost([{ offset: 1, length: 0, text: 'x\ny' }])).toEqual([
      { offset: 1, length: 0, text: 'x\ny' },
    ])
  })
})

describe('全 CRLF 文档 a\\r\\nbc\\r\\nd', () => {
  const host = 'a\r\nbc\r\nd' // \r 位于 1 与 5；\n 总数 2
  const c = new NewlineCoordinator(host)

  it('识别为 CRLF 文档并 LF 化全文', () => {
    expect(c.hasCrlf()).toBe(true)
    expect(c.isCrlfDoc).toBe(true)
    expect(c.toLfText(host)).toBe('a\nbc\nd')
  })

  it('hostOffsetToLf：越过每个 CRLF 行尾偏移 -1', () => {
    expect(c.hostOffsetToLf(0)).toBe(0)
    expect(c.hostOffsetToLf(1)).toBe(1) // \r 处
    expect(c.hostOffsetToLf(2)).toBe(1) // \n 处（区间端点落在换行前语义）
    expect(c.hostOffsetToLf(3)).toBe(2)
    expect(c.hostOffsetToLf(6)).toBe(4)
    expect(c.hostOffsetToLf(8)).toBe(6)
  })

  it('lfOffsetToHost：越过每个 CRLF 行尾偏移 +1', () => {
    expect(c.lfOffsetToHost(0)).toBe(0)
    expect(c.lfOffsetToHost(1)).toBe(1) // LF 换行处端点位于 \r 前
    expect(c.lfOffsetToHost(2)).toBe(3)
    expect(c.lfOffsetToHost(4)).toBe(5) // 第二个换行处端点位于第二个 \r 前
    expect(c.lfOffsetToHost(6)).toBe(8) // 文档末尾
  })

  it('hostChangesToLf：坐标与文本同时转换', () => {
    expect(
      c.hostChangesToLf([{ offset: 3, length: 2, text: 'X\r\nY' }]),
    ).toEqual([{ offset: 2, length: 2, text: 'X\nY' }])
  })

  it('hostChangesToLf：区间横跨换行的 length 按换行数缩减', () => {
    // 替换宿主 [1,6)（两个 CRLF 行尾在内）：LF 区间 [1,4)，length 3
    expect(c.hostChangesToLf([{ offset: 1, length: 5, text: 'z' }])).toEqual([
      { offset: 1, length: 3, text: 'z' },
    ])
  })

  it('lfChangesToHost：全 CRLF 文档把插入文本的 \\n 还原为 \\r\\n', () => {
    expect(c.lfChangesToHost([{ offset: 2, length: 0, text: 'X\nY' }])).toEqual([
      { offset: 3, length: 0, text: 'X\r\nY' },
    ])
  })

  it('rebuild 后按新文本重新映射', () => {
    const c2 = new NewlineCoordinator('a\r\nb')
    c2.rebuild('a\nb') // 外部把文档改为 LF
    expect(c2.hasCrlf()).toBe(false)
    expect(c2.hostOffsetToLf(3)).toBe(3)
  })
})

describe('混合行尾文档 a\\r\\nb\\nc', () => {
  const host = 'a\r\nb\nc' // \r 位于 1；\n 总数 2
  const c = new NewlineCoordinator(host)

  it('坐标仍按 CRLF 位置换算', () => {
    expect(c.hasCrlf()).toBe(true)
    expect(c.isCrlfDoc).toBe(false)
    expect(c.hostOffsetToLf(5)).toBe(4)
    expect(c.lfOffsetToHost(4)).toBe(5)
  })

  it('插入文本保持 LF（不把新行尾强转为 CRLF）', () => {
    expect(c.lfChangesToHost([{ offset: 2, length: 0, text: 'x\ny' }])).toEqual([
      { offset: 3, length: 0, text: 'x\ny' },
    ])
  })
})

describe('单行无换行文档（末尾无 \\n，mvp.md 文档样例清单）', () => {
  const c = new NewlineCoordinator('abc')

  it('无 CRLF 标记，末位置（=== 长度）坐标恒等不越界', () => {
    expect(c.hasCrlf()).toBe(false)
    expect(c.isCrlfDoc).toBe(false)
    expect(c.hostOffsetToLf(3)).toBe(3)
    expect(c.lfOffsetToHost(3)).toBe(3)
  })

  it('末位置插入直通（CRLF 文档的末位置编辑同此换算路径，不产生漂移）', () => {
    const crlfEnd = new NewlineCoordinator('a\r\nbc') // CRLF 文档、末尾无换行
    expect(c.lfChangesToHost([{ offset: 3, length: 0, text: '！' }])).toEqual([
      { offset: 3, length: 0, text: '！' },
    ])
    // LF 'a\nbc' 末位 4 → 宿主坐标 5（越过 1 个 CRLF 行尾 +1）
    expect(crlfEnd.lfOffsetToHost(4)).toBe(5)
  })
})

// ---- review-loops C7：大纲式多段搬移变更在 CRLF 文档上的转换不变式 ----

describe('大纲多段搬移的 CRLF 转换不变式（review-loops C7）', () => {
  // 模拟拖拽产出的两段变更：删除「乙段」+ 在丙标题前插入（文本含多行 \n）
  const host = '# 甲\r\n甲内容\r\n## 乙\r\n乙内容\r\n# 丙\r\n丙内容\r\n'
  const lf = host.replace(/\r\n/g, '\n')
  const applyText = (text: string, changes: ReadonlyArray<{ offset: number; length: number; text: string }>): string => {
    let out = text
    for (let i = changes.length - 1; i >= 0; i--) {
      const ch = changes[i]!
      out = out.slice(0, ch.offset) + ch.text + out.slice(ch.offset + ch.length)
    }
    return out
  }

  it('LF 域应用后转 CRLF == 宿主域直接应用（两域等价）', () => {
    const c = new NewlineCoordinator(host)
    expect(c.isCrlfDoc).toBe(true)
    // LF 坐标：'## 乙\n乙内容\n' 段 [10, 23)，插入到 '# 丙' 前（offset 23）
    const lfChanges = [
      { offset: 10, length: 13, text: '' },
      { offset: 23, length: 0, text: '## 乙\n乙内容\n' },
    ]
    const hostChanges = c.lfChangesToHost(lfChanges)
    const lfAfter = applyText(lf, lfChanges)
    const hostAfter = applyText(host, hostChanges)
    expect(hostAfter).toBe(lfAfter.replace(/\n/g, '\r\n'))
  })

  it('升序不重叠在宿主域保持（大纲写回约束跨域不破）', () => {
    const c = new NewlineCoordinator(host)
    const hostChanges = c.lfChangesToHost([
      { offset: 10, length: 13, text: '' },
      { offset: 23, length: 0, text: '## 乙\n乙内容\n' },
    ])
    expect(hostChanges[0]!.offset + hostChanges[0]!.length).toBeLessThanOrEqual(hostChanges[1]!.offset)
  })
})
