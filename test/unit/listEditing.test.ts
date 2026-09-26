// @vitest-environment jsdom
// 列表/引用 Enter 延续与退格清层的 webview 键位契约（工单 #119）。
//
// 核心断言（用户可观察行为，非实现复述）：
// - Enter：列表/引用行延续完整结构前缀（引用前缀 + 缩进 + 标记；有序
//   +1 保宽、任务重置未勾选），光标落新项正文起点；正文中间回车为
//   分行延续
// - 空项退出：无正文且无子项再按 Enter 删除最内层结构前缀（逐层），
//   还原普通段落；空项带子项不接管（保守交默认）
// - 退格：折叠光标紧邻前缀右端时分层剥除——嵌套先升一级（对齐父项
//   标记列）、顶级一次清整段标记、纯引用逐层剥；任务标记与列表标记
//   是一个单元
// - 不触发：光标在前缀中间、选区、多光标、IME 组合中、表格行、代码
//   围栏内、frontmatter 内——交默认行为
// - 表格上下文优先：与 tableEditing 同装时表格行 Enter 仍是 <br> 语义
// - 单笔事务：一次按键一笔写回，宿主撤销一次完整回原
import { describe, it, expect } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { liveDecorationsField } from '../../src/webview/liveDecorations'
import { mathBlocksField } from '../../src/webview/liveMath'
import { tableEditing } from '../../src/webview/tableEditing'
import { listEditing, continueListMarkup, stripListLayer } from '../../src/webview/listEditing'

if (typeof Range !== 'undefined' && Range.prototype.getClientRects === undefined) {
  ;(Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects =
    () => [] as unknown as DOMRectList
  ;(Range.prototype as unknown as { getBoundingClientRect(): DOMRect }).getBoundingClientRect =
    () => new DOMRect(0, 0, 0, 0)
}

function makeEditView(doc: string, anchor: number, extra: Extension[] = []): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [liveDecorationsField, mathBlocksField, listEditing, ...extra],
      selection: EditorSelection.single(anchor),
    }),
  })
}

const pressEnter = (view: EditorView): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
}
const pressBackspace = (view: EditorView): void => {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
  )
}

/** 按一次键后返回文本与光标（head），并销毁视图 */
function typed(view: EditorView, key: 'Enter' | 'Backspace' = 'Enter'): { text: string; head: number } {
  if (key === 'Enter') {
    pressEnter(view)
  } else {
    pressBackspace(view)
  }
  const out = { text: view.state.doc.toString(), head: view.state.selection.main.head }
  view.destroy()
  return out
}

// ---- Enter：前缀延续 ----

describe('Enter 前缀延续', () => {
  it('无序三族行尾回车延续标记，光标落新项正文起点', () => {
    expect(typed(makeEditView('- item', 6))).toEqual({ text: '- item\n- ', head: 9 })
    expect(typed(makeEditView('* item', 6))).toEqual({ text: '* item\n* ', head: 9 })
    expect(typed(makeEditView('+ item', 6))).toEqual({ text: '+ item\n+ ', head: 9 })
  })

  it('有序延续编号 +1 且保留宽度', () => {
    expect(typed(makeEditView('1. item', 7))).toEqual({ text: '1. item\n2. ', head: 11 })
    expect(typed(makeEditView('01. item', 8))).toEqual({ text: '01. item\n02. ', head: 13 })
    expect(typed(makeEditView('9. item', 7))).toEqual({ text: '9. item\n10. ', head: 12 })
  })

  it('任务项延续固定未勾选', () => {
    expect(typed(makeEditView('- [x] task', 10))).toEqual({ text: '- [x] task\n- [ ] ', head: 17 })
  })

  it('引用行延续引用前缀；嵌套引用原样延续', () => {
    expect(typed(makeEditView('> quote', 7))).toEqual({ text: '> quote\n> ', head: 10 })
    expect(typed(makeEditView('> > quote', 9))).toEqual({ text: '> > quote\n> > ', head: 14 })
  })

  it('引用内列表延续完整结构前缀', () => {
    expect(typed(makeEditView('> - item', 8))).toEqual({ text: '> - item\n> - ', head: 13 })
    expect(typed(makeEditView('> 1. item', 9))).toEqual({ text: '> 1. item\n> 2. ', head: 15 })
  })

  it('嵌套列表行延续保留缩进', () => {
    expect(typed(makeEditView('- p\n  - sub', 10))).toEqual({ text: '- p\n  - su\n  - b', head: 15 })
  })

  it('正文中间回车：分行并延续前缀（光标后内容移到新项）', () => {
    expect(typed(makeEditView('- item', 4))).toEqual({ text: '- it\n- em', head: 7 })
  })

  it('普通段落行回车不接管（返回 false，文本不变）', () => {
    const view = makeEditView('plain text', 5)
    pressEnter(view)
    expect(view.state.doc.toString()).toBe('plain text')
    expect(continueListMarkup(view)).toBe(false)
    view.destroy()
  })

  it('光标在标记中间不接管（有序编号内部）', () => {
    const view = makeEditView('1. item', 1)
    pressEnter(view)
    expect(view.state.doc.toString()).toBe('1. item')
    expect(continueListMarkup(view)).toBe(false)
    view.destroy()
  })

  it('水平线 `- - -` 不被当作列表行延续', () => {
    const view = makeEditView('- - -', 5)
    expect(continueListMarkup(view)).toBe(false)
    view.destroy()
  })
})

// ---- Enter：空项退出 ----

describe('Enter 空项退出', () => {
  it('空无序项再回车删除标记还原普通段落', () => {
    expect(typed(makeEditView('- \nnext', 2))).toEqual({ text: '\nnext', head: 0 })
  })

  it('空有序项与空任务项同样退出', () => {
    expect(typed(makeEditView('1. \nnext', 3))).toEqual({ text: '\nnext', head: 0 })
    expect(typed(makeEditView('- [ ] \nnext', 6))).toEqual({ text: '\nnext', head: 0 })
  })

  it('空引用行退出引用；引用内空列表项先退列表层', () => {
    expect(typed(makeEditView('> \nnext', 2))).toEqual({ text: '\nnext', head: 0 })
    expect(typed(makeEditView('> - \nnext', 4))).toEqual({ text: '> \nnext', head: 2 })
  })

  it('嵌套空引用行逐层退出', () => {
    expect(typed(makeEditView('> > \nnext', 4))).toEqual({ text: '> \nnext', head: 2 })
  })

  it('空项带子项不接管：保守交默认行为', () => {
    const view = makeEditView('- \n  child', 2)
    pressEnter(view)
    expect(view.state.doc.toString()).toBe('- \n  child')
    expect(continueListMarkup(view)).toBe(false)
    view.destroy()
  })
})

// ---- Backspace：退格清层 ----

describe('Backspace 退格清层', () => {
  it('顶级项一次清除整段标记变普通段落', () => {
    expect(typed(makeEditView('- item', 2), 'Backspace')).toEqual({ text: 'item', head: 0 })
    expect(typed(makeEditView('1. item', 3), 'Backspace')).toEqual({ text: 'item', head: 0 })
    expect(typed(makeEditView('  - item', 4), 'Backspace')).toEqual({ text: 'item', head: 0 })
  })

  it('任务标记与列表标记视为一个单元整段清除', () => {
    expect(typed(makeEditView('- [ ] task', 6), 'Backspace')).toEqual({ text: 'task', head: 0 })
    expect(typed(makeEditView('- [x] task', 6), 'Backspace')).toEqual({ text: 'task', head: 0 })
  })

  it('纯引用行剥一层引用', () => {
    expect(typed(makeEditView('> quote', 2), 'Backspace')).toEqual({ text: 'quote', head: 0 })
    expect(typed(makeEditView('> > quote', 4), 'Backspace')).toEqual({ text: '> quote', head: 2 })
  })

  it('引用内列表项清标记保留引用前缀', () => {
    expect(typed(makeEditView('> - item', 4), 'Backspace')).toEqual({ text: '> item', head: 2 })
  })

  it('嵌套项退格升一级：缩进对齐父项标记列', () => {
    expect(typed(makeEditView('- p\n  - c', 8), 'Backspace')).toEqual({ text: '- p\n- c', head: 6 })
  })

  it('三级嵌套逐级上升', () => {
    expect(typed(makeEditView('- a\n  - b\n    - c', 16), 'Backspace')).toEqual({
      text: '- a\n  - b\n  - c', head: 14,
    })
  })

  it('引用内嵌套项升级保留引用前缀', () => {
    expect(typed(makeEditView('> - p\n>   - c', 12), 'Backspace')).toEqual({ text: '> - p\n> - c', head: 10 })
  })

  it('空项退格同样清整段（顶级）', () => {
    expect(typed(makeEditView('- ', 2), 'Backspace')).toEqual({ text: '', head: 0 })
  })
})

// ---- 不触发条件 ----

describe('退格不触发条件（交默认逐字符删除）', () => {
  it('光标在标记中间（有序编号内）不接管', () => {
    const view = makeEditView('1. item', 1)
    expect(stripListLayer(view)).toBe(false)
    view.destroy()
  })

  it('行首（前缀之前）不接管', () => {
    const view = makeEditView('- item', 0)
    expect(stripListLayer(view)).toBe(false)
    view.destroy()
  })

  it('有选区不接管', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '- item',
        extensions: [liveDecorationsField, listEditing],
        selection: EditorSelection.range(2, 5),
      }),
    })
    expect(stripListLayer(view)).toBe(false)
    view.destroy()
  })

  it('多光标不接管', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '- item\n- more',
        extensions: [liveDecorationsField, listEditing, EditorState.allowMultipleSelections.of(true)],
        selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(9)]),
      }),
    })
    pressEnter(view)
    expect(view.state.doc.toString()).toBe('- item\n- more')
    view.destroy()
  })

  it('IME 组合进行中不接管', () => {
    const view = makeEditView('- item', 6)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(continueListMarkup(view)).toBe(false)
    expect(stripListLayer(view)).toBe(false)
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend'))
    view.destroy()
  })

  it('代码围栏内的伪列表行不接管', () => {
    const doc = '```\n- item\n```\n'
    const view = makeEditView(doc, doc.indexOf('item'))
    expect(continueListMarkup(view)).toBe(false)
    expect(stripListLayer(view)).toBe(false)
    view.destroy()
  })

  it('frontmatter 内的伪列表行不接管', () => {
    const doc = '---\n- item\n---\n'
    const view = makeEditView(doc, doc.indexOf('item'))
    expect(continueListMarkup(view)).toBe(false)
    expect(stripListLayer(view)).toBe(false)
    view.destroy()
  })

  it('表格行不接管（列表处理器返回 false）', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const view = makeEditView(doc, doc.indexOf('1') + 1)
    expect(continueListMarkup(view)).toBe(false)
    view.destroy()
  })
})

// ---- 块级公式内不接管（按源码字面编辑） ----

describe('块级公式内不接管', () => {
  it('公式块内的列表形态行 Enter 不延续', () => {
    // `$$` 块内 `- a` 会被 GFM 树解析为真 BulletList（无序可打断段落），
    // 公式源码仍按字面编辑，不做结构语义
    const doc = '$$\n- a\n$$\n'
    const view = makeEditView(doc, doc.indexOf('a') + 1)
    expect(continueListMarkup(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
    view.destroy()
  })

  it('公式块内退格不剥层（返回 false 交默认逐字符删除）', () => {
    const doc = '$$\n- a\n$$\n'
    const view = makeEditView(doc, doc.indexOf('a'))
    expect(stripListLayer(view)).toBe(false)
    expect(view.state.doc.toString()).toBe(doc)
    view.destroy()
  })
})

// ---- 与表格的优先级 ----

describe('表格上下文优先', () => {
  it('与 tableEditing 同装时表格行 Enter 仍写 <br>（不落列表延续）', () => {
    const doc = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    const view = makeEditView(doc, doc.indexOf('1') + 1, [tableEditing])
    pressEnter(view)
    expect(view.state.doc.toString()).toContain('<br>')
    expect(view.state.doc.toString()).not.toContain('2. ')
    view.destroy()
  })
})

// ---- 单笔事务 ----

describe('单笔事务语义', () => {
  it('一次 Enter 只产生一笔文档变更事务（一次撤销整体回退）', () => {
    let docChangedTxs = 0
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '- item',
        extensions: [
          liveDecorationsField,
          listEditing,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) docChangedTxs++
          }),
        ],
        selection: EditorSelection.single(6),
      }),
    })
    pressEnter(view)
    expect(docChangedTxs).toBe(1)
    expect(view.state.doc.toString()).toBe('- item\n- ')
    view.destroy()
  })
})
