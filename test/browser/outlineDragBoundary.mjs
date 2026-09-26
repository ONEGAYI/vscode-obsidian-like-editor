// 大纲拖拽的跨帧边界回归（review-loops 第 2 轮）：真实 webview 是 iframe，
// 本用例在真 iframe + 真鼠标下验证「指针越出 webview」的两条路径：
//   A 越界释放：拖出 iframe 后在宿主页非聚焦区释放——Chromium 把指针隐式
//     捕获到起始文档，pointerup 仍送达 webview，会话须正常收尾且零写回
//     （若送达被阻断，则只能靠 blur/入口清理兜底，同样不得写回）；
//   B 真实 blur：拖拽中由宿主页可聚焦元素夺焦 → webview 窗口 blur → 取消、
//     零写回、指示清除（首轮修复新增的 blur 网，这里是原生级证据）；
//   C 越界释放后回到面板原地按下释放：点击不得被误判为 drop。
// 与 outlineDrag.mjs 的差别仅在于装配位置（iframe 内，同 fixture 源）与
// 宿主页对照物（非聚焦 div 释放点 / 可聚焦 input 夺焦点）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundleBase = path.join(root, 'out/test/browser/outlineDragBoundary')
await build({ entryPoints: [path.join(root, 'test/browser/outlineDragFixture.ts')],
  bundle: true, outfile: `${bundleBase}.js`,
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })

const js = fs.readFileSync(`${bundleBase}.js`, 'utf8')
const css = fs.readFileSync(`${bundleBase}.css`, 'utf8')

// 条目索引：0 甲(H1) 1 乙(H2) 2 丁(H4) 3 丙(H2) 4 戊(H1)
const DOC = [
  '# 甲', '甲内容',
  '## 乙', '乙内容',
  '#### 丁', '丁内容',
  '## 丙', '丙内容',
  '# 戊', '戊内容',
].join('\n')

const IFRAME_W = 900
const IFRAME_H = 500
const HOST_HTML = `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;height:100%}iframe{position:absolute;left:0;top:0;border:0}
#dead{position:absolute;left:0;top:${IFRAME_H + 10}px;width:240px;height:60px}
#outside{position:absolute;left:${IFRAME_W + 30}px;top:10px;width:160px;height:40px}</style>
<iframe src="/frame.html" width="${IFRAME_W}" height="${IFRAME_H}"></iframe>
<div id="dead"></div><input id="outside">`
const FRAME_HTML = `<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;height:100%}</style>
<div id="app"></div><link rel="stylesheet" href="/bundle.css"><script src="/bundle.js"></script>`

const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
let passed = 0
try {
  const page = await browser.newPage({ viewport: { width: IFRAME_W + 240, height: IFRAME_H + 140 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  // 内存路由：不依赖本机端口与文件协议，iframe 与宿主页同源
  await page.route('http://vsidian.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname
    const body = pathname === '/host.html' ? HOST_HTML
      : pathname === '/frame.html' ? FRAME_HTML
        : pathname === '/bundle.js' ? js
          : pathname === '/bundle.css' ? css : undefined
    if (body === undefined) {
      return route.fulfill({ status: 404, body: '' })
    }
    const contentType = pathname.endsWith('.js') ? 'text/javascript'
      : pathname.endsWith('.css') ? 'text/css' : 'text/html'
    return route.fulfill({ status: 200, contentType, body })
  })
  await page.goto('http://vsidian.test/host.html')
  const frame = page.frames().find((f) => f.url().endsWith('/frame.html'))
  assert.ok(frame, 'iframe 应已装载')
  await frame.waitForFunction(() => typeof window.initDrag === 'function')
  await frame.evaluate((text) => window.initDrag(text), DOC)
  await frame.evaluate(() => window.controller.handleHostMessage({ kind: 'sidebar.test.click' }))
  await frame.locator('.vsidian-outline-item').first().waitFor()
  await page.waitForTimeout(120)

  const item = (n) => frame.locator('.vsidian-outline-item').nth(n)
  const read = () => frame.evaluate(() => window.readDrag())
  const editCount = () => frame.evaluate(() =>
    window.sent().filter((m) => m.kind === 'edit.request').length)
  const noIndication = (state) => state.itemClasses.every((c) =>
    !c.includes('vsidian-outline-drop-') && !c.includes('vsidian-outline-dragging'))

  /** 起拖并悬停到目标（不释放）：真实鼠标按下 → 分步移动（超 4px 阈值） */
  const dragTo = async (from, to, zone = 'middle') => {
    const fromBox = await item(from).boundingBox()
    const toBox = await item(to).boundingBox()
    assert.ok(fromBox && toBox, '拖拽双方条目应有布局盒')
    const x0 = fromBox.x + 40
    const y0 = fromBox.y + fromBox.height / 2
    const x = toBox.x + 60
    const y = toBox.y + (zone === 'top' ? toBox.height * 0.1
      : zone === 'bottom' ? toBox.height * 0.9 : toBox.height / 2)
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    for (let step = 1; step <= 4; step++) {
      await page.mouse.move(x0 + ((x - x0) * step) / 4, y0 + ((y - y0) * step) / 4)
    }
    return { x, y }
  }

  /** 越界释放：指针移到 iframe 外的宿主页非聚焦区再松开 */
  const releaseOutside = async () => {
    const dead = await page.locator('#dead').boundingBox()
    await page.mouse.move(dead.x + 40, dead.y + 30)
    await page.mouse.up()
  }

  // ---- 场景 A：拖出 iframe 释放——会话收尾、零写回、无残留指示 ----
  {
    await dragTo(1, 4)
    const hovered = await read()
    assert.equal(hovered.draggingIndex, 1, '拖拽中应有源条目（前置条件）')
    assert.equal(hovered.dropTargetIndex, 4, '拖拽中应记有效落点（前置条件）')
    await releaseOutside()
    await page.waitForTimeout(60)
    const after = await read()
    assert.equal(after.text, DOC, `越界释放不得写回（实际 ${JSON.stringify(after.text)}）`)
    assert.equal(await editCount(), 0, '越界释放不得产生 edit.request')
    assert.equal(after.draggingIndex, null, '越界释放后拖拽态应结束')
    assert.ok(noIndication(after), `越界释放后指示类应清除（实际 ${JSON.stringify(after.itemClasses)}）`)
    passed++
    console.log('[拖拽边界回归][PASS] 越界释放：会话收尾、零写回、指示清除')
  }

  // ---- 场景 B：拖拽中宿主页夺焦（真实 blur）——取消、零写回 ----
  {
    await dragTo(1, 4)
    assert.equal((await read()).draggingIndex, 1, '拖拽中应有源条目（前置条件）')
    await page.locator('#outside').click() // 真实焦点转移 → webview 窗口 blur
    await page.waitForTimeout(60)
    const state = await read()
    assert.equal(state.draggingIndex, null, `blur 应取消拖拽（实际 ${state.draggingIndex}）`)
    assert.ok(noIndication(state), 'blur 后指示类应清除')
    assert.equal(state.text, DOC, 'blur 取消不得写回')
    await releaseOutside()
    await page.waitForTimeout(60)
    assert.equal(await editCount(), 0, 'blur 取消后越界释放不得补写回')
    passed++
    console.log('[拖拽边界回归][PASS] 真实 blur 取消：状态清空、零写回')
  }

  // ---- 场景 C：越界释放后回到面板原地按下-释放（点击不得当 drop）----
  {
    await dragTo(1, 4)
    await releaseOutside()
    await page.waitForTimeout(60)
    const before = await editCount()
    const box = await item(4).boundingBox()
    await page.mouse.move(box.x + 60, box.y + box.height / 2)
    await page.mouse.down() // 按下：位移未超阈值
    await page.mouse.up()
    await page.waitForTimeout(60)
    assert.equal(await editCount(), before, '原地点击不得写回（未超位移阈值 ≠ drop）')
    assert.equal((await read()).text, DOC, '原地点击不得改动文档')
    // 随后真实拖拽仍可用（会话状态机未死锁）：丁(2) → 戊(4) 上缘 before
    const { x, y } = await dragTo(2, 4, 'top')
    await page.mouse.move(x, y)
    await page.mouse.up()
    const moved = await read()
    assert.equal(moved.text,
      '# 甲\n甲内容\n## 乙\n乙内容\n## 丙\n丙内容\n# 丁\n丁内容\n# 戊\n戊内容',
      `越界释放后拖拽仍应正常写回（实际 ${JSON.stringify(moved.text)}）`)
    assert.equal(await editCount(), before + 1, '该拖拽应恰产生一笔写回')
    passed++
    console.log('[拖拽边界回归][PASS] 越界释放后：原地点击零写回、随后的拖拽仍生效')
  }

  assert.deepEqual(errors, [], '页面不得有未捕获异常')
  await page.close()
} finally {
  await browser.close()
}
console.log(`[拖拽边界回归] ${passed} 项通过`)
