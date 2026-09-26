// manifest NLS 生成脚本（#97）：从字典单一事实源生成 package.nls.json（en）
// 与 package.nls.zh-cn.json（zh-cn）。JSON 不手写——命令 title 与
// displayName/description 的值全部取自 src/shared/locales/{en,zh-cn}.ts。
//
//   node scripts/genNls.mjs          # 生成并写盘（幂等：内容不变不产生 diff）
//   node scripts/genNls.mjs --check  # 不写盘：产物与磁盘内容不一致即退出码 1
//
// 映射规则（「command id → 字典键」）：
// - 工具条可见 21 条命令复用 FORMAT_OPERATIONS 的 titleKey（format.* 既有
//   键，快捷键页与命令面板同源，无第二套文案）；
// - 其余命令按 id 推导：onegayi.vsidian.<suffix> → command.<suffix>.title
//   （既有唯一键 command.table.create.title 天然吻合该规则，单轨收编）；
// - displayName / description 用 manifest.* 键（含 customEditors 的
//   displayName，与市场展示同源）。
//
// 接线：`npm run compile` 与 `vscode:prepublish` 均前置生成（字典改动随构建
// 自动同步、发布字节恒与字典一致）；提交产物与字典的一致性由契约测试
// test/unit/nlsManifest.test.ts 以 --check 钉住（改字典后须重跑并提交产物）。
// 发布链路 scripts/release.mjs 机制不变：REQUIRED_EXTENSION 已含两份 nls。
import * as esbuild from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMAND_PREFIX = 'onegayi.vsidian.'
const MANIFEST_KEYS = ['manifest.displayName', 'manifest.description']

/**
 * command id → nls 字典键：工具条命令复用 FORMAT_OPERATIONS 的 titleKey，
 * 其余按 id 推导 command.<suffix>.title。纯函数。
 * @param {string} commandId
 * @param {Map<string, string>} formatByCommand FORMAT_OPERATIONS 的 command → titleKey
 */
export function deriveCommandTitleKey(commandId, formatByCommand) {
  const titleKey = formatByCommand.get(commandId)
  if (titleKey) return titleKey
  return `command.${commandId.replace(/^onegayi\.vsidian\./, '')}.title`
}

/**
 * 组装单语言的 nls 条目（有序：manifest 两键打头，命令 title 按 package.json
 * 清单顺序）。引用的键在字典中缺失时抛错（新增命令须先入字典）。
 * @param {{contributes:{commands:{command:string}[]}}} pkg
 * @param {Map<string, string>} formatByCommand
 * @param {Record<string, string>} dict
 * @returns {[string, string][]}
 */
export function buildNlsEntries(pkg, formatByCommand, dict) {
  const entries = []
  const push = (key) => {
    const value = dict[key]
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`字典缺少 nls 生成所需词条：${key}（新增命令/清单字段须先入字典再生成）`)
    }
    entries.push([key, value])
  }
  for (const key of MANIFEST_KEYS) push(key)
  for (const { command } of pkg.contributes.commands) {
    push(deriveCommandTitleKey(command, formatByCommand))
  }
  return entries
}

/** 序列化 nls 文件（2 空格缩进 + 尾随换行，与仓库 JSON 产物格式一致）。 */
export function renderNlsFile(entries) {
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`
}

/**
 * 编译并加载字典与格式注册表（TS → ESM 内存产物，data URL import）。
 * esbuild stdin 的 import 说明符必须是相对路径（resolveDir 锚定仓库根）——
 * 盘符绝对路径会被当裸包名解析失败（#94 browser harness 实证坑）。
 */
async function loadNlsSources(root) {
  const result = await esbuild.build({
    stdin: {
      contents: [
        'export { en } from "./src/shared/locales/en.ts"',
        'export { zhCn } from "./src/shared/locales/zh-cn.ts"',
        'export { FORMAT_OPERATIONS } from "./src/shared/formatOperations.ts"',
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'nlsSources.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const check = process.argv.includes('--check')

  const { en, zhCn, FORMAT_OPERATIONS } = await loadNlsSources(root)
  const formatByCommand = new Map(FORMAT_OPERATIONS.map((op) => [op.command, op.titleKey]))
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

  const outputs = [
    ['package.nls.json', renderNlsFile(buildNlsEntries(pkg, formatByCommand, en))],
    ['package.nls.zh-cn.json', renderNlsFile(buildNlsEntries(pkg, formatByCommand, zhCn))],
  ]

  const changed = []
  for (const [name, content] of outputs) {
    // 行尾规范化后比较：产物与生成内容恒为 LF；仓库 core.autocrlf=true 且
    // 无 .gitattributes，Windows 检出会把工作树文本转 CRLF——按字节直比
    // 会在重检出后误报，规范化比较只对内容语义负责。
    const current = readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n')
    if (current !== content) changed.push(name)
  }

  if (check) {
    if (changed.length) {
      console.error(`nls 产物与字典不一致：${changed.join('、')}（重跑 npm run gen:nls 并提交产物）`)
      process.exitCode = 1
      return
    }
    console.log(`nls 产物与字典一致（${outputs.length} 份文件，${pkg.contributes.commands.length} 条命令 + ${MANIFEST_KEYS.length} 项清单字段）`)
    return
  }

  for (const [name, content] of outputs) {
    writeFileSync(path.join(root, name), content, 'utf8')
  }
  console.log(`已生成 ${outputs.map(([n]) => n).join('、')}（${changed.length ? `更新：${changed.join('、')}` : '无变化（幂等）'}）`)
}

// 直接执行时跑主流程；被 import（契约测试复用纯函数）不触发
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
