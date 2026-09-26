// manifest NLS 契约测试（#97）：package.nls.json / package.nls.zh-cn.json 由
// scripts/genNls.mjs 从字典生成，JSON 不手写。本文件钉住四层契约：
// - 两份 nls 文件键集一致（zh-cn 与 en 同键集）
// - package.json 中全部 %key% 引用的键在两份 nls 中存在（引用完备）
// - nls 键集与 package.json 引用集相等（无多余键——删命令后 nls 不得残留）
// - 生成幂等：`node scripts/genNls.mjs --check` 退出码 0（生成产物与提交
//   产物逐字节一致，字典是唯一事实源）
// 另钉映射语义：工具条 22 条命令的 nls 引用键 = FORMAT_OPERATIONS 的
// titleKey（防止 format.* / command.* 双轨）。
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { FORMAT_OPERATIONS } from '../../src/shared/formatOperations'

const REPO_ROOT = path.resolve(process.cwd())
const NLS_EN_PATH = path.join(REPO_ROOT, 'package.nls.json')
const NLS_ZH_PATH = path.join(REPO_ROOT, 'package.nls.zh-cn.json')
const PKG_PATH = path.join(REPO_ROOT, 'package.json')

const nlsEn: Record<string, string> = JSON.parse(readFileSync(NLS_EN_PATH, 'utf8'))
const nlsZh: Record<string, string> = JSON.parse(readFileSync(NLS_ZH_PATH, 'utf8'))
// package.json 以原文读取（引用扫描按文本形态，不靠字段枚举——covers
// 根 displayName/description、contributes 各处未来新增的 %key% 位置）
const pkgRaw = readFileSync(PKG_PATH, 'utf8')
const pkg = JSON.parse(pkgRaw)

/** package.json 原文中的全部 %key% 引用（按出现顺序，去重前） */
function collectNlsReferences(text: string): string[] {
  return [...text.matchAll(/%([a-zA-Z0-9][a-zA-Z0-9.]*)%/g)].map((m) => m[1]!)
}

const references = [...new Set(collectNlsReferences(pkgRaw))]

describe('manifest NLS：两份 nls 文件键集契约', () => {
  it('en 与 zh-cn 键集一致', () => {
    expect([...Object.keys(nlsZh)].sort()).toEqual([...Object.keys(nlsEn)].sort())
  })

  it('全部词条值为非空字符串', () => {
    for (const [file, dict] of [['package.nls.json', nlsEn], ['package.nls.zh-cn.json', nlsZh]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(typeof value, `${file} 值须为字符串：${key}`).toBe('string')
        expect((value as string).length, `${file} 值不得为空：${key}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('manifest NLS：package.json 引用契约', () => {
  it('全部命令 title 为 %key% 引用（44 条全覆盖，无硬编码）', () => {
    const commands: { command: string; title: string }[] = pkg.contributes.commands
    // 44 条命令清单基线（#97 工单口径 + #105 高亮；新增/删减命令须同步本断言）
    expect(commands.length).toBe(44)
    const literal = commands.filter((c) => !/^%.+%$/.test(c.title))
    expect(
      literal.map((c) => `${c.command}: ${c.title}`),
      '存在未 %key% 化的命令 title',
    ).toEqual([])
  })

  it('package.json 引用的 nls 键全部存在于两份 nls 文件', () => {
    expect(references.length, 'package.json 应至少引用 displayName/description 与命令 title').toBeGreaterThan(2)
    const missing = references.filter((key) => !(key in nlsEn) || !(key in nlsZh))
    expect(missing, `nls 文件缺键：${missing.join(', ')}`).toEqual([])
  })

  it('nls 键集与 package.json 引用集相等（无多余键，删命令后不得残留）', () => {
    const refSet = [...references].sort()
    expect([...Object.keys(nlsEn)].sort()).toEqual(refSet)
    expect([...Object.keys(nlsZh)].sort()).toEqual(refSet)
  })

  it('根 displayName/description 与 customEditors displayName 均 %key% 引用', () => {
    expect(pkg.displayName).toMatch(/^%.+%$/)
    expect(pkg.description).toMatch(/^%.+%$/)
    for (const editor of pkg.contributes.customEditors) {
      expect(editor.displayName).toMatch(/^%.+%$/)
    }
  })
})

describe('manifest NLS：command → 字典键映射语义', () => {
  it('工具条 22 条命令的引用键 = FORMAT_OPERATIONS 的 titleKey（单一事实源，无双轨）', () => {
    const byCommand = new Map<string, string>(
      (pkg.contributes.commands as { command: string; title: string }[]).map((c) => [c.command, c.title]),
    )
    expect(FORMAT_OPERATIONS.length).toBe(22)
    for (const op of FORMAT_OPERATIONS) {
      expect(byCommand.get(op.command), `package.json 缺命令 ${op.command}`).toBeDefined()
      expect(byCommand.get(op.command)).toBe(`%${op.titleKey}%`)
    }
  })

  it('非工具条命令的引用键按 command id 推导（command.<去前缀>.title）', () => {
    const formatCommands = new Set<string>(FORMAT_OPERATIONS.map((op) => op.command))
    for (const c of pkg.contributes.commands as { command: string; title: string }[]) {
      if (formatCommands.has(c.command)) continue
      const derived = `command.${c.command.replace(/^onegayi\.vsidian\./, '')}.title`
      expect(c.title, `${c.command} 的引用键应按 id 推导为 %${derived}%`).toBe(`%${derived}%`)
    }
  })
})

describe('manifest NLS：生成幂等（字典是唯一事实源）', () => {
  it('genNls --check 退出码 0（生成内容与提交产物一致；行尾经规范化以兼容 autocrlf 检出）', () => {
    const run = spawnSync(process.execPath, ['scripts/genNls.mjs', '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(
      run.status,
      `genNls --check 应通过（字典改动后须重跑 npm run gen:nls 并提交产物）；输出：${run.stdout}${run.stderr}`,
    ).toBe(0)
  })
})
