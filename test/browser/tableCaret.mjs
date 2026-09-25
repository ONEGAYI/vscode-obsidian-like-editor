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
  for (const row of process.argv.includes('--navigation-only') ? [] : [0, 1]) for (const mode of ['english', 'ime']) {
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
        await page.keyboard.press('ArrowLeft')
        const leftFocused = await page.evaluate((row) => {
          const left = document.querySelectorAll('.vsidian-table-grid-row')[row].querySelectorAll('.vsidian-table-grid-cell')[0]
          return left.contains(getSelection()?.focusNode)
        }, row)
        assert(leftFocused, '中格格首左移应把真实光标移到左格')
        await page.keyboard.type('x')
        assert.equal((await snapshot()).left, row === 0 ? '带x' : '左x', '左移后文字须输入左格')
        await page.keyboard.press('Backspace')
        await page.keyboard.press('ArrowRight')
        if (deletion !== 'empty-source') await check('', '从左格向右回到空中格')
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
        await page.keyboard.press('ArrowLeft')
        await check(mode === 'english' ? 'ssssssss' : '是', '格内向左逐字移动')
        await page.keyboard.press('ArrowRight')
        await check(mode === 'english' ? 'ssssssss' : '是', '格内向右逐字移动')
        const beforeSpace = await snapshot()
        await page.keyboard.type(' ')
        const withSpace = await snapshot()
        assert(withSpace.caretX > beforeSpace.caretX, '用户自己键入的空格必须仍有可见宽度')
        await page.keyboard.press('Backspace')
        await check(mode === 'english' ? 'ssssssss' : '是', '删除用户输入的空格')
        await page.keyboard.press('ArrowRight')
        const rightFocused = await page.evaluate((row) => {
          const right = document.querySelectorAll('.vsidian-table-grid-row')[row].querySelectorAll('.vsidian-table-grid-cell')[2]
          return right.contains(getSelection()?.focusNode)
        }, row)
        assert(rightFocused, '中格格尾右移应把真实光标移到右格')
        await page.keyboard.type('x')
        assert.equal((await snapshot()).right, row === 0 ? 'x送' : 'x右', '右移后文字须输入右格')
        await page.keyboard.press('Backspace')
        await page.keyboard.press('ArrowLeft')
        await page.keyboard.press('Backspace')
        await check(mode === 'english' ? 'sssssss' : '', '立即退格')
        assert.deepEqual(errors, [])
        passed++
        console.log(`[原生输入][PASS] ${row === 0 ? '表头' : '数据行'} ${deletion} → ${mode} → Backspace`)
      } finally { await page.close() }
    }
  }
  const navigationFailures = []
  for (const scenario of ['horizontal-wrap', 'horizontal-wrap-empty', 'vertical-inside', 'vertical-outside', 'vertical-empty', 'vertical-wrapped', 'enter-cell', 'enter-empty', 'enter-body', 'enter-middle', 'enter-repeat', 'enter-code', 'enter-code-start', 'enter-code-end', 'enter-ime']) {
    const page = await browser.newPage()
    try {
      await page.setContent('<div id="app"></div>')
      await page.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
      await page.addScriptTag({ path: bundle })
      let source = 'BEFORE\n\n| H1 | H2 |\n| --- | --- |\n| B1 | B2 |\n| C1 | C2 |\n\nAFTER'
      if (scenario === 'horizontal-wrap-empty') source = source.replace('| B1 | B2 |', '| | |')
      if (scenario === 'vertical-empty') source = source.replace(' B2 ', ' ')
      if (scenario === 'vertical-wrapped') source = source.replace('H2', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
      if (scenario === 'enter-empty') source = source.replace('H2', '')
      if (scenario.startsWith('enter-code')) source = source.replace('H2', '`H2`')
      await page.evaluate((text) => window.initTable(text), source)
      const cell = (r, c) => page.locator('.vsidian-table-grid-row').nth(r).locator('.vsidian-table-grid-cell').nth(c)
      async function checkCell(r, c) {
        const state = await page.evaluate(({ r, c }) => {
          const target = document.querySelectorAll('.vsidian-table-grid-row')[r].querySelectorAll('.vsidian-table-grid-cell')[c]
          const sel = getSelection()
          const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
          const box = target.getBoundingClientRect()
          return { ...window.readEditor(), inside: target.contains(sel?.focusNode), painted: !!rect && rect.height > 0 &&
            rect.x >= box.left && rect.x < box.right && rect.y >= box.top && rect.y < box.bottom }
        }, { r, c })
        assert(state.inside && state.painted, `${scenario} 光标应在 ${r}/${c}: ${JSON.stringify(state)}`)
        assert.equal(state.text, source, '方向键不得修改源文')
        await page.keyboard.type('x')
        const typed = await page.evaluate(() => window.readEditor())
        assert.equal(typed.text, source.slice(0, state.head) + 'x' + source.slice(state.head), '真实输入位置须与导航位置一致')
        await page.keyboard.press('Backspace')
      }
      if (scenario.startsWith('enter-')) {
        const target = cell(scenario === 'enter-body' ? 1 : 0, 1)
        await target.click()
        if (scenario.startsWith('enter-code')) {
          const at = source.indexOf('H2') + (scenario.endsWith('start') ? 0 : scenario.endsWith('end') ? 2 : 1)
          await page.evaluate(offset => window.controller.handleHostMessage({ kind: 'view.locate', offset }), at)
        }
        if (scenario === 'enter-middle') {
          await page.keyboard.press('Control+a')
          await page.keyboard.press('ArrowLeft')
          await page.keyboard.press('ArrowRight')
        }
        const before = await target.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().top)
        const breaks = scenario === 'enter-repeat' ? 2 : 1
        for (let i = 0; i < breaks; i++) await page.keyboard.press(scenario === 'enter-body' ? 'Shift+Enter' : 'Enter')
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        assert.equal(await page.locator('.vsidian-table-grid-row').count(), 3, '回车不能拆散表格')
        assert.equal((await page.evaluate(() => window.readEditor())).text.split('\n').length, source.split('\n').length, '格内换行不能拆开 Markdown 表格源行')
        const after = await target.evaluate(e => ({text:e.innerText, state:window.readEditor(), y:getSelection().getRangeAt(0).getBoundingClientRect().top, inside:e.contains(getSelection().focusNode), html:e.innerHTML, focus:getSelection().focusNode?.nodeName, offset:getSelection().focusOffset}))
        assert(after.inside && after.y > before, `回车后原生光标必须在同格下一视觉行: ${JSON.stringify({before,after})}`)
        assert(!after.text.includes('<br>'), '换行标记不得显示成源码')
        const input = scenario === 'enter-ime' ? '你好' : 'next'
        if (scenario === 'enter-ime') {
          const cdp = await page.context().newCDPSession(page)
          for (const text of ['ni', 'nihao']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
          await cdp.send('Input.insertText', { text: input })
        } else await page.keyboard.type(input)
        assert((await target.innerText()).includes(input), '换行后输入仍在原格')
        if (scenario === 'enter-cell') {
          const secondLine = await target.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().top)
          await page.keyboard.press('ArrowUp')
          const up = await target.evaluate(e => ({ inside:e.contains(getSelection().focusNode), y:getSelection().getRangeAt(0).getBoundingClientRect().top }))
          assert(up.inside && up.y < secondLine, '格内换行后上移应返回同格上一行')
          await page.keyboard.press('ArrowDown')
          const down = await target.evaluate(e => ({ inside:e.contains(getSelection().focusNode), y:getSelection().getRangeAt(0).getBoundingClientRect().top }))
          assert(down.inside && down.y > up.y, '下移应返回同格第二行')
          await page.screenshot({ path: path.join(root, 'out/test/browser/table-enter-live.png') })
          const saved = (await page.evaluate(() => window.readEditor())).text
          const reopened = await browser.newPage()
          try {
            await reopened.setContent('<div id="app"></div>')
            await reopened.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
            await reopened.addScriptTag({ path: bundle })
            await reopened.evaluate(text => {
              window.initTable(text)
              window.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' })
            }, saved)
            assert.equal(await reopened.locator('th').nth(1).locator('br').count(), 1, '重开阅读视图应保留格内换行')
            assert(!(await reopened.locator('th').nth(1).innerText()).includes('<br>'), '阅读视图不显示换行源码')
            await reopened.screenshot({ path: path.join(root, 'out/test/browser/table-enter-reading.png') })
          } finally { await reopened.close() }
        }
        for (let i = 0; i < input.length + breaks; i++) await page.keyboard.press('Backspace')
        assert.equal((await page.evaluate(() => window.readEditor())).text, source, '退格应一次删除格内换行并恢复源文')
        await page.keyboard.press('Enter')
        await page.keyboard.press('Backspace')
        assert.equal((await page.evaluate(() => window.readEditor())).text, source, '直接回车再退格必须合回原行')
      } else if (scenario.startsWith('horizontal-wrap')) {
        await cell(0, 1).click({ position: { x: 200, y: 10 } })
        await page.keyboard.press('ArrowRight')
        await checkCell(1, 0)
        await page.keyboard.press('ArrowLeft')
        await checkCell(0, 1)
      } else if (scenario === 'vertical-inside' || scenario === 'vertical-empty') {
        await cell(0, 1).click()
        await page.keyboard.press('ArrowDown')
        await checkCell(1, 1)
        await page.keyboard.press('ArrowDown')
        await checkCell(2, 1)
        await page.keyboard.press('ArrowUp')
        await checkCell(1, 1)
        await page.keyboard.press('ArrowUp')
        await checkCell(0, 1)
        await page.keyboard.press('ArrowUp')
        assert.equal((await page.evaluate(() => window.readEditor())).line, 2, '表头上移退出到表格前一行')
        await cell(2, 0).click()
        await page.keyboard.press('ArrowDown')
        assert.equal((await page.evaluate(() => window.readEditor())).line, 7, '末行下移退出到表格后一行')
      } else if (scenario === 'vertical-wrapped') {
        await page.addStyleTag({ content: '#app .cm-editor .cm-scroller .vsidian-table-grid-row { width: 160px }' })
        await cell(0, 1).click({ position: { x: 12, y: 8 } })
        await page.keyboard.press('Control+a')
        await page.keyboard.press('ArrowLeft')
        const initial = await page.evaluate(() => window.readEditor())
        await page.keyboard.press('ArrowDown')
        await checkCell(0, 1)
        assert((await page.evaluate(() => window.readEditor())).head > initial.head, '软换行下移应在格内前进')
        await page.keyboard.press('ArrowUp')
        await checkCell(0, 1)
      } else {
        await page.locator('.cm-line').filter({ hasText: /^BEFORE$/ }).click({ position: { x: 5, y: 10 } })
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowDown')
        await checkCell(0, 0)
        await page.locator('.cm-line').filter({ hasText: /^AFTER$/ }).click({ position: { x: 5, y: 10 } })
        await page.keyboard.press('ArrowUp')
        await page.keyboard.press('ArrowUp')
        await checkCell(2, 0)
      }
      passed++
      console.log(`[原生输入][PASS] ${scenario}`)
    } catch (error) {
      navigationFailures.push(error)
      console.error(`[原生输入][FAIL] ${scenario}: ${error.message}`)
    } finally { await page.close() }
  }
  if (navigationFailures.length) throw new AggregateError(navigationFailures, '表格方向键导航回归失败')
  console.log(`[原生输入] ${passed} 项通过`)
} finally { await browser.close() }
