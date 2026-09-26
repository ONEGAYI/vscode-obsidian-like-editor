// Mermaid 绘制探针回归：在真实 Chromium 布局下经 view.state.paint 观察。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/mermaidPaint.js')
await build({ entryPoints: [path.join(root, 'test/browser/quickActionsFixture.ts')],
  bundle: true, outfile: output, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })

const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
  await page.setContent('<div id="app"></div>')
  await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
  await page.addScriptTag({ path: output })
  await page.evaluate(() => window.initQuick('正文'))

  const hidden = await page.evaluate(() => {
    const diagram = document.createElement('div')
    diagram.className = 'vsidian-mermaid'
    diagram.setAttribute('data-vsidian-mermaid-state', 'rendered')
    diagram.style.cssText = 'position:fixed;left:100px;top:100px;width:100px;height:100px;background:red;z-index:1000'
    diagram.innerHTML = '<svg width="100" height="100" style="visibility:hidden"><rect width="100" height="100" fill="blue"/></svg>'
    window.controller.getView().contentDOM.appendChild(diagram)
    const hit = document.elementFromPoint(150, 150)
    window.controller.handleHostMessage({ kind: 'view.state.request' })
    const state = window.quickSent().at(-1)
    return { visible: state.paint?.mermaid?.visible, hitContainer: hit === diagram,
      svgVisibility: getComputedStyle(diagram.querySelector('svg')).visibility }
  })
  assert.equal(hidden.hitContainer, true, '预置条件：隐藏 SVG 的中心命中可见容器')
  assert.equal(hidden.svgVisibility, 'hidden')
  assert.equal(hidden.visible, false, 'SVG visibility:hidden 时不能把容器背景视为图表绘制')

  const clipped = await page.evaluate(() => {
    const crop = document.createElement('div')
    crop.style.cssText = 'position:fixed;left:250px;top:100px;width:100px;height:30px;overflow:hidden;z-index:1000'
    const diagram = document.createElement('div')
    diagram.className = 'vsidian-mermaid'
    diagram.setAttribute('data-vsidian-mermaid-state', 'rendered')
    diagram.style.cssText = 'width:100px;height:100px'
    diagram.innerHTML = '<svg width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>'
    crop.appendChild(diagram)
    window.controller.getView().contentDOM.appendChild(crop)
    const svg = diagram.querySelector('svg')
    const topHit = document.elementFromPoint(300, 115)
    const centerHit = document.elementFromPoint(300, 150)
    window.controller.handleHostMessage({ kind: 'view.state.request' })
    const state = window.quickSent().at(-1)
    return { visible: state.paint?.mermaid?.visible,
      topHitSvg: svg.contains(topHit), centerHitSvg: svg.contains(centerHit) }
  })
  assert.equal(clipped.topHitSvg, true, '预置条件：裁切后顶部 30px 仍绘出 SVG')
  assert.equal(clipped.centerHitSvg, false, '预置条件：SVG 几何中心已被祖先裁切')
  assert.equal(clipped.visible, true, '祖先裁切后仍有 SVG 绘制像素应判为可见')

  const transparent = await page.evaluate(() => {
    window.controller.getView().contentDOM.querySelectorAll('.vsidian-mermaid').forEach((el) =>
      el.parentElement?.style.position === 'fixed' ? el.parentElement.remove() : el.remove())
    const layer = document.createElement('div')
    layer.style.cssText = 'position:fixed;left:100px;top:250px;width:100px;height:100px;opacity:0;z-index:1000'
    const diagram = document.createElement('div')
    diagram.className = 'vsidian-mermaid'
    diagram.setAttribute('data-vsidian-mermaid-state', 'rendered')
    diagram.innerHTML = '<svg width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>'
    layer.appendChild(diagram)
    window.controller.getView().contentDOM.appendChild(layer)
    window.controller.handleHostMessage({ kind: 'view.state.request' })
    return window.quickSent().at(-1).paint?.mermaid?.visible
  })
  assert.equal(transparent, false, '祖先 opacity:0 时 SVG 未绘制')

  const partlyCovered = await page.evaluate(() => {
    window.controller.getView().contentDOM.querySelectorAll('.vsidian-mermaid').forEach((el) =>
      el.parentElement?.remove())
    const diagram = document.createElement('div')
    diagram.className = 'vsidian-mermaid'
    diagram.setAttribute('data-vsidian-mermaid-state', 'rendered')
    diagram.style.cssText = 'position:fixed;left:100px;top:250px;width:100px;height:100px;z-index:1000'
    diagram.innerHTML = '<svg width="100" height="100"><rect width="100" height="100" fill="blue"/></svg>'
    window.controller.getView().contentDOM.appendChild(diagram)
    const cover = document.createElement('div')
    cover.style.cssText = 'position:fixed;left:130px;top:280px;width:40px;height:40px;background:red;z-index:1001'
    document.body.appendChild(cover)
    const centerHit = document.elementFromPoint(150, 300)
    const edgeHit = document.elementFromPoint(120, 270)
    window.controller.handleHostMessage({ kind: 'view.state.request' })
    return { visible: window.quickSent().at(-1).paint?.mermaid?.visible,
      centerCovered: centerHit === cover,
      edgeSvg: diagram.querySelector('svg').contains(edgeHit) }
  })
  assert.equal(partlyCovered.centerCovered, true, '预置条件：图形中心被浮层挡住')
  assert.equal(partlyCovered.edgeSvg, true, '预置条件：图形边缘仍可见')
  assert.equal(partlyCovered.visible, true, '中心受遮挡时仍应识别其他可见 SVG 区域')
  await page.close()
  console.log('[Mermaid 绘制探针] 隐藏、裁切、透明与局部遮挡通过')
} finally {
  await browser.close()
}
