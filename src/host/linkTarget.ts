// 链接/图片目标分类（工单 #10）：宿主侧 URI 解析与路径拼接的纯逻辑核心。
//
// 职责边界（架构事实：webview 只上报原始 href/src，URI 解析必须在宿主侧）：
// - scheme 白名单：仅 http/https 外开（env.openExternal）；其余带 scheme 的
//   一律拦截（file://、javascript:、vscode-asset:、mailto:、协议相对 //…），
//   由 vscode 层给用户可见反馈
// - 工作区路径：基于当前文档所在目录解析，不得越过资源根（工作区文件夹
//   根；无工作区时为文档目录）——"路径不能静默越过工作区边界"
// - Windows 与远程不混用：Windows 盘符/反斜杠语义只在 Windows 扩展宿主
//   生效（远程 SSH 宿主是 POSIX 进程，天然只认 POSIX 路径）；Windows
//   路径出现在 POSIX 宿主时拦截而非误解析
// - 相对路径、空格、中文与 %编码：percent-decode 容错（源文原样或已编码
//   两种写法解析到同一目标）
// - 文档链接无扩展名：候选为「精确路径优先，其次补 .md」（与 #11 双链
//   「扩展名省略按 Markdown 处理」同语义；标题/锚点定位不在本票）
//
// 本模块不依赖 vscode（可在 node 单测直驱）；fsPath 语义由注入的
// LinkContext 提供，vscode 层负责 Uri ↔ fsPath 的双向换算（同一扩展宿主
// 内 round-trip，天然不混用本地与远程 URI）。
import * as path from 'node:path'

/** 目标解析上下文（宿主文件系统语义由注入方描述） */
export interface LinkContext {
  /** 当前文档所在目录（绝对 fsPath，宿主平台分隔符） */
  docDir: string
  /** 资源根（工作区文件夹根；无工作区时为文档目录）的绝对 fsPath */
  rootDir: string
  /** 宿主文件系统是否 Windows 语义（本地 Windows 为 true；远程一律 false） */
  isWindowsHost: boolean
}

/** 链接目标分类结果 */
export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'doc'; candidates: string[] }
  | {
      kind: 'blocked'
      reason: 'empty' | 'scheme' | 'escape' | 'windows-drive-on-posix'
      /** scheme 拦截时的协议名（小写；协议相对为空串） */
      scheme?: string
      detail?: string
    }

/** 图片目标分类结果（webview 只对非 http(s) 图源走宿主通道） */
export type ImageTarget =
  | { kind: 'workspace'; fsPath: string }
  | {
      kind: 'blocked'
      reason: 'empty' | 'scheme' | 'escape' | 'windows-drive-on-posix'
      scheme?: string
      detail?: string
    }

/** 宿主图片解析结果（会话经面板端口注入实现；reason 与协议 image.result 对齐） */
export type ImageResolution =
  | { ok: true; src: string }
  | {
      ok: false
      reason: 'blocked' | 'outside-workspace' | 'not-found' | 'read-error'
      detail?: string
    }

/** 协议名提取（file:、javascript: 等；不含 Windows 盘符形态——盘符在
 *  Windows 宿主上先于此检查被识别为路径） */
function schemeOf(text: string): { scheme: string; rest: string } | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):(.*)$/.exec(text)
  if (!m) {
    return null
  }
  return { scheme: m[1]!.toLowerCase(), rest: m[2]! }
}

/** Windows 盘符绝对路径（c:\x 或 C:/x）；仅在 Windows 宿主上有路径语义 */
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/].*/

/** 容错 percent-decode：非法序列按原样保留（混合编码的防御） */
function tolerantDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** 按注入语义选择路径实现：Windows/POSIX 分类不得依赖运行进程的平台
 *  （在 Windows 上跑单测也必须能验 POSIX 远程语义，反之亦然） */
function pathOps(ctx: LinkContext) {
  return ctx.isWindowsHost ? path.win32 : path.posix
}

/** 解析为工作区内的绝对路径：返回绝对 fsPath；越出资源根返回 null */
function resolveInside(href: string, ctx: LinkContext): string | null {
  // 剥掉 #fragment 与 ?query（路径部分才参与解析；锚点定位属 #11）
  const withoutHash = href.split('#')[0]!
  const pathPart = withoutHash.split('?')[0]!
  let p = tolerantDecode(pathPart.trim())
  // Windows 宿主上统一分隔符（远程 POSIX 宿主不转换：正斜杠本就合法，
  // 反斜杠是普通文件名字符——两类语义不得混用）
  if (ctx.isWindowsHost) {
    p = p.replace(/\\/g, '/')
  }
  if (p === '') {
    return null
  }
  const ops = pathOps(ctx)
  const absolute = ops.resolve(ctx.docDir, p)
  if (!isInsideRoot(absolute, ctx.rootDir, ops)) {
    return null
  }
  return absolute
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

/** 通用分类前半段：外链放行 / 空白与锚点拦截 / scheme 拦截 / 盘符拦截 */
function preClassify(
  raw: string,
  ctx: LinkContext,
):
  | { kind: 'external'; url: string }
  | {
      kind: 'blocked'
      reason: 'empty' | 'scheme' | 'windows-drive-on-posix'
      scheme?: string
      detail?: string
    }
  | { kind: 'path'; pathText: string } {
  const href = raw.trim()
  if (href === '' || href.startsWith('#')) {
    return { kind: 'blocked', reason: 'empty', detail: href === '' ? '空白链接' : '仅锚点' }
  }
  // 协议相对 //host/...：无显式 scheme 但按外站目标处理，一律拦截
  if (href.startsWith('//')) {
    return { kind: 'blocked', reason: 'scheme', scheme: '' }
  }
  // Windows 宿主上盘符是路径而非 scheme（c:\x）；POSIX 宿主上同形态只能是
  // 单字母 scheme（怪异且非白名单）——按"Windows 路径出现在远程宿主"拦截
  if (WINDOWS_DRIVE_RE.test(href)) {
    if (ctx.isWindowsHost) {
      return { kind: 'path', pathText: href }
    }
    return { kind: 'blocked', reason: 'windows-drive-on-posix' }
  }
  const s = schemeOf(href)
  if (s) {
    if (s.scheme === 'http' || s.scheme === 'https') {
      return { kind: 'external', url: href }
    }
    return { kind: 'blocked', reason: 'scheme', scheme: s.scheme }
  }
  return { kind: 'path', pathText: href }
}

/**
 * 链接目标分类：external → openExternal；doc → 候选绝对路径（存在性由
 * vscode 层探测，精确优先、无扩展名其次补 .md）；blocked → 用户可见反馈。
 */
export function classifyLinkTarget(href: string, ctx: LinkContext): LinkTarget {
  const pre = preClassify(href, ctx)
  if (pre.kind !== 'path') {
    return pre
  }
  const absolute = resolveInside(pre.pathText, ctx)
  if (absolute === null) {
    return { kind: 'blocked', reason: 'escape', detail: pre.pathText }
  }
  const candidates = [absolute]
  if (!pathOps(ctx).extname(absolute)) {
    candidates.push(`${absolute}.md`)
  }
  return { kind: 'doc', candidates }
}

/** 图片目标分类：仅工作区内相对路径可经宿主读取；外链/危险 scheme 拦截
 *  （webview 只应对非 http(s) 图源走宿主通道；http(s) 到达此处按拦截防御） */
export function classifyImageTarget(src: string, ctx: LinkContext): ImageTarget {
  const pre = preClassify(src, ctx)
  if (pre.kind === 'external') {
    return { kind: 'blocked', reason: 'scheme', scheme: 'https' }
  }
  if (pre.kind === 'blocked') {
    return pre
  }
  const absolute = resolveInside(pre.pathText, ctx)
  if (absolute === null) {
    return { kind: 'blocked', reason: 'escape', detail: pre.pathText }
  }
  return { kind: 'workspace', fsPath: absolute }
}

/** blocked reason → 协议 image.result 的 reason 码（vscode 层换算用） */
export function imageBlockReasonOf(
  target: Extract<ImageTarget, { kind: 'blocked' }>,
): Extract<ImageResolution, { ok: false }>['reason'] {
  if (target.reason === 'escape') {
    return 'outside-workspace'
  }
  return 'blocked'
}
