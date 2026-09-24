// 任务勾选点击解析契约（工单 #9）：点击来源坐标（live widget 位置 /
// reading checkbox 锚点）→ 当前文档校验 → 安全替换区间。
// - 定位安全：校验按源位置区间精确匹配（绝不做文本内容查找——重复任务
//   行会改错目标）
// - 过期锚点（外部修改致行漂移/区间失效）：严格校验失败即放弃，不产生编辑
// - 「无内容变化的重渲染不新增历史」：权威内容已是目标态时返回 null
//   （不产生文档变更，撤销栈不受影响）
// - 勾选写为 [x]、取消写为 [ ]；[X] 视为已勾选
import { describe, it, expect } from 'vitest'
import {
  resolveStaleTaskToggle,
  resolveTaskToggleAtMarker,
} from '../../src/webview/taskToggle'

const DOC = [
  '# 标题',
  '',
  '- [ ] 未完成任务甲',
  '- [ ] 未完成任务乙',
  '- [x] 已完成任务',
  '- [X] 大写勾选任务',
  '1. [ ] 有序任务',
  '- 普通列表项',
  '',
  '结尾段落',
  '',
].join('\n')

function markerRangeOf(lineText: string): { start: number; end: number } {
  const start = DOC.indexOf(lineText) + lineText.indexOf('[')
  return { start, end: start + 3 }
}

describe('resolveTaskToggleAtMarker（live 路径：widget 位置即当前文档坐标）', () => {
  it('未勾选 [ ] → 勾选写为 [x]：返回精确三字符替换区间', () => {
    const { start, end } = markerRangeOf('- [ ] 未完成任务甲')
    const target = resolveTaskToggleAtMarker(DOC, start, end, false)
    expect(target).toEqual({ from: start, to: end, nextText: '[x]' })
  })

  it('已勾选 [x] → 取消写为 [ ]', () => {
    const { start, end } = markerRangeOf('- [x] 已完成任务')
    const target = resolveTaskToggleAtMarker(DOC, start, end, true)
    expect(target).toEqual({ from: start, to: end, nextText: '[ ]' })
  })

  it('大写 [X] 视为已勾选，取消写为 [ ]', () => {
    const { start, end } = markerRangeOf('- [X] 大写勾选任务')
    const target = resolveTaskToggleAtMarker(DOC, start, end, true)
    expect(target).toEqual({ from: start, to: end, nextText: '[ ]' })
  })

  it('有序列表任务同样可切换', () => {
    const { start, end } = markerRangeOf('1. [ ] 有序任务')
    const target = resolveTaskToggleAtMarker(DOC, start, end, false)
    expect(target).toEqual({ from: start, to: end, nextText: '[x]' })
  })

  it('重复任务行：相同文本的两个任务，按源位置各自独立定位', () => {
    const dupDoc = '- [ ] 重复任务\n- [ ] 重复任务\n'
    const first = dupDoc.indexOf('[')
    const second = dupDoc.indexOf('[', first + 1)
    expect(resolveTaskToggleAtMarker(dupDoc, first, first + 3, false)).toEqual({
      from: first,
      to: first + 3,
      nextText: '[x]',
    })
    expect(resolveTaskToggleAtMarker(dupDoc, second, second + 3, false)).toEqual({
      from: second,
      to: second + 3,
      nextText: '[x]',
    })
  })

  it('区间不是任务标记（光标命中普通文本）→ 放弃', () => {
    const plain = DOC.indexOf('普通列表项')
    expect(resolveTaskToggleAtMarker(DOC, plain, plain + 3, false)).toBeNull()
  })

  it('越界与畸形区间 → 放弃（不抛错）', () => {
    expect(resolveTaskToggleAtMarker(DOC, 99999, 100002, false)).toBeNull()
    expect(resolveTaskToggleAtMarker(DOC, -4, -1, false)).toBeNull()
    expect(resolveTaskToggleAtMarker(DOC, 4, 4, false)).toBeNull()
  })

  it('文档已是目标态（点击过期显示）→ null：不产生文档变更', () => {
    // 视图显示未勾选（displayedChecked=false），但权威已是 [x]：
    // 用户意图（勾选）与现状一致 → 无内容变化，不得新增历史
    const { start, end } = markerRangeOf('- [x] 已完成任务')
    expect(resolveTaskToggleAtMarker(DOC, start, end, false)).toBeNull()
    // 反向：视图显示已勾选，权威是 [ ]
    const { start: s2, end: e2 } = markerRangeOf('- [ ] 未完成任务甲')
    expect(resolveTaskToggleAtMarker(DOC, s2, e2, true)).toBeNull()
  })
})

describe('resolveStaleTaskToggle（reading 路径：锚点严格再校验）', () => {
  it('正常路径：锚点区间有效且行仍为任务行 → 精确替换', () => {
    const { start, end } = markerRangeOf('- [ ] 未完成任务乙')
    expect(resolveStaleTaskToggle(DOC, start, end, false)).toEqual({
      from: start,
      to: end,
      nextText: '[x]',
    })
  })

  it('缩进嵌套的任务项：锚点来自其自身行，校验通过', () => {
    const nested = '- 外层\n  - [ ] 嵌套任务\n'
    const start = nested.indexOf('[')
    expect(resolveStaleTaskToggle(nested, start, start + 3, false)).toEqual({
      from: start,
      to: start + 3,
      nextText: '[x]',
    })
  })

  it('外部行漂移：锚点区间不再是标记 → 放弃（不得改错行）', () => {
    // 场景：点击渲染后外部在该行前插入文本，锚点位置落入其他内容
    const drifted = DOC.replace('- [ ] 未完成任务甲', '- 外部前缀 [ ] 未完成任务甲')
    const { start, end } = markerRangeOf('- [ ] 未完成任务甲')
    // 原锚点位置现在指向 '前缀' 等非标记内容
    expect(resolveStaleTaskToggle(drifted, start, end, false)).toBeNull()
  })

  it('标记字符恰在锚点但所在行已非任务行 → 放弃（严格行校验）', () => {
    // 行漂移后锚点恰好落在普通文本中的 [ ] 字符上：仅字符匹配不够
    const hostile = '文本 [ ] 恰好含有标记形态的普通段落\n'
    expect(resolveStaleTaskToggle(hostile, 3, 6, false)).toBeNull()
  })

  it('外部把任务行改为普通行（标记字符恰在原位但行首非列表）→ 放弃', () => {
    const { start, end } = markerRangeOf('- [ ] 未完成任务甲')
    // '- ' 与 'x ' 等长：锚点区间内仍是 '[ ]' 三字符，字符校验通过；
    // 但行首不再是列表标记——仅字符匹配会把勾选写进普通文本，必须放弃
    const changed = DOC.replace('- [ ] 未完成任务甲', 'x [ ] 未完成任务甲（不再是列表）')
    expect(resolveStaleTaskToggle(changed, start, end, false)).toBeNull()
  })

  it('文档已是目标态 → null（重渲染不新增历史）', () => {
    const { start, end } = markerRangeOf('- [x] 已完成任务')
    expect(resolveStaleTaskToggle(DOC, start, end, false)).toBeNull()
  })

  it('锚点指向的区间在行内偏移（标记移动了位置）→ 放弃', () => {
    // 行仍是任务行，但标记前被插入缩进/字符使锚点不再精确指向 [
    const { start, end } = markerRangeOf('- [ ] 未完成任务甲')
    const shifted = DOC.replace('- [ ] 未完成任务甲', '-   [ ] 未完成任务甲')
    // 行仍匹配任务行；标记实际在 start+2；锚点 start 不精确匹配 → 放弃
    expect(resolveStaleTaskToggle(shifted, start, end, false)).toBeNull()
  })
})
