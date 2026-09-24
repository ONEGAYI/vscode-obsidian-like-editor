// 宿主侧双链目标解析（工单 #11）：webview 上报的 wikilink 目标 → 工作区内
// 目标文件的纯逻辑分类器（ADR-0002：按需解析，不建持久索引——文件清单由
// vscode 层每次跳转经 workspace.findFiles 现查后注入，本模块无状态）。
//
// 职责边界（与 #10 linkTarget 同构：URI 解析只在宿主侧）：
// - 无工作区：no-workspace——不猜测、不扫描文档目录之外的内容
// - 按名查找（路径无分隔符）：工作区内任意位置 basename（去 .md）匹配，
//   多个命中为 ambiguous（vscode 层给 QuickPick，不得静默任选）
// - 显式路径（含分隔符）：文档相对与工作区相对双候选精确解析；命中不同
//   文件为 ambiguous（文档相对/工作区相对歧义不静默选错）；同一文件去重
// - 无扩展名补 .md（与 #10 普通链接候选语义一致）
// - 大小写语义按宿主平台：Windows 本地（NTFS 语义）不敏感；远程 POSIX
//   宿主严格匹配（Windows 与远程语义不混用）
// - 越出资源根（../ 上行）自然不命中（清单只含资源根内文件）
//
// 标题定位（findHeadingOffset）：ATX 标题行扫描（setext 不匹配，一期规则），
// 规范化 = trim + 空白折叠 + 小写（写入测试固定）；围栏代码内的伪标题跳过。
//
// 本模块不依赖 vscode（node 单测直驱）；平台语义由注入的
// WikilinkResolveContext 描述（与 LinkContext 同一注入模式）。
import * as path from 'node:path'

/** 双链解析上下文（宿主文件系统语义由注入方描述） */
export interface WikilinkResolveContext {
  /** 当前文档所在目录（绝对 fsPath，宿主平台分隔符） */
  docDir: string
  /** 资源根（工作区文件夹根）的绝对 fsPath */
  rootDir: string
  /** 宿主文件系统是否 Windows 语义（本地 Windows 为 true；远程一律 false） */
  isWindowsHost: boolean
  /** 当前文档是否属于某个工作区文件夹（未打开文件夹时为 false） */
  hasWorkspace: boolean
}

/** 双链文件目标解析结果（vscode 层按 kind 分派：打开/选择/提示） */
export type WikilinkFileResolution =
  | { kind: 'target'; fsPath: string }
  | { kind: 'ambiguous'; fsPaths: string[] }
  | { kind: 'not-found' }
  | { kind: 'no-workspace' }

function pathOps(ctx: WikilinkResolveContext) {
  return ctx.isWindowsHost ? path.win32 : path.posix
}

/** 比较键：Windows 宿主小写折叠（NTFS 语义）；POSIX 宿主原样（严格） */
function pathKey(ctx: WikilinkResolveContext, fsPath: string): string {
  return ctx.isWindowsHost ? fsPath.toLowerCase() : fsPath
}

/** absolute 是否位于 root 内（含 root 本身） */
function isInsideRoot(
  absolute: string,
  rootDir: string,
  ops: ReturnType<typeof pathOps>,
): boolean {
  const rel = ops.relative(rootDir, absolute)
  if (rel === '') {
    return true
  }
  return rel !== '..' && !rel.startsWith(`..${ops.sep}`) && !ops.isAbsolute(rel)
}

/**
 * 解析双链的文件目标。
 * @param spec.path 形态学模块产出的目标路径部分（trim 后；分隔符原样）
 * @param mdFiles 工作区内全部 .md 文件的绝对 fsPath（vscode 层按需查得，
 *   已限定在资源根内——越界目标自然 not-found）
 */
export function resolveWikilinkFile(
  spec: { path: string },
  ctx: WikilinkResolveContext,
  mdFiles: string[],
): WikilinkFileResolution {
  if (!ctx.hasWorkspace) {
    return { kind: 'no-workspace' }
  }
  const ops = pathOps(ctx)
  const fileByKey = new Map<string, string>()
  for (const f of mdFiles) {
    fileByKey.set(pathKey(ctx, f), f)
  }
  // 分隔符归一：Windows 宿主把反斜杠当分隔符（与 #10 一致）；POSIX 宿主上
  // 反斜杠是普通文件名字符（远程语义不转换）
  const normalized = ctx.isWindowsHost ? spec.path.replace(/\\/g, '/') : spec.path
  // 显式路径形态：含分隔符，或已带 .md 扩展名（[[笔记.md]] 按精确路径解析，
  // 不做按名匹配——否则会去匹配「笔记.md.md」）；其余为按名查找形态
  const isExplicitPath = normalized.includes('/') || /\.md$/i.test(normalized)

  const match = (absolute: string): string | undefined =>
    fileByKey.get(pathKey(ctx, absolute))

  const collect = (): string[] => {
    if (!isExplicitPath) {
      // 按名查找：任意深度 basename（去 .md）全等（按平台大小写语义）
      const nameKey = pathKey(ctx, normalized)
      const out: string[] = []
      for (const f of mdFiles) {
        const base = ops.basename(f)
        const stem = base.endsWith('.md') ? base.slice(0, -3) : base
        if (pathKey(ctx, stem) === nameKey) {
          out.push(f)
        }
      }
      return out
    }
    // 显式路径：文档相对 + 工作区相对双候选（精确路径，其次补 .md）
    const bases = [ops.resolve(ctx.docDir, normalized), ops.resolve(ctx.rootDir, normalized)]
    const out: string[] = []
    const seen = new Set<string>()
    for (const base of bases) {
      if (!isInsideRoot(base, ctx.rootDir, ops)) {
        continue
      }
      const candidates = ops.extname(base) ? [base] : [base, `${base}.md`]
      for (const candidate of candidates) {
        const hit = match(candidate)
        if (hit !== undefined) {
          const key = pathKey(ctx, hit)
          if (!seen.has(key)) {
            seen.add(key)
            out.push(hit)
          }
        }
      }
    }
    return out
  }

  if (spec.path.trim() === '') {
    return { kind: 'not-found' }
  }
  const hits = collect()
  if (hits.length === 0) {
    return { kind: 'not-found' }
  }
  if (hits.length === 1) {
    return { kind: 'target', fsPath: hits[0]! }
  }
  return { kind: 'ambiguous', fsPaths: hits.sort((a, b) => a.localeCompare(b)) }
}

/** 标题比较键：trim + 空白折叠 + 小写（大小写不敏感是标题匹配的一期规则，
 *  与文件路径的平台相关大小写语义无关—— Obsidian 同款宽松标题匹配） */
export function normalizeHeadingText(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase()
}

const ATX_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+([^\n]*?)(?:[ \t]+#+)?[ \t\r]*$/

/** 围栏行标记（``` 或 ~~~，≥3 个）：返回围栏字符，非围栏行返回 null */
function fenceMarkerOf(line: string): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  return m ? m[1]![0]! : null
}

/**
 * 目标文档内定位标题：返回首个匹配标题行的 [offset, end)（行首到行尾，
 * 不含换行；selection reveal 与 view.locate 的区间依据）。无命中返回 null。
 * 规则（一期，写入测试）：仅 ATX 标题；围栏代码内的 # 行不作为标题；
 * CRLF 行尾容错。
 */
export function findHeadingOffset(
  text: string,
  heading: string,
): { offset: number; end: number } | null {
  const want = normalizeHeadingText(heading)
  if (want === '') {
    return null
  }
  let offset = 0
  let fenceChar: string | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const marker = fenceMarkerOf(line)
    if (fenceChar !== null) {
      if (marker === fenceChar) {
        fenceChar = null // 闭围栏
      }
    } else if (marker !== null) {
      fenceChar = marker // 开围栏：其后内容直到闭围栏都不是标题
    } else {
      const m = ATX_HEADING_RE.exec(line)
      if (m && normalizeHeadingText(m[2]!) === want) {
        return { offset, end: offset + line.length }
      }
    }
    offset += rawLine.length + 1
  }
  return null
}
