// 大纲工具条与标题搜索的原生浏览器回归（#68）：真实布局（Chromium）下用
// 真实键盘输入与真实点击验证——jsdom 无布局测不了的工具条行绘制、
// display:none 过滤、mark 片段高亮 computed 背景、跳转到末尾的双模式
// 滚动到底在此落地。与 outlineCollapse.mjs 同装配模式。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/outlineSearch.js')
await build({ entryPoints: [path.join(root, 'test/browser/outlineSearchFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })

// 与单测样例同构：三章 H1，甲/乙带 H2 与 H3 孙级，丙是叶；正文撑出滚动空间。
// 条目索引：0=Alpha 1=Beta 2=Gamma 3=Delta 4=Epsilon 5=Zeta
const section = (name, child) => [
  `# ${name}`,
  `${name} 开篇正文，撑起视口高度。`.repeat(10),
  child ? `## ${child}` : '',
  child ? `${child} 正文段落。`.repeat(10) : '',
  '',
].filter((x) => x !== '').join('\n')
const DOC = [
  '# Alpha',
  'Alpha 开篇正文，撑起视口高度。'.repeat(10),
  '## **Bold** 标题',
  'Beta 正文段落。'.repeat(10),
  '### Gamma',
  'Gamma 深层正文。'.repeat(10),
  '## Delta',
  'Delta 正文段落。'.repeat(10),
  '#### Epsilon',
  'Epsilon 深层正文。'.repeat(10),
  '# Zeta',
  'Zeta 结尾正文，撑出末尾控制域。'.repeat(12),
  '',
].join('\n')
const HEADING_TEXTS = ['Alpha', 'Bold 标题', 'Gamma', 'Delta', 'Epsilon', 'Zeta']

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
  await page.evaluate((text) => window.initOutline(text), DOC)
  await page.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
  await page.locator('.vsidian-outline-item').first().waitFor()
  await page.waitForTimeout(120)

  // ---- 场景 A：工具条行真实绘制（outline-active 时 flex、三控件顺序与占位文案）----
  let s = await page.evaluate(() => window.readSearch())
  assert.equal(s.toolbarDisplay, 'flex', `工具条行应绘制为 flex（实际 ${s.toolbarDisplay}）`)
  assert.ok(s.toolbarHeightPx >= 24, `工具条行应有可见高度（实际 ${s.toolbarHeightPx}）`)
  assert.equal(s.placeholder, '输入以搜索', '搜索框 placeholder 应为「输入以搜索」')
  assert.equal(s.jumpBottomAria, '跳转到笔记末尾')
  assert.equal(s.resetAria, '重置')
  passed++
  console.log('[搜索回归][PASS] 工具条行绘制 + 三控件可访问名称与占位文案')

  // ---- 场景 B：真实键盘输入即时过滤（无关隐藏、路径保留）+ mark 片段绘制 ----
  await page.locator('.vsidian-outline-search').click()
  await page.keyboard.type('gamma', { delay: 10 })
  s = await page.evaluate(() => window.readSearch())
  assert.deepEqual(s.hidden, [false, false, false, true, true, true],
    `搜索 gamma 应只保留 Alpha/Beta/Gamma 路径（实际 ${JSON.stringify(s.hidden)}）`)
  assert.equal((await page.evaluate(() => window.readSearchMarks())).count, 1, 'Gamma 条目应有一个命中 mark')
  assert.equal((await page.evaluate(() => window.readSearchMarks())).texts.join(''), 'Gamma', 'mark 应只包命中子串')
  const markBg = (await page.evaluate(() => window.readSearchMarks())).firstBg
  assert.match(markBg, /^rgba?\(/, `命中 mark 应有可见背景（实际 ${markBg}）`)
  assert.notEqual(markBg, 'rgba(0, 0, 0, 0)', 'mark 背景不得全透明（高亮规则失效即失守）')
  passed++
  console.log('[搜索回归][PASS] 真实输入即时过滤 + mark 片段级高亮绘制')

  // ---- 场景 C：剥标记可见文本匹配（`**Bold** 标题` 输「bold」命中）----
  await page.locator('.vsidian-outline-search').fill('')
  await page.keyboard.type('bold', { delay: 10 })
  s = await page.evaluate(() => window.readSearch())
  assert.deepEqual(s.hidden, [false, false, true, true, true, true],
    `搜索 bold 应命中剥标记文本（实际 ${JSON.stringify(s.hidden)}）`)
  assert.equal((await page.evaluate(() => window.readSearchMarks())).count, 1)
  passed++
  console.log('[搜索回归][PASS] 匹配剥标记可见文本（plainText 口径）')

  // ---- 场景 D：无匹配占位；清空恢复（快照回放 + mark 消失 + 占位消失）----
  await page.locator('.vsidian-outline-search').fill('不存在词条')
  s = await page.evaluate(() => window.readSearch())
  assert.equal((await page.evaluate(() => window.readSearchMarks())).nomatchText, '无匹配', '无匹配应显示「无匹配」占位')
  // 前置折叠（档 1：Gamma/Epsilon 折叠遮蔽）再清空——回放进入搜索前的快照
  await page.evaluate(() => window.post({ kind: 'outline.test.expandClick', level: 1 }))
  await page.locator('.vsidian-outline-search').fill('')
  s = await page.evaluate(() => window.readSearch())
  assert.equal((await page.evaluate(() => window.readSearchMarks())).count, 0, '清空后 mark 应全部消失')
  assert.equal((await page.evaluate(() => window.readSearchMarks())).nomatchText, null, '清空后无匹配占位应消失')
  assert.deepEqual(s.hidden, [false, false, true, false, true, false],
    `清空应回放档 1 快照（Gamma/Epsilon 折叠遮蔽；实际 ${JSON.stringify(s.hidden)}）`)
  passed++
  console.log('[搜索回归][PASS] 无匹配占位 + 清空回放进入前折叠快照')

  // ---- 场景 E：跳转到末尾（live）：滚动到底、不落光标 ----
  const scrollBefore = await page.evaluate(() => window.readScroll())
  assert.equal(scrollBefore.mode, 'live')
  assert.ok(!scrollBefore.atBottom, '前置：live 视口不在底部')
  const selBefore = await page.evaluate(() => window.controller.getView().state.selection.main.from)
  await page.locator('.vsidian-outline-jump-bottom').click()
  await page.waitForTimeout(250)
  const scrollAfter = await page.evaluate(() => window.readScroll())
  assert.equal(scrollAfter.atBottom, true,
    `点击跳末后 live 应滚动到底（top=${scrollAfter.top} height=${scrollAfter.height}）`)
  const selAfter = await page.evaluate(() => window.controller.getView().state.selection.main.from)
  assert.equal(selAfter, selBefore, '跳转到末尾不得移动光标（不落光标口径）')
  passed++
  console.log('[搜索回归][PASS] 跳转到末尾（live）：滚动到底且不落光标')

  // ---- 场景 F：跳转到末尾（reading）：阅读容器滚动到底 ----
  await page.evaluate(() => window.post({ kind: 'view.mode.set', mode: 'reading' }))
  await page.waitForTimeout(200)
  await page.evaluate(() => window.post({ kind: 'outline.test.toolbarClick', action: 'jump-bottom' }))
  await page.waitForTimeout(300)
  const readingScroll = await page.evaluate(() => window.readScroll())
  assert.equal(readingScroll.mode, 'reading')
  assert.equal(readingScroll.atBottom, true,
    `reading 跳末后应接近底部（top=${readingScroll.top} bottom=${readingScroll.height - readingScroll.view}）`)
  passed++
  console.log('[搜索回归][PASS] 跳转到末尾（reading）：阅读容器滚动到底')

  // ---- 场景 G：重置三合一（切回 live；搜索 + 折叠 + 非默认档一键回初始态）----
  await page.evaluate(() => window.post({ kind: 'view.mode.set', mode: 'live' }))
  await page.waitForTimeout(150)
  // 组合前置：档 1 + 手动折叠 Alpha + 搜索词
  await page.evaluate(() => window.post({ kind: 'outline.test.expandClick', level: 1 }))
  await page.evaluate(() => window.post({ kind: 'outline.test.chevronClick', index: 0 }))
  await page.evaluate(() => window.post({ kind: 'outline.test.searchInput', text: 'zeta' }))
  s = await page.evaluate(() => window.readSearch())
  assert.deepEqual(s.hidden, [true, true, true, true, true, false], '前置：折叠+搜索组合下只 Zeta 可见')
  await page.locator('.vsidian-outline-reset').click()
  s = await page.evaluate(() => window.readSearch())
  assert.equal((await page.evaluate(() => window.readSearch())).searchValue, '', '重置应清空搜索输入框')
  assert.deepEqual(s.hidden, HEADING_TEXTS.map(() => false), '重置后应全展开（档 5 精确集）')
  assert.equal((await page.evaluate(() => window.readSearchMarks())).count, 0, '重置后片段高亮应消失')
  const activeDot = await page.evaluate(() => {
    const dots = [...document.querySelectorAll('.vsidian-outline-slider-dot')]
    return dots.findIndex((d) => d.classList.contains('vsidian-outline-slider-active'))
  })
  assert.equal(activeDot, 5, '重置后档位应回到默认 5')
  passed++
  console.log('[搜索回归][PASS] 重置三合一：清搜索 + 档位回 5 + 清手动折叠')

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[搜索回归] ${passed} 项通过`)
