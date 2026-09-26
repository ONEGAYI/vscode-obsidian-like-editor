// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { selectTableRegion } from '../../src/webview/tableRegionSelection'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

// #94 起文案经 t() 取词：装配生产中文包，断言与字典同源
installLocale('zh-cn', zhCn)

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
    const groups = [...bar.querySelectorAll<HTMLElement>('[role="group"]')]
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['文字', '段落', '插入'])
    expect(groups.map((group) => [...group.querySelectorAll<HTMLElement>('[data-icon]')]
      .map((el) => el.dataset['icon']))).toEqual([
      ['bold', 'italic', 'strikethrough', 'highlight', 'inlineCode', 'clearInline'],
      ['heading', 'bulletList', 'orderedList', 'taskList', 'quote', 'codeBlock'],
      ['link', 'table', 'inlineMath', 'blockMath'],
    ])
    expect(bar.querySelector('[data-icon="strikethrough"]')?.textContent).toBe('')
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

  it('公式按钮复用格式入口；块级公式在表格内禁用', () => {
    const h = setup('公式文字')
    h.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!.click()
    const bar = h.parent.querySelector<HTMLElement>('.vsidian-quick-actions')!
    const inlineMath = bar.querySelector<HTMLButtonElement>('[data-op="inlineMath"]')!
    const blockMath = bar.querySelector<HTMLButtonElement>('[data-op="blockMath"]')!
    expect(inlineMath.getAttribute('aria-label')).toBe(zhCn['format.inlineMath'])
    expect(blockMath.getAttribute('aria-label')).toBe(zhCn['format.blockMath'])
    h.view.dispatch({ selection: { anchor: 0, head: 2 } })
    inlineMath.click()
    expect(h.view.state.doc.toString()).toBe('$公式$文字')
    expect(h.messages.filter((message) => (message as { kind?: string }).kind === 'edit.request')).toHaveLength(1)
    h.controller.dispose()
    h.parent.remove()

    const table = setup('| A | B |\n| --- | --- |\n| x | y |')
    table.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!.click()
    table.view.dispatch({ selection: { anchor: table.view.state.doc.toString().indexOf('x') } })
    expect(table.parent.querySelector<HTMLButtonElement>('[data-op="blockMath"]')!.disabled).toBe(true)
    table.controller.dispose()
    table.parent.remove()
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
    expect(bold.title).toBe(zhCn['format.bold'])
    expect(bold.hasAttribute('aria-description')).toBe(false)
    h.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    expect(bold.disabled).toBe(true)
    bold.click()
    expect(h.view.state.doc.toString()).toBe('文字')
    h.controller.dispose()
    h.parent.remove()
  })

  it('宿主快照与改绑、清空、重置同步操作条提示和正文按键', () => {
    const h = setup('文字')
    h.parent.querySelector<HTMLButtonElement>('.vsidian-quick-toggle')!.click()
    const bold = h.parent.querySelector<HTMLButtonElement>('[data-op="bold"]')!
    const press = (shiftKey = false) => {
      h.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'b', ctrlKey: true, shiftKey, bubbles: true, cancelable: true,
      }))
    }
    const dispatched = () => h.messages.filter((message) =>
      (message as { kind?: string; id?: string }).kind === 'keybindings.execute' &&
      (message as { id?: string }).id === 'bold').length

    h.controller.handleHostMessage({ kind: 'keybindings.snapshot', overrides: {} })
    expect(bold.title).toContain('Ctrl+B')
    press()
    expect(dispatched()).toBe(1)

    h.controller.handleHostMessage({ kind: 'keybindings.changed', overrides: { bold: ['ctrl+shift+b'] } })
    expect(bold.title).toContain('Ctrl+Shift+B')
    expect(bold.title).not.toContain('Ctrl+B)')
    press()
    expect(dispatched()).toBe(1)
    press(true)
    expect(dispatched()).toBe(2)

    h.controller.handleHostMessage({ kind: 'keybindings.changed', overrides: { bold: [] } })
    expect(bold.title).toBe(zhCn['format.bold'])
    expect(bold.hasAttribute('aria-description')).toBe(false)
    press(true)
    expect(dispatched()).toBe(2)

    h.controller.handleHostMessage({ kind: 'keybindings.changed', overrides: {} })
    expect(bold.title).toContain('Ctrl+B')
    press()
    expect(dispatched()).toBe(3)
    h.controller.dispose()
    h.parent.remove()
  })
})
