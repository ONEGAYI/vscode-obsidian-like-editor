// #116 缺陷二/三浏览器回归：任务 checkbox 必须经真实鼠标链路（Playwright
// 原生 click：mousedown → mouseup → click）完成切换。合成 click（unit 与
// task.test.click 钩子）测不到 CM6 在 mousedown 阶段把光标放入 [ ] 标记、
// 装饰规则随即移除 widget 的路径——这正是缺陷二在既有测试全绿下漏网的原因。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/taskClick.js')
await build({ entryPoints: [path.join(root, 'test/browser/taskClickFixture.ts')],
  bundle: true, outfile: output, format: 'iife',
  loader: { '.svg': 'file' }, assetNames: 'assets/[name]' })
const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
try {
  async function openPage() {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent('<html><body><div id="app"></div></body></html>')
    await page.addStyleTag({ path: output.replace(/\.js$/, '.css') })
    await page.addScriptTag({ path: output })
    return { page, errors }
  }
  // edit.request 断言只比较载荷三要素（sessionId/docUri 等会话字段不参与）
  const editRequests = (page) => page.evaluate(() =>
    window.taskSent().filter((m) => m.kind === 'edit.request')
      .map(({ seq, baseVersion, changes }) => ({ seq, baseVersion, changes })))

  // ---- live：真实鼠标点击 checkbox 原地切换，光标不移入标记 ----
  {
    const { page, errors } = await openPage()
    const text = '- [ ] 任务甲\n- [x] 任务乙\n'
    await page.evaluate((t) => window.initTaskDoc(t, 'live'), text)
    // 真实场景：用户正在编辑器内（焦点在 contentDOM）后用鼠标点 checkbox
    await page.evaluate(() => window.controller.getView().focus())
    const boxes = page.locator('input.vsidian-task-checkbox')
    assert.equal(await boxes.count(), 2, 'live 非活动行的两个任务标记都应有 checkbox')
    // 真实鼠标点击第一个（未勾选）：mousedown 阶段 CM6 不得把光标放进 [ ]
    // （否则装饰规则移除 widget、click 永不触发——缺陷二）
    await boxes.nth(0).click()
    assert.deepEqual(await editRequests(page),
      [{ seq: 1, baseVersion: 1,
        changes: [{ offset: text.indexOf('['), length: 3, text: '[x]' }] }],
    '真实点击应派发一笔 [ ]→[x] 精确替换')
    assert.equal(await page.evaluate(() => window.taskDoc()),
      '- [x] 任务甲\n- [x] 任务乙\n', 'CM6 文档应立即乐观更新')
    assert.equal(await page.evaluate(() => window.taskHead()), 0,
      '点击 checkbox 不得把光标移入标记区间（应保持原位）')
    assert.equal(await boxes.count(), 2, '点击后 widget 须全部存活（不得显源码）')
    assert.equal(await boxes.nth(0).evaluate((el) => document.activeElement === el), false,
      '点击 checkbox 不得把焦点抢到 input 上')
    // 点击切换事务走标准编辑链：Ctrl+Z 出站 history.request（权威撤销栈
    // 在宿主文本管线，webview 本地不装 history 扩展——集成测试覆盖宿主侧
    // 撤销；此处验证真实点击后撤销链路可达）
    await page.keyboard.press('Control+z')
    assert.deepEqual(await page.evaluate(() => window.taskSent()
      .filter((m) => m.kind === 'history.request').map((m) => m.op)), ['undo'],
    'Ctrl+Z 应经 keymap 出站 history.request（undo）')
    // 模拟宿主撤销广播回流（外部增量还原勾选）：checkbox 应回到未勾选。
    // 权威串行管线：先确认在途勾选请求（undo 广播只会在确认后发生）
    await page.evaluate(() => window.controller.handleHostMessage(
      { kind: 'edit.ack', seq: 1, ok: true, version: 2 }))
    await page.evaluate((off) => window.controller.handleHostMessage(
      { kind: 'doc.changed', version: 3, origin: 'external',
        changes: [{ offset: off, length: 3, text: '[ ]' }] }), text.indexOf('['))
    assert.equal(await page.evaluate(() => window.taskDoc()), text,
      '撤销广播回流后 CM6 文档应还原为未勾选')
    assert.equal(await boxes.nth(0).evaluate((el) => el.checked), false,
      '撤销回流后 checkbox 应回到未勾选')
    // 真实点击已勾选项：[x]→[ ]
    await boxes.nth(1).click()
    assert.deepEqual(await editRequests(page), [
      { seq: 1, baseVersion: 1,
        changes: [{ offset: text.indexOf('['), length: 3, text: '[x]' }] },
      { seq: 2, baseVersion: 3,
        changes: [{ offset: text.indexOf('[x]'), length: 3, text: '[ ]' }] },
    ], '真实点击已勾选任务应派发 [x]→[ ]（撤销回流后版本顺延至 3）')
    assert.deepEqual(errors, [], '页面不能有未捕获异常')
    await page.close()
  }

  // ---- reading：紧凑任务列表真实点击（既有行为真实链路回归） ----
  {
    const { page, errors } = await openPage()
    const text = '- [ ] 紧凑甲\n- [x] 紧凑乙\n'
    await page.evaluate((t) => window.initTaskDoc(t, 'reading'), text)
    const boxes = page.locator('input.vsidian-reading-task-checkbox')
    assert.equal(await boxes.count(), 2, '紧凑任务列表应有 2 个 checkbox')
    await boxes.nth(0).click()
    assert.deepEqual(await editRequests(page),
      [{ seq: 1, baseVersion: 1,
        changes: [{ offset: text.indexOf('['), length: 3, text: '[x]' }] }],
    '阅读模式真实点击应经事件委托走出站链路')
    assert.deepEqual(await boxes.evaluateAll((nodes) => nodes.map((n) => n.checked)),
      [true, true], '阅读视图应乐观重建为勾选')
    assert.deepEqual(errors, [], '页面不能有未捕获异常')
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('[任务 checkbox 真实鼠标回归] live 光标不移入标记、reading 紧凑列表真实点击通过')
