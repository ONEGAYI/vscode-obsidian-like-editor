// 设置页生产入口的真实浏览器集成：原生输入、绘制属性、主题与窄屏。
// #95 i18n：页面注入 zh-cn 数据岛首帧装配语言包，文案断言与字典同源
// （经 loadZhCn 取词，不再复制字面量）。#96 起导航默认选中「常规」分组。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { loadZhCn, localeIslandScript } from './localeIsland.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/settingsPage.js')
await build({ entryPoints: [path.join(root, 'src/webview/settingsMain.ts')], bundle: true, outfile: output, format: 'iife' })
const zhCn = await loadZhCn()
const artifacts = path.join(root, 'out/task90')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
    const errors = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.setContent(`<html lang="zh-CN"><head>${localeIslandScript(zhCn)}</head><body><div id="app"></div></body></html>`)
    const palette = theme === 'light' ? ['#ffffff','#30343b','#f5f6f8','#59616d','#e0e4eb','#26313e','#ffffff','#d7dce3'] : ['#1e1e1e','#dddddd','#252526','#aaaaaa','#373d49','#ffffff','#313136','#474750']
    await page.addStyleTag({ content: `:root { --vscode-font-family: "Segoe UI", "Microsoft YaHei", sans-serif; --vscode-editor-background:${palette[0]}; --vscode-editor-foreground:${palette[1]}; --vscode-sideBar-background:${palette[2]}; --vscode-descriptionForeground:${palette[3]}; --vscode-list-activeSelectionBackground:${palette[4]}; --vscode-list-activeSelectionForeground:${palette[5]}; --vscode-input-background:${palette[6]}; --vscode-input-foreground:${palette[1]}; --vscode-panel-border:${palette[7]}; --vscode-focusBorder:#2687d4; }` })
    await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
    await page.evaluate(() => {
      window.savedSettings = { 'editor.lineNumbers': true }
      window.sentMessages = []
      window.acquireVsCodeApi = () => ({ postMessage(message) {
        window.sentMessages.push(message)
        setTimeout(() => {
          if (message.kind === 'settings.set') Object.assign(window.savedSettings, message.values)
          window.dispatchEvent(new MessageEvent('message', { data: { kind: message.kind === 'settings.set' ? 'settings.changed' : 'settings.snapshot', values: window.savedSettings } }))
        }, 0)
      } })
    })
    await page.addScriptTag({ path: output })
    // #96 默认选中分组为「常规」（首个分类）——选中态绘制断言取第一个
    // 导航按钮；「编辑器」按钮仍存在（下一行 exact 匹配保证）
    const nav = page.locator('.vsidian-settings-nav-item').first()
    await nav.waitFor()
    await page.getByRole('button', { name: zhCn['settings.editorCategory'], exact: true }).waitFor()
    const paint = await nav.evaluate(el => {
      const cs = getComputedStyle(el)
      const svg = getComputedStyle(el.querySelector('svg'))
      return { bg: cs.backgroundColor, fg: cs.color, radius: cs.borderRadius, display: cs.display, iconStroke: svg.stroke, iconFill: svg.fill }
    })
    assert.equal(paint.bg, theme === 'light' ? 'rgb(224, 228, 235)' : 'rgb(55, 61, 73)')
    assert.notEqual(paint.fg, paint.bg)
    assert.equal(paint.radius, '9px')
    assert.equal(paint.display, 'flex')
    assert.notEqual(paint.iconStroke, 'none')
    assert.equal(paint.iconFill, 'none')
    await page.screenshot({ path: path.join(artifacts, `settings-${theme}.png`) })
    const search = page.getByRole('searchbox', { name: zhCn['settings.searchAriaLabel'] })
    await search.focus()
    await page.keyboard.type('not found')
    assert.match(await page.locator('.vsidian-settings-list').innerText(), new RegExp(escapeRegExp(zhCn['settings.searchEmpty'].slice(0, 5))))
    await page.keyboard.press('Escape')
    await page.keyboard.insertText('留白带')
    const result = page.locator('.vsidian-settings-result')
    assert.equal(await result.count(), 1)
    assert.match(await result.innerText(), new RegExp(escapeRegExp(zhCn['settings.editorCategory'])))
    await result.click()
    const box = page.getByRole('checkbox', { name: zhCn['setting.editorLineNumbers.title'], exact: true })
    assert.equal(await box.evaluate(el => document.activeElement === el), true)
    await page.keyboard.press('Space')
    await page.getByRole('status').filter({ hasText: zhCn['settings.saveDone'] }).waitFor()
    assert.equal(await box.isChecked(), false)
    await search.focus()
    await page.keyboard.press('Control+b')
    assert.equal(await page.evaluate(() => window.sentMessages.filter(m =>
      m.kind !== 'settings.get' && m.kind !== 'settings.set' && m.kind !== 'keybindings.get').length), 0)
    const focus = await search.evaluate(el => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }))
    assert.equal(focus.style, 'solid')
    assert.equal(focus.width, '2px')
    await page.setViewportSize({ width: 360, height: 740 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await box.isVisible(), true)
    await page.screenshot({ path: path.join(artifacts, `settings-${theme}-narrow.png`) })
    assert.deepEqual(errors, [])
    console.log(`[设置页][PASS] ${theme}：主题绘制、图标、原生搜索、定位、保存、焦点与 360px 窄屏`)
    await page.close()
  }
} finally { await browser.close() }

/** 断言用的最简正则转义（词条含（）等全角标点，仅 () 需转义） */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
