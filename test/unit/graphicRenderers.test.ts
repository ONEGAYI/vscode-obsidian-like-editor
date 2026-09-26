// 图形化代码块渲染器注册表契约（工单 #111）：双侧键集一致性、「登记即
// 继承」（假想第二渲染器不引入真实依赖）与管线消费路径。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import {
  GRAPHIC_LANG_ATTR,
  MERMAID_CODE_ATTR,
  MERMAID_STATE_ATTR,
  RENDERED_FENCE_LABELS,
  scanFenceSpans,
} from '../../src/shared/mermaid'
import {
  __registerGraphicRendererForTest,
  graphicRendererFor,
  graphicRendererLanguages,
  renderGraphicBlockInto,
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

  it('阅读渲染分派走注册表：块容器扫描后代 pending 容器，命中管线即渲染，未登记跳过', () => {
    const calls: Array<{ lang: string; code: string }> = []
    const restore = __registerGraphicRendererForTest('renderlang', {
      renderInto: (el, code) => {
        calls.push({ lang: el.getAttribute(GRAPHIC_LANG_ATTR) ?? '', code })
      },
      renderSvg: async () => ({ ok: true, svg: '<svg></svg>' }),
    })
    // 挂载钩子传入的是块容器，图形容器是其后代（同 renderMermaidIn 扫描语义）
    const block = document.createElement('div')
    const el = document.createElement('div')
    el.setAttribute(GRAPHIC_LANG_ATTR, 'renderlang')
    el.setAttribute(MERMAID_CODE_ATTR, 'X')
    el.setAttribute(MERMAID_STATE_ATTR, 'pending')
    block.appendChild(el)
    renderGraphicBlockInto(block)
    expect(calls).toEqual([{ lang: 'renderlang', code: 'X' }])
    // 共享标签在而管线缺失的语言：不得回落 mermaid 管线误渲（停留降级）；
    // renderlang 容器 mock 下仍为 pending 会被重扫，属扫描语义而非缺陷
    const unknown = document.createElement('div')
    unknown.setAttribute(GRAPHIC_LANG_ATTR, 'nostack')
    unknown.setAttribute(MERMAID_CODE_ATTR, 'X')
    unknown.setAttribute(MERMAID_STATE_ATTR, 'pending')
    block.appendChild(unknown)
    renderGraphicBlockInto(block)
    expect(calls.some((entry) => entry.lang === 'nostack')).toBe(false)
    restore()
  })
})
