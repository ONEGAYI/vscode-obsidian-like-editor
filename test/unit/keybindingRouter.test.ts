// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { KeybindingRouter } from '../../src/webview/keybindingRouter'

function key(key: string, ctrlKey = true): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true })
}

describe('编辑器按键路由', () => {
  it('默认键仅在作用域中截断冒泡并执行，清空后释放旧键', () => {
    const hit = vi.fn()
    const router = new KeybindingRouter({}, hit)
    const out = key('b')
    expect(router.handle(out, 'live', false)).toBe(false)
    expect(out.defaultPrevented).toBe(false)
    const inside = key('b')
    expect(router.handle(inside, 'live', true)).toBe(true)
    expect(inside.defaultPrevented).toBe(true)
    expect(hit).toHaveBeenCalledWith('bold')
    router.update({ bold: [] })
    expect(router.handle(key('b'), 'live', true)).toBe(false)
  })

  it('两段键首段等待，Escape 与模式变化取消', () => {
    const hit = vi.fn()
    const router = new KeybindingRouter({ bold: ['ctrl+k ctrl+b'] }, hit)
    expect(router.handle(key('k'), 'live', true)).toBe(true)
    expect(router.handle(key('Escape', false), 'live', true)).toBe(true)
    expect(router.handle(key('b'), 'live', true)).toBe(false)
    expect(router.handle(key('k'), 'live', true)).toBe(true)
    expect(router.handle(key('b'), 'reading', true)).toBe(false)
    expect(hit).not.toHaveBeenCalled()
    expect(router.handle(key('k'), 'live', true)).toBe(true)
    expect(router.handle(key('b'), 'live', true)).toBe(true)
    expect(hit).toHaveBeenCalledWith('bold')
  })
})
