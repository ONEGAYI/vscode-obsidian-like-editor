// 图形化代码块渲染器注册表契约（工单 #111）：双侧键集一致性、「登记即
// 继承」（假想第二渲染器不引入真实依赖）与管线消费路径。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { RENDERED_FENCE_LABELS, scanFenceSpans } from '../../src/shared/mermaid'
import {
  __registerGraphicRendererForTest,
  graphicRendererFor,
  graphicRendererLanguages,
} from '../../src/webview/graphicRenderers'
import { buildMermaidDecorationRanges, mermaidFencesField } from '../../src/webview/liveMermaid'

describe('注册表一致性', () => {
  it('mermaid 在共享标签表与 webview 管线表双侧登记', () => {
    expect(RENDERED_FENCE_LABELS['mermaid']).toBe('Mermaid')
    expect(graphicRendererLanguages()).toContain('mermaid')
    expect(graphicRendererFor('mermaid')).toBeDefined()
    expect(graphicRendererFor(' mermaid ')).toBeDefined()
    expect(graphicRendererFor('plantuml')).toBeUndefined()
  })

  it('每个 webview 管线语言都有共享标签（卡片头部与弹窗标题依赖）', () => {
    for (const lang of graphicRendererLanguages()) {
      expect(RENDERED_FENCE_LABELS[lang], `${lang} 应有显示名标签`).toBeDefined()
    }
  })
})

describe('登记即继承（假想第二渲染器）', () => {
  it('登记 renderlang 后 live 装饰发射 widget；注销后回落源码', () => {
    const restore = __registerGraphicRendererForTest('renderlang', {
      renderInto: () => undefined,
      renderSvg: async () => ({ ok: true, svg: '<svg></svg>' }),
    })
    const doc = '```renderlang\nX\n```\n'
    const spans = scanFenceSpans(doc.split('\n'), 0)
    expect(spans).toHaveLength(1)
    const state = EditorState.create({ doc, extensions: [mermaidFencesField] })
    const fences = state.field(mermaidFencesField).spans.map((s) => ({ ...s, rendered: true, info: 'renderlang' }))
    const withRenderer = buildMermaidDecorationRanges(EditorSelection.single(100), null, fences)
    expect(withRenderer).toHaveLength(1)
    restore()
    const withoutRenderer = buildMermaidDecorationRanges(EditorSelection.single(100), null, fences)
    expect(withoutRenderer).toHaveLength(0)
  })

  it('未登记管线的语言不发射（共享标签存在但管线缺失 → 源码+卡片降级）', () => {
    const fences = [
      { from: 0, to: 10, char: '`' as const, run: 3, rendered: true, info: 'nostack', code: 'X' },
    ]
    expect(buildMermaidDecorationRanges(EditorSelection.single(100), null, fences)).toHaveLength(0)
  })
})
