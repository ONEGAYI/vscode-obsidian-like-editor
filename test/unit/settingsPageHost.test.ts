// 宿主设置页生命周期契约：异步保存完成时，已关闭的 webview 不可再访问。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const vscodeMock = vi.hoisted(() => ({ createWebviewPanel: vi.fn() }))

vi.mock('vscode', () => ({
  window: { createWebviewPanel: vscodeMock.createWebviewPanel },
  ViewColumn: { Active: 1 },
  Uri: { joinPath: (...parts: unknown[]) => parts.join('/') },
}))

import { createSettingsPage } from '../../src/host/settingsPage'

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
})
