// 三态视图编排契约（工单 #38）：
// - 三态循环 live → reading → source → live（命令面板「切换到下一视图模式」）
// - 全局模式记忆（context.globalState，键 onegayi.vsidian.lastMode）：
//   缺省 live（首次打开进实时预览）、非法值容错 live
// - resolve 阶段决策：记忆 source → 弹回原生编辑器；记忆 reading → 等
//   ready 恢复阅读；记忆 live → 正常装配
// - 初始 reading 恢复优先级：面板自身实际状态优先于全局记忆
// - 动作映射：当前模式 + 目标模式 → 动作计划（面板内切模式 / 进入 Vsidian /
//   切到源码编辑器 / 拒绝）
// 纯逻辑测试：不依赖 vscode API，memento 读取器以注入的 getter 模拟
import { describe, it, expect } from 'vitest'
import {
  LAST_MODE_KEY,
  decideReadingRestore,
  decideResolveBehavior,
  isDiffContext,
  isUriInDiffContext,
  nextTriMode,
  parseDiffLabel,
  planViewSwitch,
  readRememberedMode,
  uriBaseName,
} from '../../src/host/viewCycle'

function mementoOf(stored: Record<string, unknown>) {
  return <T>(key: string): T | undefined => stored[key] as T | undefined
}

describe('三态循环（命令面板循环命令的推导依据）', () => {
  it('live → reading → source → live', () => {
    expect(nextTriMode('live')).toBe('reading')
    expect(nextTriMode('reading')).toBe('source')
    expect(nextTriMode('source')).toBe('live')
  })

  it('三步循环回到起点（闭合环）', () => {
    let mode = 'live' as ReturnType<typeof nextTriMode>
    for (let i = 0; i < 3; i++) {
      mode = nextTriMode(mode)
    }
    expect(mode).toBe('live')
  })
})

describe('全局模式记忆读取', () => {
  it('记忆键为 onegayi.vsidian.lastMode', () => {
    expect(LAST_MODE_KEY).toBe('onegayi.vsidian.lastMode')
  })

  it('无历史时缺省 live', () => {
    expect(readRememberedMode(mementoOf({}))).toBe('live')
  })

  it('合法记忆按原值读取', () => {
    expect(readRememberedMode(mementoOf({ [LAST_MODE_KEY]: 'reading' }))).toBe('reading')
    expect(readRememberedMode(mementoOf({ [LAST_MODE_KEY]: 'source' }))).toBe('source')
    expect(readRememberedMode(mementoOf({ [LAST_MODE_KEY]: 'live' }))).toBe('live')
  })

  it('非法值容错为 live', () => {
    expect(readRememberedMode(mementoOf({ [LAST_MODE_KEY]: 'preview' }))).toBe('live')
    expect(readRememberedMode(mementoOf({ [LAST_MODE_KEY]: 42 }))).toBe('live')
  })
})

describe('resolve 阶段决策（记忆 → 装配行为）', () => {
  it('记忆 source：弹回原生编辑器（不装配任何 webview 内容）', () => {
    expect(decideResolveBehavior('source', false)).toBe('bounce-to-source')
  })

  it('记忆 reading：面板 ready 后恢复阅读模式', () => {
    expect(decideResolveBehavior('reading', false)).toBe('restore-reading')
  })

  it('记忆 live：正常装配（缺省即实时预览）', () => {
    expect(decideResolveBehavior('live', false)).toBe('assemble-live')
  })
})

describe('初始 reading 恢复的优先级（面板实际状态 vs 全局记忆）', () => {
  it('全新面板（默认 live）：下发 view.mode.set reading', () => {
    expect(decideReadingRestore('live')).toBe('send-reading')
  })

  it('面板已自恢复 reading（同面板重载等）：保持面板状态，不重复下发', () => {
    expect(decideReadingRestore('reading')).toBe('keep-panel-state')
  })
})

describe('动作映射（planViewSwitch）', () => {
  it('循环三步的动作：面板内切 reading → 切源码编辑器 → 进入 Vsidian live', () => {
    expect(planViewSwitch('live', 'reading', true, false)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'reading',
    })
    expect(planViewSwitch('reading', 'source', true, false)).toEqual({
      kind: 'open-in-source-editor',
    })
    expect(planViewSwitch('source', 'live', true, false)).toEqual({
      kind: 'open-in-vsidian',
      mode: 'live',
    })
  })

  it('从源码编辑器进入 Vsidian 的显式目标：live 与 reading 都经 open-in-vsidian', () => {
    expect(planViewSwitch('source', 'reading', true, false)).toEqual({
      kind: 'open-in-vsidian',
      mode: 'reading',
    })
  })

  it('面板内显式目标（含跨步与幂等）都映射为 switch-panel-mode', () => {
    expect(planViewSwitch('live', 'source', true, false)).toEqual({ kind: 'open-in-source-editor' })
    expect(planViewSwitch('reading', 'live', true, false)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'live',
    })
    expect(planViewSwitch('live', 'live', true, false)).toEqual({ kind: 'switch-panel-mode', mode: 'live' })
    expect(planViewSwitch('reading', 'reading', true, false)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'reading',
    })
  })

  it('无 ready 面板时面板内切换被拒绝（panel-not-ready）', () => {
    expect(planViewSwitch('live', 'reading', false, false)).toEqual({
      kind: 'reject',
      reason: 'panel-not-ready',
    })
  })

  it('source → source 无动作（no-op 拒绝）', () => {
    expect(planViewSwitch('source', 'source', true, false)).toEqual({
      kind: 'reject',
      reason: 'no-op',
    })
  })
})

describe('D10 diff 语境防御：标签解析与 basename', () => {
  it('`a ↔ b` 形态标签解析出两侧；非该形态返回 undefined', () => {
    expect(parseDiffLabel('b.md ↔ a.md')).toEqual({ left: 'b.md', right: 'a.md' })
    expect(parseDiffLabel('普通标签')).toBeUndefined()
    expect(parseDiffLabel('a ↔ ')).toBeUndefined() // 一侧为空不算 diff 标签
    expect(parseDiffLabel('a.md↔b.md')).toBeUndefined() // 无空格分隔不算
  })

  it('uriBaseName 取末段并解码百分号编码（与标签展示名同口径）', () => {
    expect(uriBaseName('file:///d%3A/notes/mode.md')).toBe('mode.md')
    expect(uriBaseName('file:///d%3A/notes/%E7%AC%94%E8%AE%B0.md')).toBe('笔记.md')
    expect(uriBaseName('file:///d%3A/notes/a%20b.md')).toBe('a b.md')
  })
})

describe('D10 diff 语境防御：活动标签判定（isDiffContext）', () => {
  it('文本 diff input（TabInputTextDiff）直接判定为 diff', () => {
    expect(isDiffContext({ inputKind: 'text-diff', label: '随便什么标签' })).toBe(true)
  })

  it('不透明 input + ↔ 标签 + 一侧 basename 匹配 contextUri → diff', () => {
    expect(
      isDiffContext({ inputKind: 'other', label: 'a.md ↔ mode.md', contextUri: 'file:///d%3A/notes/mode.md' }),
    ).toBe(true)
  })

  it('不透明 input + ↔ 标签 + basename 不匹配 contextUri → 非 diff（防误伤）', () => {
    expect(
      isDiffContext({ inputKind: 'other', label: 'a.md ↔ b.md', contextUri: 'file:///d%3A/notes/mode.md' }),
    ).toBe(false)
  })

  it('无 contextUri（命令面板入口）时不透明 + ↔ 标签保守判 diff', () => {
    expect(isDiffContext({ inputKind: 'other', label: 'a.md ↔ b.md' })).toBe(true)
  })

  it('普通 text / custom input 不判 diff（↔ 标签也不误伤）', () => {
    expect(isDiffContext({ inputKind: 'text', label: 'a.md ↔ b.md' })).toBe(false)
    expect(isDiffContext({ inputKind: 'custom', label: 'a.md ↔ b.md' })).toBe(false)
    expect(isDiffContext({ inputKind: 'custom', label: 'mode.md' })).toBe(false)
  })
})

describe('D10 diff 语境防御：弹回跳过（isUriInDiffContext + decideResolveBehavior）', () => {
  it('记忆 source 且本 uri 是某文本 diff 的 original/modified → 跳过弹回正常装配', () => {
    const tabs = [
      { inputKind: 'text-diff' as const, label: 'a.md ↔ mode.md', original: 'file:///d%3A/a.md', modified: 'file:///d%3A/notes/mode.md' },
    ]
    expect(isUriInDiffContext('file:///d%3A/notes/mode.md', tabs)).toBe(true)
    expect(decideResolveBehavior('source', true)).toBe('assemble-live')
  })

  it('记忆 source 且 basename 命中不透明 diff 标签一侧 → 跳过弹回（custom editor 在 diff 侧拿不到 uri）', () => {
    const tabs = [{ inputKind: 'other' as const, label: 'a.md ↔ 笔记.md' }]
    expect(isUriInDiffContext('file:///d%3A/notes/%E7%AC%94%E8%AE%B0.md', tabs)).toBe(true)
  })

  it('记忆 source 且不在任何 diff → 照常弹回', () => {
    const tabs = [
      { inputKind: 'text' as const, label: 'mode.md' },
      { inputKind: 'text-diff' as const, label: 'a.md ↔ b.md', original: 'file:///d%3A/a.md', modified: 'file:///d%3A/b.md' },
    ]
    expect(isUriInDiffContext('file:///d%3A/notes/mode.md', tabs)).toBe(false)
    expect(decideResolveBehavior('source', false)).toBe('bounce-to-source')
  })

  it('非 source 记忆不受 diff 语境影响', () => {
    expect(decideResolveBehavior('reading', true)).toBe('restore-reading')
    expect(decideResolveBehavior('live', true)).toBe('assemble-live')
  })
})

describe('D10 diff 语境防御：三命令拒绝（planViewSwitch）', () => {
  it('diff 语境下任何当前/目标组合都拒绝（diff-context，三命令 no-op）', () => {
    expect(planViewSwitch('live', 'reading', true, true)).toEqual({ kind: 'reject', reason: 'diff-context' })
    expect(planViewSwitch('reading', 'source', true, true)).toEqual({ kind: 'reject', reason: 'diff-context' })
    expect(planViewSwitch('source', 'live', true, true)).toEqual({ kind: 'reject', reason: 'diff-context' })
  })

  it('非 diff 语境不受影响（正常切换路径不变）', () => {
    expect(planViewSwitch('live', 'reading', true, false)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'reading',
    })
    expect(planViewSwitch('source', 'live', true, false)).toEqual({
      kind: 'open-in-vsidian',
      mode: 'live',
    })
  })
})
