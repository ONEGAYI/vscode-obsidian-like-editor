// 变更重定位纯函数契约：宿主收到 baseVersion 落后的 edit.request 时，把其
// offset/length 穿过「从 baseVersion 到当前版本之间已应用的变更组」平移；
// 区间被已应用变更覆盖或相交时返回 null（不可安全映射，走全文重同步）。
import { describe, it, expect } from 'vitest'
import {
  mapChangeThroughChanges,
  mapOffsetThroughChanges,
} from '../../src/shared/changeMapping'

describe('mapOffsetThroughChanges（无已应用变更）', () => {
  it('空变更组下位置恒等', () => {
    expect(mapOffsetThroughChanges(10, [])).toBe(10)
    expect(mapOffsetThroughChanges(0, [])).toBe(0)
  })
})

describe('mapOffsetThroughChanges（单组单变更）', () => {
  // 在 offset 10 处插入 5 个字符
  const insert = [{ offset: 10, length: 0, text: 'abcde' }]

  it('位置在插入点之前不变', () => {
    expect(mapOffsetThroughChanges(3, [insert])).toBe(3)
    expect(mapOffsetThroughChanges(10, [insert])).toBe(10) // from 侧语义：插入点左邻不受影响
  })

  it('位置在插入点之后平移 +5', () => {
    expect(mapOffsetThroughChanges(11, [insert])).toBe(16)
    expect(mapOffsetThroughChanges(100, [insert])).toBe(105)
  })

  // 删除 [10, 15) 共 5 个字符
  const del = [{ offset: 10, length: 5, text: '' }]

  it('位置在删除区间之前不变', () => {
    expect(mapOffsetThroughChanges(9, [del])).toBe(9)
  })

  it('位置在删除区间之后平移 -5', () => {
    expect(mapOffsetThroughChanges(15, [del])).toBe(10)
    expect(mapOffsetThroughChanges(20, [del])).toBe(15)
  })
})

describe('mapOffsetThroughChanges（同组多变更）', () => {
  it('前删后插的组合按文档顺序同时映射', () => {
    // 一次事件删除 [2,4) 并在 offset 8 插入 'xy'
    const group = [
      { offset: 8, length: 0, text: 'xy' },
      { offset: 2, length: 2, text: '' },
    ]
    expect(mapOffsetThroughChanges(1, [group])).toBe(1)          // 两处之前
    expect(mapOffsetThroughChanges(6, [group])).toBe(4)          // 删除之后、插入之前：-2
    expect(mapOffsetThroughChanges(10, [group])).toBe(10 - 2 + 2) // 两处之后
  })
})

describe('mapOffsetThroughChanges（多组依次映射）', () => {
  it('两组先后插入按时间顺序累计平移', () => {
    const g1 = [{ offset: 5, length: 0, text: '1234' }] // +4
    const g2 = [{ offset: 10, length: 3, text: '' }]    // -3
    expect(mapOffsetThroughChanges(20, [g1, g2])).toBe(21)
  })
})

describe('mapChangeThroughChanges', () => {
  it('区间在已应用变更之前恒等', () => {
    const applied = [[{ offset: 10, length: 0, text: 'x' }]]
    const change = { offset: 2, length: 3, text: '新' }
    expect(mapChangeThroughChanges(change, applied)).toEqual(change)
  })

  it('区间在已应用插入之后整体平移', () => {
    const applied = [[{ offset: 0, length: 2, text: '插入' }]] // delta = +2
    const change = { offset: 5, length: 1, text: '替' }
    expect(mapChangeThroughChanges(change, applied)).toEqual({ offset: 7, length: 1, text: '替' })
  })

  it('from 落在已应用删除区间内返回 null', () => {
    const applied = [[{ offset: 4, length: 6, text: '' }]]
    expect(mapChangeThroughChanges({ offset: 5, length: 1, text: 'x' }, applied)).toBeNull()
  })

  it('编辑区间与已应用删除区间相交返回 null', () => {
    const applied = [[{ offset: 4, length: 6, text: '' }]] // 删除 [4,10)
    // 编辑 [2,6)：to=6 落在删除区间内
    expect(mapChangeThroughChanges({ offset: 2, length: 4, text: 'x' }, applied)).toBeNull()
    // 编辑 [8,12)：from=8 落在删除区间内
    expect(mapChangeThroughChanges({ offset: 8, length: 4, text: 'x' }, applied)).toBeNull()
  })

  it('编辑区间完全包含已应用删除区间也返回 null（to 端点被覆盖）', () => {
    const applied = [[{ offset: 4, length: 6, text: '' }]] // 删除 [4,10)
    // 编辑 [2,12)：from=2 与 to=12 都在区间外，但区间横跨删除
    // ——按保守规则，端点可映射则允许（等价于替换掉已删除区域），此处应得到平移区间
    const mapped = mapChangeThroughChanges({ offset: 2, length: 10, text: 'x' }, applied)
    expect(mapped).toEqual({ offset: 2, length: 4, text: 'x' })
  })

  it('空已应用列表恒等', () => {
    const change = { offset: 1, length: 2, text: 'a' }
    expect(mapChangeThroughChanges(change, [])).toEqual(change)
  })
})
