import { describe, expect, it } from 'vitest'
import { KeybindingService } from '../../src/host/keybindingService'

describe('快捷键持久化', () => {
  it('清空跨实例保留，单项重置及全部重置回到缺省', async () => {
    const data = new Map<string, unknown>()
    const storage = { get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { data.set(key, value) } }
    const service = new KeybindingService(storage)
    expect((await service.set('bold', [], false)).ok).toBe(true)
    expect(new KeybindingService(storage).getSnapshot()).toEqual({ bold: [] })
    expect((await service.reset('bold')).ok).toBe(true)
    expect(service.getSnapshot()).toEqual({})
    await service.set('bold', ['ctrl+shift+b'], false)
    expect((await service.resetAll()).ok).toBe(true)
    expect(service.getSnapshot()).toEqual({})
  })

  it('拒绝冲突及写入失败，不广播未落地值', async () => {
    let fail = false
    const storage = { get: <T>() => undefined as T | undefined,
      update: async () => { if (fail) throw new Error('storage') } }
    const service = new KeybindingService(storage)
    const observed: unknown[] = []
    service.onChange((value) => observed.push(value))
    expect(await service.set('italic', ['ctrl+b'], false)).toMatchObject({ ok: false, reason: 'conflict' })
    fail = true
    expect(await service.set('bold', [], false)).toMatchObject({ ok: false, reason: 'storage' })
    expect(observed).toEqual([])
  })

  it('恢复默认发生内部冲突时要求显式替换', async () => {
    const data = new Map<string, unknown>()
    const service = new KeybindingService({
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => { data.set(key, value) },
    })
    expect((await service.set('bold', ['ctrl+i'], true)).ok).toBe(true)
    expect(await service.reset('italic')).toMatchObject({ ok: false, reason: 'conflict' })
    expect(await service.reset('italic', true)).toMatchObject({ ok: true })
    expect(service.getSnapshot()).toEqual({ bold: [] })
  })
})
