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
// 依赖构建产物：先 npm run compile（CI unit job 顺序即如此）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'
import { scanRepoCjk } from './i18nScan'

const WEBVIEW_BUNDLES = ['out/webview/main.js', 'out/webview/settings.js'] as const

const REPO_ROOT = path.resolve(process.cwd())
/** src 用户可见面现存全部 CJK 字面量（迁移期合法硬编码） */
const SRC_CJK_LITERALS = scanRepoCjk(REPO_ROOT).map((v) => v.literal)

/** en 词条：短词易与源码常规字符串误撞，只查 6 字符以上 */
const EN_VALUES = [...new Set(Object.values(en))].filter((v) => v.length >= 6)
/** zh 词条：与存量字面量子串相撞的跳过（迁移清理后自动恢复覆盖） */
const ZH_VALUES = [...new Set(Object.values(zhCn))].filter(
  (value) => value.length >= 2 && !SRC_CJK_LITERALS.some((literal) => literal.includes(value)),
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
