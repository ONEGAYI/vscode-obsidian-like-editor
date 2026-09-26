// @vitest-environment jsdom
// #95 i18n：分页文案经 t() 取词——装配生产 zh-cn 语言包，断言与字典同源
// （操作名 op.title 仍为注册表存量文案，随编辑器 webview 迁移工单入字典）。
import { describe, expect, it } from 'vitest'
import { KeybindingSettingsSection } from '../../src/webview/keybindingSettings'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

installLocale('zh-cn', zhCn)

describe('快捷键设置页', () => {
  it('按键位搜索录入后仍保留可见名称', () => {
    const section = new KeybindingSettingsSection({ postMessage: () => {} })
    const root = document.createElement('div')
    document.body.append(root)
    section.mount(root)
    const label = root.querySelector<HTMLLabelElement>('.vsidian-keybindings-key-search')
    expect(label?.textContent).toContain(zhCn['keybindingSettings.searchKeyCaption'])
    const input = label!.querySelector<HTMLInputElement>('input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
    expect(root.querySelector('.vsidian-keybindings-key-search')?.textContent)
      .toContain(zhCn['keybindingSettings.searchKeyCaption'])
    expect(root.querySelector<HTMLInputElement>('.vsidian-keybindings-key-search input')?.value).toBe('Ctrl+B')
    root.remove()
  })

  it('显示当前标签、录入两段键、冲突提示与显式替换', () => {
    const sent: unknown[] = []
    const section = new KeybindingSettingsSection({ postMessage: (m) => sent.push(m) })
    const root = document.createElement('div')
    document.body.append(root)
    section.mount(root, 'italic')
    expect(root.querySelector('[data-operation-id="bold"] kbd')?.textContent).toBe('Ctrl+B')
    // 选中添加栏后依次录入 Ctrl+B：与粗体默认键冲突，暂不发保存。
    const row = root.querySelector<HTMLElement>('[data-operation-id="italic"]')!
    const input = row.querySelector<HTMLInputElement>('.vsidian-keybindings-editor input')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }))
    row.querySelector<HTMLButtonElement>('.vsidian-keybindings-editor button')!.click()
    expect(root.querySelector('.vsidian-keybindings-conflict')?.textContent).toContain('粗体')
    expect(sent).toEqual([])
    root.querySelector<HTMLButtonElement>('.vsidian-keybindings-conflict button')!.click()
    expect(sent).toMatchObject([{ kind: 'keybindings.set', id: 'italic', bindings: ['ctrl+i', 'ctrl+b'], replaceConflicts: true }])
    root.remove()
  })

  it('清空和重置发送独立请求并回显明确未绑定', () => {
    const sent: unknown[] = []
    const section = new KeybindingSettingsSection({ postMessage: (m) => sent.push(m) })
    const root = document.createElement('div')
    document.body.append(root)
    section.mount(root)
    const bold = root.querySelector<HTMLElement>('[data-operation-id="bold"]')!
    bold.querySelectorAll<HTMLButtonElement>('.vsidian-keybindings-actions button')[1].click()
    expect(sent[0]).toMatchObject({ kind: 'keybindings.set', id: 'bold', bindings: [] })
    section.handleHostMessage({ kind: 'keybindings.changed', overrides: { bold: [] }, requestId: 1, ok: true })
    expect(root.querySelector('[data-operation-id="bold"] .vsidian-keybindings-unbound')?.textContent)
      .toBe(zhCn['keybindingSettings.unbound'])
    root.querySelector<HTMLElement>('[data-operation-id="bold"]')!
      .querySelectorAll<HTMLButtonElement>('.vsidian-keybindings-actions button')[2].click()
    expect(sent[1]).toMatchObject({ kind: 'keybindings.reset', id: 'bold' })
    root.remove()
  })
})
