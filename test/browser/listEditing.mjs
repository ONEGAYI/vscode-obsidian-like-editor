// 使用浏览器原生键盘回归 #119 列表/引用键位：Enter 前缀延续（各族标记、
// 有序 +1 保宽、任务重置、引用内列表、空项退出）与 Backspace 分层清层
// （顶级清整段、任务单元、嵌套升级、引用剥层）。光标定位走生产
// view.locate 链路；断言只看文本与光标（readEditor）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/listEditing.js')
// 与 tableCaret.mjs 同口径：katex 裸导入重定向官方 UMD；css 裁掉 woff/ttf
const katexFontStrip = {
  name: 'katex-font-fallback-strip',
  setup(b) {
    b.onLoad({ filter: /katex\.min\.css$/ }, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replace(
        /,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\((["']?)(?:woff|truetype)\1\)/g, ''),
      loader: 'css',
    }))
  },
}
const katexMinJs = {
  name: 'katex-min-js',
  setup(b) {
    b.onResolve({ filter: /^katex$/ }, () => ({
      path: path.resolve(root, 'node_modules/katex/dist/katex.min.js'),
    }))
  },
}
await build({ entryPoints: [path.join(root, 'test/browser/listEditingFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.woff2': 'file', '.svg': 'file' }, assetNames: 'assets/[name]', plugins: [katexFontStrip, katexMinJs] })

const scenarios = [
  {
    name: 'enter-bullet',
    doc: '- one', cursor: 5, keys: ['Enter'],
    text: '- one\n- ', head: 8,
    // 光标真实性：后续原生输入必须落在新项正文
    type: { keys: 'two', text: '- one\n- two' },
  },
  { name: 'enter-bullet-star', doc: '* one', cursor: 5, keys: ['Enter'], text: '* one\n* ', head: 8 },
  { name: 'enter-ordered', doc: '1. one', cursor: 6, keys: ['Enter'], text: '1. one\n2. ', head: 10 },
  { name: 'enter-ordered-width', doc: '9. one', cursor: 6, keys: ['Enter'], text: '9. one\n10. ', head: 11 },
  { name: 'enter-ordered-pad', doc: '01. one', cursor: 7, keys: ['Enter'], text: '01. one\n02. ', head: 12 },
  { name: 'enter-task-reset', doc: '- [x] one', cursor: 9, keys: ['Enter'], text: '- [x] one\n- [ ] ', head: 16 },
  { name: 'enter-quote', doc: '> one', cursor: 5, keys: ['Enter'], text: '> one\n> ', head: 8 },
  { name: 'enter-quote-nested', doc: '> > one', cursor: 7, keys: ['Enter'], text: '> > one\n> > ', head: 12 },
  { name: 'enter-quote-list', doc: '> - one', cursor: 7, keys: ['Enter'], text: '> - one\n> - ', head: 12 },
  { name: 'enter-list-nested', doc: '- p\n  - sub', cursor: 10, keys: ['Enter'], text: '- p\n  - su\n  - b', head: 15 },
  { name: 'enter-split', doc: '- item', cursor: 4, keys: ['Enter'], text: '- it\n- em', head: 7 },
  { name: 'enter-blank-exit', doc: '- \nnext', cursor: 2, keys: ['Enter'], text: '\nnext', head: 0 },
  { name: 'enter-blank-task-exit', doc: '- [ ] \nnext', cursor: 6, keys: ['Enter'], text: '\nnext', head: 0 },
  { name: 'enter-blank-quote-exit', doc: '> \nnext', cursor: 2, keys: ['Enter'], text: '\nnext', head: 0 },
  { name: 'enter-blank-quote-list', doc: '> - \nnext', cursor: 4, keys: ['Enter'], text: '> \nnext', head: 2 },
  { name: 'enter-blank-nested-quote', doc: '> > \nnext', cursor: 4, keys: ['Enter'], text: '> \nnext', head: 2 },
  { name: 'backspace-clear', doc: '- item', cursor: 2, keys: ['Backspace'], text: 'item', head: 0 },
  { name: 'backspace-ordered', doc: '1. item', cursor: 3, keys: ['Backspace'], text: 'item', head: 0 },
  { name: 'backspace-task-unit', doc: '- [ ] item', cursor: 6, keys: ['Backspace'], text: 'item', head: 0 },
  { name: 'backspace-task-done-unit', doc: '- [x] item', cursor: 6, keys: ['Backspace'], text: 'item', head: 0 },
  { name: 'backspace-quote', doc: '> item', cursor: 2, keys: ['Backspace'], text: 'item', head: 0 },
  { name: 'backspace-quote-layer', doc: '> > item', cursor: 4, keys: ['Backspace'], text: '> item', head: 2 },
  { name: 'backspace-quote-list', doc: '> - item', cursor: 4, keys: ['Backspace'], text: '> item', head: 2 },
  { name: 'backspace-nested-promote', doc: '- p\n  - c', cursor: 8, keys: ['Backspace'], text: '- p\n- c', head: 6 },
  { name: 'backspace-inside-mark', doc: '1. item', cursor: 1, keys: ['Backspace'], text: '. item', head: 0 },
  { name: 'backspace-plain-default', doc: 'plain', cursor: 2, keys: ['Backspace'], text: 'pain', head: 1 },
]

const browser = await chromium.launch({ headless: true,
  channel: process.env.VSIDIAN_TEST_BROWSER_CHANNEL || undefined })
let passed = 0
try {
  for (const s of scenarios) {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.setContent('<div id="app"></div>')
      await page.addStyleTag({ path: bundle.replace(/\.js$/, '.css') })
      await page.addScriptTag({ path: bundle })
      await page.evaluate((text) => {
        window.initDoc(text)
      }, s.doc)
      // 先点击聚焦（光标会落到点击处），再经生产 view.locate 链路精确定位
      await page.click('.cm-content')
      await page.evaluate((cursor) => window.locate(cursor), s.cursor)
      for (const key of s.keys) {
        await page.keyboard.press(key)
      }
      const after = await page.evaluate(() => window.readEditor())
      assert.equal(after.text, s.text, `${s.name}: ${JSON.stringify(after)}`)
      assert.equal(after.head, s.head, `${s.name} head: ${JSON.stringify(after)}`)
      if (s.type) {
        await page.keyboard.type(s.type.keys)
        const typedState = await page.evaluate(() => window.readEditor())
        assert.equal(typedState.text, s.type.text, `${s.name} 后续输入: ${JSON.stringify(typedState)}`)
      }
      assert.deepEqual(errors, [], `${s.name} 页面错误`)
      passed++
      console.log(`[列表键位][PASS] ${s.name}`)
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
}
console.log(`[列表键位] ${passed}/${scenarios.length} 通过`)
if (passed !== scenarios.length) process.exit(1)
