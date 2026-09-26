// i18n 防回潮扫描器（#93）：TypeScript AST 扫描源码字符串字面量中的 CJK
// 统一表意文字（U+4E00–U+9FFF）。本模块是扫描实现（非测试文件），供
// i18nNoHardcodedCjk.test.ts 契约与白名单再生使用。
//
// 扫描范围：src/webview、src/host、src/shared（排除 src/shared/locales——
// 字典本身是中文数据的唯一合法居所）与 src/extension.ts；test/ 不扫。
// 豁免（开发面文案，规格「防回潮纪律」）：console.* 调用、throw 语句与
// new Error(...) 参数子树内的字面量。判定走祖先链：字面量的任一祖先是
// console 属性调用 / ThrowStatement / new Error 即豁免（闭包边界不再细
// 分：console.* 子树内的延迟求值同样只服务于开发面日志）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

/** 扫描范围（仓库相对路径；目录递归、文件精确） */
export const SCAN_ROOTS = ['src/webview', 'src/host', 'src/shared', 'src/extension.ts'] as const

/** 范围内但豁免的路径前缀：字典目录是语言数据源，不是 UI 硬编码 */
export const SCAN_EXCLUDED_PREFIXES = ['src/shared/locales/'] as const

const CJK_RE = /[\u4e00-\u9fff]/

export interface CjkViolation {
  /** 仓库相对路径，正斜杠 */
  file: string
  /** 违规字面量原文 */
  literal: string
  /** 1 基行号 */
  line: number
}

export function scanSourceCjkLiterals(source: string, fileName: string): CjkViolation[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const violations: CjkViolation[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      CJK_RE.test(node.text) &&
      !isExempt(node)
    ) {
      violations.push({
        file: fileName,
        literal: node.text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      })
    }
    node.forEachChild(visit)
  }
  sf.forEachChild(visit)
  return violations
}

/** 豁免判定：祖先链上有 console.* 调用 / throw / new Error 即为开发面文案 */
function isExempt(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isThrowStatement(current)) {
      return true
    }
    if (
      ts.isNewExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === 'Error'
    ) {
      return true
    }
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'console'
    ) {
      return true
    }
    current = current.parent
  }
  return false
}

/** 枚举扫描范围内全部 .ts 文件（仓库相对路径，正斜杠，字典序） */
export function listScanFiles(repoRoot: string): string[] {
  const out: string[] = []
  const walk = (absDir: string, relDir: string): void => {
    for (const entry of readdirSync(absDir).sort()) {
      const abs = path.join(absDir, entry)
      const rel = `${relDir}/${entry}`
      if (statSync(abs).isDirectory()) {
        walk(abs, rel)
      } else if (entry.endsWith('.ts')) {
        out.push(rel)
      }
    }
  }
  for (const root of SCAN_ROOTS) {
    const abs = path.join(repoRoot, root)
    if (!statSync(abs).isDirectory()) {
      if (root.endsWith('.ts')) {
        out.push(root)
      }
      continue
    }
    walk(abs, root)
  }
  return out.filter((rel) => !SCAN_EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))).sort()
}

/** 全仓扫描：返回范围内全部非豁免 CJK 字面量违规 */
export function scanRepoCjk(repoRoot: string): CjkViolation[] {
  const violations: CjkViolation[] = []
  for (const rel of listScanFiles(repoRoot)) {
    const source = readFileSync(path.join(repoRoot, rel), 'utf8')
    violations.push(...scanSourceCjkLiterals(source, rel))
  }
  return violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}
