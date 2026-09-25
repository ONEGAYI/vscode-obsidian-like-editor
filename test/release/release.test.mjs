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

test('VSIX 检查：完整合法集合通过（#59 后 main.js 携带 KaTeX，超单文件警告线属预期）', () => {
  const result = inspectVsixEntries(makeEntries(), { iconPath: 'media/vsidian-icon-256.png' })
  assert.equal(result.ok, true)
  // 唯一预期警告：vendored KaTeX 使 main.js（约 829KB）越过 700KB 警告线
  //（未超 1MB 上限）；除此之外不得有其他警告（总量、字体单文件均在线内）
  assert.deepEqual(result.warnings.filter((w) => !w.includes('out/webview/main.js')), [])
  assert.ok(result.warnings.some((w) => w.includes('out/webview/main.js')))
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

test('VSIX 检查：解压总体积与单文件双阈值（警告线与失败线）', () => {
  const warn = inspectVsixEntries(
    makeEntries().map((e) => ({ ...e, size: Math.max(e.size, Math.floor(SIZE_LIMITS.totalWarnBytes / makeEntries().length) + 1) })),
  )
  assert.equal(warn.ok, true)
  assert.ok(warn.warnings.some((w) => w.includes('警告线')), '总量过警告线应有警告不失败')

  const fail = makeEntries().map((e) => ({ ...e, size: 1000 }))
  fail.push({ size: Math.floor(SIZE_LIMITS.totalMaxBytes), name: 'extension/out/webview/bloat.js' })
  const result = inspectVsixEntries(fail)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('上限')))
})
