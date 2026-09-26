// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { EditorState, StateEffect } from '@codemirror/state'
import { WebviewSyncController, type VsCodeBridge } from '../../src/webview/syncController'
import { FORMAT_OPERATIONS } from '../../src/shared/formatOperations'
import { selectTableRegion } from '../../src/webview/tableRegionSelection'
import type { WebviewToHost } from '../../src/shared/protocol'

if (Range.prototype.getClientRects === undefined) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

function setup(text: string) {
  const sent: WebviewToHost[] = []
  const bridge: VsCodeBridge = {
    postMessage: (message) => sent.push(message as WebviewToHost),
    getState: () => undefined,
    setState: () => undefined,
  }
  const controller = new WebviewSyncController(bridge)
  controller.mount(document.createElement('div'))
  controller.handleHostMessage({ kind: 'init', sessionId: 'format', docUri: 'file:///format.md', version: 1, text })
  return { controller, sent, view: controller.getView()! }
}

describe('格式命令生产链路', () => {
  it('命令面板消息走 CM6 单事务及 edit.request，撤销只需一笔', () => {
    const { controller, sent, view } = setup('中文 English')
    view.dispatch({ selection: { anchor: 1 } })
    controller.handleHostMessage({ kind: 'format.command', op: 'bold' })
    expect(view.state.doc.toString()).toBe('**中文** English')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ kind: 'edit.request', changes: [
      { offset: 0, length: 2, text: '**中文**' },
    ] })
  })

  it('无选区围栏两态切换：包裹后光标在开围栏内侧，再按取消，三按复原', () => {
    const cases = [
      ['bold', '**word**'], ['italic', '*word*'],
      ['strikethrough', '~~word~~'], ['inlineCode', '`word`'],
    ] as const
    for (const [op, wrapped] of cases) {
      const { controller, view } = setup('word')
      view.dispatch({ selection: { anchor: 0 } })
      controller.handleHostMessage({ kind: 'format.command', op })
      expect(view.state.doc.toString()).toBe(wrapped)
      expect(view.state.selection.main.head).toBe(wrapped.indexOf('word'))
      controller.handleHostMessage({ kind: 'format.command', op })
      expect(view.state.doc.toString()).toBe('word')
      controller.handleHostMessage({ kind: 'format.command', op })
      expect(view.state.doc.toString()).toBe(wrapped)
    }
  })

  it('阅读态拒绝写入；源码模式不由格式命令接管', () => {
    const { controller, sent, view } = setup('文字')
    controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
    controller.handleHostMessage({ kind: 'format.command', op: 'bold' })
    expect(view.state.doc.toString()).toBe('文字')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
  })

  it('只读状态与暂停写回状态拒绝格式操作', () => {
    const { controller, sent, view } = setup('文字')
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) })
    controller.handleHostMessage({ kind: 'format.command', op: 'bold' })
    expect(view.state.doc.toString()).toBe('文字')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(0)
    controller.handleHostMessage({ kind: 'session.suspended', version: 1, reason: 'conflict' })
    controller.handleHostMessage({ kind: 'format.command', op: 'italic' })
    expect(view.state.doc.toString()).toBe('文字')
  })

  it('矩形格区经同一命令一次写回两格，其他列不变', () => {
    const table = '| A | B |\n| --- | --- |\n| x | y |'
    const { controller, sent, view } = setup(table)
    selectTableRegion(view, { tableFrom: 0, rowFrom: 0, rowTo: 1, columnFrom: 0, columnTo: 0 })
    controller.handleHostMessage({ kind: 'format.command', op: 'bold' })
    expect(view.state.doc.toString()).toBe('| **A** | B |\n| --- | --- |\n| **x** | y |')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
  })

  it('分割线插入经同一命令链路：单事务写回、光标落行尾（#106）', () => {
    const { controller, sent, view } = setup('上文\n下文')
    view.dispatch({ selection: { anchor: 2 } })
    controller.handleHostMessage({ kind: 'format.command', op: 'horizontalRule' })
    expect(view.state.doc.toString()).toBe('上文\n\n---\n\n下文')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ kind: 'edit.request', changes: [
      { offset: 0, length: 2, text: '上文\n\n---\n' },
    ] })
    expect(view.state.selection.main.anchor).toBe(7)
  })

  it('清单覆盖全部操作，写操作只在 Live，约定默认键位准确', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      contributes: { commands: Array<{ command: string }> }
    }
    for (const item of FORMAT_OPERATIONS) {
      expect(manifest.contributes.commands.some((command) => command.command === item.command)).toBe(true)
      expect(item.mode).toBe('live')
      expect(item.writes).toBe(true)
    }
    const bindings = FORMAT_OPERATIONS.filter((item) => item.defaultKey !== null)
    expect(bindings.map((item) => item.id)).toEqual([
      'bold', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'headingNone',
    ])
  })

  it('行内围栏两态往返：光标在围栏内再触发即取消整段（显式枚举，#105 起含高亮）', () => {
    const cases: ReadonlyArray<[typeof FORMAT_OPERATIONS[number]['id'], string]> = [
      ['bold', '**文字**'],
      ['italic', '*文字*'],
      ['strikethrough', '~~文字~~'],
      ['inlineCode', '`文字`'],
      ['highlight', '==文字=='],
    ]
    for (const [op, text] of cases) {
      const { controller, view } = setup(text)
      view.dispatch({ selection: { anchor: text.indexOf('文字') } })
      controller.handleHostMessage({ kind: 'format.command', op })
      expect(view.state.doc.toString(), `操作 ${op}`).toBe('文字')
      controller.dispose()
    }
  })

  it('高亮命令走 CM6 单事务写回（与 bold 同链路）', () => {
    const { controller, sent, view } = setup('中文 English')
    view.dispatch({ selection: { anchor: 0 } })
    controller.handleHostMessage({ kind: 'format.command', op: 'highlight' })
    expect(view.state.doc.toString()).toBe('==中文== English')
    expect(sent.filter((m) => m.kind === 'edit.request')).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({ kind: 'edit.request', changes: [
      { offset: 0, length: 2, text: '==中文==' },
    ] })
  })
})
