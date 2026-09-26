// 大纲右键菜单的原生浏览器回归（#69）：真实布局（Chromium）下用真实右键、
// hover 与键盘验证——菜单浮层真实绘制与定位（不遮挡目标条目、右缘不越界）、
// 级联子菜单 :hover 展开、Esc 关闭、重命名 Enter 真实键盘链路、删除整控制
// 域后的文档文本对拍。与 outlineCollapse.mjs 同装配模式。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/outlineMenu.js')
await build({ entryPoints: [path.join(root, 'test/browser/outlineMenuFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })

// 样例：0 主(H1) 1 Alpha(H2) 2 Alpha子(H3) 3 Beta(H2) 4 Beta深(H4 跨级) 5 第二顶(H1)
const DOC = [
  '# 主标题',
  '主标题内容',
  '## Alpha',
  'Alpha 内容',
  '### Alpha 子',
  '子内容',
  '## Beta',
  'Beta 内容',
  '#### Beta 深',
  '深内容',
  '# 第二顶',
  '内容',
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
  await page.evaluate((text) => window.initMenu(text), DOC)
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
  await page.locator('.vsidian-outline-item').first().waitFor()
  await page.waitForTimeout(120)
  const item = (n) => page.locator('.vsidian-outline-item').nth(n)

  // ---- 场景 A：真实右键弹出菜单 + 绘制与定位（不遮挡目标、右缘不越界） ----
  await item(1).click({ button: 'right', position: { x: 80, y: 8 } })
  let state = await page.evaluate(() => window.readMenu())
  assert.ok(state.menuRect, '右键后菜单应有布局盒（真实绘制）')
  assert.ok(state.menuRect.width > 100 && state.menuRect.height > 80,
    `菜单应有实质尺寸（实际 ${state.menuRect.width}x${state.menuRect.height}）`)
  assert.ok(state.commands.includes('delete') && state.commands.includes('copyLink') && state.commands.includes('rename'),
    `菜单应含全部命令（实际 ${JSON.stringify(state.commands)}）`)
  // 不遮挡目标：菜单顶边在目标条目底边之下（让位语义）
  const item1Box = await item(1).boundingBox()
  assert.ok(item1Box, '目标条目应有布局盒')
  assert.ok(state.menuRect.y >= item1Box.y + item1Box.height - 1,
    `菜单应让位到条目下方不遮挡目标（menu.y=${state.menuRect.y} 条目 bottom=${item1Box.y + item1Box.height}）`)
  // 右缘不越界：菜单右边缘不超过侧栏右缘
  assert.ok(state.menuRect.x + state.menuRect.width <= state.sidebarRect.x + state.sidebarRect.width + 1,
    `菜单不得越出侧栏右缘（menu.right=${state.menuRect.x + state.menuRect.width} sidebar.right=${state.sidebarRect.x + state.sidebarRect.width}）`)
  // 浏览器原生菜单被拦截（preventDefault 后无默认上下文菜单——以默认动作取消为准）
  passed++
  console.log('[菜单回归][PASS] 真实右键弹出菜单：绘制、让位不遮挡、右缘 clamp')

  // ---- 场景 B：hover 级联子菜单展开（:hover 显隐唯一开关） ----
  const subBefore = await page.evaluate(() => window.readMenu().submenuDisplay)
  assert.ok(subBefore.every((d) => d === 'none'), `子菜单默认应隐藏（实际 ${JSON.stringify(subBefore)}）`)
  await page.locator('.vsidian-outline-menu button[data-vsidian-command="copy"]').hover()
  await page.waitForTimeout(80)
  state = await page.evaluate(() => window.readMenu())
  assert.ok(state.submenuDisplay.some((d) => d === 'block'),
    `hover 复制父项后子菜单应展开（实际 ${JSON.stringify(state.submenuDisplay)}）`)
  passed++
  console.log('[菜单回归][PASS] hover 级联子菜单：默认隐藏、悬停父项展开')

  // ---- 场景 C：子菜单真实点击复制标题（剪贴板桥出站 plainText） ----
  await page.locator('.vsidian-outline-menu button[data-vsidian-command="copyHeading"]').click()
  state = await page.evaluate(() => window.readMenu())
  assert.equal(state.menuExists, false, '命令执行后菜单应关闭')
  const sent = await page.evaluate(() => window.sent())
  const clip = sent.filter((m) => m.kind === 'clipboard.write').at(-1)
  assert.deepEqual(clip, { kind: 'clipboard.write', text: 'Alpha' }, `复制标题应出站 plainText（实际 ${JSON.stringify(clip)}）`)
  passed++
  console.log('[菜单回归][PASS] 子菜单真实点击：复制标题经剪贴板桥出站、菜单关闭')

  // ---- 场景 D：Esc 键盘关闭 + 键盘可达（菜单项为 button 可聚焦） ----
  await item(2).click({ button: 'right', position: { x: 80, y: 8 } })
  await page.keyboard.press('Escape')
  state = await page.evaluate(() => window.readMenu())
  assert.equal(state.menuExists, false, 'Esc 应关闭菜单')
  passed++
  console.log('[菜单回归][PASS] Esc 键盘关闭菜单')

  // ---- 场景 E：重命名真实键盘链路（input + 键入 + Enter 写回） ----
  await item(3).click({ button: 'right', position: { x: 80, y: 8 } })
  await page.locator('.vsidian-outline-menu button[data-vsidian-command="rename"]').click()
  const input = page.locator('.vsidian-outline-rename-input')
  await input.waitFor()
  state = await page.evaluate(() => window.readMenu())
  assert.equal(state.inputValue, 'Beta', `重命名输入框初值应为原文（实际 ${state.inputValue}）`)
  await input.fill('Beta 改名')
  await input.press('Enter')
  state = await page.evaluate(() => window.readMenu())
  assert.ok(state.text.includes('## Beta 改名'), `Enter 提交应写回整行（实际片段缺失）`)
  assert.equal(state.inputExists, false, '提交后编辑态应退出')
  await page.waitForTimeout(400) // 250ms 去抖后大纲重建
  const itemTexts = await page.locator('.vsidian-outline-item').allTextContents()
  assert.ok(itemTexts.some((t) => t.includes('Beta 改名')), `大纲条目应更新（实际 ${JSON.stringify(itemTexts)}）`)
  passed++
  console.log('[菜单回归][PASS] 重命名：输入框原文初值、真实键入、Enter 写回、大纲更新')

  // ---- 场景 F：Esc 取消重命名（零写回） ----
  await item(3).click({ button: 'right', position: { x: 80, y: 8 } })
  await page.locator('.vsidian-outline-menu button[data-vsidian-command="rename"]').click()
  await page.locator('.vsidian-outline-rename-input').fill('不该出现')
  await page.locator('.vsidian-outline-rename-input').press('Escape')
  state = await page.evaluate(() => window.readMenu())
  assert.ok(!state.text.includes('不该出现'), 'Esc 取消不得写回')
  assert.ok(state.text.includes('## Beta 改名'), '原文应保持')
  passed++
  console.log('[菜单回归][PASS] 重命名 Esc 取消：零写回')

  // ---- 场景 G：删除整控制域（真实点击 + 文档对拍） ----
  await item(3).click({ button: 'right', position: { x: 80, y: 8 } })
  await page.locator('.vsidian-outline-menu button[data-vsidian-command="delete"]').click()
  state = await page.evaluate(() => window.readMenu())
  assert.ok(!state.text.includes('Beta'), `删除应移除整控制域（实际 ${JSON.stringify(state.text)}）`)
  assert.ok(state.text.endsWith('子内容\n# 第二顶\n内容'), '删除段与后段应直接相接且后段完整')
  assert.ok(state.text.includes('### Alpha 子'), '前段（Alpha 子树）完整保留')
  await page.waitForTimeout(400)
  const afterTexts = await page.locator('.vsidian-outline-item').allTextContents()
  assert.equal(afterTexts.length, 4, `删除后大纲应剩 4 条（实际 ${JSON.stringify(afterTexts)}）`)
  passed++
  console.log('[菜单回归][PASS] 删除整控制域：相邻段完整、大纲同步')

  // ---- 场景 H：结构命令真实点击（折叠同级）----
  await item(0).click({ button: 'right', position: { x: 80, y: 8 } })
  await page.locator('.vsidian-outline-menu button[data-vsidian-command="collapseSiblings"]').click()
  await page.waitForTimeout(60)
  const hiddenFlags = await page.evaluate(() =>
    [...document.querySelectorAll('.vsidian-outline-item')]
      .map((el) => getComputedStyle(el).display === 'none'))
  // 折叠同级作用顶层组（主标题、第二顶）：主标题折叠遮 Alpha 子树；
  // 第二顶是叶（无键可删、自身恒可见）
  assert.deepEqual(hiddenFlags, [false, true, true, false], `折叠同级后 Alpha 子树应隐藏（实际 ${JSON.stringify(hiddenFlags)}）`)
  passed++
  console.log('[菜单回归][PASS] 结构命令：折叠同级（真实点击链路）')

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[菜单回归] ${passed} 项通过`)
