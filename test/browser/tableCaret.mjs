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

// ---- #60 Mermaid 渲染回归（文件末尾追加段；独立浏览器实例 + 复刻 webview CSP 的页面）----
// 关键验证目标：mermaid 独立产物经懒加载链路（URI 注入 → 按需 <script>）在
// 与宿主 webview 同款的 CSP（无 unsafe-eval、script-src 'self'+nonce）下真实
// 渲染；live/阅读双模式、源码编辑重渲染、无效语法降级、同源多图 id 唯一、
// 图内链接不跳转、明暗主题重渲染。真实 mermaid 11.12.2，非 mock。
import http from 'node:http'

const mermaidArtifact = path.join(root, 'out/test/browser/mermaid.js')
await build({
  // 生产同构：与 esbuild.mjs 的 mermaid target 同入口同配置（ESM 源打包，
  // 官方 UMD 的模块作用域全局自赋值会落空，见 mermaidEntry.ts 头注释）
  entryPoints: [path.join(root, 'src/webview/mermaidEntry.ts')],
  outfile: mermaidArtifact, bundle: true, platform: 'browser', format: 'iife',
  target: 'chrome118', minify: true, sourcemap: false, logLevel: 'silent',
})
const browserOutDir = path.join(root, 'out/test/browser')
const serveOutFile = async (res, rel) => {
  const file = path.join(browserOutDir, rel)
  try {
    const data = await readFile(file) // 文件顶部的 node:fs/promises 版本
    res.writeHead(200, {
      'content-type': rel.endsWith('.css') ? 'text/css'
        : rel.endsWith('.html') ? 'text/html'
          : 'text/javascript',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}
// CSP 复刻（与 textEditorProvider.buildWebviewHtml 同形）：default-src 'none'、
// script-src 'self' + nonce（nonce 放行 URI 注入内联脚本——宿主同款机制）、
// style-src 'unsafe-inline'（CM6 与 mermaid SVG 内嵌样式）、无 unsafe-eval
const mermaidNonce = 'vsidian-mermaid-test-nonce'
const mermaidPageHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'nonce-${mermaidNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; font-src 'self'">
<link rel="stylesheet" href="/tableCaret.css">
</head><body><div id="app"></div>
<script nonce="${mermaidNonce}">window.__vsidianMermaidUri = "/mermaid.js";</script>
<script nonce="${mermaidNonce}" src="/tableCaret.js"></script>
</body></html>`
const mermaidServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(mermaidPageHtml)
    return
  }
  void serveOutFile(res, url.pathname.slice(1))
})
await new Promise((resolve) => mermaidServer.listen(0, '127.0.0.1', resolve))
const mermaidBase = `http://127.0.0.1:${mermaidServer.address().port}`

const mermaidBrowser = await chromium.launch({
  headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined,
})
const MERMAID_DOC = [
  '# 图表演例', '',
  '```mermaid', 'graph TD', 'A[开始]-->B[结束]', '```', '',
  '正文段落一。', '',
  '```mermaid', 'sequenceDiagram', 'Alice->>Bob: 你好', 'Bob-->>Alice: 很好', '```', '',
  '```mermaid', 'flowchart LR', 'X-->Y', '```', '',
  '```mermaid', 'flowchart LR', 'X-->Y', '```', '',
  '语法错误样例：', '',
  '```mermaid', '这不是合法图表语法', '```', '',
  '结尾段落保持可用。',
].join('\n')
const mermaidFailures = []
let mermaidPassed = 0
try {
  for (const scenario of ['live-render', 'edit-rerender', 'reading-mode', 'no-navigation', 'theme-rerender']) {
    const page = await mermaidBrowser.newPage()
    // 高视口：CM6 widget 只在可见区物化——图渲染后高度扩张会把后续围栏推出
    // 默认 720px 视口，widget 永不创建导致等待超时；拉高视口让全部图可见
    await page.setViewportSize({ width: 1280, height: 2600 })
    const errors = []
    const consoleErrors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (msg) => {
      const text = msg.text()
      // favicon 请求被 default-src 'none' 拦截属页面副作用，与渲染无关
      if (msg.type() === 'error' && !/favicon/i.test(text)) {
        consoleErrors.push(text)
      }
    })
    try {
      await page.goto(mermaidBase + '/')
      await page.waitForFunction(() => typeof window.initTable === 'function')
      await page.evaluate((text) => window.initTable(text), MERMAID_DOC)
      const states = () => page.evaluate(() => {
        const readingActive = document.querySelector('.vsidian-view-reading').style.display !== 'none'
        const scope = readingActive
          ? document.querySelector('.vsidian-view-reading')
          : document.querySelector('.cm-content')
        return {
          rendered: scope.querySelectorAll('.vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length,
          pending: scope.querySelectorAll('.vsidian-mermaid[data-vsidian-mermaid-state="rendering"], .vsidian-mermaid[data-vsidian-mermaid-state="pending"]').length,
          degraded: scope.querySelectorAll('.vsidian-mermaid[data-vsidian-mermaid-state="error"]').length,
          svg: scope.querySelectorAll('.vsidian-mermaid svg').length,
          text: window.readEditor().text,
        }
      })
      const locate = (offset) => page.evaluate(
        (o) => window.controller.handleHostMessage({ kind: 'view.locate', offset: o }), offset)
      if (scenario === 'live-render') {
        // 流程图 + 时序图 + 同源相邻多图：4 个 rendered，1 个语法降级
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        const st = await states()
        assert.equal(st.rendered, 4, `渲染数: ${JSON.stringify(st)}`)
        assert.equal(st.degraded, 1, `语法错误图降级: ${JSON.stringify(st)}`)
        assert.equal(st.svg, 4, '渲染态必须含真实 SVG')
        assert.equal(st.text, MERMAID_DOC, '渲染不得改写源文')
        // 真实绘制（rect 有面积）+ SVG 宽度受容器约束
        const painted = await page.evaluate(() => {
          const el = document.querySelector('.cm-content .vsidian-mermaid svg')
          if (!el) return false
          const rect = el.getBoundingClientRect()
          const container = el.closest('.vsidian-mermaid').getBoundingClientRect()
          return rect.width > 0 && rect.height > 0 && rect.width <= container.width + 1
        })
        assert(painted, '图形必须真实绘制（rect 有面积且不超出容器宽）')
        // 懒加载链路：mermaid.js 注入且仅注入一次；全局可用
        const loaded = await page.evaluate(() => ({
          scripts: document.querySelectorAll('script[src$="/mermaid.js"]').length,
          api: typeof globalThis.mermaid === 'object' && typeof globalThis.mermaid.render === 'function',
        }))
        assert.equal(loaded.scripts, 1, 'mermaid.js 按需注入一次')
        assert(loaded.api, '全局 mermaid API 可用（懒加载完成）')
        // 同源相邻两图：文档内无重复 id（缓存克隆改写）
        const uniqueIds = await page.evaluate(() => {
          const ids = [...document.querySelectorAll('.vsidian-mermaid [id]')].map((el) => el.id)
          return { total: ids.length, unique: new Set(ids).size }
        })
        assert(uniqueIds.total > 0, '渲染产物应含内部 id')
        assert.equal(uniqueIds.unique, uniqueIds.total, '同源多图缓存复用不得产生重复 id')
        // 降级不吞后续块：结尾段落仍在
        const tail = await page.evaluate(() => {
          const lines = [...document.querySelectorAll('.cm-content .cm-line')]
          return lines.some((l) => l.textContent.includes('结尾段落保持可用'))
        })
        assert(tail, '语法错误图不吞掉后续正文块')
        // CSP 不得出现渲染被拦截的报错（无 unsafe-eval 下的真实渲染证明）
        assert.deepEqual(consoleErrors.filter((t) => /Content Security Policy/i.test(t)), [],
          `CSP 拦截了渲染资源: ${JSON.stringify(consoleErrors)}`)
      } else if (scenario === 'edit-rerender') {
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        await page.locator('.cm-line').first().click({ position: { x: 5, y: 8 } })
        const aAt = MERMAID_DOC.indexOf('A[开始]') + 1
        await locate(aAt)
        // 光标进入围栏：该图退场显源码，其余图不受影响
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid').length === 4)
        await page.keyboard.type('2')
        assert((await states()).text.includes('A2[开始]'), '围栏内输入精确写回')
        await locate(0)
        // 离开围栏：源码修改后的图重新渲染（缓存按新源文失效）
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        await locate(aAt + 1)
        await page.keyboard.press('Backspace')
        await locate(0)
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        assert.equal((await states()).text, MERMAID_DOC, '退格后围栏原文逐字节复原')
      } else if (scenario === 'reading-mode') {
        // 阅读模式：挂载块内渲染 + 模式切换一致性（切回 live 再渲染、零写回）
        await page.evaluate(() => window.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' }))
        await page.waitForFunction(() =>
          document.querySelectorAll('.vsidian-view-reading .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        const reading = await page.evaluate(() => {
          const scope = document.querySelector('.vsidian-view-reading')
          const svg = scope.querySelector('.vsidian-mermaid svg')
          const rect = svg?.getBoundingClientRect()
          return {
            degraded: scope.querySelectorAll('.vsidian-mermaid[data-vsidian-mermaid-state="error"]').length,
            painted: !!rect && rect.width > 0 && rect.height > 0,
          }
        })
        assert.equal(reading.degraded, 1, '阅读模式同样降级语法错误图')
        assert(reading.painted, '阅读模式图形真实绘制')
        await page.evaluate(() => window.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'live' }))
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        assert.equal((await states()).text, MERMAID_DOC, '模式切换不得改写文本')
      } else if (scenario === 'no-navigation') {
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        // 图内点击（节点区域）不产生导航；产物内无 javascript: 链接
        const urlBefore = page.url()
        await page.locator('.cm-content .vsidian-mermaid svg').first().click()
        await page.waitForTimeout(300)
        assert.equal(page.url(), urlBefore, '图内点击不得触发导航')
        const dangerous = await page.evaluate(() =>
          [...document.querySelectorAll('.vsidian-mermaid a[href]')]
            .filter((a) => (a.getAttribute('href') ?? '').trim().toLowerCase().startsWith('javascript:')).length)
        assert.equal(dangerous, 0, '渲染产物不得含 javascript: 链接')
      } else if (scenario === 'theme-rerender') {
        await page.waitForFunction(() =>
          document.querySelectorAll('.cm-content .vsidian-mermaid[data-vsidian-mermaid-state="rendered"]').length === 4,
          null, { timeout: 20000 })
        await page.evaluate(() => {
          window.__firstMermaidSvg = document.querySelector('.cm-content .vsidian-mermaid svg')
        })
        // 宿主主题 class 切换（webview 同款观察源）：dark 触发重渲染（新 SVG 实例）
        await page.evaluate(() => document.body.classList.add('vscode-dark'))
        await page.waitForFunction(() => {
          const svg = document.querySelector('.cm-content .vsidian-mermaid svg')
          return svg && svg !== window.__firstMermaidSvg
        }, null, { timeout: 20000 })
        // 切回亮色再次重渲染（第二次实例替换）
        await page.evaluate(() => {
          window.__secondMermaidSvg = document.querySelector('.cm-content .vsidian-mermaid svg')
          document.body.classList.remove('vscode-dark')
        })
        await page.waitForFunction(() => {
          const svg = document.querySelector('.cm-content .vsidian-mermaid svg')
          return svg && svg !== window.__firstMermaidSvg && svg !== window.__secondMermaidSvg
        }, null, { timeout: 20000 })
      }
      assert.deepEqual(errors, [], `页面异常: ${JSON.stringify(errors)}`)
      mermaidPassed++
      console.log(`[原生输入][PASS] mermaid/${scenario}`)
    } catch (error) {
      mermaidFailures.push(error)
      console.error(`[原生输入][FAIL] mermaid/${scenario}: ${error.message}`)
    } finally {
      await page.close()
    }
  }
} finally {
  await mermaidBrowser.close()
  mermaidServer.close()
}
if (mermaidFailures.length) throw new AggregateError(mermaidFailures, 'Mermaid 渲染回归失败')
console.log(`[原生输入] mermaid ${mermaidPassed} 项通过`)
