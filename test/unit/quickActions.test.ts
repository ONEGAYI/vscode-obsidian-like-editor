// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { selectTableRegion } from '../../src/webview/tableRegionSelection'

if (Range.prototype.getClientRects === undefined) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

function setup(text: string, saved: Record<string, unknown> = {}) {
  let state = saved
  const messages: unknown[] = []
  const bridge: VsCodeBridge = {
    postMessage: (message) => messages.push(message),
    getState: <T,>() => state as T,
    setState: (next) => { state = next as Record<string, unknown> },
  }
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const controller = new WebviewSyncController(bridge)
  controller.mount(parent)
  controller.handleHostMessage({ kind: 'init', sessionId: 'quick', docUri: 'file:///quick.md', version: 1, text })
  return { controller, parent, messages, view: controller.getView()!, saved: () => state }
}

describe('快速操作条', () => {
  it('展开占据主编辑区流内位置，并在重开时恢复', () => {
    const h = setup('文字')
    const toggle = h.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!
    const bar = h.parent.querySelector<HTMLElement>('.vsidian-quick-actions')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(h.saved()['quickActionsOpen']).toBe(true)
    expect(bar.previousElementSibling).toBe(h.parent.querySelector('.vsidian-toolbar'))
    expect(bar.nextElementSibling).toBe(h.parent.querySelector('.vsidian-suspend-banner'))
    h.controller.dispose()
    h.parent.remove()
    const reopened = setup('文字', h.saved())
    expect(reopened.parent.querySelector('.vsidian-quick-toggle')?.getAttribute('aria-expanded')).toBe('true')
    reopened.controller.dispose()
    reopened.parent.remove()
  })

  it('常驻清单和 #88 同源；鼠标操作保持明确选区并仅写回一次', () => {
    const h = setup('中文 English')
    h.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!.click()
    const bar = h.parent.querySelector<HTMLElement>('.vsidian-quick-actions')!
    expect([...bar.querySelectorAll<HTMLElement>('[data-op]')].map((el) => el.dataset['op'])).toEqual([
      'bold', 'italic', 'strikethrough', 'inlineCode', 'bulletList', 'orderedList',
      'taskList', 'quote', 'codeBlock', 'link', 'clearInline',
    ])
    h.view.dispatch({ selection: { anchor: 0, head: 2 } })
    const bold = bar.querySelector<HTMLButtonElement>('[data-op="bold"]')!
    bold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    bold.click()
    expect(h.view.state.doc.toString()).toBe('**中文** English')
    expect(h.messages.filter((message) => (message as { kind?: string }).kind === 'edit.request')).toHaveLength(1)
    expect(bold.getAttribute('aria-pressed')).toBe('true')
    h.controller.dispose()
    h.parent.remove()
  })

  it('标题弹出菜单支持键盘选择与 Escape；格区操作走同一格式入口', () => {
    const h = setup('| A | B |\n| --- | --- |\n| x | y |')
    h.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!.click()
    const bar = h.parent.querySelector<HTMLElement>('.vsidian-quick-actions')!
    const heading = bar.querySelector<HTMLButtonElement>('.vsidian-quick-heading')!
    heading.click()
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    const menu = bar.querySelector<HTMLElement>('.vsidian-quick-heading-menu')!
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(heading.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(heading)
    selectTableRegion(h.view, { tableFrom: 0, rowFrom: 0, rowTo: 1, columnFrom: 0, columnTo: 0 })
    bar.querySelector<HTMLButtonElement>('[data-op="bold"]')!.click()
    expect(h.view.state.doc.toString()).toContain('| **A** | B |')
    expect(h.view.state.doc.toString()).toContain('| **x** | y |')
    h.controller.dispose()
    h.parent.remove()
  })

  it('阅读态禁用写操作；提示接入动态有效绑定', () => {
    const h = setup('文字')
    h.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!.click()
    const bold = h.parent.querySelector<HTMLButtonElement>('[data-op="bold"]')!
    h.controller.setQuickActionBindingHints((op) => op === 'bold' ? ['ctrl+shift+b'] : [])
    expect(bold.title).toContain('Ctrl+Shift+B')
    expect(bold.getAttribute('aria-description')).toContain('Ctrl+Shift+B')
    h.controller.setQuickActionBindingHints(() => [])
    expect(bold.title).toBe('粗体')
    expect(bold.hasAttribute('aria-description')).toBe(false)
    h.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(bold.disabled).toBe(true)
    bold.click()
    expect(h.view.state.doc.toString()).toBe('文字')
    h.controller.dispose()
    h.parent.remove()
  })
})
