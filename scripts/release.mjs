// 发布脚本：CHANGELOG 最新段落提取 → VSIX 打包 → 包内容与体积检查 →
// （--upload）创建 GitHub Release 并附带 VSIX。
//
//   node scripts/release.mjs            # 打包 + 检查（日常本地可跑）
//   node scripts/release.mjs --upload   # 以上 + gh release create 附带 VSIX
//
// 约定见 AGENTS.md「打包与发布」：VSIX 体积严格控制，检查器是发布前的
// 最后一道闸（.vscodeignore 挡打包输入，这里挡最终产物），失败即非零退出。
// 纯函数（extractLatestChangelog / parseUnzipListing / inspectVsixEntries）
// 由 test/release/release.test.mjs 以 node --test 契约测试钉住。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SIZE_LIMITS = {
  // 解压总体积：#59 KaTeX 后基线约 1.05 MB，#60 加入 mermaid.js 独立产物
  // （约 2.60 MB）后基线约 4.1 MB（实测见 AGENTS.md「打包与发布」）——
  // 警告与失败线为基线 + 功能增长余量，防"意外塞进大文件"而非卡正常演进。
  totalWarnBytes: 4.5 * 1024 * 1024,
  totalMaxBytes: 5.5 * 1024 * 1024,
  // 一般单文件：mermaid.js（刻意 vendored 的独立产物，minify 后实测
  // 2,727,077 B ≈ 2.60 MB）是最大单项，警告线 3 MB 在其上留小余量、
  // 失败线 4 MB 拦截意外超大文件（如误升 mermaid 12.x 的 5.3 MB 产物）。
  // 主 bundle（main.js 约 0.80 MB，含 CM6 + KaTeX）随之不再触发单文件
  // 警告——其增长由总量线约束，属本阈值调整的已接受取舍。
  fileWarnBytes: 3 * 1024 * 1024,
  fileMaxBytes: 4 * 1024 * 1024,
  // 图标专项：Marketplace 展示只需 256×256，35 KB 已足够，百 KB 级即异常。
  iconMaxBytes: 100 * 1024,
}

// 必需清单：VSIX 根结构文件 + extension/ 下运行时资产。README / LICENSE /
// CHANGELOG 由 vsce 自动打入且大小写形态随版本变化（实测 readme.md 小写），
// 统一按小写 basename 匹配。
const REQUIRED_ROOT = ['extension.vsixmanifest', '[content_types].xml']
const REQUIRED_EXTENSION = [
  'package.json',
  'package.nls.json',
  'package.nls.zh-cn.json',
  'readme.md',
  'changelog.md',
  'license', // 实测形态为 LICENSE.txt，前缀匹配兜底
  'out/extension.js',
  'out/webview/main.js',
  'out/webview/main.css',
  'out/webview/settings.js',
  'out/webview/settings.css',
  // #60 Mermaid 独立产物（按需懒加载的渲染器；缺失时图表降级为错误态）
  'out/webview/mermaid.js',
  'media/css-contract-probe.css',
]

// #59 KaTeX 字体（仅 woff2，esbuild assetNames 稳定命名无 hash）：缺失任一
// 都会导致公式回落系统字体，逐文件登记精确拦截。
const KATEX_FONT_FAMILIES = [
  'KaTeX_AMS-Regular',
  'KaTeX_Caligraphic-Bold',
  'KaTeX_Caligraphic-Regular',
  'KaTeX_Fraktur-Bold',
  'KaTeX_Fraktur-Regular',
  'KaTeX_Main-Bold',
  'KaTeX_Main-BoldItalic',
  'KaTeX_Main-Italic',
  'KaTeX_Main-Regular',
  'KaTeX_Math-BoldItalic',
  'KaTeX_Math-Italic',
  'KaTeX_SansSerif-Bold',
  'KaTeX_SansSerif-Italic',
  'KaTeX_SansSerif-Regular',
  'KaTeX_Script-Regular',
  'KaTeX_Size1-Regular',
  'KaTeX_Size2-Regular',
  'KaTeX_Size3-Regular',
  'KaTeX_Size4-Regular',
  'KaTeX_Typewriter-Regular',
]
const REQUIRED_KATEX_FONTS = KATEX_FONT_FAMILIES.map(
  (family) => `out/webview/assets/${family}.woff2`,
)
const REQUIRED_EXTENSION_WITH_FONTS = [...REQUIRED_EXTENSION, ...REQUIRED_KATEX_FONTS]

// 禁止模式：仓库管理与开发文件一律不得进入 VSIX（大小写不敏感）。
const FORBIDDEN_PATTERNS = [
  [/^extension\/\.github\//, 'GitHub 平台配置'],
  [/\/\.git(\/|$)/, '.git 目录'],
  [/node_modules/, 'node_modules'],
  [/^extension\/src\//, 'TypeScript 源码'],
  [/^extension\/test\//, '测试'],
  [/^extension\/docs\//, '项目文档'],
  [/^extension\/scripts\//, '构建脚本'],
  [/\.map$/, 'sourcemap'],
  [/\.tsx?$/, 'TypeScript 源文件'],
  [/package-lock\.json$/, 'npm lockfile'],
  [/readme\.en\.md$/, '英文 README（仅 GitHub 展示）'],
  [/\.vsix$/, 'VSIX 嵌套'],
  // 评审 C7：webview 目标 chrome118 只需 woff2——出现 woff/ttf 即字体
  // 裁剪失效（如 katex 升级改动 CSS src 格式使裁剪正则失配），体积闸
  // 只给警告不可靠，硬错误拦截。
  [/\.woff$/, '非 woff2 字体（字体裁剪失效，webview 仅需 woff2）'],
  [/\.ttf$/, 'TTF 字体（字体裁剪失效，webview 仅需 woff2）'],
]

/** 解析 `unzip -l` 输出为条目列表（name 含 `extension/` 前缀）。 */
export function parseUnzipListing(text) {
  const entries = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+(.+)$/)
    if (m) entries.push({ size: Number(m[1]), name: m[2].trim() })
  }
  return entries
}

/** 列出 zip 内容；优先 unzip（CI Linux / Git Bash），Windows 回退 PowerShell。 */
function listZipEntries(vsixPath) {
  const unzip = spawnSync('unzip', ['-l', vsixPath], { encoding: 'utf8' })
  if (unzip.status === 0 && unzip.stdout) return parseUnzipListing(unzip.stdout)
  if (process.platform === 'win32') {
    const ps = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$z=[System.IO.Compression.ZipFile]::OpenRead($args[0])",
      "foreach($e in $z.Entries){ Write-Output ($e.Length.ToString() + \"`t\" + $e.FullName) }",
      '$z.Dispose()',
    ].join('; ')
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps, vsixPath], { encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`无法读取 VSIX 内容：${out.stderr || 'unzip 与 PowerShell 均失败'}`)
    return out.stdout.split(/\r?\n/).filter((l) => l.includes('\t')).map((l) => {
      const [size, ...rest] = l.split('\t')
      return { size: Number(size), name: rest.join('\t') }
    })
  }
  throw new Error(`无法读取 VSIX 内容：${unzip.stderr || 'unzip 不可用'}`)
}

/**
 * 提取 CHANGELOG.md 最新版本段落。
 * @throws 最新段落版本与 expectedVersion 不符、或找不到版本段落时抛错。
 */
export function extractLatestChangelog(content, expectedVersion) {
  const lines = content.split(/\r?\n/)
  let start = -1
  let version = null
  let date = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^## (\[?[^\s\]]+\]?)\s*(?:-\s*(.*))?$/)
    if (m) {
      start = i
      version = m[1].replace(/^\[|\]$/g, '')
      date = (m[2] || '').trim() || null
      break
    }
  }
  if (start < 0) throw new Error('CHANGELOG.md 中未找到任何 `## <版本>` 段落')
  if (version !== expectedVersion) {
    throw new Error(`CHANGELOG 最新段落为 ${version}，与 package.json 的 ${expectedVersion} 不一致`)
  }
  const bodyEnd = lines.findIndex((l, i) => i > start && /^## /.test(l))
  const body = lines.slice(start + 1, bodyEnd < 0 ? lines.length : bodyEnd).join('\n').trim()
  return { version, date, body }
}

/**
 * 检查 VSIX 条目：必需项齐全、无禁止文件、体积在阈值内。
 * @param {{size:number,name:string}[]} entries VSIX 内全部条目
 * @param {{iconPath?:string}} options package.json 的 icon 相对路径
 * @returns {{ok:boolean,errors:string[],warnings:string[],totalBytes:number}}
 */
export function inspectVsixEntries(entries, options = {}) {
  const errors = []
  const warnings = []
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
  const lowerNames = entries.map((e) => e.name.toLowerCase())

  for (const root of REQUIRED_ROOT) {
    if (!lowerNames.includes(root)) errors.push(`缺少结构文件 ${root}`)
  }
  for (const rel of REQUIRED_EXTENSION_WITH_FONTS) {
    if (rel === 'license') {
      const hit = lowerNames.some((n) => /^extension\/license(\.txt)?$/.test(n))
      if (!hit) errors.push('缺少 LICENSE（打包后应为 extension/LICENSE*）')
    } else if (!lowerNames.includes(`extension/${rel.toLowerCase()}`)) {
      errors.push(`缺少运行时资产 extension/${rel}`)
    }
  }

  // out/ 白名单（评审 C1）：上面只拦「缺」，这里拦「多」——out/ 下任何
  // 未登记文件（调试遗留、构建实验产物、裁剪失效的重复字体）一律拒绝，
  // 避免「REQUIRED 不含即静默混入包内」（v0.1.0 后曾实测发生 out/ 杂物
  // 混入打包输入且旧检查不拦）。新增运行时产物须同步登记 REQUIRED_EXTENSION。
  const allowedOut = new Set(REQUIRED_EXTENSION_WITH_FONTS.map((rel) => `extension/${rel.toLowerCase()}`))
  for (const e of entries) {
    const lower = e.name.toLowerCase()
    if (lower.startsWith('extension/out/') && !allowedOut.has(lower)) {
      errors.push(`out/ 未登记产物 ${e.name}（新资产须登记 REQUIRED_EXTENSION）`)
    }
  }

  for (const e of entries) {
    for (const [pattern, label] of FORBIDDEN_PATTERNS) {
      if (pattern.test(e.name.toLowerCase())) errors.push(`禁止文件 ${e.name}（${label}）`)
    }
  }

  if (options.iconPath) {
    const icon = entries.find((e) => e.name.toLowerCase() === `extension/${options.iconPath.toLowerCase()}`)
    if (!icon) errors.push(`缺少图标 extension/${options.iconPath}`)
    else if (icon.size > SIZE_LIMITS.iconMaxBytes) {
      errors.push(`图标 ${icon.name} 为 ${icon.size} 字节，超过 ${SIZE_LIMITS.iconMaxBytes}（应 ≤256×256）`)
    }
  }

  if (totalBytes > SIZE_LIMITS.totalMaxBytes) errors.push(`解压总体积 ${(totalBytes / 1048576).toFixed(2)} MB 超过上限 ${SIZE_LIMITS.totalMaxBytes / 1048576} MB`)
  else if (totalBytes > SIZE_LIMITS.totalWarnBytes) warnings.push(`解压总体积 ${(totalBytes / 1048576).toFixed(2)} MB 超过警告线 ${SIZE_LIMITS.totalWarnBytes / 1048576} MB`)

  for (const e of entries) {
    if (options.iconPath && e.name.toLowerCase() === `extension/${options.iconPath.toLowerCase()}`) continue
    if (e.size > SIZE_LIMITS.fileMaxBytes) errors.push(`单文件 ${e.name} 为 ${(e.size / 1048576).toFixed(2)} MB，超过上限`)
    else if (e.size > SIZE_LIMITS.fileWarnBytes) warnings.push(`单文件 ${e.name} 为 ${(e.size / 1024).toFixed(0)} KB，超过警告线`)
  }

  return { ok: errors.length === 0, errors, warnings, totalBytes }
}

function git(args) {
  const out = spawnSync('git', args, { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${out.stderr}`)
  return out.stdout.trim()
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const upload = process.argv.includes('--upload')
  const allowDirty = process.argv.includes('--allow-dirty')

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const { version } = pkg

  if (!allowDirty && git(['status', '--porcelain']) !== '') {
    console.error('工作树不干净：先提交或 stash，或用 --allow-dirty 明确跳过（打包内容可能与提交不符）')
    process.exitCode = 1
    return
  }

  let notes
  try {
    notes = extractLatestChangelog(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version)
  } catch (err) {
    console.error(String(err.message))
    process.exitCode = 1
    return
  }
  console.log(`CHANGELOG ${notes.version}${notes.date ? `（${notes.date}）` : ''} 段落提取成功，${notes.body.length} 字符`)

  console.log('打包 VSIX（vsce --no-dependencies，含 vscode:prepublish 生产构建）…')
  // Windows 上 npx/gh 是 .cmd，必须经 shell；参数拼接为整条命令避免 DEP0190（args+shell 组合）
  const vsce = spawnSync(`npx @vscode/vsce package --no-dependencies`, { cwd: root, encoding: 'utf8', shell: true })
  if (vsce.status !== 0) {
    console.error(vsce.stdout)
    console.error(vsce.stderr)
    process.exitCode = 1
    return
  }

  const vsixName = `${pkg.name}-${version}.vsix`
  const vsixPath = path.join(root, vsixName)
  if (!existsSync(vsixPath)) {
    console.error(`打包完成但未找到 ${vsixPath}`)
    process.exitCode = 1
    return
  }

  const entries = listZipEntries(vsixPath)
  const result = inspectVsixEntries(entries, { iconPath: pkg.icon })
  console.log(`VSIX 共 ${entries.length} 个文件，解压 ${(result.totalBytes / 1024).toFixed(0)} KB（${vsixName}）`)
  for (const w of result.warnings) console.warn(`警告：${w}`)
  if (!result.ok) {
    for (const e of result.errors) console.error(`检查失败：${e}`)
    process.exitCode = 1
    return
  }
  console.log('包内容检查通过（必需清单 / 禁止模式 / 体积阈值）')

  if (!upload) {
    console.log('如需创建 GitHub Release：node scripts/release.mjs --upload')
    return
  }

  const tag = `v${version}`
  const headTag = git(['describe', '--tags', '--exact-match', 'HEAD']).split('\n')[0]
  if (headTag !== tag) {
    console.error(`HEAD 未打 ${tag} 标签（当前 ${headTag || '无'}）。先 git tag ${tag} 再上传`)
    process.exitCode = 1
    return
  }
  const head = git(['rev-parse', 'HEAD'])
  const notesFile = path.join(mkdtempSync(path.join(tmpdir(), 'vsidian-release-')), 'notes.md')
  writeFileSync(notesFile, notes.body + '\n', 'utf8')

  console.log(`创建 GitHub Release ${tag} 并上传 ${vsixName}…`)
  const gh = spawnSync(`gh release create ${tag} "${vsixPath}" --target ${head} --title ${tag} --notes-file "${notesFile}"`, { cwd: root, encoding: 'utf8', shell: true })
  rmSync(path.dirname(notesFile), { recursive: true, force: true })
  if (gh.status !== 0) {
    console.error(gh.stdout)
    console.error(gh.stderr)
    process.exitCode = 1
    return
  }
  console.log(`Release ${tag} 创建完成：https://github.com/${git(['config', '--get', 'remote.origin.url']).replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/')}/releases/tag/${tag}`)
}

// 仅在直接执行（node scripts/release.mjs）时跑主流程；契约测试 import 纯函数不触发
if (process.argv[1] && path.resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
