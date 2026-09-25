// 大纲拖拽排序的原生浏览器回归（#70）：真实布局（Chromium）+ 真实鼠标
// （mouse.down/move/up）驱动拖拽——三态落点容差几何（上缘/中部/下缘）、
// 拖拽中源条目提示、落点指示真实绘制（dropHintPainted）、drop 单笔写回
// 全文对拍、Esc 取消零写回、无效落点（拖入自身子树）拒绝、搜索过滤隐藏
// 条目不构成落点。与 outlineMenu.mjs 同装配模式。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/outlineDrag.js')
await build({ entryPoints: [path.join(root, 'test/browser/outlineDragFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife' })

// 条目索引：0 甲(H1) 1 乙(H2) 2 丁(H4,跨级挂乙) 3 丙(H2) 4 戊(H1)
const DOC = [
  '# 甲',
  '甲内容',
  '## 乙',
  '乙内容',
  '#### 丁',
  '丁内容',
  '## 丙',
  '丙内容',
  '# 戊',
  '戊内容',
].join('\n')

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
  await page.evaluate((text) => window.initDrag(text), DOC)
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
  await page.locator('.vsidian-outline-item').first().waitFor()
  await page.waitForTimeout(120)
  const item = (n) => page.locator('.vsidian-outline-item').nth(n)

  /** 真实鼠标拖拽：按下 → 分步移动（触发 pointermove 序列）→ 停在目标三态区域 */
  const dragHover = async (from, to, zone) => {
    const fromBox = await item(from).boundingBox()
    const toBox = await item(to).boundingBox()
    assert.ok(fromBox && toBox, '拖拽双方条目应有布局盒')
    const x0 = fromBox.x + 40
    const y0 = fromBox.y + fromBox.height / 2
    const y = toBox.y + (zone === 'top' ? toBox.height * 0.1
      : zone === 'bottom' ? toBox.height * 0.9 : toBox.height / 2)
    const x = toBox.x + 60
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    // 分步移动（位移超阈值后进入拖拽态）
    for (let step = 1; step <= 4; step++) {
      await page.mouse.move(x0 + ((x - x0) * step) / 4, y0 + ((y - y0) * step) / 4)
    }
    return { x, y }
  }

  // ---- 场景 A：三态落点容差几何（真实鼠标 + 真实布局的 25% 容差）----
  for (const [zone, cls, position] of [
    ['top', 'vsidian-outline-drop-before', 'before'],
    ['middle', 'vsidian-outline-drop-inside', 'inside'],
    ['bottom', 'vsidian-outline-drop-after', 'after'],
  ]) {
    await dragHover(1, 4, zone) // 乙 → 戊（三态均可）
    const state = await page.evaluate(() => window.readDrag())
    assert.ok(state.itemClasses[1].includes('vsidian-outline-dragging'),
      `${zone} 落点：源条目应有 dragging 提示类（实际 ${state.itemClasses[1]}）`)
    assert.ok(state.itemClasses[4].includes(cls),
      `${zone} 落点：目标条目应带 ${cls}（实际 ${state.itemClasses[4]}）`)
    assert.equal(state.draggingIndex, 1, `${zone} 落点：probe draggingIndex`)
    assert.equal(state.dropTargetIndex, 4, `${zone} 落点：probe dropTargetIndex`)
    assert.equal(state.dropPosition, position, `${zone} 落点：probe dropPosition`)
    assert.equal(state.dropHintPainted, true,
      `${zone} 落点：落点指示应真实绘制（中心命中 + 样式差异可读）`)
    // Esc 释放本轮（探测性悬停不写回），再补 mouse.up 归位按键态
    await page.keyboard.press('Escape')
    await page.mouse.up()
    assert.equal((await page.evaluate(() => window.readDrag())).text, DOC,
      `${zone} 探测性悬停不得写回`)
    passed++
    console.log(`[拖拽回归][PASS] 三态落点几何：${zone} → ${position}（指示真实绘制）`)
  }

  // ---- 场景 B：drop 单笔写回（before：丁对齐戊层级）+ 大纲即时更新 ----
  {
    const { x, y } = await dragHover(2, 4, 'top')
    await page.mouse.move(x, y) // 停在上缘 before 落点
    await page.mouse.up()
    const state = await page.evaluate(() => window.readDrag())
    const edits = await page.evaluate(() => window.sent().filter((m) => m.kind === 'edit.request'))
    assert.equal(edits.length, 1, 'drop 应产生一笔 edit.request（单事务）')
    assert.equal(state.text,
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
      `before 落点全文对拍（实际 ${JSON.stringify(state.text)}）`)
    await page.waitForTimeout(400) // 250ms 去抖后大纲重建（写回路径已即时刷新，此处校验稳定态）
    const texts = await page.locator('.vsidian-outline-item').allTextContents()
    assert.deepEqual(texts.map((t) => t.trim()), ['甲', '乙', '丙', '丁', '戊'],
      `写回后大纲条目序应更新（实际 ${JSON.stringify(texts)}）`)
    passed++
    console.log('[拖拽回归][PASS] drop 单笔写回：调级对齐、全文对拍、大纲更新')
  }

  // ---- 场景 C：inside 落点（成为目标最后子级）----
  {
    // B 后条目序：0 甲 1 乙 2 丙 3 丁 4 戊；戊(index 4) → 丙(index 2) 中部
    const { x, y } = await dragHover(4, 2, 'middle')
    await page.mouse.move(x, y)
    await page.mouse.up()
    const state = await page.evaluate(() => window.readDrag())
    assert.equal(state.text,
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n### 戊\n戊内容\n# 丁\n丁内容\n',
      `inside 落点全文对拍（实际 ${JSON.stringify(state.text)}）`)
    passed++
    console.log('[拖拽回归][PASS] inside 落点：成为目标最后子级（level+1）')
  }

  // ---- 场景 D：Esc 取消（真实键盘，零写回）----
  {
    const before = (await page.evaluate(() => window.readDrag())).text
    await dragHover(1, 4, 'bottom')
    await page.keyboard.press('Escape')
    const state = await page.evaluate(() => window.readDrag())
    assert.equal(state.draggingIndex, null, 'Esc 后拖拽态应退出')
    assert.ok(state.itemClasses.every((c) => !c.includes('vsidian-outline-drop-') && !c.includes('vsidian-outline-dragging')),
      `Esc 后指示类应清除（实际 ${JSON.stringify(state.itemClasses)}）`)
    assert.equal(state.text, before, 'Esc 取消不得写回')
    // Esc 后鼠标按键仍是按下态（真实浏览器），补一次 mouse.up 收尾
    await page.mouse.up()
    passed++
    console.log('[拖拽回归][PASS] Esc 取消：状态清空、零写回')
  }

  // ---- 场景 E：无效落点（拖入自身子树）：无指示、drop 零写回 ----
  {
    const before = (await page.evaluate(() => window.readDrag())).text
    const editsBefore = await page.evaluate(() => window.sent().filter((m) => m.kind === 'edit.request').length)
    // 当前条目序（场景 C 后）：0 甲 1 乙 2 丙 3 戊 4 丁；甲(H1) 的子树 =
    // [甲,乙,丙,戊]（乙丙戊全挂甲下；丁为同级 H1 不在其内）→ 目标乙在子树内
    const { x, y } = await dragHover(0, 1, 'middle') // 甲 → 乙（自身子级）
    let state = await page.evaluate(() => window.readDrag())
    assert.equal(state.draggingIndex, 0, '拖拽源有效（甲）')
    assert.equal(state.dropTargetIndex, null, '目标在自身子树内应无有效落点')
    assert.ok(state.itemClasses.every((c) => !c.includes('vsidian-outline-drop-')),
      '无效落点不得显示指示')
    await page.mouse.move(x, y)
    await page.mouse.up()
    const editsAfter = await page.evaluate(() => window.sent().filter((m) => m.kind === 'edit.request').length)
    assert.equal(editsAfter, editsBefore, '无效落点 drop 不得写回')
    assert.equal((await page.evaluate(() => window.readDrag())).text, before, '文档保持不变')
    passed++
    console.log('[拖拽回归][PASS] 无效落点：拖入自身子树拒绝（无指示、零写回）')
  }

  // ---- 场景 F：搜索态下的拖拽（可见目标间写回 + 搜索过滤保持）----
  {
    await page.evaluate(() => window.controller.handleHostMessage(
      { kind: 'outline.test.searchInput', text: '戊' })) // 保留 戊 + 祖先（甲丙）
    const hidden = await item(1).evaluate((el) => getComputedStyle(el).display)
    assert.equal(hidden, 'none', '被搜索过滤的乙应 display:none（不可见条目不可拖不落点）')
    // 当前条目序：0 甲 1 乙 2 丙 3 戊 4 丁；戊(index 3) → 甲(index 0) 上缘
    const { x, y } = await dragHover(3, 0, 'top')
    await page.mouse.move(x, y)
    await page.mouse.up()
    const state = await page.evaluate(() => window.readDrag())
    assert.equal(state.text,
      '# 戊\n戊内容\n# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n',
      `搜索态拖拽写回全文对拍（实际 ${JSON.stringify(state.text)}）`)
    // 搜索态随写回存活：词条保持、过滤对新序列重算（戊升至首位且无祖先）
    await page.evaluate(() => window.controller.handleHostMessage({ kind: 'view.state.request' }))
    const probe = await page.evaluate(() =>
      [...window.sent()].reverse().find((m) => m.kind === 'view.state'))
    assert.equal(probe.outline.searchQuery, '戊', '写回后搜索词条保持')
    assert.equal(probe.outline.searchActive, true, '搜索态保持')
    assert.deepEqual(probe.outline.filteredVisibleIndices, [0],
      `过滤可见集应重算为仅命中戊（实际 ${JSON.stringify(probe.outline.filteredVisibleIndices)}）`)
    await page.evaluate(() => window.controller.handleHostMessage(
      { kind: 'outline.test.searchInput', text: '' }))
    passed++
    console.log('[拖拽回归][PASS] 搜索态拖拽：写回正确、过滤态存活重算')
  }

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[拖拽回归] ${passed} 项通过`)
