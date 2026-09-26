// 生产设置页在 Chromium 中的原生按键录入、双键搜索与明暗绘制回归。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/keybindings.js')
await build({ entryPoints: [path.join(root, 'src/webview/settingsMain.ts')], bundle: true,
  outfile: output, format: 'iife' })
const artifacts = path.join(root, 'out/task91')
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<html lang="zh-CN"><body><div id="app"></div></body></html>')
    const palette = theme === 'light' ? ['#fff', '#30343b', '#f5f6f8', '#d7dce3', '#f2f4f7']
      : ['#1e1e1e', '#ddd', '#252526', '#474750', '#313136']
    await page.addStyleTag({ content: `:root { --vscode-editor-background:${palette[0]}; --vscode-editor-foreground:${palette[1]}; --vscode-sideBar-background:${palette[2]}; --vscode-panel-border:${palette[3]}; --vscode-editorWidget-background:${palette[4]}; --vscode-input-background:${palette[0]}; --vscode-input-foreground:${palette[1]}; --vscode-descriptionForeground:${palette[1]}; --vscode-focusBorder:#2687d4; }` })
    await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
    await page.evaluate(() => {
      window.messages = []
      window.overrides = {}
      window.acquireVsCodeApi = () => ({ postMessage(message) {
        window.messages.push(message)
        if (message.kind === 'settings.get') setTimeout(() => window.dispatchEvent(new MessageEvent('message',
          { data: { kind: 'settings.snapshot', values: { 'editor.lineNumbers': true } } })), 0)
        if (message.kind === 'keybindings.get') setTimeout(() => window.dispatchEvent(new MessageEvent('message',
          { data: { kind: 'keybindings.snapshot', overrides: window.overrides } })), 0)
        if (message.kind === 'keybindings.set') {
          window.overrides[message.id] = message.bindings
          if (message.replaceConflicts) window.overrides.bold = []
          setTimeout(() => window.dispatchEvent(new MessageEvent('message',
            { data: { kind: 'keybindings.changed', overrides: window.overrides,
              requestId: message.requestId, ok: true } })), 0)
        }
      } })
    })
    await page.addScriptTag({ path: output })
    await page.getByRole('button', { name: '快捷键', exact: true }).click()
    const bold = page.locator('[data-operation-id="bold"]')
    await bold.locator('kbd').waitFor()
    assert.equal(await bold.locator('kbd').innerText(), 'Ctrl+B')
    const paint = await bold.locator('.vsidian-keybindings-tag').evaluate((node) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return { bg: style.backgroundColor, border: style.borderStyle, visible: rect.width > 0 && rect.height > 0 }
    })
    assert.equal(paint.bg, theme === 'light' ? 'rgb(242, 244, 247)' : 'rgb(49, 49, 54)')
    assert.equal(paint.border, 'solid')
    assert.equal(paint.visible, true)
    const italic = page.locator('[data-operation-id="italic"]')
    await italic.getByRole('button', { name: '添加绑定' }).click()
    await italic.getByRole('textbox', { name: '按下单段或连续两段快捷键' }).focus()
    await page.keyboard.press('Control+b')
    await italic.getByRole('button', { name: '保存绑定' }).click()
    await italic.getByRole('alert').waitFor()
    const conflictPaint = await italic.getByRole('alert').evaluate((node) => {
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return { border: style.borderLeftWidth, visible: rect.width > 0 && rect.height > 0 }
    })
    assert.equal(conflictPaint.border, '3px')
    assert.equal(conflictPaint.visible, true)
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.kind === 'keybindings.set').length), 0)
    await italic.getByRole('button', { name: '替换原绑定' }).click()
    await page.getByRole('status').filter({ hasText: '快捷键已保存' }).waitFor()
    assert.equal(await bold.locator('.vsidian-keybindings-unbound').innerText(), '未绑定')
    const math = page.locator('[data-operation-id="inlineMath"]')
    await math.getByRole('button', { name: '添加绑定' }).click()
    await math.getByRole('textbox', { name: '按下单段或连续两段快捷键' }).focus()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+m')
    await math.getByRole('button', { name: '保存绑定' }).click()
    await page.getByRole('status').filter({ hasText: '快捷键已保存' }).waitFor()
    assert.equal(await math.locator('kbd').innerText(), 'Ctrl+K Ctrl+M')
    const keySearch = page.getByRole('textbox', { name: '按键搜索绑定' })
    await keySearch.focus()
    await page.keyboard.press('Control+k')
    await page.keyboard.press('Control+m')
    assert.equal(await page.locator('.vsidian-keybindings-row').count(), 1)
    assert.equal(await page.locator('.vsidian-keybindings-row').getAttribute('data-operation-id'), 'inlineMath')
    await page.screenshot({ path: path.join(artifacts, `keybindings-${theme}.png`) })
    assert.deepEqual(errors, [])
    console.log(`[快捷键页][PASS] ${theme}：原生录键、冲突替换、两段键搜索与标签绘制`)
    await page.close()
  }
} finally { await browser.close() }
