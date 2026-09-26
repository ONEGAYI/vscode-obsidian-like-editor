// webview 产物零字典字节断言（#93 i18n 懒加载命门；#94 修订检查口径）：
// main.js / settings.js 不得打包任何语言包内容——字典只允许进入宿主
// bundle（out/extension.js），webview 经数据岛与 locale.changed 获取当前
// 语言包。任一泄漏即懒加载机制被破坏（t() 模块静态 import 字典、或误引
// locales 注册表等结构性回退的信号）。
//
// 检查口径（#94 实证修订；原「任意词条值子串」口径存在两类误报）：
// - 主检【字典键的对象属性形态】：产物出现 `"format.bold":` 这类键后随
//   冒号的形态，只可能来自字典对象本体（静态 import 字典/注册表会把全
//   部键以属性形态带入）。合法键引用不产生该形态：t() 调用点的键是孤立
//   字符串字面量（后随 `)` 或 `,`），数据表里的键在值位
//   （`labelKey: 'outlineMenu.copy'`）。
// - 辅检【每命名空间最长词条抽查】：防键形态之外的搬运（数组/拼接等）。
//   整包 import 必然泄漏全部词条，抽长词足以拦截；长词条在第三方代码与
//   打包注释中的碰撞概率可忽略——短词值子串检查会误报：KaTeX 字体名
//   Main-BoldItalic 撞 en "Italic"、lezer 节点名撞 "Strikethrough"，
//   esbuild 保留注释中的领域词（粗体/无匹配…）撞 zh 短词条。
// 依赖构建产物：先 npm run compile（CI unit job 顺序即如此）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'

const WEBVIEW_BUNDLES = ['out/webview/main.js', 'out/webview/settings.js'] as const

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 主检正则（两形态覆盖未压缩与压缩产物）：
 *  - 未压缩：esbuild 保留 JSDoc，字典属性独占一行（行首缩进 + "key":）；
 *    case 标签（case "kind":）与三元假值臂（cond ? "a" : "b"）的键不在
 *    行首，不误伤——协议消息 kind 与字典键同用点分命名，须区分
 *  - 压缩：属性紧贴 `{` 或 `,`（{"key": / ,"key":），注释全部剥离 */
function keyPropertyRegexes(keys: readonly string[]): RegExp[] {
  const alt = keys.map(escapeRegExp).join('|')
  return [
    new RegExp(`^[ \\t]*["'](?:${alt})["']\\s*:`, 'm'),
    new RegExp(`[{,]\\s*["'](?:${alt})["']\\s*:`),
  ]
}
const KEY_PROPERTY_RES = keyPropertyRegexes(Object.keys(en))

/** src 全文（含注释——esbuild 保留注释进产物，注释里的领域词属合法字节；
 *  排除 src/shared/locales/——字典文件的词条字节合法存在于宿主 bundle） */
function collectSrcText(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) {
      if (path.relative(process.cwd(), file) !== path.join('src', 'shared', 'locales')) {
        collectSrcText(file, out)
      }
    } else if (file.endsWith('.ts')) {
      out.push(readFileSync(file, 'utf8'))
    }
  }
  return out
}
const SRC_TEXT = collectSrcText(path.resolve(process.cwd(), 'src')).join('\n')

/** 每命名空间最长词条（zh/en 各一，>= 6 字符且不在 src 全文中——后者是
 *  注释合法字节，不构成泄漏证据） */
function longestValuesByNamespace(): string[] {
  const byNs = new Map<string, { zh: string; en: string }>()
  for (const key of Object.keys(en)) {
    const ns = key.split('.')[0]!
    const cur = byNs.get(ns) ?? { zh: '', en: '' }
    const zhValue = zhCn[key as keyof typeof zhCn]
    const enValue = en[key as keyof typeof en]
    if (zhValue.length > cur.zh.length) {
      cur.zh = zhValue
    }
    if (enValue.length > cur.en.length) {
      cur.en = enValue
    }
    byNs.set(ns, cur)
  }
  return [...byNs.values()].flatMap((v) => [v.zh, v.en])
    .filter((v) => v.length >= 6 && !SRC_TEXT.includes(v))
}
const LONGEST_MARKERS = longestValuesByNamespace()

function readBundle(bundle: string): string {
  const file = path.resolve(process.cwd(), bundle)
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new Error(`构建产物缺失：${bundle}——先运行 npm run compile 再跑本契约`)
  }
}

describe('webview 构建产物不含字典字节', () => {
  it.for(WEBVIEW_BUNDLES)('%s 不含字典键的属性形态（静态 import 字典/注册表即全键泄漏）', (bundle) => {
    const source = readBundle(bundle)
    for (const re of KEY_PROPERTY_RES) {
      const hit = source.match(re)
      expect(
        hit === null,
        `webview 产物出现字典对象属性形态（懒加载被破坏）：${String(hit?.[0])}`,
      ).toBe(true)
    }
  })

  it.for(WEBVIEW_BUNDLES)('%s 不含各命名空间最长词条（防键形态之外的搬运）', (bundle) => {
    const source = readBundle(bundle)
    const leaked = LONGEST_MARKERS.filter((value) => source.includes(value))
    expect(
      leaked,
      `webview 产物泄漏语言包词条：${leaked.join(' | ')}`,
    ).toEqual([])
  })

  it('抽查口径可观测：覆盖每个命名空间且含已知长词条', () => {
    // 防呆：辅检标记非空，且 settings 命名空间的代表长词条在册
    expect(LONGEST_MARKERS.length).toBeGreaterThan(0)
    expect(LONGEST_MARKERS).toContain('Vsidian Settings')
  })
})
