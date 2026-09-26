// Mermaid 渲染层（工单 #60）：live widget 与阅读 fence 容器共用的异步渲染
// 管线——懒加载、按源文本 LRU 缓存、SVG 克隆 id 唯一性处理、错误降级与
// 明暗主题联动。
//
// 加载链路（决策记录）：mermaid 不打进主 bundle（约 2.7MB 会让每个 webview
// 启动都付出解析成本），独立产物 out/webview/mermaid.js 由宿主在
// buildWebviewHtml 里经 nonce 内联脚本把资源 URI 写入全局
// __vsidianMermaidUri（webview 无法自行构造 asWebviewUri 前缀）；本文档
// 存在 mermaid 围栏的容器首次渲染时按需注入 <script> 加载（CSP 的
// script-src cspSource 已放行扩展资源脚本）。真实加载行为由浏览器/集成
// 回归验证；单测经 __setMermaidApiForTest 注入 mock。
//
// 渲染路径（设计使然绕过 markdown-it 净化链）：mermaid.render 产出 SVG 字符串
// 后经 DOM API 插入专用容器——SVG 由 mermaid 自产 + securityLevel:'strict'
// （用户文本转义、禁 click 交互）+ webview CSP 三层兜底，不经
// sanitizeReadingDom（其会剥 SVG 内嵌 <style> 导致配色丢失）。围栏内链接
// 点击不做跳转处理（strict 档下以纯文本呈现），见 #60 实施记录。
//
// 缓存与 id 唯一性：渲染结果按源文本 LRU 缓存（同一图滚动往返不重渲染，
// 失败同样缓存避免反复重试）。mermaid SVG 内部携带 id 属性与引用
// （marker/clip/aria 等），同一缓存条目插入多个容器时必须克隆改写——插入
// 时把条目内出现的全部 id 值映射为新的实例 id（属性值与 #引用同步替换，
// 前缀边界判定防误伤），保证文档内 id 唯一、<style> 选择器不串图。
//
// 主题联动：SVG 的主题样式在渲染时烘焙进内嵌 <style>，明暗切换时清空缓存
// 并重渲染当前在文档中的全部容器（live widget 与阅读容器共用同一 data 属性
// 形态，统一扫描）。缓存条目携带主题代次戳（themeGen）：在途渲染完成时若
// 代次已过（渲染期间切换了主题），结果应用到容器但不写缓存——否则后续
// 渲染会命中旧主题缓存条目，容器永久滞留旧主题（主题竞态修复）。
import { MERMAID_CLASS_NAMES, MERMAID_CODE_ATTR, MERMAID_STATE_ATTR } from '../shared/mermaid'
import { t } from '../shared/i18n'

/** mermaid API 面（仅本模块消费的能力；真实实现来自懒加载的全局） */
export interface MermaidApi {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

/** 渲染缓存上限（键是图源码，无上限会随大文档滚动无限累积） */
export const MERMAID_RENDER_CACHE_LIMIT = 64

/** 观测计数（单测断言与性能记录用） */
export const mermaidRenderStats = {
  renders: 0,
  cacheHits: 0,
  errors: 0,
  cloneInserts: 0,
}

type CacheEntry =
  | { kind: 'ok'; svg: string; ids: string[]; gen: number }
  | { kind: 'error'; message: string; gen: number }

let api: MermaidApi | null = null
let loadPromise: Promise<MermaidApi | null> | null = null
/** 注入失败终态：script onerror（或装载后全局缺失）后不再重试注入——
 *  webview 内资源 URI 固定，重注入只会堆积失败 script，渲染统一走降级 */
let loadFailed = false
let initialized = false
let dark = false
/** 主题代次戳：setMermaidDarkTheme 递增；缓存条目记录写入时的代次 */
let themeGen = 0
let renderSeq = 0
let instanceSeq = 0
const cache = new Map<string, CacheEntry>()
/** 渲染串行队列：一屏多图逐个渲染，避免并行 render 的主线程长任务风暴 */
let renderQueue: Promise<unknown> = Promise.resolve()

// ---- 懒加载 ----

function mermaidGlobal(): MermaidApi | null {
  const g = globalThis as { mermaid?: Partial<MermaidApi> }
  const m = g.mermaid
  if (m && typeof m.initialize === 'function' && typeof m.render === 'function') {
    return m as MermaidApi
  }
  return null
}

/** 宿主注入的资源 URI（buildWebviewHtml 的 nonce 内联脚本全局变量） */
export function mermaidUri(): string | null {
  const g = globalThis as { __vsidianMermaidUri?: unknown }
  return typeof g.__vsidianMermaidUri === 'string' && g.__vsidianMermaidUri !== ''
    ? g.__vsidianMermaidUri
    : null
}

function initializeMermaid(): void {
  api?.initialize({
    securityLevel: 'strict',
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
  })
  initialized = true
}

/** 确保 mermaid API 可用：已注入直取；否则按需注入 <script>（真实网络装
 *  载由浏览器环境完成；失败/无 URI 返回 null，调用方降级为错误态）。
 *  注入失败置终态不再重试（资源 URI 固定，重试无意义；渲染降级） */
export function ensureMermaidApi(): Promise<MermaidApi | null> {
  if (api) {
    return Promise.resolve(api)
  }
  const direct = mermaidGlobal()
  if (direct) {
    api = direct
    return Promise.resolve(api)
  }
  if (loadFailed) {
    return Promise.resolve(null)
  }
  if (loadPromise) {
    return loadPromise
  }
  const uri = mermaidUri()
  if (!uri || typeof document === 'undefined') {
    return Promise.resolve(null)
  }
  loadPromise = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = uri
    script.async = true
    script.onload = () => {
      const loaded = mermaidGlobal()
      if (loaded) {
        api = loaded
      } else {
        // 脚本装载完成但全局未挂上（产物内容异常）：同样置终态，
        // 重注入同一 URI 不会改变结果
        loadFailed = true
      }
      loadPromise = null
      resolve(api)
    }
    script.onerror = () => {
      loadFailed = true
      loadPromise = null
      resolve(null)
    }
    document.head.appendChild(script)
  })
  return loadPromise
}

// ---- 缓存与渲染 ----

function evictCache(): void {
  while (cache.size > MERMAID_RENDER_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message
  }
  const m = (e as { message?: unknown } | null | undefined)?.message
  return typeof m === 'string' && m !== '' ? m : String(e)
}

/** 收集 svg 字符串内的全部 id 属性值（克隆改写的映射源） */
export function extractSvgIds(svg: string): string[] {
  const ids = new Set<string>()
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) {
    ids.add(m[1]!)
  }
  return [...ids]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 已知的多值 id 引用属性（属性值是以空白分隔的 id 引用列表，如
 *  aria-labelledby="a b"）——单值的 ="id" 整体替换不命中它们，需按空白
 *  分词逐段改写（mermaid 11.12.2 产物实测仅单值，此处把能力补齐并防
 *  未来版本引入多值形态） */
const MULTI_REF_ATTRS = ['aria-labelledby', 'aria-describedby'] as const

/** 克隆改写：属性值（="id"）与引用（#id，后随非 id 字符为边界）同步替换。
 *  键按长度降序处理，防前缀 id 的引用边界歧义。多值引用属性按空白分词
 *  逐段替换（保持原空白分隔形态）。 */
function rewriteSvgIds(svg: string, mapping: Map<string, string>): string {
  let out = svg
  const keys = [...mapping.keys()].sort((a, b) => b.length - a.length)
  for (const oldId of keys) {
    const newId = mapping.get(oldId)!
    out = out
      .replaceAll(`="${oldId}"`, `="${newId}"`)
      .replace(new RegExp(`#${escapeRegExp(oldId)}(?![\\w-])`, 'g'), `#${newId}`)
  }
  for (const attr of MULTI_REF_ATTRS) {
    out = out.replace(
      new RegExp(`(${attr}=")([^"]*)(")`, 'g'),
      (_m, pre: string, value: string, post: string) =>
        `${pre}${value.split(/(\s+)/).map((tok) => mapping.get(tok) ?? tok).join('')}${post}`,
    )
  }
  return out
}

/** 缓存条目 → DOM：成功插入 SVG 克隆（id 改写），失败构建降级内容 */
function applyEntry(container: HTMLElement, code: string, entry: CacheEntry): void {
  container.textContent = ''
  container.classList.toggle(MERMAID_CLASS_NAMES.error, entry.kind === 'error')
  if (entry.kind === 'error') {
    const message = document.createElement('div')
    message.className = 'vsidian-mermaid-error-message'
    message.setAttribute('role', 'note')
    message.textContent = t('decor.mermaidError', { message: entry.message })
    const source = document.createElement('pre')
    source.className = 'vsidian-mermaid-error-source'
    const codeEl = document.createElement('code')
    codeEl.textContent = code
    source.appendChild(codeEl)
    container.append(message, source)
    container.setAttribute(MERMAID_STATE_ATTR, 'error')
    return
  }
  instanceSeq += 1
  const prefix = `vsidian-mmd-i${instanceSeq}`
  const mapping = new Map(entry.ids.map((oldId, i) => [oldId, `${prefix}-${i}`]))
  const tpl = document.createElement('template')
  tpl.innerHTML = entry.ids.length > 0 ? rewriteSvgIds(entry.svg, mapping) : entry.svg
  container.appendChild(tpl.content)
  mermaidRenderStats.cloneInserts += 1
  container.setAttribute(MERMAID_STATE_ATTR, 'rendered')
}

function applyUnavailable(container: HTMLElement, code: string): void {
  applyEntry(container, code, { kind: 'error', message: t('decor.mermaidUnavailable'), gen: themeGen })
}

/** 串行渲染一个源码（缓存优先；未命中入队 render 并写缓存）。
 *  缓存条目携带主题代次：命中检查对旧代次条目视为未命中；run 完成时
 *  代次已过（渲染期间切了主题）则结果应用到容器但不写缓存——防止
 *  主题切换后的重渲染命中旧主题条目（主题竞态）。 */
function renderCached(target: MermaidApi, code: string): Promise<CacheEntry> {
  const hit = cache.get(code)
  if (hit && hit.gen === themeGen) {
    mermaidRenderStats.cacheHits += 1
    cache.delete(code)
    cache.set(code, hit) // LRU touch
    return Promise.resolve(hit)
  }
  if (hit) {
    cache.delete(code) // 旧代次残留：淘汰后重渲染
  }
  const run = renderQueue.then(async (): Promise<CacheEntry> => {
    const startGen = themeGen
    const again = cache.get(code)
    if (again && again.gen === themeGen) {
      mermaidRenderStats.cacheHits += 1
      return again
    }
    if (!initialized) {
      initializeMermaid()
    }
    renderSeq += 1
    mermaidRenderStats.renders += 1
    try {
      const { svg } = await target.render(`vsidian-mmd-r${renderSeq}`, code)
      const entry: CacheEntry = { kind: 'ok', svg, ids: extractSvgIds(svg), gen: startGen }
      if (startGen === themeGen) {
        cache.set(code, entry)
        evictCache()
      }
      return entry
    } catch (e) {
      mermaidRenderStats.errors += 1
      const entry: CacheEntry = { kind: 'error', message: errorMessage(e), gen: startGen }
      if (startGen === themeGen) {
        cache.set(code, entry)
        evictCache()
      }
      return entry
    }
  })
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 渲染一个容器（live widget toDOM 与阅读挂载钩子共用入口）：
 * 异步装载 → 串行渲染（缓存优先）→ 仍在文档中则应用结果。
 * 容器离开文档（视口回收/CM6 丢弃 widget）时结果只进缓存，不回插。
 */
export function renderMermaidInto(container: HTMLElement, code: string): void {
  container.setAttribute(MERMAID_STATE_ATTR, 'rendering')
  void ensureMermaidApi().then((a) => {
    if (!a) {
      if (container.isConnected) {
        applyUnavailable(container, code)
      }
      return
    }
    return renderCached(a, code).then((entry) => {
      if (!container.isConnected) {
        return
      }
      applyEntry(container, code, entry)
    })
  })
}

/** 阅读块挂载钩子：扫描 root（含自身）内 pending 态容器逐个发起渲染 */
export function renderMermaidIn(root: ParentNode): void {
  if (
    root instanceof HTMLElement &&
    root.getAttribute(MERMAID_STATE_ATTR) === 'pending' &&
    root.getAttribute(MERMAID_CODE_ATTR) !== null
  ) {
    renderMermaidInto(root, root.getAttribute(MERMAID_CODE_ATTR)!)
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${MERMAID_CODE_ATTR}]`))) {
    if (el.getAttribute(MERMAID_STATE_ATTR) === 'pending') {
      renderMermaidInto(el, el.getAttribute(MERMAID_CODE_ATTR)!)
    }
  }
}

/** 取渲染 SVG 字符串（#111 图表弹窗与导出共用）：缓存优先（同源码不
 *  重渲染）、走同一串行队列与主题代次防护；失败返回错误消息。 */
export type MermaidSvgResult = { ok: true; svg: string } | { ok: false; message: string }

export async function renderMermaidSvg(code: string): Promise<MermaidSvgResult> {
  const api = await ensureMermaidApi()
  if (!api) {
    return { ok: false, message: t('decor.mermaidUnavailable') }
  }
  const entry = await renderCached(api, code)
  return entry.kind === 'ok' ? { ok: true, svg: entry.svg } : { ok: false, message: entry.message }
}

/** 主题联动：切换明暗时递增主题代次、以新主题重新 initialize、清空缓存
 *  并重渲染当前在文档中的全部容器（等值跳过；真实切换由
 *  syncController.applyHostTheme 驱动）。 */
export function setMermaidDarkTheme(next: boolean): void {
  if (next === dark) {
    return
  }
  dark = next
  themeGen += 1
  if (api) {
    initializeMermaid()
  } else {
    initialized = false // 尚未装载：首次渲染前以新主题 initialize
  }
  cache.clear()
  if (typeof document === 'undefined') {
    return
  }
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(`.${MERMAID_CLASS_NAMES.diagram}[${MERMAID_CODE_ATTR}]`),
  )) {
    const code = el.getAttribute(MERMAID_CODE_ATTR)
    if (code !== null) {
      renderMermaidInto(el, code)
    }
  }
}

/** 当前主题态观测（测试与探针） */
export function mermaidDarkTheme(): boolean {
  return dark
}

// ---- 测试钩子（仅单测注入 mock 与重置状态用，生产不消费） ----

export function __setMermaidApiForTest(mock: MermaidApi | null): void {
  api = mock
  loadPromise = null
  loadFailed = false
  initialized = false
}

export function __resetMermaidRenderStateForTest(): void {
  api = null
  loadPromise = null
  loadFailed = false
  initialized = false
  dark = false
  themeGen = 0
  renderSeq = 0
  instanceSeq = 0
  renderQueue = Promise.resolve()
  cache.clear()
  mermaidRenderStats.renders = 0
  mermaidRenderStats.cacheHits = 0
  mermaidRenderStats.errors = 0
  mermaidRenderStats.cloneInserts = 0
}
