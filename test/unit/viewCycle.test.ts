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
  nextTriMode,
  planViewSwitch,
  readRememberedMode,
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
    expect(decideResolveBehavior('source')).toBe('bounce-to-source')
  })

  it('记忆 reading：面板 ready 后恢复阅读模式', () => {
    expect(decideResolveBehavior('reading')).toBe('restore-reading')
  })

  it('记忆 live：正常装配（缺省即实时预览）', () => {
    expect(decideResolveBehavior('live')).toBe('assemble-live')
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
    expect(planViewSwitch('live', 'reading', true)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'reading',
    })
    expect(planViewSwitch('reading', 'source', true)).toEqual({
      kind: 'open-in-source-editor',
    })
    expect(planViewSwitch('source', 'live', true)).toEqual({
      kind: 'open-in-vsidian',
      mode: 'live',
    })
  })

  it('从源码编辑器进入 Vsidian 的显式目标：live 与 reading 都经 open-in-vsidian', () => {
    expect(planViewSwitch('source', 'reading', true)).toEqual({
      kind: 'open-in-vsidian',
      mode: 'reading',
    })
  })

  it('面板内显式目标（含跨步与幂等）都映射为 switch-panel-mode', () => {
    expect(planViewSwitch('live', 'source', true)).toEqual({ kind: 'open-in-source-editor' })
    expect(planViewSwitch('reading', 'live', true)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'live',
    })
    expect(planViewSwitch('live', 'live', true)).toEqual({ kind: 'switch-panel-mode', mode: 'live' })
    expect(planViewSwitch('reading', 'reading', true)).toEqual({
      kind: 'switch-panel-mode',
      mode: 'reading',
    })
  })

  it('无 ready 面板时面板内切换被拒绝（panel-not-ready）', () => {
    expect(planViewSwitch('live', 'reading', false)).toEqual({
      kind: 'reject',
      reason: 'panel-not-ready',
    })
  })

  it('source → source 无动作（no-op 拒绝）', () => {
    expect(planViewSwitch('source', 'source', true)).toEqual({
      kind: 'reject',
      reason: 'no-op',
    })
  })
})
