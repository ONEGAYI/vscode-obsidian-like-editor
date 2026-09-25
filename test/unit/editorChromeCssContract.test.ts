// @vitest-environment jsdom
// 编辑器铬件明暗主题自适应契约：CM6 dark 声明随宿主 body 主题 class
// 动态跟随（mount 初始判定 + MutationObserver 热切换），光标颜色交给
// baseTheme 内建变体（light: caret black / dark: caret white）——不在
// CSS 硬编码颜色（#34 验收决议：深色主题黑底黑光标的根治方式）。
// jsdom 无 CSS 引擎，行为断言走 EditorView.darkTheme facet 实值；
// 另以源文本钉子守住 main.css 不回退到硬编码颜色方案。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import {
  WebviewSyncController,
  isVscodeDarkBody,
  type VsCodeBridge,
} from '../../src/webview/syncController'
import type { WebviewToHost } from '../../src/shared/protocol'

const css = readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')

function makeBridge(): VsCodeBridge {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (m) => sent.push(m as WebviewToHost),
    getState: () => undefined,
    setState: () => undefined,
  }
  return bridge
}

/** MutationObserver 回调在微任务后派发；宏任务必在其后 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

function darkFacet(c: WebviewSyncController): boolean | undefined {
  return c.getView()?.state.facet(EditorView.darkTheme)
}

describe('宿主明暗主题判定（isVscodeDarkBody）', () => {
  function bodyWith(...classes: string[]): HTMLElement {
    const el = document.createElement('body')
    el.classList.add(...classes)
    return el
  }

  it('深色与暗色高对比为暗；浅色与亮色高对比及无标记为亮', () => {
    expect(isVscodeDarkBody(bodyWith('vscode-dark', 'vscode-theme'))).toBe(true)
    expect(isVscodeDarkBody(bodyWith('vscode-high-contrast'))).toBe(true)
    expect(isVscodeDarkBody(bodyWith('vscode-light', 'vscode-theme'))).toBe(false)
    expect(isVscodeDarkBody(bodyWith('vscode-high-contrast-light'))).toBe(false)
    expect(isVscodeDarkBody(bodyWith('vscode-theme'))).toBe(false)
  })
})

describe('CM6 dark 声明随宿主主题热跟随', () => {
  let controller: WebviewSyncController | undefined

  beforeEach(() => {
    document.body.className = ''
    controller = new WebviewSyncController(makeBridge())
    controller.mount(document.createElement('div'))
  })

  afterEach(() => {
    controller?.dispose()
    controller = undefined
    document.body.className = ''
  })

  it('初始无主题 class 时为亮色声明', () => {
    expect(darkFacet(controller!)).toBe(false)
  })

  it('body 加 vscode-dark 后热切换为 dark，移除后回落', async () => {
    document.body.classList.add('vscode-dark')
    await settle()
    expect(darkFacet(controller!)).toBe(true)
    document.body.classList.remove('vscode-dark')
    await settle()
    expect(darkFacet(controller!)).toBe(false)
  })

  it('暗色高对比（vscode-high-contrast）同样激活，亮色高对比不激活', async () => {
    document.body.classList.add('vscode-high-contrast')
    await settle()
    expect(darkFacet(controller!)).toBe(true)
    document.body.classList.replace('vscode-high-contrast', 'vscode-high-contrast-light')
    await settle()
    expect(darkFacet(controller!)).toBe(false)
  })

  it('dispose 后不再跟随主题变化（观察者已断开、view 已销毁）', async () => {
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const c = controller!
    try {
      c.dispose()
      controller = undefined
      expect(disconnectSpy, 'dispose 应断开 body 主题观察者').toHaveBeenCalled()
      expect(c.getView(), 'dispose 后 EditorView 应已销毁').toBeUndefined()
      // 断开后主题变化不应再触发任何跟随（此处仅验证无异常路径）
      document.body.classList.add('vscode-dark')
      await settle()
    } finally {
      disconnectSpy.mockRestore()
    }
  })
})

describe('光标颜色按主题适配（main.css 源文本）', () => {
  it('只允许零宽格隐藏原生光标，其他位置交给 baseTheme 明暗变体', () => {
    expect(css.match(/caret-color\s*:/g)).toHaveLength(1)
    expect(css).toMatch(/#app \.cm-editor \.cm-content:has\(\.vsidian-table-grid-empty-active\)\s*\{\s*caret-color:\s*transparent;/)
    expect(css).toMatch(/\.vsidian-table-grid-empty-active::after[\s\S]*?border-left:\s*1px solid currentColor;/)
    expect(css, '未启用 drawSelection，不应残留 .cm-cursor 颜色规则').not.toMatch(/\.cm-cursor/)
    expect(css, '未启用 drawSelection，不应残留 .cm-selectionBackground 颜色规则')
      .not.toMatch(/\.cm-selectionBackground/)
  })
})
