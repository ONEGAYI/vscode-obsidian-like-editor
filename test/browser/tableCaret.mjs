// 使用浏览器原生按键与组合输入，避免 dispatchEvent/execCommand 遗漏事件顺序。
// 默认使用 Playwright Chromium；可设 VSIDIAN_TEST_BROWSER_CHANNEL=msedge。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/tableCaret.js')
await build({ entryPoints: [path.join(root, 'test/browser/tableCaretFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife' })
const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
let passed = 0
try {
  for (const row of [0, 1]) for (const mode of ['english', 'ime']) {
    for (const deletion of ['backspace', 'delete', 'selection', 'empty-source']) {
      const page = await browser.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      try {
        await page.setContent('<div id="app"></div>')
        await page.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
        await page.addScriptTag({ path: bundle })
        await page.evaluate((empty) => window.initTable(`| 带 |${empty ? '' : 'middle'}| 送 |\n| --- | --- | --- |\n| 左 |${empty ? '' : 'middle'}| 右 |\n`), deletion === 'empty-source')
        const cell = page.locator('.vsidian-table-grid-row').nth(row).locator('.vsidian-table-grid-cell').nth(1)
        await cell.click()
        if (deletion === 'selection') {
          await page.keyboard.press('Control+a')
          await page.keyboard.press('Backspace')
        } else if (deletion !== 'empty-source') {
          // 行首/行尾按键会跳出单元格，因此先按格内全选定位端点。
          await page.keyboard.press('Control+a')
          await page.keyboard.press(deletion === 'backspace' ? 'ArrowRight' : 'ArrowLeft')
          for (let i = 0; i < 10; i++) await page.keyboard.press(deletion === 'backspace' ? 'Backspace' : 'Delete')
        }
        async function snapshot() {
          return page.evaluate((row) => {
            const cells = document.querySelectorAll('.vsidian-table-grid-row')[row].querySelectorAll('.vsidian-table-grid-cell')
            const selection = getSelection()
            const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
            const box = cells[1].getBoundingClientRect()
            const walker = document.createTreeWalker(cells[1], NodeFilter.SHOW_TEXT)
            let lastText = null
            while (walker.nextNode()) if (walker.currentNode.textContent.length) lastText = walker.currentNode
            let paddingWidth = 0
            if (lastText?.textContent.endsWith(' ')) {
              const padding = document.createRange()
              padding.setStart(lastText, lastText.textContent.length - 1)
              padding.setEnd(lastText, lastText.textContent.length)
              paddingWidth = padding.getBoundingClientRect().width
            }
            return { middle: cells[1].textContent, caretX: rect?.x,
              paddingWidth,
              left: cells[0].textContent.trim(), right: cells[2].textContent.trim(),
              caretInside: cells[1].contains(selection?.focusNode),
              caretPainted: !!rect && rect.height > 0 && rect.x >= box.left && rect.x < box.right }
          }, row)
        }
        async function check(value, step) {
          const state = await snapshot()
          assert.equal(state.middle.trim(), value, `${step}: ${JSON.stringify(state)}`)
          assert.equal(state.paddingWidth, 0, `${step} 填充空格不得占据可见宽度`)
          assert(state.caretInside && state.caretPainted, `${step} 光标必须在中格: ${JSON.stringify(state)}`)
          assert.equal(state.left, row === 0 ? '带' : '左')
          assert.equal(state.right, row === 0 ? '送' : '右')
        }
        if (deletion !== 'empty-source') {
          await check('', '删光后')
          const empty = await snapshot()
          for (let i = 0; i < 2; i++) {
            await page.evaluate(() => document.activeElement.blur())
            await cell.click()
            const refocused = await snapshot()
            assert.equal(refocused.middle, empty.middle, '失焦再聚焦不得修改填充空白')
            assert.equal(refocused.caretX, empty.caretX, '重新聚焦空格后光标不得越过填充空格')
          }
        }
        for (let i = 0; i < 3; i++) {
          await page.keyboard.press('ArrowLeft')
          if (deletion !== 'empty-source') await check('', '清空后按左方向键')
        }
        if (mode === 'english') {
          for (let i = 1; i <= 8; i++) {
            await page.keyboard.type('s')
            await check('s'.repeat(i), `英文第 ${i} 次输入`)
          }
        } else {
          const cdp = await page.context().newCDPSession(page)
          for (const text of ['s', 'sh', 'shi']) {
            await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
            await check(text, `IME 候选 ${text}`)
          }
          await cdp.send('Input.insertText', { text: '是' })
          await check('是', 'IME 确认')
        }
        const beforeSpace = await snapshot()
        await page.keyboard.type(' ')
        const withSpace = await snapshot()
        assert(withSpace.caretX > beforeSpace.caretX, '用户自己键入的空格必须仍有可见宽度')
        await page.keyboard.press('Backspace')
        await check(mode === 'english' ? 'ssssssss' : '是', '删除用户输入的空格')
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('Backspace')
        await check(mode === 'english' ? 'sssssss' : '', '立即退格')
        assert.deepEqual(errors, [])
        passed++
        console.log(`[原生输入][PASS] ${row === 0 ? '表头' : '数据行'} ${deletion} → ${mode} → Backspace`)
      } finally { await page.close() }
    }
  }
  console.log(`[原生输入] ${passed} 项通过`)
} finally { await browser.close() }
