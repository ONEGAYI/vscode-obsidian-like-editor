import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/quickActions.js')
await build({ entryPoints: [path.join(root, 'test/browser/quickActionsFixture.ts')],
  bundle: true, outfile: output, format: 'iife' })
const artifacts = path.join(root, 'out/task89')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 300, height: 640 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent(`<html><body class="vscode-${theme}"><div id="app"></div></body></html>`)
    await page.addStyleTag({ content: `:root { --vscode-font-family: sans-serif; --vscode-editor-background: ${theme === 'light' ? '#fff' : '#1e1e1e'}; --vscode-editor-foreground: ${theme === 'light' ? '#222' : '#ddd'}; --vscode-button-background: ${theme === 'light' ? '#075fae' : '#1476bd'}; --vscode-button-foreground: #fff; --vscode-focusBorder: #4fc1ff; }` })
    await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
    await page.addScriptTag({ path: output })
    await page.evaluate(() => window.initQuick('中文 English\n第二段'))
    await page.locator('.vsidian-quick-toggle').click()
    const bar = page.locator('.vsidian-quick-actions')
    const barBox = await bar.boundingBox()
    const editorBox = await page.locator('.vsidian-view-live').boundingBox()
    assert.ok(barBox && editorBox && barBox.height > 30 && editorBox.y >= barBox.y + barBox.height - 1,
      '窄窗口操作条应换行并把正文推到下方')
    await page.evaluate(() => window.controller.getView().dispatch({ selection: { anchor: 0, head: 2 } }))
    await page.locator('[data-op="bold"]').click()
    assert.equal(await page.evaluate(() => window.quickText()), '**中文** English\n第二段')
    assert.equal(await page.evaluate(() => window.quickSent().filter((m) => m.kind === 'edit.request').length), 1)
    const active = await page.locator('[data-op="bold"]').evaluate((el) => ({
      state: el.getAttribute('aria-pressed'), bg: getComputedStyle(el).backgroundColor,
    }))
    assert.equal(active.state, 'true')
    assert.notEqual(active.bg, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(30, 30, 30)')
    await page.locator('.vsidian-quick-heading').click()
    assert.equal(await page.locator('.vsidian-quick-heading-menu').evaluate((el) =>
      getComputedStyle(el).display), 'flex')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.vsidian-quick-heading').getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('.vsidian-quick-heading-menu').evaluate((el) =>
      getComputedStyle(el).display), 'none')
    assert.equal(await page.locator('.vsidian-quick-heading').evaluate((el) => document.activeElement === el), true)
    await page.screenshot({ path: path.join(artifacts, `quick-${theme}.png`) })
    await page.locator('.vsidian-quick-heading').click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    assert.ok((await page.evaluate(() => window.quickText())).startsWith('## '),
      '标题菜单应支持方向键选择并由 Enter 写回')
    assert.deepEqual(errors, [], '页面不能有未捕获异常')
    await page.close()
  }
  // 原生鼠标路径：先拖出表格矩形格区，再点击顶栏展开与粗体按钮。
  const page = await browser.newPage({ viewport: { width: 620, height: 480 } })
  await page.setContent('<html><body><div id="app"></div></body></html>')
  await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await page.addScriptTag({ path: output })
  await page.evaluate(() => window.initQuick('| H | Q |\n| --- | --- |\n| A | B |\n| x | y |'))
  const cell = (row, column) => page.locator('.vsidian-table-grid-row').nth(row)
    .locator('.vsidian-table-grid-cell').nth(column)
  const first = await cell(1, 0).boundingBox()
  const second = await cell(2, 0).boundingBox()
  assert.ok(first && second, '测试表格两格应绘制')
  await page.mouse.move(first.x + 14, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(second.x + 26, second.y + second.height / 2)
  await page.mouse.up()
  assert.equal(await page.locator('.vsidian-table-region-cell').count(), 2,
    '原生拖选应形成 A/x 两格矩形选区')
  await page.locator('.vsidian-quick-toggle').click()
  assert.equal(await page.locator('.vsidian-table-region-cell').count(), 2,
    '鼠标点击展开按钮后必须保留矩形格区')
  await page.locator('[data-op="bold"]').click()
  assert.equal(await page.evaluate(() => window.quickText()),
    '| H | Q |\n| --- | --- |\n| **A** | B |\n| **x** | y |', '粗体应逐格作用于保留的矩形选区')
  assert.equal(await page.evaluate(() => window.quickSent().filter((m) => m.kind === 'edit.request').length), 1,
    '矩形格区格式化应是一笔写回')
  await page.locator('.vsidian-quick-toggle').focus()
  await page.keyboard.press('Space')
  assert.equal(await page.locator('.vsidian-quick-toggle').getAttribute('aria-expanded'), 'false',
    '鼠标保焦处理不得损害键盘激活')
  await page.close()
} finally {
  await browser.close()
}
console.log('[快速操作条浏览器回归] 明暗主题、窄窗换行、原生点击与绘制通过')
