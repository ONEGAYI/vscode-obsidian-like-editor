// Mermaid 渲染层契约测试（工单 #60）：懒加载（URI 注入）、渲染缓存（LRU）、
// SVG 插入的 id 唯一性处理、语法错误降级、主题联动重渲染、挂载钩子扫描。
// mermaid 本体在单测中 mock（真实渲染交由浏览器/集成层）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { installLocale } from '../../src/shared/i18n'
import { zhCn } from '../../src/shared/locales/zh-cn'

// #94 起错误占位文案经 t() 取词：装配生产中文包，断言与字典同源
installLocale('zh-cn', zhCn)
import {
  MERMAID_CLASS_NAMES,
  MERMAID_CODE_ATTR,
  MERMAID_STATE_ATTR,
} from '../../src/shared/mermaid'
import {
  __resetMermaidRenderStateForTest,
  __setMermaidApiForTest,
  ensureMermaidApi,
  extractSvgIds,
  mermaidDarkTheme,
  mermaidRenderStats,
  renderMermaidIn,
  renderMermaidInto,
  setMermaidDarkTheme,
  type MermaidApi,
} from '../../src/webview/mermaidRender'

/** mock mermaid API：svg 模板含根 id、内部 id 与引用（模拟真实产物的 id 形态） */
function makeApi(svgFor: (code: string) => string): MermaidApi & { configs: Array<Record<string, unknown>>; rendered: string[] } {
  const state = { configs: [] as Array<Record<string, unknown>>, rendered: [] as string[] }
  return {
    configs: state.configs,
    rendered: state.rendered,
    initialize(config) {
      state.configs.push(config)
    },
    async render(_id, code) {
      state.rendered.push(code)
      return { svg: svgFor(code) }
    },
  }
}

const SAMPLE_SVG = (code: string) =>
  `<svg id="mmd-root" xmlns="http://www.w3.org/2000/svg"><style>#mmd-node rect{fill:#09f}</style>` +
  `<defs><marker id="mmd-arrow" markerWidth="6"></marker></defs>` +
  `<g class="node"><rect id="mmd-node"></rect><text>${code}</text></g>` +
  `<path marker-end="url(#mmd-arrow)" aria-labelledby="mmd-root"></path></svg>`

function makeContainer(code = 'A-->B'): HTMLElement {
  const el = document.createElement('div')
  el.className = MERMAID_CLASS_NAMES.diagram
  el.setAttribute(MERMAID_CODE_ATTR, code)
  el.setAttribute(MERMAID_STATE_ATTR, 'pending')
  document.body.appendChild(el)
  return el
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve()
  }
}

afterEach(() => {
  __resetMermaidRenderStateForTest()
  delete (globalThis as Record<string, unknown>)['__vsidianMermaidUri']
  document.body.textContent = ''
  document.head.querySelectorAll('script').forEach((s) => s.remove())
})

describe('renderMermaidInto：成功渲染与容器状态', () => {
  it('渲染成功：容器内插入 SVG，状态 rendered', async () => {
    __setMermaidApiForTest(makeApi(SAMPLE_SVG))
    const el = makeContainer()
    renderMermaidInto(el, 'graph TD\nA-->B')
    await settle()
    expect(el.getAttribute(MERMAID_STATE_ATTR)).toBe('rendered')
    expect(el.querySelector('svg')).not.toBeNull()
  })

  it('初始化配置：securityLevel=strict、startOnLoad=false、主题随明暗', async () => {
    const api = makeApi(SAMPLE_SVG)
    __setMermaidApiForTest(api)
    renderMermaidInto(makeContainer(), 'A-->B')
    await settle()
    expect(api.configs.length).toBeGreaterThanOrEqual(1)
    const cfg = api.configs[0]! as Record<string, unknown>
    expect(cfg['securityLevel']).toBe('strict')
    expect(cfg['startOnLoad']).toBe(false)
    expect(cfg['theme']).toBe('default')
    setMermaidDarkTheme(true)
    const darkCfg = api.configs[api.configs.length - 1]! as Record<string, unknown>
    expect(darkCfg['theme']).toBe('dark')
  })
})

describe('语法/渲染失败降级', () => {
  it('render 抛错：容器进入 error 态，展示错误信息与源码，不含 SVG', async () => {
    __setMermaidApiForTest({
      initialize() {},
      async render() {
        throw new Error('Parse error on line 2')
      },
    })
    const el = makeContainer()
    renderMermaidInto(el, 'graph TD\n<<bad')
    await settle()
    expect(el.getAttribute(MERMAID_STATE_ATTR)).toBe('error')
    expect(el.classList.contains(MERMAID_CLASS_NAMES.error)).toBe(true)
    expect(el.textContent).toContain('Parse error on line 2')
    expect(el.textContent).toContain('graph TD')
    expect(el.querySelector('svg')).toBeNull()
  })

  it('渲染器不可用（无 API、无 URI）：降级为错误态而非抛出', async () => {
    const el = makeContainer()
    renderMermaidInto(el, 'A-->B')
    await settle()
    expect(el.getAttribute(MERMAID_STATE_ATTR)).toBe('error')
    expect(el.textContent).toContain('A-->B')
  })

  it('失败结果同样缓存：同一坏源码不反复重试 render', async () => {
    let calls = 0
    __setMermaidApiForTest({
      initialize() {},
      async render() {
        calls += 1
        throw new Error('bad')
      },
    })
    renderMermaidInto(makeContainer(), 'bad code')
    await settle()
    renderMermaidInto(makeContainer(), 'bad code')
    await settle()
    expect(calls).toBe(1)
  })
})

describe('按源文本 LRU 缓存', () => {
  it('同源码二次渲染命中缓存（render 只调一次）', async () => {
    const api = makeApi(SAMPLE_SVG)
    __setMermaidApiForTest(api)
    renderMermaidInto(makeContainer(), 'A-->B')
    await settle()
    renderMermaidInto(makeContainer(), 'A-->B')
    await settle()
    expect(api.rendered.filter((c) => c === 'A-->B')).toHaveLength(1)
    expect(mermaidRenderStats.cacheHits).toBeGreaterThanOrEqual(1)
  })

  it('超过上限后最旧条目被淘汰（缓存有界）', async () => {
    __setMermaidApiForTest(makeApi(SAMPLE_SVG))
    const codes = Array.from({ length: 70 }, (_, i) => `A${i}-->B`)
    for (const code of codes) {
      renderMermaidInto(makeContainer(), code)
      await settle()
    }
    expect(mermaidRenderStats.renders).toBe(70)
    // 重渲染最旧的 A0：已被淘汰 → 重新 render（renders 增长）
    renderMermaidInto(makeContainer(), 'A0-->B')
    await settle()
    expect(mermaidRenderStats.renders).toBe(71)
  })
})

describe('SVG id 唯一性：缓存复用的克隆重写', () => {
  it('同一源码插入两个容器：文档内无重复 id，引用同步改写', async () => {
    __setMermaidApiForTest(makeApi(SAMPLE_SVG))
    const a = makeContainer()
    const b = makeContainer()
    renderMermaidInto(a, 'A-->B')
    await settle()
    renderMermaidInto(b, 'A-->B')
    await settle()
    const ids = [
      ...a.querySelectorAll('[id]'),
      ...b.querySelectorAll('[id]'),
    ].map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 引用改写后：marker-end 的 url(#id) 指向自身文档内的现存 id
    for (const path of [...a.querySelectorAll('path'), ...b.querySelectorAll('path')]) {
      const m = /url\(#([\w-]+)\)/.exec(path.getAttribute('marker-end') ?? '')
      expect(m, path.outerHTML).not.toBeNull()
      expect(document.getElementById(m![1]!)).not.toBeNull()
    }
    // aria-labelledby 引用同样改写有效
    for (const el of [...a.querySelectorAll('[aria-labelledby]'), ...b.querySelectorAll('[aria-labelledby]')]) {
      expect(document.getElementById(el.getAttribute('aria-labelledby')!)).not.toBeNull()
    }
  })

  it('多值 id 引用属性（aria-labelledby 双值，D-6）：按空白分词逐段改写，各段指向现存 id', async () => {
    const svgMulti = (code: string) =>
      `<svg id="mmd-root" xmlns="http://www.w3.org/2000/svg">` +
      `<g id="mmd-a"><g id="mmd-b"><text>${code}</text></g></g>` +
      `<path aria-labelledby="mmd-root mmd-a mmd-b"></path></svg>`
    __setMermaidApiForTest(makeApi(svgMulti))
    const a = makeContainer()
    const b = makeContainer()
    renderMermaidInto(a, 'A-->B')
    await settle()
    renderMermaidInto(b, 'A-->B')
    await settle()
    const ids = [
      ...a.querySelectorAll('[id]'),
      ...b.querySelectorAll('[id]'),
    ].map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length) // id 值本身照常改写唯一
    for (const p of [...a.querySelectorAll('[aria-labelledby]'), ...b.querySelectorAll('[aria-labelledby]')]) {
      const refs = (p.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter((s) => s !== '')
      expect(refs, p.outerHTML).toHaveLength(3)
      for (const ref of refs) {
        // 多值引用的每一段都指向文档内现存 id（克隆后不残留旧前缀）
        expect(document.getElementById(ref), p.outerHTML).not.toBeNull()
      }
    }
  })

  it('extractSvgIds：收集 svg 内全部 id 属性值', () => {
    const ids = extractSvgIds(SAMPLE_SVG('x'))
    expect(ids.sort()).toEqual(['mmd-arrow', 'mmd-node', 'mmd-root'])
  })
})

describe('主题联动', () => {
  it('明暗切换：initialize 更新主题、缓存清空、已渲染容器重渲染', async () => {
    const api = makeApi(SAMPLE_SVG)
    __setMermaidApiForTest(api)
    const el = makeContainer()
    renderMermaidInto(el, 'A-->B')
    await settle()
    const firstSvg = el.querySelector('svg')
    expect(mermaidDarkTheme()).toBe(false)
    setMermaidDarkTheme(true)
    await settle()
    expect(mermaidDarkTheme()).toBe(true)
    expect(api.rendered).toHaveLength(2) // 缓存清空后重渲染
    expect(el.querySelector('svg')).not.toBe(firstSvg) // DOM 重建为新实例
    expect(el.getAttribute(MERMAID_STATE_ATTR)).toBe('rendered')
  })

  it('等值切换不动作（无抖动）', async () => {
    const api = makeApi(SAMPLE_SVG)
    __setMermaidApiForTest(api)
    setMermaidDarkTheme(false)
    await settle()
    expect(api.configs).toHaveLength(0)
    expect(api.rendered).toHaveLength(0)
  })

  it('主题切换与在途渲染竞态（D-1）：在途 run 的结果不写旧主题缓存，容器最终为新主题 SVG', async () => {
    // 复现路径：run1 在途时切换主题 → 清缓存并重发 run2 → run1 完成
    // 写回旧主题缓存条目 → run2 命中旧缓存 → 容器永久滞留旧主题。
    // 修复后 run1 的结果按主题代次丢弃，run2 真实以新主题渲染。
    let dark = false
    let releaseFirst: (() => void) | null = null
    const api: MermaidApi = {
      initialize() {},
      render(_id, code) {
        if (!dark) {
          return new Promise((resolve) => {
            releaseFirst = () => resolve({ svg: `<svg id="m"><title>light-${code}</title></svg>` })
          })
        }
        return Promise.resolve({ svg: `<svg id="m"><title>dark-${code}</title></svg>` })
      },
    }
    __setMermaidApiForTest(api)
    const el = makeContainer()
    renderMermaidInto(el, 'A-->B')
    await settle()
    expect(releaseFirst).not.toBeNull() // 旧主题 render 在途
    dark = true
    setMermaidDarkTheme(true) // 在途时切换：清缓存并重发（run2 入队）
    releaseFirst!() // run1 完成：代次已过 → 应用后不写缓存
    await settle(12)
    // run2 未命中旧主题缓存 → 真实以新主题渲染覆盖容器
    expect(el.querySelector('title')?.textContent).toBe('dark-A-->B')
  })
})

describe('挂载钩子：renderMermaidIn 扫描 pending 容器', () => {
  it('仅渲染 pending 容器；已渲染容器不重复渲染', async () => {
    __setMermaidApiForTest(makeApi(SAMPLE_SVG))
    const root = document.createElement('div')
    document.body.appendChild(root)
    const c1 = document.createElement('div')
    c1.className = MERMAID_CLASS_NAMES.diagram
    c1.setAttribute(MERMAID_CODE_ATTR, 'A-->B')
    c1.setAttribute(MERMAID_STATE_ATTR, 'pending')
    const c2 = document.createElement('div')
    c2.className = MERMAID_CLASS_NAMES.diagram
    c2.setAttribute(MERMAID_CODE_ATTR, 'C-->D')
    c2.setAttribute(MERMAID_STATE_ATTR, 'rendered') // 主题刷新前的既有渲染态
    root.append(c1, c2)
    renderMermaidIn(root)
    await settle()
    expect(c1.getAttribute(MERMAID_STATE_ATTR)).toBe('rendered')
    expect(c1.querySelector('svg')).not.toBeNull()
    expect(c2.querySelector('svg')).toBeNull() // 未被重渲染
  })
})

describe('懒加载：URI 注入链路', () => {
  it('存在全局 URI 时向 head 注入 script（真实加载交由浏览器层）', async () => {
    ;(globalThis as Record<string, unknown>)['__vsidianMermaidUri'] = 'https://res.invalid/mermaid.js'
    try {
      void ensureMermaidApi() // jsdom 不装载外部资源：不 await pending 装载承诺
      await settle(2)
      const script = document.head.querySelector<HTMLScriptElement>(
        'script[src="https://res.invalid/mermaid.js"]')
      expect(script).not.toBeNull()
    } finally {
      delete (globalThis as Record<string, unknown>)['__vsidianMermaidUri']
    }
  })

  it('无 URI 且未加载：返回 null 不注入', async () => {
    __resetMermaidRenderStateForTest()
    expect(await ensureMermaidApi()).toBeNull()
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('脚本加载失败后置失败终态：不重复注入 script、后续渲染走降级（D-5）', async () => {
    ;(globalThis as Record<string, unknown>)['__vsidianMermaidUri'] = 'https://res.invalid/mermaid.js'
    try {
      const first = ensureMermaidApi()
      await settle(2)
      const script = document.head.querySelector<HTMLScriptElement>(
        'script[src="https://res.invalid/mermaid.js"]')
      expect(script).not.toBeNull()
      script!.onerror?.(new Event('error') as ErrorEvent)
      expect(await first).toBeNull()
      // 失败后再次请求：置失败终态直接返回 null——不注入第二个 script，
      // 也不产出依赖真实装载的 pending promise（渲染走降级）
      const second = ensureMermaidApi()
      const outcome = await Promise.race([
        second.then((v) => `resolved:${String(v)}`),
        new Promise<string>((r) => setTimeout(() => r('pending'), 50)),
      ])
      expect(outcome).toBe('resolved:null')
      expect(
        document.head.querySelectorAll('script[src="https://res.invalid/mermaid.js"]'),
      ).toHaveLength(1)
    } finally {
      delete (globalThis as Record<string, unknown>)['__vsidianMermaidUri']
    }
  })
})
