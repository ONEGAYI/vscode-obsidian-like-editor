// 语言包与语言解析契约（#93 i18n 基础设施）：
// - 两语言包键集运行时一致（编译期 parity 之外的第二道防线，防构建旁路——
//   例如经 as/any 绕过类型检查的字典改动）
// - 键为点分扁平格式、值非空字符串
// - resolveLocale 的 auto 解析语义（env.language 以 zh 开头 → zh-cn，其余 → en）
// - 代码中 t('…') 字面量键全部存在于字典（AST 扫描，防拼写漂移）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import ts from 'typescript'
import { en } from '../../src/shared/locales/en'
import { zhCn } from '../../src/shared/locales/zh-cn'
import {
  LOCALE_MESSAGES,
  SUPPORTED_LOCALES,
  isLocaleCode,
  resolveLocale,
} from '../../src/shared/locales'

const REPO_ROOT = path.resolve(process.cwd())
const FLAT_KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/

describe('两语言包契约（en 为类型基准）', () => {
  it('键集运行时一致（zh-cn 不多键不少键）', () => {
    expect([...Object.keys(zhCn)].sort()).toEqual([...Object.keys(en)].sort())
  })

  it('值均为非空字符串，键为点分扁平格式', () => {
    for (const [pack, dict] of [['en', en], ['zh-cn', zhCn]] as const) {
      for (const [key, value] of Object.entries(dict)) {
        expect(FLAT_KEY_RE.test(key), `${pack} 键格式非法：${key}`).toBe(true)
        expect(typeof value, `${pack} 值须为字符串：${key}`).toBe('string')
        expect((value as string).length, `${pack} 值不得为空：${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('注册表 LOCALE_MESSAGES 覆盖全部支持语言', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(['en', 'zh-cn'])
    for (const code of SUPPORTED_LOCALES) {
      expect(LOCALE_MESSAGES[code]).toBeDefined()
    }
  })
})

describe('resolveLocale（auto 解析语义）', () => {
  it('显式偏好直接生效', () => {
    expect(resolveLocale('zh-cn', 'en-US')).toBe('zh-cn')
    expect(resolveLocale('en', 'zh-cn')).toBe('en')
  })

  it('auto / 缺省 / 非法偏好按宿主显示语言解析：zh* → zh-cn，其余 → en', () => {
    expect(resolveLocale('auto', 'zh-cn')).toBe('zh-cn')
    expect(resolveLocale('auto', 'zh-tw')).toBe('zh-cn')
    expect(resolveLocale('auto', 'zh')).toBe('zh-cn')
    expect(resolveLocale('auto', 'en')).toBe('en')
    expect(resolveLocale('auto', 'en-US')).toBe('en')
    // 未适配语言（如日语）按规格回落 en
    expect(resolveLocale('auto', 'ja')).toBe('en')
    expect(resolveLocale(undefined, 'zh-cn')).toBe('zh-cn')
    expect(resolveLocale('fr', 'zh-CN')).toBe('zh-cn')
    expect(resolveLocale('fr', 'de')).toBe('en')
    // env 为空串/未提供视为非 zh
    expect(resolveLocale('auto', '')).toBe('en')
    expect(resolveLocale(undefined, undefined as never)).toBe('en')
  })

  it('isLocaleCode 只认字典语言代码', () => {
    expect(isLocaleCode('en')).toBe(true)
    expect(isLocaleCode('zh-cn')).toBe(true)
    expect(isLocaleCode('zh-CN')).toBe(false)
    expect(isLocaleCode('auto')).toBe(false)
    expect(isLocaleCode(1)).toBe(false)
  })
})

describe('代码中 t() 字面量键全部存在于字典（AST 扫描）', () => {
  it('src 内 t("…") 引用的键均为 MessageKey', () => {
    const used = collectTCallKeys()
    // 扫描器本身至少应找到本票的取词点（防扫描器失效导致用例空转）
    expect(used.length).toBeGreaterThan(0)
    const known = new Set(Object.keys(en))
    const unknown = used.filter((entry) => !known.has(entry.key))
    expect(
      unknown,
      `t() 引用了不存在的字典键：${unknown.map((u) => `${u.file}:${u.key}`).join(', ')}`,
    ).toEqual([])
  })
})

interface TCallUse {
  file: string
  key: string
}

/** 收集 src/ 下所有 t('字面量') 调用的键（AST；非字面量键跳过） */
function collectTCallKeys(): TCallUse[] {
  const uses: TCallUse[] = []
  for (const file of listSourceFiles()) {
    const source = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 't' &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0]!)
      ) {
        uses.push({
          file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
          key: (node.arguments[0] as ts.StringLiteral).text,
        })
      }
      node.forEachChild(visit)
    }
    visit(sf)
  }
  return uses
}

function listSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.ts')) {
        out.push(full)
      }
    }
  }
  walk(path.join(REPO_ROOT, 'src'))
  return out
}
