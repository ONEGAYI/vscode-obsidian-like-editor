// scripts/release.mjs 纯函数契约测试（node --test，与 testHost.test.mjs 同
// 先例：mjs 工具用 node --test 钉契约，不进 vitest 扫描范围）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractLatestChangelog, inspectVsixEntries, parseUnzipListing, SIZE_LIMITS } from '../../scripts/release.mjs'

// KaTeX 字体条目（#59）：体积取 woff2 实际产物的代表值（最大 28KB）
function katexFontEntries() {
  return ['AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold',
    'Fraktur-Regular', 'Main-Bold', 'Main-BoldItalic', 'Main-Italic', 'Main-Regular',
    'Math-BoldItalic', 'Math-Italic', 'SansSerif-Bold', 'SansSerif-Italic',
    'SansSerif-Regular', 'Script-Regular', 'Size1-Regular', 'Size2-Regular',
    'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular'].map((family) => ({
    size: 14000,
    name: `extension/out/webview/assets/KaTeX_${family}.woff2`,
  }))
}

// 与真实 VSIX 内容对应的合法基线（体积取包体检查阈值内的代表值）。
function makeEntries() {
  return [
    { size: 2477, name: 'extension.vsixmanifest' },
    { size: 511, name: '[Content_Types].xml' },
    { size: 4881, name: 'extension/package.json' },
    { size: 56, name: 'extension/package.nls.json' },
    { size: 54, name: 'extension/package.nls.zh-cn.json' },
    { size: 10688, name: 'extension/readme.md' },
    { size: 3000, name: 'extension/CHANGELOG.md' },
    { size: 1100, name: 'extension/LICENSE.txt' },
    { size: 101482, name: 'extension/out/extension.js' },
    { size: 829024, name: 'extension/out/webview/main.js' },
    { size: 41308, name: 'extension/out/webview/main.css' },
    { size: 5683, name: 'extension/out/webview/settings.js' },
    { size: 902, name: 'extension/out/webview/settings.css' },
    // #60 Mermaid 独立产物（minify 后实测 2,727,077 B 的代表值；低于 3MB
    // 单文件警告线与 4MB 上限）
    { size: 2727077, name: 'extension/out/webview/mermaid.js' },
    { size: 3898, name: 'extension/media/css-contract-probe.css' },
    { size: 35761, name: 'extension/media/vsidian-icon-256.png' },
    ...katexFontEntries(),
  ]
}

test('CHANGELOG 提取：最新段落的版本、日期与正文（含 ### 子标题）', () => {
  const content = [
    '# Changelog',
    '',
    '## 0.2.0 - 2026-10-01',
    '',
    '### 新增',
    '',
    '- B 功能',
    '',
    '## 0.1.0 - 2026-09-25',
    '',
    '- 首个版本',
  ].join('\n')
  const notes = extractLatestChangelog(content, '0.2.0')
  assert.equal(notes.version, '0.2.0')
  assert.equal(notes.date, '2026-10-01')
  assert.match(notes.body, /### 新增/)
  assert.match(notes.body, /- B 功能/)
  assert.doesNotMatch(notes.body, /0\.1\.0/)
})

test('CHANGELOG 提取：最新版本与 package.json 不一致时报错', () => {
  const content = '# Changelog\n\n## 0.0.9 - 2026-01-01\n\n- 旧版本'
  assert.throws(() => extractLatestChangelog(content, '0.1.0'), /0\.0\.9.*0\.1\.0/)
})

test('CHANGELOG 提取：没有任何版本段落时报错', () => {
  assert.throws(() => extractLatestChangelog('# Changelog\n\n只有开头'), /未找到/)
})

test('unzip -l 解析：只提取"长度 日期 时间 路径"形态的文件行', () => {
  const listing = [
    'Archive:  vsidian-0.1.0.vsix',
    '  Length      Date    Time    Name',
    '---------  ---------- -----   ----',
    '     2477  2026-09-25 15:20   extension.vsixmanifest',
    '    10688  2026-09-25 15:20   extension/readme.md',
    '---------  ---------- -----   ----',
    '                    2 files',
  ].join('\n')
  const entries = parseUnzipListing(listing)
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { size: 2477, name: 'extension.vsixmanifest' })
  assert.equal(entries[1].name, 'extension/readme.md')
})

test('VSIX 检查：完整合法集合通过且零警告（#60 后单文件警告线 3MB，main.js 829KB 与 mermaid.js 2.62MB 均在线内）', () => {
  const result = inspectVsixEntries(makeEntries(), { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(result.ok, true)
  // #85 后总量两线上调 1MB：fixture 基线约 3.86MB 远低于警告线，全部
  // 单文件 < 3MB——合法基线不再有预期警告（#59 期 main.js 超 700KB
  // 警告线的口径作废）
  assert.deepEqual(result.warnings, [])
})

test('VSIX 检查：缺少任一 KaTeX 字体报错（公式回落系统字体的防线）', () => {
  const missing = makeEntries().filter(
    (e) => e.name !== 'extension/out/webview/assets/KaTeX_Size1-Regular.woff2',
  )
  const result = inspectVsixEntries(missing, { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('KaTeX_Size1-Regular.woff2')))
})

test('VSIX 检查：缺少必需运行时资产报错（大小写不敏感匹配）', () => {
  const entries = makeEntries().map((e) =>
    e.name === 'extension/package.nls.json' ? { ...e, name: 'extension/other.json' } : e,
  )
  const result = inspectVsixEntries(entries, { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('package.nls.json')))
})

test('VSIX 检查：README 大小写形态变化仍被接受', () => {
  const entries = makeEntries().map((e) => (e.name === 'extension/readme.md' ? { ...e, name: 'extension/README.MD' } : e))
  const result = inspectVsixEntries(entries, { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(result.ok, true)
})

test('VSIX 检查：仓库管理与开发文件一律拒绝', () => {
  for (const [name, label] of [
    ['extension/.github/workflows/ci.yml', 'GitHub 平台配置'],
    ['extension/out/webview/main.js.map', 'sourcemap'],
    ['extension/README.en.md', '英文 README'],
    ['extension/scripts/release.mjs', '构建脚本'],
    ['extension/package-lock.json', 'lockfile'],
  ]) {
    const result = inspectVsixEntries([...makeEntries(), { size: 100, name }])
    assert.equal(result.ok, false, `${name} 应被拒绝`)
    assert.ok(result.errors.some((e) => e.includes(label)), `${name} 的错误应标注 ${label}`)
  }
})

test('VSIX 检查：out/ 未登记产物拒绝（白名单拦「多」，评审 C1）', () => {
  for (const name of [
    'extension/out/webview/zz_analyze.css', // 调试遗留（v0.1.0 后实测发生过）
    'extension/out/webview/assets/KaTeX_Main-Regular.woff', // 裁剪失效的多余格式（同时被 C7 拦）
    'extension/out/webview/vendor.js', // 未登记的新产物
  ]) {
    const result = inspectVsixEntries([...makeEntries(), { size: 100, name }])
    assert.equal(result.ok, false, `${name} 应被拒绝`)
    assert.ok(result.errors.some((e) => e.includes('未登记产物')), `${name} 的错误应标注未登记产物`)
  }
})

test('VSIX 检查：woff/ttf 字体拒绝（字体裁剪失效防线，评审 C7）', () => {
  for (const name of [
    'extension/out/webview/assets/KaTeX_Main-Regular.woff',
    'extension/out/webview/assets/KaTeX_Main-Regular.ttf',
    'extension/media/fonts/some.ttf',
  ]) {
    const result = inspectVsixEntries([...makeEntries(), { size: 100, name }])
    assert.equal(result.ok, false, `${name} 应被拒绝`)
    assert.ok(
      result.errors.some((e) => e.includes('woff2')),
      `${name} 的错误应指向仅 woff2 约定`,
    )
  }
})

test('VSIX 检查：icon 缺失或超限报错（原图不得混入包内）', () => {
  const missing = inspectVsixEntries(makeEntries().filter((e) => !e.name.endsWith('vsidian-icon-256.png')), { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.some((e) => e.includes('缺少图标')))

  // 原图体积（约 598 KB > 100 KB 上限）即使混入也会被体积闸拦下
  const oversized = inspectVsixEntries(
    makeEntries().map((e) => (e.name.endsWith('vsidian-icon-256.png') ? { ...e, size: 598260 } : e)),
    { iconPath: 'media/vsidian-icon-256.png' },
  )
  assert.equal(oversized.ok, false)
  assert.ok(oversized.errors.some((e) => e.includes('图标')))
})

test('VSIX 检查：缺少 mermaid.js 报错（#60 图表渲染器懒加载产物的防线）', () => {
  const missing = makeEntries().filter((e) => e.name !== 'extension/out/webview/mermaid.js')
  const result = inspectVsixEntries(missing, { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('out/webview/mermaid.js')))
})

test('VSIX 检查：解压总体积与单文件双阈值（警告线与失败线）', () => {
  // 总量恰过警告线：增量摊到 mermaid.js 与 main.js 两个条目（各约一半，
  // 增量后均 < 4MB 单文件上限，只触发总量警告不触发失败）。#85 后总量
  // 两线上调 1MB，增量已大于任一单文件距 4MB 上限的余量——全压单个
  // 条目会先触发单文件失败，断言语义就变了。
  const base = makeEntries()
  const baseTotal = base.reduce((sum, e) => sum + e.size, 0)
  const overflow = Math.floor(SIZE_LIMITS.totalWarnBytes) - baseTotal + 1
  const warnEntries = base.map((e) => {
    if (e.name === 'extension/out/webview/mermaid.js') {
      return { ...e, size: e.size + Math.ceil(overflow / 2) }
    }
    if (e.name === 'extension/out/webview/main.js') {
      return { ...e, size: e.size + Math.floor(overflow / 2) }
    }
    return e
  })
  const warn = inspectVsixEntries(warnEntries)
  assert.equal(warn.ok, true)
  assert.ok(warn.warnings.some((w) => w.includes('警告线')), '总量过警告线应有警告不失败')

  const fail = makeEntries().map((e) => ({ ...e, size: 1000 }))
  fail.push({ size: Math.floor(SIZE_LIMITS.totalMaxBytes), name: 'extension/out/webview/bloat.js' })
  const result = inspectVsixEntries(fail)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('上限')))
})
