// 实时预览 Mermaid 装饰契约测试（工单 #60）：liveMermaid.ts 的围栏表
// StateField 增量维护、跨行块装饰（CM6 约束：StateField 提供）、光标进出
// 显隐切换、frontmatter/伪围栏抑制与装饰实例缓存。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  LiveMermaidWidget,
  mermaidDecorations,
  mermaidFencesField,
  mermaidWidgetDeco,
} from '../../src/webview/liveMermaid'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { MERMAID_CLASS_NAMES } from '../../src/shared/mermaid'

/** 装饰集合直驱：跨行 replace 装饰来自 StateField（CM6 硬约束） */
function buildBlocks(
  text: string,
  anchor: number,
): Array<{ from: number; to: number; cls?: string; widget?: LiveMermaidWidget }> {
  const state = EditorState.create({
    doc: text,
    extensions: [liveDecorationsField, mermaidFencesField, mermaidDecorations],
    selection: EditorSelection.single(anchor),
  })
  const set = state.field(mermaidDecorations)
  const out: Array<{ from: number; to: number; cls?: string; widget?: LiveMermaidWidget }> = []
  set.between(0, text.length, (from, to, value) => {
    const spec = value.spec as { class?: string; widget?: LiveMermaidWidget }
    out.push({ from, to, cls: spec['class'], widget: spec.widget })
  })
  return out.sort((a, b) => a.from - b.from)
}

const DOC = [
  '# 标题',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '',
  '正文段落。',
].join('\n')

const FENCE_FROM = DOC.indexOf('```mermaid')
const FENCE_TO = DOC.lastIndexOf('```') + 3 // 闭围栏行行尾（排他端）

describe('live Mermaid 装饰：显隐切换', () => {
  it('光标在围栏外 → 整块替换为渲染 widget（区间覆盖开闭围栏行）', () => {
    const items = buildBlocks(DOC, 0)
    expect(items).toHaveLength(1)
    expect(items[0]!.from).toBe(FENCE_FROM)
    expect(items[0]!.to).toBe(FENCE_TO)
    expect(items[0]!.widget).toBeInstanceOf(LiveMermaidWidget)
    expect(items[0]!.widget!.code).toBe('graph TD\nA-->B')
  })

  it('光标进入围栏区间（含边界）→ 无替换装饰，源码显形可编辑', () => {
    for (const at of [FENCE_FROM, FENCE_FROM + 8, FENCE_TO - 1]) {
      expect(buildBlocks(DOC, at), `at=${at}`).toHaveLength(0)
    }
  })

  it('多图相邻：光标在第一图内 → 其余图仍渲染', () => {
    const text = [
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      '```mermaid',
      'sequenceDiagram',
      'A->>B: hi',
      '```',
    ].join('\n')
    expect(buildBlocks(text, 5)).toHaveLength(1) // 仅第二图渲染
    // 光标在两图之后的行尾：两图都渲染（位置 0 会触及首图边界显源码）
    expect(buildBlocks(`${text}\n`, text.length + 1)).toHaveLength(2)
  })

  it('非 mermaid 围栏与伪围栏（外层长围栏内/缩进 4）不产出装饰', () => {
    const js = buildBlocks('```js\nlet a\n```', 0)
    expect(js).toHaveLength(0)
    const nested = buildBlocks('````md\n```mermaid\nA-->B\n```\n````', 0)
    expect(nested).toHaveLength(0)
    const indented = buildBlocks('    ```mermaid\n    A-->B\n    ```', 0)
    expect(indented).toHaveLength(0)
  })

  it('frontmatter 内的 mermaid 围栏不渲染（源码降级边界）', () => {
    const text = '---\ntitle: t\n```mermaid\nA-->B\n```\n---\n\n正文'
    expect(buildBlocks(text, text.length)).toHaveLength(0)
  })

  it('未闭合围栏（EOF）不产出（稳定降级为源码）', () => {
    expect(buildBlocks('```mermaid\ngraph TD', 0)).toHaveLength(0)
  })
})

describe('装饰实例缓存与 widget 形态', () => {
  it('同源码的 deco 实例复用（RangeSet.eq 前提）', () => {
    const a = mermaidWidgetDeco('A-->B')
    const b = mermaidWidgetDeco('A-->B')
    expect(a).toBe(b)
  })

  it('widget eq 按源码比较；lineBreaks 为 1（块级视觉行）', () => {
    const w = new LiveMermaidWidget('A-->B')
    expect(w.eq(new LiveMermaidWidget('A-->B'))).toBe(true)
    expect(w.eq(new LiveMermaidWidget('C-->D'))).toBe(false)
    expect(w.lineBreaks).toBe(1)
  })

  it('toDOM 产出稳定类名容器并携带源码 data 属性（渲染入口）', () => {
    const w = new LiveMermaidWidget('graph TD\nA-->B')
    const dom = w.toDOM()
    expect(dom.className).toBe(MERMAID_CLASS_NAMES.diagram)
    expect(dom.getAttribute('data-vsidian-mermaid-code')).toBe('graph TD\nA-->B')
  })
})

describe('围栏表 StateField：文档编辑的增量维护', () => {
  it('编辑围栏内容后围栏表更新（区间与内容跟随）', () => {
    const text = DOC + '\n'
    const state = EditorState.create({ doc: text, extensions: [mermaidFencesField] })
    const before = state.field(mermaidFencesField)
    expect(before).toHaveLength(1)
    // 在围栏内容行插入 "C-->D\n"（源码修改触发重渲染的增量路径）
    const insertAt = text.indexOf('graph TD') + 'graph TD'.length
    const tr = state.update({ changes: { from: insertAt, insert: '\nC-->D' } })
    const after = tr.state.field(mermaidFencesField)
    expect(after).toHaveLength(1)
    expect(after[0]!.to).toBe(before[0]!.to + '\nC-->D'.length)
    expect(after[0]!.code).toBe('graph TD\nC-->D\nA-->B')
  })

  it('删除闭围栏 → 围栏未闭合，装饰退场（源码显形）', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const closeAt = DOC.lastIndexOf('```')
    const tr = state.update({ changes: { from: closeAt, to: closeAt + 3, insert: 'xyz' } })
    // 闭围栏行变成内容行：围栏延伸到 EOF 未闭合 → 不产出
    expect(tr.state.field(mermaidFencesField)).toHaveLength(0)
  })

  it('围栏前的普通编辑：表项坐标映射（不重建误伤）', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const tr = state.update({ changes: { from: 0, insert: '头部\n\n' } })
    const after = tr.state.field(mermaidFencesField)
    expect(after).toHaveLength(1)
    expect(after[0]!.from).toBe(4 + FENCE_FROM)
    expect(after[0]!.code).toBe('graph TD\nA-->B')
  })

  it('围栏外新建围栏：新增围栏被增量扫描捕获', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const tr = state.update({
      changes: { from: DOC.length, insert: '\n```mermaid\nC-->D\n```' },
    })
    const after = tr.state.field(mermaidFencesField)
    expect(after).toHaveLength(2)
    expect(after[1]!.code).toBe('C-->D')
  })

  it('纯选区移动不重扫（表项稳定，装饰字段随选区切换显隐）', () => {
    const state = EditorState.create({ doc: DOC, extensions: [mermaidFencesField] })
    const tr = state.update({ selection: EditorSelection.single(2) })
    expect(tr.state.field(mermaidFencesField)).toBe(state.field(mermaidFencesField))
  })
})
