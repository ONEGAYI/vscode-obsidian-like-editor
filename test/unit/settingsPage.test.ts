// @vitest-environment jsdom
// 设置页 UI 契约（#33）：页面归属 Vsidian（标题）、空状态（无占位开关）、
// fixture 定义渲染、快照回显、变更上送（settings.set）与权威值恢复
// （宿主拒绝后以 settings.snapshot 回滚显示）。
import { describe, it, expect } from 'vitest'
import {
  SettingsPageView,
  SETTINGS_PAGE_CLASS_NAMES,
} from '../../src/webview/settingsPageView'
import { PRODUCTION_SETTING_DEFINITIONS, type SettingDefinition } from '../../src/shared/settings'

const FIXTURE_DEFS: readonly SettingDefinition[] = [
  {
    key: 'editor.lineNumbers',
    type: 'boolean',
    default: false,
    title: '显示源文件行号',
    description: '在源文件左侧显示行号',
  },
  { key: 'editor.spellcheck', type: 'boolean', default: true, title: '拼写检查' },
]

function makeView(defs: readonly SettingDefinition[]): {
  view: SettingsPageView
  sent: unknown[]
  parent: HTMLElement
} {
  const sent: unknown[] = []
  const view = new SettingsPageView({ postMessage: (m) => sent.push(m) }, defs)
  const parent = document.createElement('div')
  view.mount(parent)
  return { view, sent, parent }
}

describe('页面结构（#33 归属与空状态）', () => {
  it('标题明确归属 Vsidian 设置', () => {
    const { parent } = makeView(FIXTURE_DEFS)
    const title = parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.title}`)
    expect(title?.textContent).toContain('Vsidian')
    expect(title?.textContent).toContain('设置')
  })

  it('空定义表渲染空状态，不出现任何开关（渲染层空状态路径）', () => {
    const { parent } = makeView([])
    const empty = parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.empty}`)
    expect(empty, '应渲染空状态元素').toBeTruthy()
    expect(empty!.textContent).toContain('暂无可配置项')
    expect(parent.querySelectorAll('input')).toHaveLength(0)
    expect(parent.querySelectorAll('button')).toHaveLength(0)
  })

  it('生产注册表（#34 起）渲染真实开关：显示行号、默认勾选', () => {
    // #34：首个实际设置项接入后设置页不再是空状态——注册表追加定义即
    // 出现开关（#33 设计的预期演进），此处以生产定义直测渲染结果
    expect(PRODUCTION_SETTING_DEFINITIONS.length).toBeGreaterThan(0)
    const { parent } = makeView(PRODUCTION_SETTING_DEFINITIONS)
    expect(parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.empty}`)).toBeNull()
    const boxes = parent.querySelectorAll<HTMLInputElement>(
      `input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`,
    )
    expect(boxes).toHaveLength(PRODUCTION_SETTING_DEFINITIONS.length)
    const first = parent.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.itemTitle}`)
    expect(first?.textContent).toBe('显示行号')
    expect(boxes[0]!.checked).toBe(true) // 默认开启
  })
})

describe('定义渲染与快照回显', () => {
  it('fixture 定义渲染为带标题的复选行，默认值生效', () => {
    const { parent } = makeView(FIXTURE_DEFS)
    const items = parent.querySelectorAll(`.${SETTINGS_PAGE_CLASS_NAMES.item}`)
    expect(items).toHaveLength(2)
    const first = items[0]!
    expect(first.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.itemTitle}`)?.textContent)
      .toBe('显示源文件行号')
    expect(first.querySelector(`.${SETTINGS_PAGE_CLASS_NAMES.itemDescription}`)?.textContent)
      .toBe('在源文件左侧显示行号')
    const boxes = parent.querySelectorAll<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)
    expect(boxes[0]!.checked).toBe(false) // 默认 false
    expect(boxes[1]!.checked).toBe(true) // 默认 true
  })

  it('settings.snapshot 回显当前值', () => {
    const { view, parent } = makeView(FIXTURE_DEFS)
    view.handleHostMessage({ kind: 'settings.snapshot', values: { 'editor.lineNumbers': true } })
    const boxes = parent.querySelectorAll<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)
    expect(boxes[0]!.checked).toBe(true)
  })

  it('settings.changed 广播同样刷新回显', () => {
    const { view, parent } = makeView(FIXTURE_DEFS)
    view.handleHostMessage({ kind: 'settings.changed', values: { 'editor.spellcheck': false } })
    const boxes = parent.querySelectorAll<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)
    expect(boxes[1]!.checked).toBe(false)
  })

  it('非法宿主消息整体忽略（不崩溃、不清空已渲染内容）', () => {
    const { view, parent } = makeView(FIXTURE_DEFS)
    view.handleHostMessage({ kind: 'init', sessionId: 's', docUri: 'u', version: 1, text: 'x' })
    view.handleHostMessage({ kind: 'settings.snapshot' }) // 缺 values
    view.handleHostMessage(null)
    view.handleHostMessage('x')
    expect(parent.querySelectorAll(`.${SETTINGS_PAGE_CLASS_NAMES.item}`)).toHaveLength(2)
  })
})

describe('变更上送与权威值恢复', () => {
  it('切换复选框上送 settings.set（键值对）', () => {
    const { view, sent, parent } = makeView(FIXTURE_DEFS)
    view.handleHostMessage({ kind: 'settings.snapshot', values: { 'editor.lineNumbers': false } })
    const box = parent.querySelector<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(sent).toContainEqual({
      kind: 'settings.set',
      values: { 'editor.lineNumbers': true },
    })
  })

  it('宿主拒绝保存（回 settings.snapshot 权威值）后显示回滚', () => {
    const { view, sent, parent } = makeView(FIXTURE_DEFS)
    view.handleHostMessage({ kind: 'settings.snapshot', values: { 'editor.lineNumbers': false } })
    const box = parent.querySelector<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    expect(sent.at(-1)).toEqual({ kind: 'settings.set', values: { 'editor.lineNumbers': true } })
    // 宿主以权威快照响应（保存被拒或另一窗口已改回）：render 重建后以
    // 权威值回滚显示
    view.handleHostMessage({ kind: 'settings.snapshot', values: { 'editor.lineNumbers': false } })
    const revived = parent.querySelector<HTMLInputElement>(`input.${SETTINGS_PAGE_CLASS_NAMES.checkbox}`)!
    expect(revived.checked).toBe(false)
  })
})
