// 生产编辑器控制器在 Chromium 原生 keyboard 路径上的键位捕获与旧键释放。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/keybindingEditor.js')
await build({ entryPoints: [path.join(root, 'test/browser/keybindingEditorFixture.ts')],
  bundle: true, outfile: output, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })
const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  const page = await browser.newPage()
  await page.setContent('<html><body><div id="app"></div></body></html>')
  await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await page.addScriptTag({ path: output })
  await page.evaluate(() => window.initKeys('word'))
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+b')
  let state = await page.evaluate(() => window.keyState())
  assert.equal(state.text, '**word**')
  assert.equal(state.forwarded, 0, '被 Vsidian 捕获的按键不应到达 window 冒泡转发层')
  await page.evaluate(() => { window.initKeys('word'); window.updateKeys({ bold: [] }) })
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+b')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.text, 'word', '显式清空后旧键不应执行格式操作')
  assert.equal(state.forwarded, 1, '清空后旧键应重新经过 window 层')
  await page.evaluate(() => window.updateKeys({ bold: ['ctrl+shift+b'] }))
  await page.keyboard.press('Control+Shift+b')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.text, '**word**')
  assert.equal(state.forwarded, 1)
  await page.evaluate(() => window.setMode('reading'))
  await page.keyboard.press('Control+b')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.text, '**word**', '阅读模式不执行写操作')
  await page.keyboard.press('Control+f')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.findOpen, true, '阅读模式保留只读查找键位')
  const forwardedBeforeStep = state.forwarded
  await page.keyboard.press('F3')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.forwarded, forwardedBeforeStep, '查找输入中 F3 被本地路由捕获')
  await page.evaluate(() => window.updateKeys({ findNext: [] }))
  await page.keyboard.press('F3')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.forwarded, forwardedBeforeStep + 1, '清空后 F3 释放到 window 层')
  await page.evaluate(() => window.setMode('live'))
  await page.evaluate(() => { window.initKeys('word'); window.updateKeys({ bold: ['ctrl+k ctrl+b'] }) })
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+k')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.text, 'word')
  await page.keyboard.press('Control+b')
  state = await page.evaluate(() => window.keyState())
  assert.equal(state.text, '**word**')
  assert.equal(state.forwarded, 3)
  await page.close()
  console.log('[编辑器快捷键][PASS] 原生键盘默认/清空释放/改绑/两段键与 window 转发隔离')
} finally { await browser.close() }
