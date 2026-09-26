// CSS 契约测试共享解析（评审去重）：把 main.css 拆成「选择器 + 声明体」
// 规则块并按选择器后缀查询，消除各契约测试各自维护的同形正则解析——
// 解析口径一处定义，高亮/分割线等契约测试（hrPaintCssContract、
// highlightCssContract）引用此处，避免规则块语义漂移时两处修一漏一。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'

export interface RuleBlock {
  selector: string
  body: string
}

export function readMainCss(): string {
  return readFileSync(path.resolve(process.cwd(), 'src/webview/main.css'), 'utf8')
}

/** 拆出全部顶层简单规则块（选择器 { 声明 }；@规则与嵌套不在契约范围） */
export function cssRuleBlocks(css: string): RuleBlock[] {
  const blocks = css.match(/[^{}]+\{[^{}]*\}/g) ?? []
  return blocks.map((block) => {
    const [selector, body] = block.split('{')
    return { selector: (selector ?? '').trim(), body: body ?? '' }
  })
}

/** 选择器后缀唯一命中的规则块，返回其声明体（含尾 `}`） */
export function cssRule(css: string, selector: string): string {
  const found = cssRuleBlocks(css).filter((b) => b.selector.endsWith(selector))
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!.body
}

/** 选择器全等唯一命中的规则块（后缀匹配会被「body.vscode-light #app」
    这类更specific的覆盖规则干扰时使用），返回其声明体（含尾 `}`） */
export function cssRuleExact(css: string, selector: string): string {
  const found = cssRuleBlocks(css).filter((b) => b.selector === selector)
  expect(found, `CSS 规则 ${selector} 应唯一存在`).toHaveLength(1)
  return found[0]!.body
}
