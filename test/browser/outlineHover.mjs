// 大纲悬停视效的原生浏览器回归（#99）：真实布局（Chromium）下用真实
// 悬停驱动验证——条目整行指针光标、悬停行浅一档高亮（located 优先不
// 叠加、悬停互斥单行、移出即恢复）。与 outlineJump.mjs 同装配模式
// （esbuild 打包生产控制器 + 注入页面），located 高亮经点击即时落位。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/outlineHover.js')
await build({ entryPoints: [path.join(root, 'test/browser/outlineHoverFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })

const DOC = [
  '# 甲',
  '甲开篇正文。',
  '## 甲一',
  '甲一正文段落。',
  '### 甲一一',
  '甲一一深层正文。',
  '## 甲二',
  '甲二正文段落。',
  '# 乙',
  '乙开篇正文。',
  '## 乙一',
  '乙一正文段落。',
  '',
].join('\n')
// 条目序列（0 基）：甲0 甲一1 甲一一2 甲二3 乙4 乙一5

/** 从 computed 颜色里取 alpha（兼容 rgba(...) 与 color(srgb ... / a)
 *  两种序列化——color-mix 产物在 Chromium 下输出 color() 函数格式） */
const alphaOf = (color) => {
  const m = /(?:,\s*|\/\s*)([\d.]+)\)$/.exec(color ?? '')
  return m ? Number.parseFloat(m[1]) : 1
}

const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
let passed = 0
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 560 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setContent('<div id="app"></div>')
  await page.addStyleTag({ content: 'html, body { margin: 0; height: 100%; }' })
  await page.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
  await page.addScriptTag({ path: bundle })
  await page.evaluate((text) => window.initOutline(text), DOC)
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
  await page.locator('.vsidian-outline-item').first().waitFor()
  await page.waitForTimeout(120)

  // 前置：点击「乙」（条目 4）——located 即时落位（#66 路径）
  await page.locator('.vsidian-outline-item').nth(4).click()
  let state = await page.evaluate(() => window.readOutline())
  assert.equal(state.locatedIndex, 4, `点击后高亮应在条目 4「乙」（实际 ${state.locatedIndex}）`)

  // ---- 场景 A：条目整行指针光标（点击命中区与光标语义一致）----
  for (const n of [0, 1, 5]) {
    const cursor = await page.evaluate((i) => window.readOutline().cursor(i), n)
    assert.equal(cursor, 'pointer', `条目 ${n} 光标应为 pointer（实际 ${cursor}）`)
  }
  passed++
  console.log('[悬停回归][PASS] 条目整行指针光标（含深层与叶条目）')

  // ---- 场景 B：悬停非 located 条目——浅一档背景（alpha 约 0.07，位于 (0.02, 0.1)）----
  await page.locator('.vsidian-outline-item').nth(0).hover()
  const hoverBg = await page.evaluate(() => window.readOutline().bg(0))
  const hoverAlpha = alphaOf(hoverBg)
  assert(hoverAlpha > 0.02 && hoverAlpha < 0.1,
    `悬停条目背景应为浅一档半透明（alpha≈0.07，实际 ${hoverBg}）`)
  passed++
  console.log('[悬停回归][PASS] 悬停非 located 条目：浅一档背景着色')

  // ---- 场景 C：悬停 located 条目——located 优先不叠加（最多两条、最少一条）----
  const locatedBgBefore = await page.evaluate(() => window.readOutline().bg(4))
  await page.locator('.vsidian-outline-item').nth(4).hover()
  const locatedBgDuring = await page.evaluate(() => window.readOutline().bg(4))
  assert.equal(locatedBgDuring, locatedBgBefore,
    `悬停 located 条目时背景应保持 located 原色（实际 ${locatedBgDuring} ≠ ${locatedBgBefore}）`)
  assert(alphaOf(locatedBgDuring) > 0.1,
    `located 背景应明显深于悬停浅档（实际 ${locatedBgDuring}）`)
  // 悬停互斥：悬停移到条目 4 后，条目 0 的悬停着色应消失（最多一条悬停行）
  const bg0AfterMove = await page.evaluate(() => window.readOutline().bg(0))
  assert.equal(bg0AfterMove, 'rgba(0, 0, 0, 0)',
    `悬停移开后条目 0 应无背景（实际 ${bg0AfterMove}）`)
  passed++
  console.log('[悬停回归][PASS] 悬停 located 条目：located 优先不叠加 + 悬停互斥')

  // ---- 场景 D：移出条目区——悬停着色即恢复透明，located 常驻不受影响 ----
  await page.locator('.vsidian-outline-slider').hover()
  const bg4AfterLeave = await page.evaluate(() => window.readOutline().bg(4))
  assert.equal(bg4AfterLeave, locatedBgBefore,
    `悬停移出后 located 常驻背景应保持（实际 ${bg4AfterLeave}）`)
  passed++
  console.log('[悬停回归][PASS] 移出悬停：located 常驻高亮不受悬停影响')

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[悬停回归] ${passed} 项通过`)
