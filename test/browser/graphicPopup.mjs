// 图形化代码块交互浏览器回归（工单 #111）：真实 Chromium + 真实 mermaid
// 产物上的原生键鼠路径——按钮悬停显隐、禁点击、edit 迁移、弹窗滚轮缩放/
// 拖拽平移/键盘/Esc、导出消息与 PNG 光栅化（CSP data: 放行的实证）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.join(root, 'out/test/browser/graphic')
await mkdir(outDir, { recursive: true })
const output = path.join(outDir, 'fixture.js')
await build({
  entryPoints: [path.join(root, 'test/browser/quickActionsFixture.ts')],
  bundle: true, outfile: output, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]',
})

const DOC = [
  '# 图形化代码块',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[开始] --> B{判断}',
  '  B -- 是 --> C[结束]',
  '```',
  '',
].join('\n')

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fixture.css">
<script>window.__vsidianMermaidUri = new URL('../../../webview/mermaid.js', location.href).href;</script>
</head><body><div id="app"></div><script src="fixture.js"></script></body></html>`
await writeFile(path.join(outDir, 'page.html'), html)

const browser = await chromium.launch({
  headless: true, channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined,
})
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  await page.goto('file:///' + path.join(outDir, 'page.html').replaceAll('\\', '/'))
  await page.evaluate((doc) => {
    window.initQuick(doc)
    const view = window.controller.getView()
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  }, DOC)
  await page.waitForFunction(
    () => document.querySelector('.vsidian-mermaid')?.getAttribute('data-vsidian-mermaid-state') === 'rendered',
    null,
    { timeout: 30000 },
  )

  const frame = page.locator('.vsidian-graphic-frame').first()
  const editBtn = page.locator('.vsidian-graphic-chrome-edit').first()
  const popupBtn = page.locator('.vsidian-graphic-chrome-popup').first()

  // 1) 悬停显隐：未悬停透明不可见，悬停 frame 后显现（原生 mouse.move）
  const idleOpacity = await editBtn.evaluate((el) => getComputedStyle(el).opacity)
  assert.equal(idleOpacity, '0', '未悬停时按钮应透明隐藏')
  await frame.hover()
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('.vsidian-graphic-chrome-edit')).opacity === '1',
  )
  // 2) 禁点击：原生点击图形中心，光标不落位、渲染图不退场
  const anchorBefore = await page.evaluate(() => window.controller.getView().state.selection.main.anchor)
  const frameBox = await frame.boundingBox()
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + Math.min(frameBox.height / 2, 200))
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => ({
    anchor: window.controller.getView().state.selection.main.anchor,
    rendered: document.querySelector('.vsidian-graphic-frame') !== null,
  }))
  assert.equal(after.anchor, anchorBefore, '点击图形不得移动光标（禁点击进编辑）')
  assert.equal(after.rendered, true, '点击图形后渲染图仍在场')

  // 3) edit 按钮：原生点击后光标落围栏、源码显形（编辑入口迁移）
  await frame.hover()
  await editBtn.click()
  await page.waitForFunction(() => document.querySelector('.vsidian-graphic-frame') === null)
  const editState = await page.evaluate(() => ({
    anchor: window.controller.getView().state.selection.main.anchor,
    text: window.controller.getView().state.doc.toString(),
  }))
  assert.equal(editState.anchor, DOC.indexOf('```mermaid'), 'edit 后光标应落围栏起点')
  assert.ok(editState.text.includes('```mermaid'), '文档内容不受 edit 影响（零写回）')

  // 恢复呈现态（光标移出围栏）再开弹窗
  await page.evaluate(() => {
    const view = window.controller.getView()
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  })
  await page.waitForFunction(
    () => document.querySelector('.vsidian-mermaid')?.getAttribute('data-vsidian-mermaid-state') === 'rendered',
  )

  // 4) popup：原生点击打开全屏浮层，SVG 以矢量装载
  await frame.hover()
  await popupBtn.click()
  await page.waitForFunction(() => document.querySelector('.vsidian-diagram-media svg') !== null)
  assert.ok(await page.locator('.vsidian-diagram-overlay').isVisible(), '浮层应可见')

  // 5) 滚轮缩放（写 SVG 实际尺寸）：放大后 svg width 增长
  const widthBefore = await page.evaluate(() => {
    const svg = document.querySelector('.vsidian-diagram-media svg')
    return Math.round(Number.parseFloat(svg.style.width))
  })
  await page.mouse.move(450, 350)
  await page.mouse.wheel(0, -600)
  await page.waitForTimeout(150)
  const widthAfter = await page.evaluate(() => {
    const svg = document.querySelector('.vsidian-diagram-media svg')
    return { w: Math.round(Number.parseFloat(svg.style.width)), t: document.querySelector('.vsidian-diagram-media').style.transform }
  })
  assert.ok(widthAfter.w > widthBefore, `滚轮放大应增大 SVG 实际尺寸（${widthBefore} → ${widthAfter.w}）`)

  // 6) 拖拽平移：transform 的 translate 变化
  await page.mouse.move(450, 350)
  await page.mouse.down()
  await page.mouse.move(550, 400, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  const panTransform = await page.evaluate(() => document.querySelector('.vsidian-diagram-media').style.transform)
  assert.notEqual(panTransform, widthAfter.t, '拖拽应改变平移 transform')

  // 7) 键盘：0 重置、Esc 关闭（浮层内生效，关闭后焦点归还）
  await page.keyboard.press('0')
  await page.waitForTimeout(100)
  const resetWidth = await page.evaluate(() =>
    Math.round(Number.parseFloat(document.querySelector('.vsidian-diagram-media svg').style.width)),
  )
  assert.ok(resetWidth < widthAfter.w, '0 应重置为 contain-fit 尺寸')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('.vsidian-diagram-overlay') === null)
  assert.equal(await page.evaluate(() => document.body.style.overflow), '', '关闭后恢复 body overflow')

  // 8) 导出 SVG：经桥发出 diagram.export（生产控制器的消息通道）
  await frame.hover()
  await popupBtn.click()
  await page.waitForFunction(() => document.querySelector('.vsidian-diagram-media svg') !== null)
  await page.locator('.vsidian-diagram-export-svg').click()
  await page.waitForFunction(
    () => window.quickSent().some((m) => m.kind === 'diagram.export'),
  )
  const svgExport = await page.evaluate(() =>
    window.quickSent().find((m) => m.kind === 'diagram.export'),
  )
  assert.equal(svgExport.format, 'svg')
  assert.ok(svgExport.content.includes('<svg'), 'SVG 导出内容应为序列化文档')
  assert.ok(svgExport.content.includes('width='), '导出 SVG 应固化尺寸')

  // 9) PNG 光栅化（CSP data: 实证 + foreignObject 风险项实测）：产出
  //    dataURL 并发出 diagram.export；非空 base64 即通过，视觉保真度属
  //    人工验证清单项
  await page.locator('.vsidian-diagram-export-png').click()
  await page.waitForFunction(
    () => window.quickSent().some((m) => m.kind === 'diagram.export' && m.format === 'png'),
    null,
    { timeout: 15000 },
  )
  const pngExport = await page.evaluate(() =>
    window.quickSent().find((m) => m.kind === 'diagram.export' && m.format === 'png'),
  )
  assert.ok(pngExport.content.length > 1000, 'PNG base64 应为非平凡载荷')
  assert.match(pngExport.content, /^[A-Za-z0-9+/]+={0,2}$/, 'PNG 内容应为严格 base64')

  // 10) 关闭路径：点击 backdrop 关闭
  await page.mouse.click(20, 20)
  await page.waitForFunction(() => document.querySelector('.vsidian-diagram-overlay') === null)

  await page.close()
  console.log('[图形化代码块交互] 悬停显隐、禁点击、edit 迁移、弹窗缩放/平移/键盘/Esc、SVG/PNG 导出通过')
} finally {
  await browser.close()
}
