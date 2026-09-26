// 使用浏览器原生键盘回归 #120 Tab/Shift+Tab 通用缩进：无选区光标行、
// 选区多行、列表智能对齐（`- ` 2 格、`10. ` 4 格、任务 6 格、引用内
// 列表落点）、Shift+Tab 反向与不足全删、表格内导航优先与边界不缩进、
// 代码块围栏内普通行语义。光标定位走生产 view.locate 链路；断言只看
// 文本与光标（readEditor）。
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = path.join(root, 'out/test/browser/tabIndent.js')
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
await build({ entryPoints: [path.join(root, 'test/browser/tabIndentFixture.ts')],
  bundle: true, outfile: bundle, format: 'iife',
  loader: { '.woff2': 'file', '.svg': 'file' }, assetNames: 'assets/[name]', plugins: [katexFontStrip, katexMinJs] })

const TABLE_DOC = '| a | b |\n| --- | --- |\n| 1 | 2 |\npara'

const scenarios = [
  { name: 'tab-plain', doc: 'plain text', cursor: 6, keys: ['Tab'],
    text: '  plain text', head: 8,
    // 光标真实性：后续原生输入落在缩进后的正文
    type: { keys: 'x', text: '  plain xtext' } },
  { name: 'tab-empty-line', doc: 'a\n\nb', cursor: 2, keys: ['Tab'], text: 'a\n  \nb', head: 4 },
  { name: 'tab-bullet', doc: '- p\n- c', cursor: 6, keys: ['Tab'], text: '- p\n  - c', head: 8 },
  { name: 'tab-nested-bullet', doc: '- p\n  - c', cursor: 8, keys: ['Tab'], text: '- p\n    - c', head: 10 },
  { name: 'tab-ordered-wide', doc: '10. p\n11. c', cursor: 10, keys: ['Tab'], text: '10. p\n    11. c', head: 14 },
  { name: 'tab-task', doc: '- [ ] p\n- [ ] c', cursor: 13, keys: ['Tab'], text: '- [ ] p\n      - [ ] c', head: 19 },
  { name: 'tab-quote-list', doc: '> - p\n> - c', cursor: 8, keys: ['Tab'], text: '> - p\n>   - c', head: 10 },
  { name: 'tab-quote-plain', doc: '> q', cursor: 3, keys: ['Tab'], text: '  > q', head: 5 },
  { name: 'tab-code-fence', doc: '```js\n1. code\n```', cursor: 7, keys: ['Tab'], text: '```js\n  1. code\n```', head: 9 },
  { name: 'shift-plain', doc: '  plain', cursor: 5, keys: ['Shift+Tab'], text: 'plain', head: 3 },
  { name: 'shift-over-indent', doc: '    plain', cursor: 7, keys: ['Shift+Tab'], text: '  plain', head: 5 },
  { name: 'shift-bullet', doc: '- p\n  - c', cursor: 8, keys: ['Shift+Tab'], text: '- p\n- c', head: 6 },
  { name: 'shift-ordered-wide', doc: '10. p\n    11. c', cursor: 14, keys: ['Shift+Tab'], text: '10. p\n11. c', head: 10 },
  { name: 'shift-insufficient', doc: '- p\n - c', cursor: 7, keys: ['Shift+Tab'], text: '- p\n- c', head: 6 },
  { name: 'shift-nothing-swallows', doc: 'plain', cursor: 2, keys: ['Shift+Tab'], text: 'plain', head: 2 },
  {
    name: 'tab-selection-lines', doc: 'a\nb\nc', range: [0, 3], keys: ['Tab'],
    text: '  a\n  b\nc', from: 2, to: 7,
  },
  {
    name: 'tab-selection-mixed', doc: '- item\nplain', range: [0, 12], keys: ['Tab'],
    text: '  - item\n  plain', from: 2, to: 16,
  },
  {
    name: 'tab-table-nav-priority', doc: TABLE_DOC, cursor: TABLE_DOC.indexOf('1') + 1,
    keys: ['Tab'], text: TABLE_DOC, head: TABLE_DOC.indexOf('2'),
  },
  {
    name: 'shift-table-edge-no-indent', doc: TABLE_DOC, cursor: TABLE_DOC.indexOf('a') + 1,
    keys: ['Shift+Tab'], text: TABLE_DOC, head: TABLE_DOC.indexOf('a') + 1,
  },
  {
    name: 'tab-table-row-selection-no-indent', doc: TABLE_DOC,
    range: [TABLE_DOC.indexOf('| 1'), TABLE_DOC.indexOf('2 |') + 2],
    keys: ['Tab'], text: TABLE_DOC,
    from: TABLE_DOC.indexOf('| 1'), to: TABLE_DOC.indexOf('2 |') + 2,
  },
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
      if (s.range) {
        await page.evaluate(([from, to]) => window.selectRange(from, to), s.range)
      } else {
        await page.evaluate((cursor) => window.locate(cursor), s.cursor)
      }
      for (const key of s.keys) {
        await page.keyboard.press(key)
      }
      const after = await page.evaluate(() => window.readEditor())
      assert.equal(after.text, s.text, `${s.name}: ${JSON.stringify(after)}`)
      if (s.range) {
        assert.equal(after.from, s.from, `${s.name} from: ${JSON.stringify(after)}`)
        assert.equal(after.to, s.to, `${s.name} to: ${JSON.stringify(after)}`)
      } else {
        assert.equal(after.head, s.head, `${s.name} head: ${JSON.stringify(after)}`)
      }
      if (s.type) {
        await page.keyboard.type(s.type.keys)
        const typedState = await page.evaluate(() => window.readEditor())
        assert.equal(typedState.text, s.type.text, `${s.name} 后续输入: ${JSON.stringify(typedState)}`)
      }
      assert.deepEqual(errors, [], `${s.name} 页面错误`)
      passed++
      console.log(`[缩进键位][PASS] ${s.name}`)
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
}
console.log(`[缩进键位] ${passed}/${scenarios.length} 通过`)
if (passed !== scenarios.length) process.exit(1)
