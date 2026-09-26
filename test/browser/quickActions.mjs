import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { buildZhLocaleIsland } from './localeIsland.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/quickActions.js')
await build({ entryPoints: [path.join(root, 'test/browser/quickActionsFixture.ts')],
  bundle: true, outfile: output, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })
const artifacts = path.join(root, 'out/task89')
await mkdir(artifacts, { recursive: true })
// #94：操作条文案经 t() 取词——注入生产同款 zh-cn 数据岛（fixture 入口 boot）
const { islandHtml, zhCnMessages } = await buildZhLocaleIsland(root)
const iconPaint = async (page, key) => {
  const png = await page.locator(`[data-icon="${key}"]`).screenshot()
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
    const rgb = new Set()
    let left = bitmap.width, right = -1, top = bitmap.height, bottom = -1
    const base = [...data.slice(0, 3)]
    for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
      const at = (y * bitmap.width + x) * 4
      const color = [...data.slice(at, at + 3)]
      rgb.add(color.join(','))
      if (color.some((channel, index) => Math.abs(channel - base[index]) > 30)) {
        left = Math.min(left, x); right = Math.max(right, x)
        top = Math.min(top, y); bottom = Math.max(bottom, y)
      }
    }
    return { colors: rgb.size, centerX: (left + right) / 2, centerY: (top + bottom) / 2,
      width: bitmap.width, height: bitmap.height }
  }, png.toString('base64'))
}
const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 300, height: 640 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const iconRequests = []
    await page.route('http://quick.test/assets/*.svg', async (route) => {
      const name = path.basename(new URL(route.request().url()).pathname)
      iconRequests.push(name)
      await route.fulfill({ path: path.join(root, 'out/test/browser/assets', name),
        contentType: 'image/svg+xml' })
    })
    await page.setContent(`<html><head><base href="http://quick.test/"></head><body class="vscode-${theme}">${islandHtml}<div id="app"></div></body></html>`)
    await page.addStyleTag({ content: `:root { --vscode-font-family: sans-serif; --vscode-editor-background: ${theme === 'light' ? '#fff' : '#1e1e1e'}; --vscode-editor-foreground: ${theme === 'light' ? '#222' : '#ddd'}; --vscode-button-background: ${theme === 'light' ? '#075fae' : '#1476bd'}; --vscode-button-foreground: #fff; --vscode-focusBorder: #4fc1ff; }` })
    await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
    await page.addScriptTag({ path: output })
    await page.evaluate(() => window.initQuick('中文 English\n第二段'))
    await page.locator('.vsidian-quick-toggle').click()
    const bar = page.locator('.vsidian-quick-actions')
    assert.deepEqual(await bar.locator('[role="group"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label'))),
    [zhCnMessages['format.groupText'], zhCnMessages['format.groupParagraph'], zhCnMessages['format.groupInsert']])
    await page.waitForFunction(() => [...document.querySelectorAll('.vsidian-quick-action-group')]
      .every((node) => node.dataset.separated === 'false'))
    const barBox = await bar.boundingBox()
    const editorBox = await page.locator('.vsidian-view-live').boundingBox()
    assert.ok(barBox && editorBox && barBox.height > 30 && editorBox.y >= barBox.y + barBox.height - 1,
      '窄窗口操作条应换行并把正文推到下方')
    assert.equal(await bar.locator('[data-icon]').count(), 17)
    await page.waitForFunction((theme) => performance.getEntriesByType('resource').filter((entry) =>
      entry.name.includes(`/assets/${theme}-`) && entry.name.endsWith('.svg')).length === 17, theme)
    assert.equal(iconRequests.filter((name) => name.startsWith(`${theme}-`)).length, 17,
      '全部图标资源应真实加载')
    const boldIcon = await iconPaint(page, 'bold')
    assert.ok(boldIcon.colors > 2, '粗体图标应真实绘制')
    const strike = await iconPaint(page, 'strikethrough')
    assert.ok(strike.colors > 2 && Math.abs(strike.centerX - strike.width / 2) < 3 &&
      Math.abs(strike.centerY - strike.height / 2) < 3, '删除线图标应可见且在画布中心')
    await page.setViewportSize({ width: 720, height: 640 })
    await page.waitForFunction(() => [...document.querySelectorAll('.vsidian-quick-action-group')]
      .slice(1).every((node) => node.dataset.separated === 'true'))
    assert.equal(await bar.locator('[role="group"]').nth(1).evaluate((node) =>
      getComputedStyle(node, '::before').borderLeftWidth), '2px', '同行组间应绘制竖线')
    await page.screenshot({ path: path.join(artifacts, `quick-wide-${theme}.png`) })
    await page.setViewportSize({ width: 300, height: 640 })
    await page.waitForFunction(() => [...document.querySelectorAll('.vsidian-quick-action-group')]
      .every((node) => node.dataset.separated === 'false'))
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
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator('[data-op="bulletList"]').evaluate((el) =>
      document.activeElement === el), true, '方向键应跨组移动焦点')
    await page.keyboard.press('End')
    assert.equal(await page.locator('[data-op="horizontalRule"]').evaluate((el) =>
      document.activeElement === el), true)
    await page.screenshot({ path: path.join(artifacts, `quick-${theme}.png`) })
    await page.locator('.vsidian-quick-heading').click()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    assert.ok((await page.evaluate(() => window.quickText())).startsWith('## '),
      '标题菜单应支持方向键选择并由 Enter 写回')
    await page.evaluate(() => {
      window.initQuick('## 标题\n正文')
      window.controller.getView().dispatch({ selection: { anchor: 4 } })
    })
    for (const width of [720, 390, 300]) {
      await page.setViewportSize({ width, height: 640 })
      await page.locator('.vsidian-quick-heading').click()
      const popup = await page.evaluate(() => {
        const heading = document.querySelector('.vsidian-quick-heading')
        const menu = document.querySelector('.vsidian-quick-heading-menu')
        const first = menu.querySelector('[data-heading-op="heading1"]')
        const selected = menu.querySelector('[data-heading-op="heading2"]')
        const anchor = heading.getBoundingClientRect()
        const box = menu.getBoundingClientRect()
        const firstBox = first.getBoundingClientRect()
        const selectedBox = selected.getBoundingClientRect()
        return {
          anchor: { left: anchor.left, bottom: anchor.bottom },
          box: { left: box.left, right: box.right, top: box.top, width: box.width },
          firstBackground: getComputedStyle(first).backgroundColor,
          selectedBackground: getComputedStyle(selected).backgroundColor,
          selectedChecked: selected.getAttribute('aria-checked'),
          firstFocused: document.activeElement === first,
          firstPainted: first.contains(document.elementFromPoint(firstBox.left + 12,
            firstBox.top + firstBox.height / 2)),
          selectedPainted: selected.contains(document.elementFromPoint(selectedBox.left + 12,
            selectedBox.top + selectedBox.height / 2)),
        }
      })
      assert.ok(Math.abs(popup.box.left - Math.min(popup.anchor.left, width - popup.box.width)) <= 3,
        `${theme} ${width}px：菜单左边应靠标题按钮，触右缘时回退到视口内：${JSON.stringify(popup)}`)
      assert.ok(Math.abs(popup.box.top - popup.anchor.bottom) <= 3,
        `${theme} ${width}px：换行后菜单应从标题按钮下方展开：${JSON.stringify(popup)}`)
      assert.ok(popup.box.left >= -1 && popup.box.right <= width + 1 &&
        popup.firstPainted && popup.selectedPainted,
      `${theme} ${width}px：菜单选项应在视口内真实绘制：${JSON.stringify(popup)}`)
      assert.equal(popup.selectedChecked, 'true', '当前 H2 层级须由 aria-checked 单独表达')
      assert.equal(popup.firstFocused, false, '指针打开菜单不应把焦点移至 H1')
      assert.equal(popup.firstBackground, 'rgba(0, 0, 0, 0)',
        '指针打开时 H1 不应出现灰色焦点或悬停背景')
      assert.notEqual(popup.selectedBackground, popup.firstBackground, '当前 H2 应有独立选中底色')
      await page.keyboard.press('Escape')
    }
    await page.locator('.vsidian-quick-heading').evaluate((el) => {
      el.style.transform = 'translateX(210px)'
    })
    await page.locator('.vsidian-quick-heading').click()
    const edge = async () => page.evaluate(() => {
      const anchor = document.querySelector('.vsidian-quick-heading').getBoundingClientRect()
      const menu = document.querySelector('.vsidian-quick-heading-menu').getBoundingClientRect()
      return { anchorLeft: anchor.left, left: menu.left, right: menu.right,
        width: menu.width, viewportWidth: window.innerWidth }
    })
    let edgeBox = await edge()
    assert.ok(edgeBox.anchorLeft > edgeBox.viewportWidth - edgeBox.width &&
      Math.abs(edgeBox.right - edgeBox.viewportWidth) <= 3,
    `靠视口右边的标题按钮应把菜单收进视口：${JSON.stringify(edgeBox)}`)
    await page.setViewportSize({ width: 270, height: 640 })
    await page.waitForFunction(() => {
      const menu = document.querySelector('.vsidian-quick-heading-menu').getBoundingClientRect()
      return Math.abs(menu.right - innerWidth) <= 3
    })
    edgeBox = await edge()
    assert.ok(edgeBox.left >= 0 && edgeBox.right <= 271,
      `菜单打开时缩窄视口仍须重新定位：${JSON.stringify(edgeBox)}`)
    await page.keyboard.press('Escape')
    await page.locator('.vsidian-quick-heading').evaluate((el) => { el.style.transform = '' })
    await page.locator('.vsidian-quick-heading').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.locator('.vsidian-quick-heading-menu').isVisible(), true,
      '键盘 Enter 应打开菜单')
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.locator('[data-heading-op="heading2"]').evaluate((el) =>
      document.activeElement === el), true, '键盘打开后方向键仍可移动菜单焦点')
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.vsidian-quick-heading').evaluate((el) =>
      document.activeElement === el), true, 'Escape 应把焦点还给标题按钮')
    assert.deepEqual(errors, [], '页面不能有未捕获异常')
    await page.close()
  }
  // 原生 Tab：光标进入行内代码后粗体禁用，工具条仍须有唯一可用入口。
  const tabPage = await browser.newPage({ viewport: { width: 720, height: 480 } })
  await tabPage.setContent('<html><body><div id="app"></div></body></html>')
  await tabPage.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await tabPage.addScriptTag({ path: output })
  await tabPage.evaluate(() => window.initQuick('`word`'))
  await tabPage.locator('.vsidian-quick-toggle').click()
  await tabPage.evaluate(() => window.controller.getView().dispatch({ selection: { anchor: 2 } }))
  const tabBar = tabPage.locator('.vsidian-quick-actions')
  assert.equal(await tabBar.locator('[data-op="bold"]').isDisabled(), true)
  assert.equal(await tabBar.locator('[data-op="inlineCode"]').isEnabled(), true)
  assert.deepEqual(await tabBar.locator('.vsidian-quick-action-group button').evaluateAll((buttons) =>
    buttons.filter((button) => !button.disabled && button.tabIndex === 0)
      .map((button) => button.dataset.op ?? button.dataset.icon)), ['inlineCode'],
  '禁用原入口后应转移到唯一可用按钮')
  await tabPage.locator('.vsidian-sidebar-toggle').focus()
  await tabPage.keyboard.press('Tab')
  assert.equal(await tabBar.locator('[data-op="inlineCode"]').evaluate((button) =>
    document.activeElement === button), true, '原生 Tab 应进入可用格式按钮')
  await tabPage.keyboard.press('ArrowRight')
  assert.equal(await tabBar.locator('.vsidian-quick-table').evaluate((button) =>
    document.activeElement === button && button.tabIndex === 0), true,
  '方向键应从回退入口继续 roving 到下一个可用按钮')
  await tabPage.close()
  const formulaPage = await browser.newPage({ viewport: { width: 720, height: 480 } })
  await formulaPage.setContent('<html><body><div id="app"></div></body></html>')
  await formulaPage.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await formulaPage.addScriptTag({ path: output })
  await formulaPage.evaluate(() => window.initQuick('公式文字'))
  await formulaPage.locator('.vsidian-quick-toggle').click()
  await formulaPage.evaluate(() => window.controller.getView().dispatch({ selection: { anchor: 0, head: 2 } }))
  await formulaPage.locator('[data-op="inlineMath"]').click()
  assert.equal(await formulaPage.evaluate(() => window.quickText()), '$公式$文字')
  assert.equal(await formulaPage.evaluate(() => window.quickSent().filter((m) => m.kind === 'edit.request').length), 1)
  await formulaPage.close()
  const blockPage = await browser.newPage({ viewport: { width: 720, height: 480 } })
  await blockPage.setContent('<html><body><div id="app"></div></body></html>')
  await blockPage.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await blockPage.addScriptTag({ path: output })
  await blockPage.evaluate(() => window.initQuick(''))
  await blockPage.locator('.vsidian-quick-toggle').click()
  await blockPage.locator('[data-op="blockMath"]').click()
  assert.equal(await blockPage.evaluate(() => window.quickText()), '$$\n\n$$',
    '无选区块级公式应沿 #88 契约插入围栏')
  assert.equal(await blockPage.evaluate(() => window.quickSent().filter((m) => m.kind === 'edit.request').length), 1,
    '块级公式应一笔写回')
  await blockPage.close()
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
  assert.equal(await page.locator('[data-op="blockMath"]').isDisabled(), true,
    '表格矩形格区禁用块级公式')
  await page.locator('.vsidian-quick-toggle').focus()
  await page.keyboard.press('Space')
  assert.equal(await page.locator('.vsidian-quick-toggle').getAttribute('aria-expanded'), 'false',
    '鼠标保焦处理不得损害键盘激活')
  await page.close()
} finally {
  await browser.close()
}
console.log('[快速操作条浏览器回归] 明暗主题、窄窗换行、原生点击与绘制通过')
