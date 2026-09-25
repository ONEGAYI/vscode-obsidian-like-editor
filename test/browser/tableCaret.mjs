// 使用浏览器原生按键与组合输入，避免 dispatchEvent/execCommand 遗漏事件顺序。
// 默认使用 Playwright Chromium；可设 VSIDIAN_TEST_BROWSER_CHANNEL=msedge。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/tableCaret.js')
// #59 公式依赖：katex.min.css 经 import 进入 bundle，需字体 loader（与
// esbuild.mjs 的 webviewBase 同口径；裁剪插件去掉 woff/ttf 回退引用）
const katexFontStrip = {
  name: 'katex-font-fallback-strip',
  setup(b) {
    b.onLoad({ filter: /katex\.min\.css$/ }, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replace(
        /,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\((["']?)(?:woff|truetype)\1\)/g, ''),
      loader: 'css',
    }))
  },
}
await build({ entryPoints: [path.join(root, 'test/browser/tableCaretFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.woff2': 'file' }, assetNames: 'assets/[name]', plugins: [katexFontStrip] })
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
  for (const scenario of ['horizontal-wrap', 'horizontal-wrap-empty', 'vertical-inside', 'vertical-outside', 'vertical-empty', 'vertical-wrapped', 'enter-cell', 'enter-empty', 'enter-body', 'enter-middle', 'enter-repeat', 'enter-code', 'enter-code-start', 'enter-code-end', 'enter-ime', 'drag-row', 'drag-column', 'drag-table-outside']) {
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
      } else if (scenario.startsWith('drag-')) {
        // #57：真实鼠标拖选（page.mouse）建立跨格/整表选区，再以原生按键删除。
        const gridState = () => page.evaluate(() => ({
          ...window.readEditor(),
          rows: document.querySelectorAll('.vsidian-table-grid-row').length,
          delimiterHidden: getComputedStyle(document.querySelector('.vsidian-table-grid-delimiter') ?? document.body).display === 'none',
        }))
        const dragTo = async (from, to) => {
          await page.mouse.move(from.x, from.y)
          await page.mouse.down()
          await page.mouse.move(to.x, to.y, { steps: 6 })
          await page.mouse.up()
        }
        if (scenario === 'drag-row') {
          const a = await cell(1, 0).boundingBox()
          const b = await cell(1, 1).boundingBox()
          await dragTo({ x: a.x + 14, y: a.y + a.height / 2 },
            { x: b.x + 26, y: b.y + b.height / 2 })
          const rowAt = source.indexOf('| B1 | B2 |')
          const sel = await gridState()
          assert(sel.from >= rowAt + 1 && sel.from <= rowAt + 5,
            `拖选头应落在 B1 格内: ${JSON.stringify(sel)}`)
          assert(sel.to >= rowAt + 6 && sel.to <= rowAt + 10,
            `拖选尾应跨到 B2 格内: ${JSON.stringify(sel)}`)
          assert(sel.to > sel.from, '拖选选区应已建立')
          await page.keyboard.press('Backspace')
          const after = await gridState()
          assert(!after.text.includes('B1') && !after.text.includes('B2'),
            `同行跨格删除应清掉两格可见内容: ${JSON.stringify(after)}`)
          assert(after.rows === 3 && after.delimiterHidden, '删除后网格与隐藏分隔行保持')
          assert(after.text.includes('H1') && after.text.includes('C1') && after.text.includes('C2'),
            '未选中的格不受影响')
        } else if (scenario === 'drag-column') {
          const a = await cell(1, 0).boundingBox()
          const b = await cell(2, 0).boundingBox()
          await dragTo({ x: a.x + 14, y: a.y + a.height / 2 },
            { x: b.x + 26, y: b.y + b.height / 2 })
          const bRow = source.indexOf('| B1 | B2 |')
          const cRow = source.indexOf('| C1 | C2 |')
          const sel = await gridState()
          assert(sel.from >= bRow + 1 && sel.from <= bRow + 5,
            `拖选头应落在 B1 格内: ${JSON.stringify(sel)}`)
          assert(sel.to >= cRow + 1 && sel.to <= cRow + 5,
            `拖选尾应跨行落到 C1 格内: ${JSON.stringify(sel)}`)
          await page.keyboard.press('Backspace')
          const after = await gridState()
          assert(!after.text.includes('B1') && !after.text.includes('B2') && !after.text.includes('C1'),
            `同列跨行删除应清掉覆盖行各格可见内容: ${JSON.stringify(after)}`)
          assert(after.rows === 3 && after.delimiterHidden, '删除后网格与隐藏分隔行保持')
          assert(after.text.includes('H1') && after.text.includes('H2') && after.text.includes('C2'),
            '未选中的格不受影响')
        } else {
          // drag-table-outside：表外文本发起、横跨整表拖选，一次 Delete 移除整表
          const beforeLine = page.locator('.cm-line').filter({ hasText: /^BEFORE$/ })
          const afterLine = page.locator('.cm-line').filter({ hasText: /^AFTER$/ })
          const a = await beforeLine.boundingBox()
          const b = await afterLine.boundingBox()
          await dragTo({ x: a.x + a.width - 6, y: a.y + a.height / 2 },
            { x: b.x + 4, y: b.y + b.height / 2 })
          const sel = await gridState()
          assert(sel.from <= source.indexOf('H1') && sel.to >= source.indexOf('C2'),
            `拖选应横跨整表: ${JSON.stringify(sel)}`)
          await page.keyboard.press('Delete')
          const state = await gridState()
          assert(!state.text.includes('|') && !state.text.includes('---'),
            `整表删除后不得残留表格源码: ${JSON.stringify(state)}`)
          assert(state.text.startsWith('BEFOR') && state.text.endsWith('FTER'),
            `表格前后正文按选区保留（选区端点所在字符按所见即所删）: ${JSON.stringify(state)}`)
          assert(state.rows === 0, '表格 DOM 应随整块删除消失')
        }
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
  // ---- #59 公式输入回归：进入/编辑/离开、IME、粘贴、删除、块级与普通美元 ----
  const mathFailures = []
  for (const scenario of ['render-toggle', 'inline-edit', 'inline-ime', 'inline-paste',
    'block-edit', 'dollar-plain', 'undo-redo-text', 'multi-math']) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.setContent('<div id="app"></div>')
      await page.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
      await page.addScriptTag({ path: bundle })
      const source = '价格 $x^2$ 元\n\n$$\nE=mc^2\n$$\n\n花费 $5，合计 $10\n\n$a$ 与 $b$'
      await page.evaluate((text) => window.initTable(text), source)
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const mathState = () => page.evaluate(() => ({
        rendered: document.querySelectorAll('.cm-content .vsidian-math').length,
        renderedKatex: document.querySelectorAll('.cm-content .vsidian-math .katex').length,
        renderedBlock: document.querySelectorAll('.cm-content .vsidian-math-block').length,
        error: document.querySelectorAll('.cm-content .vsidian-math-error').length,
        source: document.querySelectorAll('.cm-content .vsidian-math-source').length,
        text: window.readEditor().text,
        head: window.readEditor().head,
      }))
      const locate = (offset) => page.evaluate(
        o => window.controller.handleHostMessage({ kind: 'view.locate', offset: o }), offset)
      // view.locate 只移动光标不给 contentDOM 焦点：键盘场景先点击行首聚焦
      //（x=5 落在行首文字前，不会定位进公式区间）
      const focusEditor = () => page.locator('.cm-line').first()
        .click({ position: { x: 5, y: 8 } }).then(() => locate(0))
      const inlineAt = source.indexOf('$x^2$')
      const blockAt = source.indexOf('$$')
      if (scenario === 'render-toggle') {
        // 初始（光标在文档首，不触及公式）：渲染态存在且真实绘制（有面积）
        const initial = await mathState()
        assert(initial.rendered >= 3, `渲染态公式数: ${JSON.stringify(initial)}`)
        assert(initial.renderedKatex === initial.rendered, '渲染态必须含 KaTeX 结构')
        assert.equal(initial.renderedBlock, 1, '块级公式单独计数')
        assert.equal(initial.error, 0, '合法公式无降级')
        const painted = await page.evaluate(() => {
          const el = document.querySelector('.cm-content .vsidian-math')
          const rect = el?.getBoundingClientRect()
          return rect ? rect.width > 0 && rect.height > 0 : false
        })
        assert(painted, '渲染态公式必须真实绘制（rect 有面积）')
        // 光标进入行内公式 → 源码显形；离开 → 恢复渲染
        await locate(inlineAt + 2)
        const editing = await mathState()
        assert(editing.source >= 1 && editing.rendered === editing.renderedKatex &&
          editing.rendered + editing.source === initial.rendered, `进入后: ${JSON.stringify(editing)}`)
        await locate(0)
        const left = await mathState()
        assert.equal(left.source, 0, '离开公式后不得残留源码态')
        assert.equal(left.rendered, initial.rendered, '离开后渲染态恢复')
        assert.equal(left.text, source, '切换显隐不得改写源文')
      } else if (scenario === 'inline-edit') {
        await focusEditor()
        await locate(inlineAt + 4) // 光标在 x^2 的 2 后
        await page.keyboard.type('+1')
        const typed = await mathState()
        assert.equal(typed.text, source.replace('$x^2$', '$x^2+1$'), '行内编辑写回源文')
        await locate(0)
        const restored = await mathState()
        assert(restored.rendered >= 1 && restored.error === 0, '编辑后合法公式仍渲染')
        // 删除恢复
        await locate(inlineAt + 6)
        await page.keyboard.press('Backspace')
        await page.keyboard.press('Backspace')
        assert.equal((await mathState()).text, source, '退格删除恢复原文')
      } else if (scenario === 'inline-ime') {
        await focusEditor()
        await locate(inlineAt + 4)
        const cdp = await page.context().newCDPSession(page)
        for (const text of ['go', 'gong']) {
          await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length })
          const composing = await mathState()
          assert(composing.text.includes(`$x^2${text}$`), `IME 候选 ${text} 写入公式: ${composing.text}`)
          assert(composing.source >= 1, '组合期间保持源码态可编辑')
        }
        await cdp.send('Input.insertText', { text: '功' })
        const committed = await mathState()
        assert(committed.text.includes('$x^2功$'), 'IME 确认写入公式')
        assert.equal(committed.text, source.replace('$x^2$', '$x^2功$'), '未触碰文本不被规范化')
        await locate(0)
        const after = await mathState()
        assert(after.rendered >= 1 && after.error === 0, 'IME 提交后公式恢复渲染（中文在数学模式静默渲染）')
        // 退格删除中文输入恢复
        await locate(inlineAt + 5)
        await page.keyboard.press('Backspace')
        assert.equal((await mathState()).text, source, '删除 IME 输入恢复原文')
      } else if (scenario === 'inline-paste') {
        await focusEditor()
        await locate(inlineAt + 4)
        await page.keyboard.insertText('^2_3')
        const pasted = await mathState()
        assert(pasted.text.includes('$x^2^2_3$'), '粘贴文本进入公式')
        await locate(0)
        const r = await mathState()
        assert(r.rendered >= 1, '粘贴后其他公式仍渲染')
        // 粘贴造成非法公式（^ 重复）时该公式降级但不丢内容
        assert.equal((await mathState()).text, source.replace('$x^2$', '$x^2^2_3$'))
      } else if (scenario === 'block-edit') {
        await focusEditor()
        const eAt = blockAt + source.slice(blockAt).indexOf('E')
        await locate(eAt + 1) // 光标在 E 后
        const editing = await mathState()
        assert(editing.source >= 1, '光标进入块级公式显源码')
        await page.keyboard.type('2')
        const typed = await mathState()
        assert.equal(typed.text, source.replace('E=mc^2', 'E2=mc^2'), '块内输入精确写回')
        await page.keyboard.press('Backspace')
        await locate(0)
        const restored = await mathState()
        assert.equal(restored.text, source, '块内删除恢复原文')
        assert.equal(restored.renderedBlock, 1, '块级公式恢复渲染')
      } else if (scenario === 'dollar-plain') {
        // 普通美元与代码区不渲染、不影响公式
        const s = await mathState()
        const plainStart = source.indexOf('花费')
        for (const at of [plainStart + 3, plainStart + 10]) {
          await locate(at)
          const st = await mathState()
          assert.equal(st.source, 0, '普通美元区间不得显公式源码态')
        }
        await locate(0)
        assert((await mathState()).rendered >= 3, '公式渲染不受普通美元干扰')
        void s
      } else if (scenario === 'undo-redo-text') {
        await focusEditor()
        // 撤销/重做的权威栈在宿主（本装配无宿主）：此处钉「编辑序列后原文可
        // 由等量退格复原」——等价校验输入事务的可逆性不依赖宿主历史
        await locate(inlineAt + 4)
        await page.keyboard.type('abc')
        for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
        assert.equal((await mathState()).text, source, '逐字退格完全复原输入')
        await locate(0)
        assert((await mathState()).rendered >= 3, '复原后渲染态完整')
      } else if (scenario === 'multi-math') {
        // 相邻公式互不吞并：两个行内公式中间的文本可编辑
        const between = source.indexOf(' 与 ') + 1 // '与' 字符位
        await focusEditor()
        await locate(between)
        await page.keyboard.type('Z')
        const typed = await mathState()
        assert.equal(typed.text, source.replace(' 与 ', ' Z与 '), '相邻公式间输入只改目标位置')
        await page.keyboard.press('Backspace')
        assert.equal((await mathState()).text, source, '相邻公式间编辑可复原')
      }
      assert.deepEqual(errors, [])
      passed++
      console.log(`[原生输入][PASS] math/${scenario}`)
    } catch (error) {
      mathFailures.push(error)
      console.error(`[原生输入][FAIL] math/${scenario}: ${error.message}`)
    } finally { await page.close() }
  }
  if (mathFailures.length) throw new AggregateError(mathFailures, '公式输入回归失败')
  if (navigationFailures.length) throw new AggregateError(navigationFailures, '表格方向键导航回归失败')
  console.log(`[原生输入] ${passed} 项通过`)
} finally { await browser.close() }
