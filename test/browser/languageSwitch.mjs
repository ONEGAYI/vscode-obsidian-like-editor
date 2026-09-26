// #96 语言切换即生效的真实浏览器集成：原生下拉操作 → 宿主回发
// settings.changed + locale.changed → webview 原子换包并重渲染常驻文本。
// 断言全部落在用户可见文本与 <html lang>（视觉层断言纪律）：
// - 切换 zh↔en 后页面标题、分组导航、auto 选项显示名变化
// - 语言自名不自译：en 语言下「简体中文」选项保持原样
// - <html lang> 随生效语言同步
// 语言包从 src/shared/locales 同源构建（断言与字典一致，不复制字面量）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/languageSwitch.js')
await build({ entryPoints: [path.join(root, 'src/webview/settingsMain.ts')], bundle: true, outfile: output, format: 'iife' })
// 字典单独构建为 Node 可 import 的 ESM：测试从同一事实源取词条做期望值
const dictOut = path.join(root, 'out/test/browser/languageSwitchLocales.mjs')
await build({ entryPoints: [path.join(root, 'src/shared/locales/index.ts')], bundle: true, outfile: dictOut, format: 'esm' })
const { LOCALE_MESSAGES } = await import(pathToFileURL(dictOut).href)

const browser = await chromium.launch({ headless: true, channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  // 宿主 HTML 生成点的等价物：数据岛注入 zh-cn（首帧文案就绪，零宿主消息；
  // `<` 转义与 buildLocaleIslandHtml 同口径，防 </script> 逃逸）
  const islandJson = JSON.stringify({ lang: 'zh-cn', messages: LOCALE_MESSAGES['zh-cn'] })
    .replace(/</g, '\\u003c')
  await page.setContent(
    `<html lang="zh-cn"><head></head><body><div id="app"></div>` +
    `<script type="application/json" id="vsidian-locale">${islandJson}</script></body></html>`,
  )
  await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await page.evaluate((packs) => {
    // mock 宿主桥：语言设置保存成功 → 回发 settings.changed + （生效语言
    // 变化时）locale.changed 携完整新语言包（与 provider 广播行为同构）
    window.localePacks = packs
    window.currentLang = 'zh-cn'
    window.saved = {}
    window.sent = []
    window.acquireVsCodeApi = () => ({ postMessage(message) {
      window.sent.push(message)
      if (message.kind !== 'settings.set') return
      Object.assign(window.saved, message.values)
      const replies = [{ kind: 'settings.changed', values: window.saved }]
      const pref = message.values['general.language']
      if (pref !== undefined) {
        const eff = pref === 'auto' ? 'zh-cn' : pref // mock 宿主为中文显示语言
        if (eff !== window.currentLang) {
          window.currentLang = eff
          replies.push({ kind: 'locale.changed', lang: eff, messages: window.localePacks[eff] })
        }
      }
      setTimeout(() => {
        for (const reply of replies) {
          window.dispatchEvent(new MessageEvent('message', { data: reply }))
        }
      }, 0)
    } })
  }, { 'zh-cn': LOCALE_MESSAGES['zh-cn'], en: LOCALE_MESSAGES.en })
  await page.addScriptTag({ path: output })

  const title = page.locator('.vsidian-settings-title')
  const navItem = page.locator('.vsidian-settings-nav-item').first()
  const select = page.locator('select.vsidian-settings-select')
  const optionTexts = () => select.locator('option').evaluateAll((nodes) => nodes.map((n) => n.textContent))

  // 首帧（zh-cn 数据岛）：标题、常规分组、下拉选项可见文本
  await title.filter({ hasText: LOCALE_MESSAGES['zh-cn']['settings.pageTitle'] }).waitFor()
  await expectNavText(page, LOCALE_MESSAGES['zh-cn']['settings.generalSection'])
  assert.deepEqual(await optionTexts(), ['自动', '简体中文', 'English'])
  assert.equal(await select.inputValue(), 'auto')
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-cn')
  // 分组图标真实绘制（视觉层：stroke 生效而非空元素；display 由布局决定不设期值）
  const iconPaint = await navItem.evaluate((el) => getComputedStyle(el.querySelector('svg')).stroke)
  assert.notEqual(iconPaint, 'none')

  // 切换 en：标题、分组导航、auto 选项名随之变化；语言自名不自译
  await select.selectOption('en')
  await title.filter({ hasText: LOCALE_MESSAGES.en['settings.pageTitle'] }).waitFor()
  await expectNavText(page, LOCALE_MESSAGES.en['settings.generalSection'])
  assert.deepEqual(await optionTexts(), ['Auto', '简体中文', 'English'])
  assert.equal(await select.inputValue(), 'en')
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en')

  // 切回 zh-cn：常驻文本就地恢复
  await select.selectOption('zh-cn')
  await title.filter({ hasText: LOCALE_MESSAGES['zh-cn']['settings.pageTitle'] }).waitFor()
  await expectNavText(page, LOCALE_MESSAGES['zh-cn']['settings.generalSection'])
  assert.deepEqual(await optionTexts(), ['自动', '简体中文', 'English'])
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-cn')

  // 切回 auto：中文宿主环境下解析回 zh-cn（页面维持中文，html lang 不变）
  await select.selectOption('auto')
  await page.waitForTimeout(100)
  await expectNavText(page, LOCALE_MESSAGES['zh-cn']['settings.generalSection'])
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'zh-cn')
  assert.equal(await select.inputValue(), 'auto')

  // 全程只上送 settings.set（换包由宿主 locale.changed 驱动，非 webview 自取）
  assert.deepEqual(
    (await page.evaluate(() => window.sent.filter((m) => m.kind !== 'settings.get' && m.kind !== 'keybindings.get')))
      .map((m) => m.values['general.language']),
    ['en', 'zh-cn', 'auto'],
  )
  assert.deepEqual(errors, [])
  console.log('[语言切换][PASS] zh↔en 可见文本即时变化、自名不自译、html lang 同步、auto 回落')
  await page.close()
} finally { await browser.close() }

/** 首个分组导航（general）按期望词条可见（换语言后词条变化即等待到位） */
async function expectNavText(page, expectedText) {
  await page.locator('.vsidian-settings-nav-item').filter({ hasText: expectedText }).first().waitFor()
}
