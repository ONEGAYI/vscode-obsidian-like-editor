// 大纲点击跳转与常驻高亮的原生浏览器回归（#66）：真实布局（Chromium）
// 下用真实鼠标点击与滚轮验证——jsdom 无布局测不了的居中滚动、视口顶行
// 计算与 CSS 半透明横条在此落地。与 tableCaret.mjs 同装配模式（esbuild
// 打包生产控制器 + 注入页面）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/outlineJump.js')
await build({ entryPoints: [path.join(root, 'test/browser/outlineJumpFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife' })

// 长文档：15 个一级标题 ×（3 段正文），标题行号可预期
// 标题 i（0 基）行号 = i*5 + 1：标题行 + 空行 + 三行正文
const HEADING_COUNT = 15
const DOC = Array.from({ length: HEADING_COUNT }, (_, i) =>
  [`# 章节 ${i + 1} 标题`, '', `第 ${i + 1} 节第一段正文。`, `第 ${i + 1} 节第二段正文。`, `第 ${i + 1} 节第三段正文。`, ''].join('\n'),
).join('\n')
const headingLine = (i) => i * 6 + 1 // 每节 6 行（含节尾空行）

const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
/** 推进 rAF + 宏任务交替帧（headless 页面空闲时不自动产生帧，定位链的
 *  帧+宏任务兜底（scheduleLocateSnap 等）需要测试显式驱动） */
async function settleFrames(page, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => new Promise((resolve) =>
      requestAnimationFrame(() => setTimeout(resolve, 0))))
  }
  await page.waitForTimeout(60)
}
let passed = 0
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 560 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setContent('<div id="app"></div>')
  await page.addStyleTag({ content: 'html, body { margin: 0; height: 100%; }' })
  await page.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
  await page.addScriptTag({ path: bundle })
  await page.evaluate((text) => window.initOutline(text), DOC)
  // 展开右侧栏（sidebarOpen 缺省收起；outlineActive 缺省激活）
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
  await page.locator('.vsidian-outline-item').first().waitFor()
  const itemCount = await page.locator('.vsidian-outline-item').count()
  assert.equal(itemCount, HEADING_COUNT, '大纲条目数应等于标题数')

  // ---- 场景 A：live 点击跳转（光标落标题行首 + 居中 + 高亮即时落位）----
  const target = page.locator('.vsidian-outline-item').nth(9)
  await target.click()
  const caret = await page.evaluate(() => window.readCaret())
  assert.equal(caret.line, headingLine(9), `点击第 10 条后光标应在标题行（第 ${headingLine(9)} 行），实际第 ${caret.line} 行`)
  assert.equal(caret.text, DOC, '跳转不得修改源文')
  // 光标真实绘制且接近视口中部（scrollIntoView y:'center' 语义；滚动在
  // CM6 下次布局测量时应用，等双帧后读）
  await page.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const caretBox = await page.evaluate(() => {
    const sel = getSelection()
    const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null
    return rect ? { top: rect.top, height: rect.height } : null
  })
  assert(caretBox && caretBox.height > 0, '光标须有可见高度（真实绘制）')
  assert(Math.abs(caretBox.top + caretBox.height / 2 - 560 / 2) < 560 / 3,
    `光标应接近视口中部（scrollIntoView center），实际 top=${caretBox?.top}`)
  // 高亮即时落位：located = 被点击条目，computed 背景为半透明色
  const afterJump = await page.evaluate(() => window.readOutline())
  assert.equal(afterJump.locatedIndex, 9, `跳转后高亮应在第 10 条（实际 ${afterJump.locatedIndex}）`)
  assert.match(afterJump.locatedBackground ?? '', /^rgba\(/,
    `高亮条目须有 rgba 半透明背景（实际 ${afterJump.locatedBackground}）`)
  const alpha = Number.parseFloat((afterJump.locatedBackground?.match(/,\s*([\d.]+)\)$/) ?? [])[1] ?? '1')
  assert(alpha > 0 && alpha < 1, `半透明横条的 alpha 应在 (0,1)（实际 ${alpha}）`)
  // 非高亮条目无背景（两态差异唯一来源是 located 规则）
  const firstBg = await page.evaluate(() =>
    getComputedStyle(document.querySelectorAll('.vsidian-outline-item')[0]).backgroundColor)
  assert.equal(firstBg, 'rgba(0, 0, 0, 0)', `非 located 条目不得有背景（实际 ${firstBg}）`)

  // ---- 场景 B：护栏——跳转的程序性滚动不反向改写高亮 ----
  // 居中滚动后视口顶行在目标标题上方（属上一控制域）；护栏吞掉程序性
  // 滚动事件，500ms 后高亮仍是目标条目（若无护栏会重算到上一节）
  await page.waitForTimeout(500)
  const guarded = await page.evaluate(() => window.readOutline())
  assert.equal(guarded.locatedIndex, 9,
    `跳转引发的程序性滚动不得改写高亮（实际 ${guarded.locatedIndex}；无护栏时会被视口顶行重算到第 9 条的控制域）`)
  passed++
  console.log('[大纲回归][PASS] live 跳转居中 + 高亮即时落位 + 防抖动护栏')

  // ---- 场景 C：用户滚动恢复联动（视口顶部行驱动重算）----
  // 滚到文档顶部：高亮应重算为首标题（用户滚动正常驱动）
  await page.locator('.cm-editor').first().click({ position: { x: 200, y: 300 } })
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -600)
  await page.waitForTimeout(300)
  const scrolled = await page.evaluate(() => window.readOutline())
  assert.equal(scrolled.locatedIndex, 0,
    `滚到顶部后高亮应为首标题条目（实际 ${scrolled.locatedIndex}）`)
  // 再向下滚动数屏：高亮应离开首条（跟随视口顶行）
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 800)
  await page.waitForTimeout(300)
  const scrolledDown = await page.evaluate(() => window.readOutline())
  assert(scrolledDown.locatedIndex >= 1,
    `向下滚动后高亮应跟随视口顶行离开首条（实际 ${scrolledDown.locatedIndex}）`)
  passed++
  console.log('[大纲回归][PASS] 用户滚动恢复联动（视口顶部行驱动高亮重算）')

  // ---- 场景 D：reading 点击跳转（滚动到块 + 高亮跟随锚点）----
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'reading' }))
  await page.locator('.vsidian-reading-block h1').first().waitFor()
  await settleFrames(page)
  // 视口先滚到顶部（reading 重进后的锚点恢复不受影响：点击是显式意图）
  const readingTarget = page.locator('.vsidian-outline-item').nth(13)
  await readingTarget.click()
  await settleFrames(page)
  // 目标标题块应滚进视口且落在上半视区（scrollToSrcStart 语义；虚拟化
  // 高度表的估计残差使块顶不必精确贴容器顶——与集成断言口径一致：
  // 锚点正确 + 目标块挂载可见 + 发生了滚动）
  const blockTop = await page.evaluate(() => {
    const container = document.querySelector('.vsidian-view-reading')
    const heads = [...container.querySelectorAll('h1')]
    const target = heads.find((h) => h.textContent?.includes('章节 14'))
    if (!target) return null
    const block = target.closest('[data-vsidian-src-start]')
    return { top: block.getBoundingClientRect().top, containerTop: container.getBoundingClientRect().top,
      clientH: container.clientHeight, scrollTop: container.scrollTop }
  })
  assert(blockTop, '应能找到「章节 14」标题块')
  assert(blockTop.top >= blockTop.containerTop - 2 &&
    blockTop.top < blockTop.containerTop + blockTop.clientH / 2,
    `reading 点击后目标块应滚进上半视区（块 top=${blockTop.top}，容器 top=${blockTop.containerTop}，` +
      `clientH=${blockTop.clientH}，scrollTop=${blockTop.scrollTop}）`)
  assert(blockTop.scrollTop > 200, `reading 跳转应发生显著滚动（scrollTop=${blockTop.scrollTop}）`)
  const readingState = await page.evaluate(() => ({ outline: window.readOutline(), text: window.readCaret().text }))
  assert.equal(readingState.outline.locatedIndex, 13,
    `reading 跳转后高亮应为目标条目（实际 ${readingState.outline.locatedIndex}）`)
  assert.equal(readingState.text, DOC, 'reading 跳转零写回')
  passed++
  console.log('[大纲回归][PASS] reading 跳转滚动到块 + 高亮跟随锚点')

  // ---- 场景 E：reading 滚动联动 + 模式切换即时重算 ----
  // 鼠标先移进阅读区（此前点击大纲条目的指针位置在侧栏，滚轮不会到达
  // reading 容器）
  await page.mouse.move(400, 300)
  for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -600)
  await settleFrames(page, 6)
  const topReading = await page.evaluate(() => window.readOutline())
  assert.equal(topReading.locatedIndex, 0, `reading 滚到顶后高亮应为首条（实际 ${topReading.locatedIndex}）`)
  // 切回 live：即时重算（锚点恢复 + scrollIntoView 后按视口首行块重算）
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'view.mode.set', mode: 'live' }))
  await page.waitForTimeout(100)
  const backLive = await page.evaluate(() => window.readOutline())
  assert(backLive.locatedIndex !== null && backLive.locatedIndex >= 0,
    `切回 live 后应即时重算出 located（实际 ${backLive.locatedIndex}）`)
  passed++
  console.log('[大纲回归][PASS] reading 滚动联动 + 模式切换即时重算')

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[大纲回归] ${passed} 项通过`)
