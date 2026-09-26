// 图形化代码块渲染器注册表（工单 #111，规格 docs/specs/
// graphic-code-block-interaction.md）：webview 侧管线注册表——按钮组、
// 图表弹窗、禁点击进编辑等路径级行为全部读本表驱动，新渲染语言登记
// 即继承全部交互。共享侧 RENDERED_FENCE_LABELS（shared/mermaid.ts）是
// 「哪些语言算渲染型围栏」的判定与标签事实源；本表是「渲染管线在哪」
// 的事实源。两侧键集一致性由契约测试钉住（每键须有标签、每管线须有
// 渲染实现），「登记即继承」由假想第二渲染器用例验证（不引入真实依赖）。
//
// 接入清单（新增图形化渲染语言的三步）：
// 1. shared/mermaid.ts 的 RENDERED_FENCE_LABELS 登记语言显示名；
// 2. 本表登记 { renderInto, renderSvg }（renderInto 负责容器内渲染与
//    降级态，renderSvg 供弹窗/导出取矢量产物，缓存口径与 mermaidRender
//    对齐）；
// 3. 契约测试补一行（test/unit/graphicRenderers.test.ts 的语言枚举）。
// 按钮/弹窗/禁点击/导出自动继承，无需逐处适配。
import {
  renderMermaidInto,
  renderMermaidSvg,
  type MermaidSvgResult,
} from './mermaidRender'

/** 图形化代码块渲染管线（webview 侧能力面） */
export interface GraphicRenderer {
  /** 容器内渲染（含降级态；live widget 内层容器与阅读挂载容器共用） */
  renderInto(container: HTMLElement, code: string): void
  /** 取渲染 SVG 字符串（缓存优先；图表弹窗与导出共用一条取图路径） */
  renderSvg(code: string): Promise<MermaidSvgResult>
}

const mermaidRenderer: GraphicRenderer = {
  renderInto: renderMermaidInto,
  renderSvg: renderMermaidSvg,
}

const registry = new Map<string, GraphicRenderer>([
  ['mermaid', mermaidRenderer],
])

/** 语言（trim 后 info）→ 渲染管线；未登记返回 undefined（调用方降级） */
export function graphicRendererFor(language: string): GraphicRenderer | undefined {
  return registry.get(language.trim())
}

/** 已登记语言清单（观测与契约测试） */
export function graphicRendererLanguages(): readonly string[] {
  return [...registry.keys()]
}

/** 测试钩子：注册假想渲染器验证「登记即继承」（返回清理函数还原） */
export function __registerGraphicRendererForTest(
  language: string,
  renderer: GraphicRenderer,
): () => void {
  registry.set(language, renderer)
  return () => {
    registry.delete(language)
  }
}
