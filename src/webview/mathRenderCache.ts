// KaTeX 渲染缓存（#59 评审 C2 抽离的共享模块）：live（liveMath.ts）与
// 阅读（readingMarkdown.ts）两条渲染通道共用同一 LRU——键 = tex +
// displayMode，命中零重算。模块不依赖 CM6/vscode/DOM（两条导入图均可
// 安全引入）；成功与失败的结果同样缓存（同一公式的失败解析只发生一次）。
import katex from 'katex'
import { stripInlineTexTicks } from '../shared/math'

/** 缓存上限：键是用户内容（公式源文），无上限会随大文档滚动无限累积 */
export const MATH_RENDER_CACHE_LIMIT = 512

const renderCache = new Map<string, string | null>()

/** 观测探针（测试与 perf 断言 renders/cacheHits 的差值语义） */
export const mathRenderStats = { renders: 0, cacheHits: 0 }

function lruTouch(cache: Map<string, string | null>, key: string): void {
  const hit = cache.get(key)
  if (hit !== undefined || cache.has(key)) {
    cache.delete(key)
    cache.set(key, hit as string | null)
  }
}

function lruEvict(cache: Map<string, string | null>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}

/**
 * 渲染公式为 KaTeX HTML。失败返回 null（调用方降级为原文）。
 * 行内（displayMode=false）先剥 `` $`1+1`$ `` 形态的首尾反引号（与
 * @vscode/markdown-it-katex 一致，#59 评审 C5：live 与阅读共用本入口，
 * 剥离口径单一事实源在 shared/math.ts）。
 */
export function renderMathHtml(tex: string, displayMode: boolean): string | null {
  const source = displayMode ? tex : stripInlineTexTicks(tex)
  const key = `${displayMode ? 'D' : 'I'}\u0000${source}`
  if (renderCache.has(key)) {
    mathRenderStats.cacheHits += 1
    lruTouch(renderCache, key)
    return renderCache.get(key) ?? null
  }
  let html: string | null
  try {
    html = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      strict: false, // 中文等 Unicode 数学模式字符静默渲染（两视图同口径）
    })
  } catch {
    html = null
  }
  mathRenderStats.renders += 1
  renderCache.set(key, html)
  lruEvict(renderCache, MATH_RENDER_CACHE_LIMIT)
  return html
}
