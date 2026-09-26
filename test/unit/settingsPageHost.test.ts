// 宿主设置页生命周期契约：异步保存完成时，已关闭的 webview 不可再访问。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const vscodeMock = vi.hoisted(() => ({ createWebviewPanel: vi.fn(), envLanguage: 'en' }))

vi.mock('vscode', () => ({
  window: { createWebviewPanel: vscodeMock.createWebviewPanel },
  ViewColumn: { Active: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
  // #93：HTML 生成点经 vscode.env.language 解析生效语言（auto 语义）
  env: { language: vscodeMock.envLanguage },
}))

import { createSettingsPage } from '../../src/host/settingsPage'
import { installLocale } from '../../src/shared/i18n'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'

function makePanel() {
  let disposed = false
  let onDispose = () => {}
  const sent: unknown[] = []
  const webview = {
    cspSource: 'vscode-resource:',
    asWebviewUri: () => 'vscode-resource:/settings',
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    postMessage: (message: unknown) => { sent.push(message); return Promise.resolve(true) },
    html: '',
  }
  const panel = {
    title: '',
    get webview() {
      if (disposed) throw new Error('Webview is disposed')
      return webview
    },
    onDidDispose: (callback: () => void) => { onDispose = callback; return { dispose: () => {} } },
    dispose: () => { disposed = true; onDispose() },
    reveal: () => {},
  }
  return { panel, sent }
}

describe('设置页异步回信与面板生命周期', () => {
  beforeEach(() => vscodeMock.createWebviewPanel.mockReset())

  it('保存尚未完成时关闭面板，不访问已释放 webview', async () => {
    const { panel, sent } = makePanel()
    vscodeMock.createWebviewPanel.mockReturnValue(panel)
    let finish!: (value: { ok: true; values: Record<string, boolean> }) => void
    const service = {
      getSnapshot: () => ({ 'test.flag': true }),
      apply: () => new Promise<{ ok: true; values: Record<string, boolean> }>((resolve) => { finish = resolve }),
    }
    const page = createSettingsPage({ extensionUri: 'extension' } as never, service as never,
      { getSnapshot: () => ({}) } as never)
    page.open()
    page.injectMessage({ kind: 'settings.set', values: { 'test.flag': true } })
    page.close()
    finish({ ok: true, values: { 'test.flag': true } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
  })

  it('open() 注入语言数据岛并同步 <html lang>（#93 首帧管线）', () => {
    const { panel } = makePanel()
    vscodeMock.createWebviewPanel.mockReturnValue(panel)
    const service = {
      getSnapshot: () => ({}),
      apply: () => Promise.resolve({ ok: true as const, values: {} }),
    }
    const page = createSettingsPage({ extensionUri: 'extension' } as never, service as never,
      { getSnapshot: () => ({}) } as never)
    page.open()
    // mock env.language 为 en：auto 解析为 en，数据岛与 html lang 同步该语言
    expect(panel.webview.html).toContain('<html lang="en">')
    expect(panel.webview.html).toContain('<script type="application/json" id="vsidian-locale">')
    expect(panel.webview.html).toContain('"lang":"en"')
  })

  it('notifyLocaleChanged：向自身面板发 locale.changed 携完整新包，标题同步新语言（#96）', () => {
    // 宿主装配（真实链路由 provider 先 installHostLocale 再通知；此处直接
    // 模拟两态：zh 开面板 → 切 en）
    installLocale('zh-cn', zhCn)
    const { panel, sent } = makePanel()
    // createWebviewPanel 的第二参即面板标题（真实 API 语义），mock 回填
    vscodeMock.createWebviewPanel.mockImplementation(((_viewType: unknown, title: string) => {
      panel.title = title
      return panel
    }) as never)
    const service = {
      getSnapshot: () => ({}),
      apply: () => Promise.resolve({ ok: true as const, values: {} }),
    }
    const page = createSettingsPage({ extensionUri: 'extension' } as never, service as never,
      { getSnapshot: () => ({}) } as never)
    page.open()
    expect(panel.title).toBe(zhCn['settings.pageTitle'])
    // 宿主换包发生在通知之前（title 取词即时为新语言）
    installLocale('en', en)
    page.notifyLocaleChanged('en')
    expect(sent).toContainEqual({ kind: 'locale.changed', lang: 'en', messages: en })
    expect(panel.title).toBe(en['settings.pageTitle'])
    // 面板未开时 no-op（不抛错；下次 open 按新快照语言生成）
    page.close()
    page.notifyLocaleChanged('zh-cn')
    expect(sent).toHaveLength(1)
  })

  it('settings.get 应答链附带当前语言包（#96 R1：重载装回旧语言被拉正）', () => {
    const fresh = makePanel()
    vscodeMock.createWebviewPanel.mockReturnValue(fresh.panel)
    // 开面板时语言为 en（数据岛随 HTML 固化为 en——重载后装回的即它）
    let snapshot: Record<string, unknown> = { 'general.language': 'en' }
    const service = {
      getSnapshot: () => snapshot,
      apply: () => Promise.resolve({ ok: true as const, values: {} }),
    }
    const page = createSettingsPage({ extensionUri: 'extension' } as never, service as never,
      { getSnapshot: () => ({}) } as never)
    page.open()
    expect(fresh.panel.webview.html).toContain('"lang":"en"')
    // 开面板后语言切到 zh-cn：重载页面装回 en 数据岛、经 settings.get 回线
    snapshot = { 'general.language': 'zh-cn' }
    page.injectMessage({ kind: 'settings.get' })
    const out = fresh.sent
    const snapshotIdx = out.findIndex((m) => (m as { kind?: string }).kind === 'settings.snapshot')
    const localeIdx = out.findIndex((m) => (m as { kind?: string }).kind === 'locale.changed')
    expect(snapshotIdx).toBeGreaterThanOrEqual(0)
    // 校准消息在快照应答之后（页面先回显值再对齐语言，顺序可观测）
    expect(localeIdx).toBeGreaterThan(snapshotIdx)
    expect(out[localeIdx]).toEqual({ kind: 'locale.changed', lang: 'zh-cn', messages: zhCn })
  })
})
