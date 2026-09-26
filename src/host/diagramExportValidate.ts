// 图表导出载荷校验（工单 #111，纯逻辑）：上限、白名单与文件名清洗，
// 与 vscode API 解耦（node 单测直驱）。执行壳在 diagramExportHost.ts。
import type { DiagramExportPayload } from '../shared/protocol'

/** 导出载荷上限（单一事实源） */
export const DIAGRAM_EXPORT_LIMITS = {
  /** SVG 文档文本上限（字符） */
  svgMaxChars: 4_000_000,
  /** PNG base64 上限（字符；约 9MB 二进制） */
  pngBase64MaxChars: 12_000_000,
  /** 文件名长度上限 */
  fileNameMax: 120,
} as const

const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/

/** 剥离路径成分与控制字符；空/超长回退默认名（按格式扩展名） */
export function sanitizeExportFileName(name: string, format: 'svg' | 'png'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned.length > DIAGRAM_EXPORT_LIMITS.fileNameMax) {
    return `diagram.${format}`
  }
  return cleaned
}

/** 载荷校验：格式白名单、内容非空且不超上限、PNG 须为严格 base64 */
export function validateDiagramExportPayload(payload: DiagramExportPayload): boolean {
  if (payload.format !== 'svg' && payload.format !== 'png') {
    return false
  }
  const limit =
    payload.format === 'svg' ? DIAGRAM_EXPORT_LIMITS.svgMaxChars : DIAGRAM_EXPORT_LIMITS.pngBase64MaxChars
  if (
    typeof payload.content !== 'string' ||
    payload.content.length === 0 ||
    payload.content.length > limit
  ) {
    return false
  }
  return payload.format === 'svg' || BASE64_STRICT.test(payload.content)
}

/** 文档 URI path → 所在目录 path（无目录分隔返回 null，调用方回退文件
 *  系统根）——另存为默认目录落文档所在处的纯函数内核 */
export function documentDirPath(docPath: string): string | null {
  const idx = docPath.lastIndexOf('/')
  return idx > 0 ? docPath.slice(0, idx) : null
}
