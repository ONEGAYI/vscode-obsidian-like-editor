// @vitest-environment jsdom
// Tab/Shift+Tab 通用行缩进的 webview 键位契约（工单 #120）。
//
// 核心断言（用户可观察行为，非实现复述）：
// - Tab：光标行（无选区）或选区覆盖的各行整行缩进一级，光标/选区随
//   缩进平移；Shift+Tab 反向（至多删一级，不足全删）
// - 列表行缩进量智能对齐父项内容起点（`- ` 2 格、`10. ` 4 格、任务
//   6 格），落点在引用前缀右端；普通行（含纯引用行）单位 2 空格
// - 代码块围栏内同普通行语义（不做列表智能对齐）
// - 表格上下文不接管（返回 false）：单元格导航归 tableEditing，表格
//   边界放行也不缩进表格行（不破坏表格结构）
// - frontmatter、IME 组合中不接管；无可删空白时 Shift+Tab 仍吞键
//   （返回 true，避免焦点逃逸到工作台）
// - 多选区各 range 覆盖行取并集；选区末端恰在行首不含该行（对齐
//   CM6 changeBySelectedLine 口径）
// - 单笔事务：一次按键一笔文档变更事务（一次撤销整体回退）
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { tableEditing } from '../../src/webview/tableEditing'
import {
  indentEditing,
  indentLine,
  dedentLine,
} from '../../src/webview/indentEditing'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

function makeEditView(
  doc: string,
  selection: { anchor: number; head?: number } | number,
  extra: Extension[] = [],
): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const sel = typeof selection === 'number'
    ? EditorSelection.single(selection)
    : EditorSelection.range(selection.anchor, selection.head ?? selection.anchor)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [liveDecorationsField, tableEditing, indentEditing, ...extra],
      selection: sel,
    }),
  })
}

const pressTab = (view: EditorView, shift = false): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }),
  )
}

/** 按一次 Tab/Shift+Tab 后返回文本与主选区，并销毁视图 */
function typed(
  view: EditorView,
  shift = false,
): { text: string; from: number; to: number } {
  pressTab(view, shift)
  const main = view.state.selection.main
  const out = { text: view.state.doc.toString(), from: main.from, to: main.to }
  view.destroy()
  return out
}

// ---- Tab：光标行缩进 ----

describe('Tab 无选区光标行缩进', () => {
  it('普通行：行首插入 2 空格，光标随缩进右移', () => {
    expect(typed(makeEditView('plain text', 6))).toEqual({ text: '  plain text', from: 8, to: 8 })
  })

  it('光标在行首：缩进后光标落在缩进右端', () => {
    expect(typed(makeEditView('plain', 0))).toEqual({ text: '  plain', from: 2, to: 2 })
  })

  it('空行：同样插入 2 空格', () => {
    const doc = 'a\n\nb'
    expect(typed(makeEditView(doc, 2))).toEqual({ text: 'a\n  \nb', from: 4, to: 4 })
  })

  it('列表行：缩进对齐父项内容起点（`- ` 2 格）', () => {
    const doc = '- p\n- c'
    expect(typed(makeEditView(doc, 5))).toEqual({ text: '- p\n  - c', from: 7, to: 7 })
  })

  it('有序宽编号：`10. ` 4 格', () => {
    const doc = '10. p\n11. c'
    expect(typed(makeEditView(doc, 8))).toEqual({ text: '10. p\n    11. c', from: 12, to: 12 })
  })

  it('任务行：`- [ ] ` 6 格', () => {
    const doc = '- [ ] p\n- [ ] c'
    expect(typed(makeEditView(doc, 11))).toEqual({ text: '- [ ] p\n      - [ ] c', from: 17, to: 17 })
  })

  it('引用内列表：缩进落在引用前缀右端', () => {
    const doc = '> - p\n> - c'
    // L2 从 6 起，插入点 8（quote 右端）在光标右侧：光标不动
    expect(typed(makeEditView(doc, 7))).toEqual({ text: '> - p\n>   - c', from: 7, to: 7 })
  })

  it('纯引用行：普通行语义（行首 2 空格）', () => {
    expect(typed(makeEditView('> q', 3))).toEqual({ text: '  > q', from: 5, to: 5 })
  })

  it('代码块围栏内：普通行语义，不做列表智能对齐', () => {
    const doc = '```js\n1. code\n```'
    const at = doc.indexOf('1.') + 1
    expect(typed(makeEditView(doc, at))).toEqual({ text: '```js\n  1. code\n```', from: at + 2, to: at + 2 })
  })

  it('嵌套列表再缩进一级：从 2 格到 4 格', () => {
    const doc = '- p\n  - c'
    expect(typed(makeEditView(doc, 7))).toEqual({ text: '- p\n    - c', from: 9, to: 9 })
  })
})

// ---- Tab：选区多行 ----

describe('Tab 选区多行缩进', () => {
  it('选区覆盖的各行全部缩进，选区随平移', () => {
    const doc = 'a\nb\nc'
    const out = typed(makeEditView(doc, { anchor: 0, head: 3 }))
    expect(out.text).toBe('  a\n  b\nc')
    expect(out.from).toBe(2)
    expect(out.to).toBe(7)
  })

  it('选区末端恰在行首不含该行（对齐 CM6 选区行口径）', () => {
    const doc = 'a\nb\nc'
    const out = typed(makeEditView(doc, { anchor: 0, head: 2 }))
    expect(out.text).toBe('  a\nb\nc')
  })

  it('选区从行中间开始：该行仍整行缩进', () => {
    const doc = 'aaa\nbbb'
    const out = typed(makeEditView(doc, { anchor: 1, head: 5 }))
    expect(out.text).toBe('  aaa\n  bbb')
    expect(out.from).toBe(3)
    expect(out.to).toBe(9)
  })

  it('列表与普通行混选：各行按自身单位缩进', () => {
    const doc = '- item\nplain'
    const out = typed(makeEditView(doc, { anchor: 0, head: 12 }))
    expect(out.text).toBe('  - item\n  plain')
  })

  it('多光标：各 range 覆盖行取并集', () => {
    const doc = 'a\nb\nc\nd'
    const view = makeEditView(doc, 0, [EditorState.allowMultipleSelections.of(true)])
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]),
    })
    pressTab(view)
    expect(view.state.doc.toString()).toBe('  a\nb\n  c\nd')
    expect(view.state.selection.ranges.map((r) => r.head)).toEqual([2, 8])
    view.destroy()
  })
})

// ---- Shift+Tab：反向 ----

describe('Shift+Tab 反向缩进', () => {
  it('普通行删 2 空格，光标左移', () => {
    expect(typed(makeEditView('  plain', 5), true)).toEqual({ text: 'plain', from: 3, to: 3 })
  })

  it('缩进超一级只删一级（4 格 → 2 格）', () => {
    expect(typed(makeEditView('    plain', 7), true)).toEqual({ text: '  plain', from: 5, to: 5 })
  })

  it('列表行删至父项内容对齐列', () => {
    const doc = '- p\n  - c'
    expect(typed(makeEditView(doc, 7), true)).toEqual({ text: '- p\n- c', from: 5, to: 5 })
  })

  it('有序宽编号删 4 格', () => {
    const doc = '10. p\n    11. c'
    expect(typed(makeEditView(doc, 12), true)).toEqual({ text: '10. p\n11. c', from: 8, to: 8 })
  })

  it('引用内列表：删引用前缀右端的缩进', () => {
    const doc = '> - p\n>   - c'
    // 删除 L2 内 [8,10)：光标 9 落在删除区间，坍到区间起点（'-' 前）
    expect(typed(makeEditView(doc, 9), true)).toEqual({ text: '> - p\n> - c', from: 8, to: 8 })
  })

  it('缩进不足一级全删', () => {
    const doc = '- p\n - c'
    expect(typed(makeEditView(doc, 6), true)).toEqual({ text: '- p\n- c', from: 5, to: 5 })
  })

  it('无可删空白：吞键但不产生任何文本与选区变化', () => {
    const view = makeEditView('plain', 2)
    expect(dedentLine(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('plain')
    expect(view.state.selection.main.head).toBe(2)
    view.destroy()
  })

  it('选区多行混合：有缩进的删、无缩进的保持', () => {
    const doc = '  a\nb\n  c'
    const out = typed(makeEditView(doc, { anchor: 0, head: 8 }), true)
    expect(out.text).toBe('a\nb\nc')
    expect(out.from).toBe(0)
    expect(out.to).toBe(4)
  })
})

// ---- 不接管条件 ----

describe('不接管条件（返回 false 交默认）', () => {
  it('表格行：单元格导航归 tableEditing，缩进处理器不接手', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const view = makeEditView(doc, doc.indexOf('1') + 1)
    expect(indentLine(view)).toBe(false)
    expect(dedentLine(view)).toBe(false)
    view.destroy()
  })

  it('表格边界（首格 Shift+Tab 导航放行）：同样不缩进表格行', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const view = makeEditView(doc, doc.indexOf('a') + 1)
    const before = { text: view.state.doc.toString(), head: view.state.selection.main.head }
    pressTab(view, true)
    expect(view.state.doc.toString()).toBe(before.text)
    expect(view.state.selection.main.head).toBe(before.head)
    view.destroy()
  })

  it('选区覆盖表格行：整体不接管（不破坏表格结构）', () => {
    const doc = 'para\n| a | b |\n| --- | --- |\n'
    const view = makeEditView(doc, { anchor: 0, head: doc.length - 1 })
    expect(indentLine(view)).toBe(false)
    view.destroy()
  })

  it('frontmatter 内不接管', () => {
    const doc = '---\ntitle: x\n---\nbody'
    const view = makeEditView(doc, doc.indexOf('title'))
    expect(indentLine(view)).toBe(false)
    view.destroy()
  })

  it('IME 组合进行中不接管', () => {
    const view = makeEditView('plain', 2)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(indentLine(view)).toBe(false)
    expect(dedentLine(view)).toBe(false)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    view.destroy()
  })
})

// ---- 表格优先（完整装配） ----

describe('表格上下文优先', () => {
  it('与 tableEditing 同装时表格内 Tab 是单元格导航（文本零变化）', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const view = makeEditView(doc, doc.indexOf('1') + 1)
    pressTab(view)
    expect(view.state.selection.main.head).toBe(doc.indexOf('2'))
    expect(view.state.doc.toString()).toBe(doc)
    view.destroy()
  })
})

// ---- 单笔事务 ----

describe('单笔事务语义', () => {
  it('一次 Tab 多行缩进只产生一笔文档变更事务', () => {
    let docChangedTxs = 0
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'a\nb\nc',
        extensions: [
          liveDecorationsField,
          indentEditing,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) docChangedTxs++
          }),
        ],
        selection: EditorSelection.range(0, 3),
      }),
    })
    pressTab(view)
    expect(docChangedTxs).toBe(1)
    expect(view.state.doc.toString()).toBe('  a\n  b\nc')
    view.destroy()
  })
})
