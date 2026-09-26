// 宿主设置服务契约（#33）：定义注册、快照读取、补丁保存（原子校验 +
// 持久化 overlay）、变更通知。存储抽象为 SettingsStorage（vscode 层用
// context.globalState 实现；globalState 按用户 profile 持久、重启保留，
// 「重启后回读」在单测层以同一 storage 重建服务等价验证，真实重启见
// 人工验证条目）。#95 i18n：注册拒绝原因经 t() 取词——装配 zh-cn 包，
// 断言与字典同源。
import { describe, it, expect } from 'vitest'
import { SettingsService, type SettingsStorage } from '../../src/host/settingsService'
import {
  PRODUCTION_SETTING_DEFINITIONS,
  type SettingDefinition,
} from '../../src/shared/settings'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

installLocale('zh-cn', zhCn)

const FIXTURE_DEFS: readonly SettingDefinition[] = [
  { key: 'editor.lineNumbers', type: 'boolean', default: false, titleKey: 'setting.editorLineNumbers.title' },
  { key: 'editor.spellcheck', type: 'boolean', default: true, titleKey: 'setting.testFlag.title' },
]

/** 假持久层：记录写入，模拟 globalState 语义（update 完成后 get 可见新值） */
function makeStorage(writes: Array<{ key: string; value: unknown }> = []): SettingsStorage & {
  writes: Array<{ key: string; value: unknown }>
  failNext: boolean
} {
  const store = new Map<string, unknown>()
  const storage: SettingsStorage & { writes: typeof writes; failNext: boolean } = {
    writes,
    failNext: false,
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: async (key, value) => {
      if (storage.failNext) {
        storage.failNext = false
        throw new Error('storage unavailable')
      }
      store.set(key, value)
      writes.push({ key, value })
    },
  }
  return storage
}

describe('快照读取', () => {
  it('生产注册表（#34 起）：快照为定义默认值（五开关均开 + 语言 auto）', () => {
    const svc = new SettingsService(makeStorage(), PRODUCTION_SETTING_DEFINITIONS)
    expect(svc.getSnapshot()).toEqual({
      'general.language': 'auto',
      'editor.lineNumbers': true,
      'codeblock.card': true,
      'codeblock.lineNumbers': true,
      'codeblock.copyButton': true,
      'codeblock.highlight': true,
    })
  })

  it('fixture 定义下按默认值产出快照', () => {
    const svc = new SettingsService(makeStorage(), FIXTURE_DEFS)
    expect(svc.getSnapshot()).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': true,
    })
  })
})

describe('补丁保存（apply）', () => {
  it('有效值保存成功并可回读；持久层收到 overlay 写入', async () => {
    const storage = makeStorage()
    const svc = new SettingsService(storage, FIXTURE_DEFS)
    const result = await svc.apply({ 'editor.lineNumbers': true })
    expect(result).toEqual({
      ok: true,
      values: { 'editor.lineNumbers': true, 'editor.spellcheck': true },
    })
    expect(svc.getSnapshot()['editor.lineNumbers']).toBe(true)
    expect(storage.writes).toEqual([
      { key: 'vsidian.settings', value: { 'editor.lineNumbers': true } },
    ])
  })

  it('第二批保存保留第一批的显式值（overlay 合并）', async () => {
    const storage = makeStorage()
    const svc = new SettingsService(storage, FIXTURE_DEFS)
    await svc.apply({ 'editor.lineNumbers': true })
    await svc.apply({ 'editor.spellcheck': false })
    expect(svc.getSnapshot()).toEqual({
      'editor.lineNumbers': true,
      'editor.spellcheck': false,
    })
    expect(storage.writes.at(-1)).toEqual({
      key: 'vsidian.settings',
      value: { 'editor.lineNumbers': true, 'editor.spellcheck': false },
    })
  })

  it('无效值整批拒绝：持久层零写入、快照不变', async () => {
    const storage = makeStorage()
    const svc = new SettingsService(storage, FIXTURE_DEFS)
    const result = await svc.apply({ 'editor.lineNumbers': true, 'editor.spellcheck': 'yes' as never })
    expect(result.ok).toBe(false)
    expect(svc.getSnapshot()).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': true,
    })
    expect(storage.writes).toHaveLength(0)
  })

  it('未知键拒绝', async () => {
    const svc = new SettingsService(makeStorage(), FIXTURE_DEFS)
    const result = await svc.apply({ 'unknown.key': true })
    expect(result.ok).toBe(false)
  })

  it('持久层写入失败：返回失败、不通知变更', async () => {
    const storage = makeStorage()
    const svc = new SettingsService(storage, FIXTURE_DEFS)
    storage.failNext = true
    const notified: unknown[] = []
    svc.onChange((values) => notified.push(values))
    const result = await svc.apply({ 'editor.lineNumbers': true })
    expect(result.ok).toBe(false)
    expect(notified).toHaveLength(0)
    expect(svc.getSnapshot()['editor.lineNumbers']).toBe(false)
  })
})

describe('变更通知（onChange）', () => {
  it('保存成功后以新快照通知全部监听者；取消订阅后不再收到', async () => {
    const svc = new SettingsService(makeStorage(), FIXTURE_DEFS)
    const a: unknown[] = []
    const b: unknown[] = []
    const off = svc.onChange((values) => a.push(values))
    svc.onChange((values) => b.push(values))
    await svc.apply({ 'editor.lineNumbers': true })
    expect(a).toEqual([{ 'editor.lineNumbers': true, 'editor.spellcheck': true }])
    expect(b).toHaveLength(1)
    off()
    await svc.apply({ 'editor.lineNumbers': false })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })

  it('拒绝的保存不通知', async () => {
    const svc = new SettingsService(makeStorage(), FIXTURE_DEFS)
    const seen: unknown[] = []
    svc.onChange((values) => seen.push(values))
    await svc.apply({ 'editor.lineNumbers': 1 as never })
    expect(seen).toHaveLength(0)
  })
})

describe('运行时定义注册（addDefinitions）', () => {
  it('合法定义并入：快照随后含其默认值', () => {
    const svc = new SettingsService(makeStorage(), [])
    const result = svc.addDefinitions(FIXTURE_DEFS)
    expect(result.ok).toBe(true)
    expect(svc.getSnapshot()).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': true,
    })
  })

  it('重复键拒绝且整批不并入（原子）', () => {
    const svc = new SettingsService(makeStorage(), [FIXTURE_DEFS[0]])
    const result = svc.addDefinitions([FIXTURE_DEFS[0], FIXTURE_DEFS[1]])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // 拒绝原因经 t() 取词：与字典 host.duplicateSettingKey 同源
      expect(result.error).toBe(zhCn['host.duplicateSettingKey'].replace('{key}', FIXTURE_DEFS[0].key))
    }
    // 原子：第二批整体未并入
    expect(svc.getSnapshot()).toEqual({ 'editor.lineNumbers': false })
  })

  it('非法定义拒绝（缺字段/类型错误），快照不受影响', () => {
    const svc = new SettingsService(makeStorage(), [])
    expect(svc.addDefinitions([{ key: '', type: 'boolean', default: false, titleKey: 'x' }]).ok).toBe(false)
    expect(svc.addDefinitions([{ key: 'a', type: 'number', default: 1, titleKey: 'x' } as never]).ok).toBe(false)
    expect(svc.getSnapshot()).toEqual({})
  })
})

describe('重启回读等价验证（同一 storage 重建服务）', () => {
  it('保存后以同一 storage 构造新服务：显式值恢复、未设置的键回默认', async () => {
    const storage = makeStorage()
    const first = new SettingsService(storage, FIXTURE_DEFS)
    await first.apply({ 'editor.lineNumbers': true })
    const revived = new SettingsService(storage, FIXTURE_DEFS)
    expect(revived.getSnapshot()).toEqual({
      'editor.lineNumbers': true,
      'editor.spellcheck': true,
    })
  })

  it('存量被外部污染（非法值/未知键）时清洗恢复', async () => {
    const storage = makeStorage()
    await storage.update('vsidian.settings', { 'editor.lineNumbers': 'on', 'legacy.key': true })
    const svc = new SettingsService(storage, FIXTURE_DEFS)
    expect(svc.getSnapshot()).toEqual({
      'editor.lineNumbers': false,
      'editor.spellcheck': true,
    })
  })
})
