// 大纲折叠滑块与手动折叠的原生浏览器回归（#67）：真实布局（Chromium）
// 下用真实鼠标点击/拖拽与滚轮验证——jsdom 无布局测不了的串珠两态绘制、
// display:none 折叠、scrollIntoView 高亮行滚进面板可视区在此落地。
// 与 outlineJump.mjs 同装配模式（esbuild 打包生产控制器 + 注入页面）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/outlineCollapse.js')
await build({ entryPoints: [path.join(root, 'test/browser/outlineCollapseFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })

// 三章同构：H1 + 两节 H2（各带一个 H3 子节），中间正文行撑出滚动空间。
// 条目序列（0 基）：甲0 甲一1 甲一一2 甲二3 乙4 乙一5 乙一一6 乙二7 丙8 丙一9 丙一一10 丙二11
const chapter = (name) => [
  `# ${name}`,
  `${name} 开篇正文，撑起视口高度。`.repeat(6),
  `## ${name}一`,
  `${name}一 正文段落。`.repeat(8),
  `### ${name}一一`,
  `${name}一一 深层正文。`.repeat(8),
  `## ${name}二`,
  `${name}二 正文段落。`.repeat(8),
  '',
].join('\n')
const DOC = [chapter('甲'), chapter('乙'), chapter('丙')].join('\n')
const HEADING_TEXTS = [
  '甲', '甲一', '甲一一', '甲二', '乙', '乙一', '乙一一', '乙二', '丙', '丙一', '丙一一', '丙二',
]

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
  // 等待 250ms 去抖刷新链路完成（首场经 ensureFresh 即时渲染，等待兜底）
  await page.waitForTimeout(120)

  // ---- 场景 A：默认档 5 全展开 + 串珠绘制（#99 能量条满格：全珠实心）----
  let state = await page.evaluate(() => window.readOutline())
  assert.equal(state.expandLevel, 5, `默认档应为 5（实际 ${state.expandLevel}）`)
  assert.deepEqual(state.hidden, HEADING_TEXTS.map(() => false), '默认档 5 全部条目可见')
  assert.equal(state.chevronCount, 6, `父节点箭头数应为 6（每章 H1+H2一；实际 ${state.chevronCount}）`)
  // #99 能量条：档 5 满格——沿途珠（0..4）与当前珠（5）全部实心
  const dotBgOf = (n) => window.readOutline().dotBg(n)
  for (const n of [0, 1, 2, 3, 4, 5]) {
    const bg = await page.evaluate(dotBgOf, n)
    assert.match(bg, /^rgb\(/, `档 5 圆点 ${n} 应为实心（实际 ${bg}）`)
  }
  const track = await page.evaluate(() => window.readOutline().trackPx())
  assert(track > 0, `轨道应有布局宽度（实际 ${track}）`)
  const fill5 = await page.evaluate(() => window.readOutline().fillPx())
  assert(Math.abs(fill5 - track) < 2, `档 5 填充条应占满轨道（实际 ${fill5}/${track}）`)
  // #99 层级对齐引导线：「甲一一」（条目 2，H3）有两条线（祖先 甲 H1 的
  // 9px 与 甲一 H2 的 19px），1px 宽、computed 背景非全透明（样式失效时
  // 透明可捕获）；顶层「甲」（条目 0）无线
  const guide0 = await page.evaluate(() => window.readOutline().guideOf(2, 0))
  const guide1 = await page.evaluate(() => window.readOutline().guideOf(2, 1))
  assert(guide0 && guide0.left === '9px' && guide0.width === '1px',
    `条目 2 第 1 条引导线应为 1px 宽、left 9px（实际 ${JSON.stringify(guide0)}）`)
  assert(guide1 && guide1.left === '19px' && guide1.width === '1px',
    `条目 2 第 2 条引导线应为 1px 宽、left 19px（实际 ${JSON.stringify(guide1)}）`)
  assert(/^rgba\(/.test(guide0.bg) && !/rgba\(0, 0, 0, 0\)/.test(guide0.bg),
    `引导线 computed 背景应非全透明（实际 ${guide0.bg}）`)
  const guideTop = await page.evaluate(() => window.readOutline().guideOf(0, 0))
  assert(guideTop === null, `顶层条目不应有引导线（实际 ${JSON.stringify(guideTop)}）`)
  passed++
  console.log('[折叠回归][PASS] 默认档 5 全展开 + 串珠满格绘制（全珠实心 + 填充满轨）')
  console.log('[折叠回归][PASS] 层级引导线绘制：深层条目双线对齐祖先 chevron、顶层无线')

  // ---- 场景 B：真实点击圆点选档 1——H2 可见、H3 折叠隐藏 ----
  await page.locator('.vsidian-outline-slider-dot').nth(1).click()
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.expandLevel, 1, `点击档 1 后 expandLevel 应为 1（实际 ${state.expandLevel}）`)
  // 档 1 = 展开 H1 父节点：H2 直接子级可见，H3（*一一）折叠隐藏
  assert.deepEqual(state.hidden, [false, false, true, false, false, false, true, false, false, false, true, false],
    `档 1 下 H3 应折叠隐藏（实际 ${JSON.stringify(state.hidden)}）`)
  // #99 能量条：沿途珠 0/当前珠 1 实心、未充段珠 3 空心、填充条约 20% 轨道
  assert.match(await page.evaluate(dotBgOf, 1), /^rgb\(/, '档 1 圆点应为实心（active 类切换生效）')
  assert.match(await page.evaluate(dotBgOf, 0), /^rgb\(/, '档 1 沿途珠 0 应实心（filled 类）')
  assert.equal(await page.evaluate(dotBgOf, 3), 'rgba(0, 0, 0, 0)',
    `档 1 未充段圆点应为透明空心（实际 ${await page.evaluate(dotBgOf, 3)}）`)
  const fill1 = await page.evaluate(() => window.readOutline().fillPx())
  assert(Math.abs(fill1 - track * 0.2) < 2, `档 1 填充条应约 20% 轨道（实际 ${fill1}/${track}）`)
  // #99 热区放大：点在视觉圆外 1px 的盒角（(11,11) 距中心 7.07px > 圆半径
  // 6px、< 热区半径 11px）也应选档——热区伪元素失效时此处 click 落 row
  // 空白（closest 不命中珠），且原地点击无位移不走拖拽换算，选档不发生
  await page.locator('.vsidian-outline-slider-dot').nth(3)
    .click({ position: { x: 11, y: 11 } })
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.expandLevel, 3, `热区外缘点击应选中档 3（实际 ${state.expandLevel}）`)
  passed++
  console.log('[折叠回归][PASS] 点击圆点选档 1：H3 折叠隐藏 + 能量条两态（实心/空心/20% 填充）')
  console.log('[折叠回归][PASS] 热区放大：视觉圆外的盒角点击仍选档（22px 命中区生效）')

  // ---- 场景 C：真实点击箭头折叠「甲一」（单条生效）与点文字跳转共存 ----
  // 档 5 下折叠「甲一」（index 1，有子「甲一一」）：甲一一（index 2）隐藏
  await page.locator('.vsidian-outline-slider-dot').nth(5).click()
  await page.locator('.vsidian-outline-item').nth(1).locator('.vsidian-outline-chevron').click()
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.hidden[2], true, '折叠「甲一」后「甲一一」应隐藏')
  assert.equal(state.hidden.filter(Boolean).length, 1, '手动折叠只影响单条子树（其余可见）')
  // #99 引导线随行断线：「甲一一」隐藏后其行内 guide 不参与布局（display
  // 不继承，故以 offsetParent 判定可见性而非 computed display）
  const guideHidden = await page.evaluate(() => window.readOutline().guideOf(2, 0))
  assert(guideHidden && guideHidden.visible === false,
    `折叠子树的引导线应随行隐藏（实际 ${JSON.stringify(guideHidden)}）`)
  // 点文字仍跳转（#66 路径不受箭头影响）：点击「乙一」文字 → 高亮即时落位
  await page.locator('.vsidian-outline-item').nth(5).click({ position: { x: 60, y: 8 } })
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.locatedText, '乙一', `点文字应跳转并高亮（实际 ${state.locatedText}）`)
  // 再点「甲一」的箭头展开：甲一一恢复
  await page.locator('.vsidian-outline-item').nth(1).locator('.vsidian-outline-chevron').click()
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.hidden[2], false, '再次点击箭头应展开恢复「甲一一」')
  passed++
  console.log('[折叠回归][PASS] 箭头折叠/展开单条生效；点文字仍跳转')

  // ---- 场景 D：拖拽选档（pointer 捕获 + 最近圆点换算）----
  // 从档 5 圆点按下拖到档 0 圆点位置：整体替换为档 0 精确集（只露 H1）
  const dotBox = async (n) => page.locator('.vsidian-outline-slider-dot').nth(n).boundingBox()
  const from = await dotBox(5)
  const to = await dotBox(0)
  assert(from && to, '圆点应有布局盒')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  // 分步拖拽（触发 pointermove 序列；位移超阈值后捕获指针逐档换算）
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      from.x + (to.x - from.x) * i / steps,
      from.y + (to.y - from.y) * i / steps,
    )
  }
  await page.mouse.up()
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.expandLevel, 0, `拖拽到档 0 后 expandLevel 应为 0（实际 ${state.expandLevel}）`)
  assert.deepEqual(state.hidden, HEADING_TEXTS.map((t, i) => ![0, 4, 8].includes(i)),
    '档 0 只露顶层 H1（甲乙丙），其余全部隐藏')
  passed++
  console.log('[折叠回归][PASS] 拖拽选档：整体替换为档 0 精确集（只露顶层）')

  // ---- 场景 E：滚动动态展开（only-expand）+ 高亮滚进面板可视区 ----
  // 档 0 下滚动正文进入「乙一」控制域：乙的路径展开（乙、乙一可见），
  // 其他章（甲、丙）保持折叠；高亮落在乙一自身并滚进面板可视区
  await page.locator('.cm-editor').first().click({ position: { x: 200, y: 300 } })
  for (let i = 0; i < 22; i++) await page.mouse.wheel(0, 500)
  await page.waitForTimeout(400)
  state = await page.evaluate(() => window.readOutline())
  // 乙（4）应展开、乙一（5）可见；丙（8）仍折叠（丙一 9 隐藏）
  assert.equal(state.hidden[9], true, '未浏览区域（丙一）保持折叠（only-expand 不打扰）')
  const visibleDeep = [5, 6, 7].some((i) => !state.hidden[i])
  assert(visibleDeep, `滚动进入「乙」区域后其子级应有可见者（实际 ${JSON.stringify(state.hidden)}）`)
  assert.equal(state.locatedText !== null && state.locatedText.startsWith('乙'), true,
    `滚动后高亮应在乙控制域（实际 ${state.locatedText}）`)
  assert.equal(state.locatedVisibleInPanel, true,
    `高亮行应滚进大纲面板可视区（实际 ${JSON.stringify(state.locatedVisibleInPanel)}）`)
  passed++
  console.log('[折叠回归][PASS] 滚动动态展开（only-expand）+ 高亮滚进面板可视区')

  // ---- 场景 F：编辑存活（真实编辑链路：重命名不扰动、新增自动展开）----
  // 先滚回文档顶部：滚动动态展开（only-expand）会展开「当前浏览路径」，
  // 视口停在乙区域时乙一的折叠会被合法展开——存活断言须远离当前路径
  await page.locator('.cm-editor').first().click({ position: { x: 200, y: 300 } })
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -600)
  await page.waitForTimeout(400)
  state = await page.evaluate(() => window.readOutline())
  assert(state.locatedText === null || state.locatedText === '甲',
    `前置：滚回顶部后高亮应离开乙区域（实际 ${state.locatedText}）`)
  // 档 0 下展开「乙」、再展开并折叠「乙一」（两次点击：先入展开集再折叠），
  // 随后重命名「丙」：折叠视图不扰动
  await page.evaluate(() => window.post({ kind: 'outline.test.expandClick', level: 0 }))
  await page.locator('.vsidian-outline-item').nth(4).locator('.vsidian-outline-chevron').click() // 展开乙
  await page.locator('.vsidian-outline-item').nth(5).locator('.vsidian-outline-chevron').click() // 展开乙一
  await page.locator('.vsidian-outline-item').nth(5).locator('.vsidian-outline-chevron').click() // 折叠乙一
  let before = await page.evaluate(() => window.readOutline())
  assert.equal(before.hidden[6], true, '前置：乙一折叠中（乙一一隐藏）')
  await page.evaluate(() => window.replaceText('# 丙', '# 丙改名'))
  await page.waitForTimeout(400) // 250ms 去抖窗口
  state = await page.evaluate(() => window.readOutline())
  assert.equal(state.texts[8], '丙改名', `重命名应更新条目（实际 ${state.texts[8]}）`)
  assert.equal(state.hidden[6], true, '重命名不扰动手动折叠（乙一仍折叠）')
  // 尾部新增深层标题：其祖先链自动展开（新标题可见）
  await page.evaluate(() => window.appendText('\n## 新增节\n新增正文。\n'))
  await page.waitForTimeout(400)
  state = await page.evaluate(() => window.readOutline())
  const newTextIndex = state.texts.indexOf('新增节')
  assert(newTextIndex > 0, `新增标题应出现在大纲（实际 ${JSON.stringify(state.texts)}）`)
  assert.equal(state.hidden[newTextIndex], false, '新增标题应可见（祖先链自动展开）')
  assert.equal(state.hidden[6], true, '既有手动折叠在两次编辑后仍存活（乙一仍折叠）')
  passed++
  console.log('[折叠回归][PASS] 编辑存活：重命名不扰动折叠、新增标题祖先链自动展开')

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[折叠回归] ${passed} 项通过`)
