// webview 产物零字典字节断言（#93 i18n 懒加载命门）：
// main.js / settings.js 不得打包任何语言包词条——字典只允许进入宿主
// bundle（out/extension.js），webview 经数据岛与 locale.changed 获取当前
// 语言包。任一词条泄漏即懒加载机制被破坏（t() 模块静态 import 字典、或
// 误引 locales 注册表等结构性回退的信号）。
//
// 迁移期碰撞豁免（#94/#95 存量清理完成前）：部分词条与仍在源码中的
// 白名单硬编码字面量同文（如 zh 词条是某条存量文案的子串）——bundle 里
// 的这些字节来自存量硬编码而非字典 import，按「词条是 src 某字面量的
// 子串」判定跳过；迁移工单清除存量后豁免自动失效（检查自愈）。整包
// import 必然泄漏全部词条，未豁免词条足以拦截。
//
// #95 起豁免口径再扩两层（词条值与合法 bundle 字节的巧合碰撞）：
// - zh：bundle 保留源码注释，豁免源从「src CJK 字面量集合」扩为「src
//   受扫文件源码全文」——注释中的中文（如「代码块卡片状态（#79）」）
//   是合法字节，不构成字典泄漏证据；
// - en：短词易与依赖标识符 / 字典键名 / 命令 id 相撞（EditorSelection、
//   KaTeX displayMode、settings.groupDisplay、toReading），显式登记。
// 依赖构建产物：先 npm run compile（CI unit job 顺序即如此）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'
import { listScanFiles } from './i18nScan'

const WEBVIEW_BUNDLES = ['out/webview/main.js', 'out/webview/settings.js'] as const

const REPO_ROOT = path.resolve(process.cwd())

/** src 用户可见面受扫文件的源码全文（含注释）：bundle 保留注释字节，源码
 *  内出现的中文（字面量或注释）都不构成字典泄漏证据 */
const SRC_SOURCE_TEXT = listScanFiles(REPO_ROOT)
  .map((rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf8'))
  .join('\n')

/** en 词条显式豁免（值与依赖标识符/键名/命令 id 巧合相撞；逐条附出处） */
const EN_VALUE_EXEMPTIONS = new Map([
  ['Options', 'CM6 依赖的 observeOptions 标识符（bundle 含依赖代码）'],
  ['Editor', 'CM6 EditorSelection 等标识符（bundle 含依赖代码）'],
  ['Display', 'KaTeX displayMode 设置名与 settings.groupDisplay 键名'],
  ['Reading', 'onegayi.vsidian.mode.toReading 命令 id 与键名 modeReading'],
  ['Unbound', '依赖高亮词表的 UnboundLocalError 标识符'],
])

/** en 词条：短词易与源码常规字符串误撞，只查 6 字符以上 */
const EN_VALUES = [...new Set(Object.values(en))].filter(
  (v) => v.length >= 6 && !EN_VALUE_EXEMPTIONS.has(v),
)
/** zh 词条：与 src 源码全文（含注释）子串相撞的跳过（迁移清理后自动恢复覆盖） */
const ZH_VALUES = [...new Set(Object.values(zhCn))].filter(
  (value) => value.length >= 2 && !SRC_SOURCE_TEXT.includes(value),
)

describe('webview 构建产物不含字典字节', () => {
  it.for(WEBVIEW_BUNDLES)('%s 不含任何语言包词条（迁移期豁免除外）', (bundle) => {
    const file = path.resolve(process.cwd(), bundle)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      throw new Error(`构建产物缺失：${bundle}——先运行 npm run compile 再跑本契约`)
    }
    const markers = [...EN_VALUES, ...ZH_VALUES]
    // 契约自身防呆：豁免不应吞掉全部词条（否则检查空转）
    expect(markers.length, '受检词条不得为空').toBeGreaterThan(0)
    const leaked = markers.filter((value) => source.includes(value))
    expect(
      leaked,
      `webview 产物泄漏了语言包词条（懒加载被破坏）：${leaked.join(' | ')}`,
    ).toEqual([])
  })

  it('迁移期豁免口径可观测：受检词条数 = en 长词 + 无存量碰撞的 zh 词条', () => {
    // 防呆：豁免逻辑若失真（如全部 zh 词条被跳过且 en 全是短词），
    // 上一用例的 markers.length 断言兜底；此处固定当前字典的最小覆盖
    expect(EN_VALUES).toContain('Vsidian Settings')
  })
})
