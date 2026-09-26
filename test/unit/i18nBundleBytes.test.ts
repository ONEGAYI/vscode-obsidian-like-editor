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

/** 还原 esbuild 的 \uXXXX 与 \xNN 转义（R5；R2 复核补 \xNN 形态）：esbuild
 *  默认 charset=ascii，非 ASCII 字节以两种形态进产物——U+0100 及以上用
 *  \uXXXX（含大小写两种十六进制写法，astral 字符拆代理对逐半编码），拉丁-1
 *  区 U+0080–U+00FF 用更短的 \xNN（产物实证存在 \xB7）。zh 词条的
 *  includes 检查必须先还原，否则永不命中（辅检空转）。字符串里的字面
 *  反斜杠编码为 \\，使 \u/\x 前的反斜杠总数成偶——此时 u…/x… 是普通
 *  文本，按奇偶判定不还原（捕获组长度 +1 即总数，组为偶 = 总数为奇 =
 *  真转义） */
function decodeUnicodeEscapes(source: string): string {
  return source.replace(
    /(\\*)\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g,
    (match, slashes: string, uHex: string | undefined, xHex: string | undefined) =>
      slashes.length % 2 === 1
        ? match
        : `${slashes}${String.fromCharCode(parseInt(uHex ?? xHex ?? '', 16))}`,
  )
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
    // R5：比较在转义还原后的产物文本上进行（zh 词条以 \uXXXX 形态、
    // 拉丁-1 区词条以 \xNN 形态进产物，直接 includes 永不命中）；
    // 主检（键属性形态）键为 ASCII，无须还原
    const source = decodeUnicodeEscapes(readBundle(bundle))
    const leaked = LONGEST_MARKERS.filter((value) => source.includes(value))
    expect(
      leaked,
      `webview 产物泄漏语言包词条：${leaked.join(' | ')}`,
    ).toEqual([])
  })

  it('抽查口径可观测：覆盖每个命名空间且含已知长词条', () => {
    // 防呆：辅检标记非空，且 settings 命名空间当前最长的 en 词条在册
    // （#94 落地时该词条是 'Vsidian Settings'，#96 的 generalSection*
    // 更长——期望值与字典同源计算，不随词条增长失真）
    expect(LONGEST_MARKERS.length).toBeGreaterThan(0)
    const longestSettings = Object.entries(en)
      .filter(([key]) => key.startsWith('settings.'))
      .reduce((a, b) => (b[1].length > a[1].length ? b : a))[1]
    expect(LONGEST_MARKERS).toContain(longestSettings)
  })
})

// 负向自证（\xNN 形态补齐的回归防线）：decodeUnicodeEscapes 是辅检的
// 前置能力，直接钉住还原语义与覆盖面——不依赖构建产物，纯函数测试。
describe('decodeUnicodeEscapes 转义还原（辅检前置能力）', () => {
  it('还原 \\xNN（拉丁-1 区）与 \\uXXXX（BMP 区）的单形态、十六进制大小写与混排', () => {
    expect(decodeUnicodeEscapes('\\xB7')).toBe('·') // 产物实证形态（U+00B7）
    expect(decodeUnicodeEscapes('\\xb7')).toBe('·') // 小写十六进制
    expect(decodeUnicodeEscapes('\\xE9\\x41')).toBe('éA') // ASCII 区 \xNN 同语义
    expect(decodeUnicodeEscapes('\\u4e2d\\u6587')).toBe('中文')
    expect(decodeUnicodeEscapes('a\\xB7b\\u4e2dc')).toBe('a·b中c') // 两形态混排
    expect(decodeUnicodeEscapes('\\uD83D\\uDE00')).toBe('😀') // 代理对逐半还原
  })

  it('字面反斜杠（前导斜杠成偶）后的 \\xNN / \\uXXXX 不还原', () => {
    // 产物中的 '\\xB7' 是字面反斜杠 + 普通 xB7 文本，须原样保留
    expect(decodeUnicodeEscapes('\\\\xB7')).toBe('\\\\xB7')
    expect(decodeUnicodeEscapes('\\\\u4e2d')).toBe('\\\\u4e2d')
    // 三个反斜杠 = 字面 '\' + 真转义：字面部分保留，转义部分还原
    expect(decodeUnicodeEscapes('\\\\\\xB7')).toBe('\\\\·')
    expect(decodeUnicodeEscapes('\\\\\\u4e2d')).toBe('\\\\中')
  })

  it('防线：拉丁-1 区（U+0080–U+00FF）词条在 \\xNN 还原能力覆盖内，不静默漏检', () => {
    // 模拟 esbuild charset=ascii 的编码形态：拉丁-1 区用 \xNN（更短），
    // 其余非 ASCII 用 \uXXXX（astral 字符拆代理对逐半编码）
    const esbuildEscape = (text: string): string =>
      Array.from(text)
        .map((ch) => {
          const code = ch.codePointAt(0)!
          if (code >= 0x80 && code <= 0xff) {
            return `\\x${code.toString(16).padStart(2, '0')}`
          }
          if (code >= 0x80) {
            // astral 字符按 UTF-16 code unit 逐半编码（Array.from 按
            // code point 迭代会丢低代理半，不能用于此处）
            let encoded = ''
            for (let i = 0; i < ch.length; i += 1) {
              const u = ch.charCodeAt(i)
              encoded += u >= 0x80 ? `\\u${u.toString(16).padStart(4, '0')}` : ch[i]!
            }
            return encoded
          }
          return ch
        })
        .join('')
    // 现状钉住：当前最长标记集不含拉丁-1 区字符（字典唯一拉丁-1 字符 ·
    // 属 keybindingSettings.modeLiveReading，非其命名空间最长词条）。此
    // 断言失败 = 未来出现拉丁-1 最长标记——此时辅检命中与否由下面的
    // 能力断言保证，并应同步更新本注释中的字典现状描述
    expect(LONGEST_MARKERS.filter((v) => /[\u0080-\u00FF]/.test(v))).toEqual([])
    // 能力钉住：全部最长标记、字典中真实含拉丁-1 的词条与混排样本，经
    // esbuild 形态编码后必须被完整还原——含拉丁-1 的词条未来成为最长
    // 标记时，辅检的 includes 才不会静默空转
    const latin1DictValues = [...new Set([...Object.values(en), ...Object.values(zhCn)])].filter(
      (v) => /[\u0080-\u00FF]/.test(v),
    )
    expect(latin1DictValues.length).toBeGreaterThan(0) // 字典现状：· 在册
    for (const sample of [...LONGEST_MARKERS, ...latin1DictValues, 'café·中文😀']) {
      expect(decodeUnicodeEscapes(esbuildEscape(sample)), `roundtrip 失败：${sample}`).toBe(sample)
    }
  })
})
