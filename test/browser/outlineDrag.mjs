// 大纲拖拽排序的原生浏览器回归（#70）：真实布局（Chromium）+ 真实鼠标
// （mouse.down/move/up）驱动拖拽——三态落点容差几何（上缘/中部/下缘）、
// 拖拽中源条目提示、落点指示真实绘制（dropHintPainted）、drop 单笔写回
// 全文对拍、Esc 取消零写回、无效落点（拖入自身子树）拒绝、搜索过滤隐藏
// 条目不构成落点、非主键（右键）不启动拖拽、拖拽中右键结束手势且零写回
// （先松右键与先松左键两种释放顺序各一场景）。
// 场景 K（review-loops 第 3 轮补）走 CDP 触摸仿真：触屏拖拽被浏览器接管为
// 面板滚动、零写回、无拖拽指示——触摸路径此前无覆盖；它是覆盖性回归，不是
// 某次修复的红绿证据（按键掩码判据的红绿证据在单测 outlineDragPanel.test.ts）。
// 与 outlineMenu.mjs 同装配模式。
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

  /** 菜单观测（夹具未导出：直接读 view.state probe 与侧栏 DOM——
   *  与 outlineMenu.mjs 的 readMenu() 同对象面，此处只取本套断言所需字段） */
  const readMenu = () => page.evaluate(() => {
    window.controller.handleHostMessage({ kind: 'view.state.request' })
    const probe = [...window.sent()].reverse().find((m) => m.kind === 'view.state')
    return {
      open: probe?.outline?.menuOpen === true,
      targetIndex: probe?.outline?.menuTargetIndex ?? null,
      inDom: document.querySelector('.vsidian-outline-menu') !== null,
    }
  })

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

  // ---- 场景 G：drop 之后的下一次点击仍须生效（review-loops 第 2 轮）----
  {
    // 吞掉「浏览器补发 click」的标志只在补发 click 抵达时解除，而写回会在
    // pointerup 处理内同步重建条目 DOM——补发 click 不送达时标志残留，吞掉
    // 用户下一次真实点击（跳转/折叠箭头都失效）。人工清单 A30.7 承诺
    // 「拖拽完成后立即单击另一条目——正常跳转」。
    // 夹具无宿主回执：第 2 笔起的写回会因累积「未确认」偏移被判冲突（本地
    // 仍生效、出站变 conflict.report）。此处重新 init 复位，使本次 drop 走
    // 真实 edit.request 路径
    await page.evaluate((text) => window.initDrag(text), DOC)
    await page.waitForTimeout(120)
    await item(0).click() // 基线：点击生效后的高亮与光标
    const baseline = await page.evaluate(() => window.readJump())
    assert.equal(baseline.locatedIndex, 0, `基线点击应高亮第 1 条（实际 ${baseline.locatedIndex}）`)
    const editsBefore = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    const { x, y } = await dragHover(4, 0, 'top') // 末条 → 首条之前（真实写回一笔）
    await page.mouse.move(x, y)
    await page.mouse.up()
    const editsAfter = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    assert.equal(editsAfter, editsBefore + 1,
      `前置条件：该拖拽应恰写回一笔（实际 ${editsBefore} → ${editsAfter}）`)
    await page.waitForTimeout(300) // 等写回后的去抖重建落定
    await item(2).click() // drop 之后第一次点击：必须生效
    const after = await page.evaluate(() => window.readJump())
    assert.equal(after.locatedIndex, 2,
      `drop 后第一次点击就应跳转并高亮该条（实际 ${after.locatedIndex}——吞噬标志残留）`)
    assert.notEqual(after.caretLine, baseline.caretLine, 'drop 后点击应移动光标到目标标题行')
    passed++
    console.log('[拖拽回归][PASS] drop 后下一次点击仍生效（跳转与高亮）')
  }

  // ---- 场景 H：右键不启动拖拽、打开菜单（review-loops 第 2 轮补缺）----
  {
    // 面板 pointerdown 委托只认主键（pointerType=mouse 且 button!==0 直接
    // 返回），右键的手势入口是 contextmenu。此前本套只驱动过主键，非主键
    // 这条「不启动」口径没有端到端覆盖。
    await page.evaluate((text) => window.initDrag(text), DOC) // 复位（前面场景累积改写）
    await page.waitForTimeout(120)
    const before = await page.evaluate(() => window.readDrag())
    const editsBefore = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    const box = await item(1).boundingBox()
    assert.ok(box, '右键目标条目应有布局盒')
    await page.mouse.move(box.x + 40, box.y + box.height / 2)
    await page.mouse.down({ button: 'right' })
    // 按下后真实移动（横向 110px，位移远超 4px 阈值；保持抬起点仍在同一条目
    // 行内——菜单锚定目标是抬起点下方的条目，纵向移动会改变锚定对象）
    await page.mouse.move(box.x + 90, box.y + box.height / 2)
    await page.mouse.move(box.x + 150, box.y + box.height / 2)
    const held = await page.evaluate(() => window.readDrag())
    assert.equal(held.draggingIndex, null, '右键按下后移动不得进入拖拽态')
    assert.ok(held.itemClasses.every((c) => !c.includes('vsidian-outline-dragging') && !c.includes('vsidian-outline-drop-')),
      `右键拖动不得出现拖拽/落点指示类（实际 ${JSON.stringify(held.itemClasses)}）`)
    await page.mouse.up({ button: 'right' })
    const state = await page.evaluate(() => window.readDrag())
    assert.equal(state.draggingIndex, null, '右键手势全程不得进入拖拽态')
    assert.ok(state.itemClasses.every((c) => !c.includes('vsidian-outline-dragging') && !c.includes('vsidian-outline-drop-')),
      `右键手势后不得残留拖拽/落点指示类（实际 ${JSON.stringify(state.itemClasses)}）`)
    const editsAfter = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    assert.equal(editsAfter, editsBefore, '右键手势不得产生写回（edit.request 不增）')
    assert.equal(state.text, before.text, '右键手势不得改写文档')
    // 菜单：contextmenu 兑现后真实打开（本装配下 Chromium 的触发时机分平台
    // ——Windows 在抬键、Linux 在按键，断言点统一放在抬起之后以覆盖两端）
    const menu = await readMenu()
    assert.equal(menu.open, true, '右键抬起后菜单应打开（probe menuOpen）')
    assert.equal(menu.inDom, true, '菜单容器应真实挂载在侧栏')
    assert.equal(menu.targetIndex, 1, `菜单目标应为右键条目（实际 ${menu.targetIndex}）`)
    await page.keyboard.press('Escape') // 关菜单，避免影响后续场景
    passed++
    console.log('[拖拽回归][PASS] 右键不启动拖拽：零指示、零写回、菜单打开')
  }

  // ---- 场景 I：拖拽中按右键结束手势、零写回（review-loops 第 2 轮补缺）----
  {
    // 口径：「拖拽中按右键 → 上一手势结束 → 菜单打开」且零写回。实测机制与
    // 代码注释略有出入：Chromium 对和弦按键（已按住左键再按右键）不投递
    // pointerdown（该次按键报为 pointermove(button=2, buttons=3)），故 document
    // capture 入口的「按下即取消会话」在此路径不可达；会话实际由 contextmenu
    // 抵达时取消（openOutlineMenu 内 cancelOutlineDrag）。因此「手势结束」的
    // 断言点放在右键抬起之后——两端平台结果一致（Windows 抬起时触发
    // contextmenu，Linux 按下时触发、会话更早取消，抬起后同为零写回）。
    // 「先松左键」的另一半释放顺序曾按残留落点写出 drop（已修，见场景 J：
    // 非主键按下即结束会话，「仅主键释放执行落点写回」为不变式）
    await page.evaluate((text) => window.initDrag(text), DOC) // 复位：本场景不得有历史写回干扰
    await page.waitForTimeout(120)
    const editsBefore = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    const { x, y } = await dragHover(1, 4, 'middle') // 乙 → 戊（中部落点：有效目标）
    await page.mouse.move(x, y)
    const drag = await page.evaluate(() => window.readDrag())
    assert.equal(drag.draggingIndex, 1, '前置条件：左键拖拽应进行中（源乙）')
    assert.equal(drag.dropTargetIndex, 4, '前置条件：中部落点为有效目标（戊）')
    await page.mouse.down({ button: 'right' }) // 拖拽中按右键
    assert.equal((await page.evaluate(() => window.readDrag())).text, DOC,
      '右键按下时刻不得写回（本地文本不变）')
    await page.mouse.up({ button: 'right' }) // 右键手势收尾（触发 contextmenu）
    const state = await page.evaluate(() => window.readDrag())
    assert.equal(state.draggingIndex, null, '右键手势后拖拽会话应结束')
    assert.ok(state.itemClasses.every((c) => !c.includes('vsidian-outline-dragging') && !c.includes('vsidian-outline-drop-')),
      `右键手势后拖拽/落点指示类应清除（实际 ${JSON.stringify(state.itemClasses)}）`)
    const editsAfter = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    assert.equal(editsAfter, editsBefore, '右键结束手势不得写回（edit.request 不增）')
    assert.equal(state.text, DOC, `右键结束手势不得改写文档（实际 ${JSON.stringify(state.text)}）`)
    const menu = await readMenu()
    assert.equal(menu.open || menu.inDom, true, '右键结束手势后应由同一手势打开菜单')
    await page.mouse.up() // 释放仍按住的左键（会话已结束，不再触发 drop）
    assert.equal((await page.evaluate(() => window.readDrag())).text, DOC,
      '左键抬起收尾仍须零写回')
    assert.equal(await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length), editsBefore,
      '左键抬起收尾不得补一笔写回')
    await page.keyboard.press('Escape') // 关菜单
    passed++
    console.log('[拖拽回归][PASS] 拖拽中按右键：手势结束、指示清除、零写回')
  }

  // ---- 场景 J：拖拽中按右键后先松左键：手势结束、零写回（review-loops 第 2 轮补：和弦按键）----
  {
    // 与场景 I 的另一半释放顺序。和弦按键（左键按住时再按右键）不投递
    // pointerdown——第二个按键只报 pointermove(button=2, buttons=3)，其释放也
    // 不是 pointerup。若「先松左键」（右键仍按住），右键抬起是最后一个按键 →
    // 投递真实 pointerup(button=2, buttons=0)，残留会话即按残留落点写出 drop。
    // 不变式：仅主键（左键）释放执行落点写回。
    await page.evaluate((text) => window.initDrag(text), DOC) // 复位：本场景不得有历史写回干扰
    await page.waitForTimeout(120)
    const editsBefore = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    const { x, y } = await dragHover(1, 4, 'middle') // 乙 → 戊（中部落点：有效目标）
    await page.mouse.move(x, y)
    const drag = await page.evaluate(() => window.readDrag())
    assert.equal(drag.draggingIndex, 1, '前置条件：左键拖拽应进行中（源乙）')
    assert.equal(drag.dropTargetIndex, 4, '前置条件：中部落点为有效目标（戊）')
    await page.mouse.down({ button: 'right' }) // 拖拽中按右键（和弦）
    const chord = await page.evaluate(() => window.readDrag())
    assert.equal(chord.draggingIndex, null,
      '非主键按下即结束会话（和弦按键只报 pointermove，守卫须落在移动路径上）')
    assert.ok(chord.itemClasses.every((c) => !c.includes('vsidian-outline-dragging') && !c.includes('vsidian-outline-drop-')),
      `非主键按下后拖拽/落点指示类应清空（实际 ${JSON.stringify(chord.itemClasses)}）`)
    await page.mouse.up() // 松左键（右键仍按住）：不得落成 drop
    assert.equal((await page.evaluate(() => window.readDrag())).text, DOC,
      '松左键时不得写回（会话已结束）')
    await page.mouse.up({ button: 'right' }) // 松右键：最后一个按键的释放（真实 pointerup）
    const state = await page.evaluate(() => window.readDrag())
    assert.equal(state.draggingIndex, null, '手势全程结束后不得残留会话')
    const editsAfter = await page.evaluate(() =>
      window.sent().filter((m) => m.kind === 'edit.request').length)
    assert.equal(editsAfter, editsBefore,
      `和弦右键不得写回（edit.request ${editsBefore} → ${editsAfter}）`)
    assert.equal(state.text, DOC, `和弦右键不得改写文档（实际 ${JSON.stringify(state.text)}）`)
    const menu = await readMenu()
    assert.equal(menu.open, true, '右键落在条目上应照常弹出菜单（probe menuOpen）')
    assert.equal(menu.inDom, true, '菜单容器应真实挂载在侧栏')
    assert.equal(menu.targetIndex, 4, `菜单目标应为右键命中的条目（实际 ${menu.targetIndex}）`)
    await page.keyboard.press('Escape') // 关菜单
    passed++
    console.log('[拖拽回归][PASS] 拖拽中按右键后先松左键：手势结束、零写回、菜单照常打开')
  }

  // ---- 场景 K：触屏拖拽被浏览器接管为面板滚动：零写回、无拖拽指示 ----
  // 覆盖性回归（review-loops 第 3 轮补）：触摸路径此前从未进过本套件。touch
  // 指针的取值口径（接触 pointerdown button=0/buttons=1、移动 button=-1）由
  // 本场景实测记录并断言；拖拽语义未在 touch-action 上作声明，故浏览器把
  // 纵向移动接管为面板滚动、随后投递 pointercancel（buttons=0），会话按取消
  // 处理、零写回。与 ①/②/③ 无因果关系——不是修复的红绿证据。
  {
    // 40 条标题（每条一行）：面板高度被侧栏钳制，内容总高溢出 → 可滚动
    const TOUCH_DOC = Array.from({ length: 40 }, (_v, i) => `# 标题${i + 1}\n正文${i + 1}`).join('\n')
    const context = await browser.newContext({ viewport: { width: 1000, height: 560 }, hasTouch: true })
    const touchPage = await context.newPage()
    const touchErrors = []
    touchPage.on('pageerror', (error) => touchErrors.push(error.message))
    try {
      await touchPage.setContent('<div id="app"></div>')
      await touchPage.addStyleTag({ content: 'html, body { margin: 0; height: 100%; }' })
      await touchPage.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
      await touchPage.addScriptTag({ path: bundle })
      await touchPage.evaluate((text) => window.initDrag(text), TOUCH_DOC)
      await touchPage.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
      await touchPage.locator('.vsidian-outline-item').first().waitFor()
      await touchPage.waitForTimeout(120)
      // 触摸指针事件实录（capture 层，含后续 pointercancel）：断言用户摸得到
      // 的输入口径，并在日志里留下实测取值
      await touchPage.evaluate(() => {
        window.__touchLog = []
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
          document.addEventListener(type, (e) => window.__touchLog.push({
            type: e.type, pointerType: e.pointerType, button: e.button,
            buttons: e.buttons, isPrimary: e.isPrimary,
          }), true)
        }
      })
      const panelBefore = await touchPage.evaluate(() => {
        const panel = document.querySelector('.vsidian-outline-panel')
        return { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight }
      })
      assert.ok(panelBefore.scrollHeight > panelBefore.clientHeight,
        `前置条件：面板应可滚动（实际 scrollHeight=${panelBefore.scrollHeight} clientHeight=${panelBefore.clientHeight}）`)
      const box = await touchPage.locator('.vsidian-outline-item').nth(1).boundingBox()
      assert.ok(box, '触摸拖拽源条目应有布局盒')
      const x = box.x + 60
      const yStart = box.y + box.height / 2
      const cdp = await context.newCDPSession(touchPage)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: [{ x, y: yStart }],
      })
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove', touchPoints: [{ x, y: yStart - step * 28 }],
        })
        await touchPage.waitForTimeout(16)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      // 同步点：等浏览器的手势接管落定（pointercancel 抵达即会话已按取消
      // 处理），避免「接管尚未投递」的时序竞态。超时不吞失败——断言照旧按
      // 真实状态判定，失败信息里的实录可定位时序
      await touchPage.waitForFunction(
        () => window.__touchLog.some((e) => e.type === 'pointercancel'), null, { timeout: 2000 },
      ).catch(() => {})
      await touchPage.waitForTimeout(80)
      const log = await touchPage.evaluate(() => window.__touchLog)
      const panelAfter = await touchPage.evaluate(() => {
        const panel = document.querySelector('.vsidian-outline-panel')
        return { scrollTop: panel.scrollTop }
      })
      const state = await touchPage.evaluate(() => window.readDrag())
      const edits = await touchPage.evaluate(() => window.sent().filter((m) => m.kind === 'edit.request'))
      // 浏览器接管为滚动：面板滚动位置前移（触摸移动不落成拖拽）
      assert.ok(panelAfter.scrollTop > panelBefore.scrollTop,
        `触摸拖拽应被接管为面板滚动（scrollTop ${panelBefore.scrollTop} → ${panelAfter.scrollTop}）`)
      // 触摸指针口径（实测）：接触态 button=0；移动的 button=-1、buttons=1
      // 只含 bit0——按掩码判据换算不结束会话，会话由 pointercancel 收掉
      const down = log.find((e) => e.type === 'pointerdown')
      const cancel = log.find((e) => e.type === 'pointercancel')
      assert.ok(down && down.pointerType === 'touch' && down.button === 0,
        `触屏 pointerdown 应为 touch/button=0（实际 ${JSON.stringify(down)}）`)
      assert.ok(cancel && cancel.buttons === 0,
        `浏览器接管后应投递 pointercancel(buttons=0)（实际 ${JSON.stringify(cancel)}）`)
      // 零写回、无残留拖拽态与指示类、文档逐字不变
      assert.equal(edits.length, 0, `触摸手势不得产生写回（实际 ${edits.length} 笔）`)
      assert.equal(state.draggingIndex, null, '触摸手势结束后不得残留拖拽态')
      assert.equal(state.dropTargetIndex, null, '触摸手势不得留下落点')
      assert.ok(state.itemClasses.every((c) => !c.includes('vsidian-outline-dragging') &&
        !c.includes('vsidian-outline-drop-')),
      `触摸手势后不得残留拖拽/落点指示类（实际 ${JSON.stringify(state.itemClasses)}）`)
      assert.equal(state.text, TOUCH_DOC, `触摸手势不得改写文档（实际 ${JSON.stringify(state.text.slice(0, 60))}…）`)
      assert.deepEqual(touchErrors, [], '触摸页不得有未捕获异常')
      passed++
      console.log(`[拖拽回归][PASS] 触屏拖拽被接管为滚动：scrollTop ${panelBefore.scrollTop} → ${panelAfter.scrollTop}、`
        + `零写回、无指示（触及事件实录 ${JSON.stringify(log)}）`)
    } finally {
      await context.close()
    }
  }

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[拖拽回归] ${passed} 项通过`)
