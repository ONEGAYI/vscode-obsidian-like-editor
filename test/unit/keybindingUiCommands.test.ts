// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { WebviewSyncController } from '../../src/webview/syncController'

describe('可绑定的大纲/侧栏操作', () => {
  it('命令入口与可见按钮共享状态，搜索会打开大纲并聚焦输入', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const controller = new WebviewSyncController({ postMessage() {}, getState() {}, setState() {} })
    controller.mount(root)
    controller.handleHostMessage({ kind: 'init', sessionId: 'ui-keys',
      docUri: 'file:///outline.md', version: 1, text: '# 标题\n\n## 子标题\n' })
    controller.handleHostMessage({ kind: 'ui.command', op: 'outlineSearch' })
    expect(root.querySelector('.vsidian-body')?.classList.contains('vsidian-sidebar-open')).toBe(true)
    expect(root.querySelector('.vsidian-sidebar')?.classList.contains('vsidian-outline-active')).toBe(true)
    expect(document.activeElement).toBe(root.querySelector('.vsidian-outline-search'))
    controller.handleHostMessage({ kind: 'ui.command', op: 'outlineCollapseAll' })
    controller.handleHostMessage({ kind: 'ui.command', op: 'outlineExpandAll' })
    controller.handleHostMessage({ kind: 'ui.command', op: 'outlineReset' })
    controller.dispose()
    root.remove()
  })
})
