// 语言包数据岛（#93 i18n 基础设施）：宿主 HTML 生成点注入、webview 首帧
// 读取的 <script type="application/json"> 非执行数据——不受 CSP script-src
// 约束（不是脚本），首帧文案即就绪、永不空窗。
//
// 本模块不 import 字典文件（两端共用：宿主用构建端、webview 用解析端，
// 均不得带入字典字节——见 shared/i18n.ts 的懒加载约束）。

/** 数据岛元素 id（宿主注入端与 webview 读取端的稳定契约） */
export const LOCALE_ISLAND_ID = 'vsidian-locale'

/** 数据岛载荷：语言代码 + 完整语言包（与 locale.changed 消息同构） */
export interface LocaleIslandData {
  lang: string
  messages: Record<string, string>
}

/**
 * 构建数据岛 HTML 片段（宿主注入端）。`<` 转义为 \u003c：词条含 </script>
 * 时不得提前闭合数据岛（JSON.parse 会把 \u003c 还原为 <）。
 */
export function buildLocaleIslandHtml(lang: string, messages: Record<string, string>): string {
  const json = JSON.stringify({ lang, messages }).replace(/</g, '\\u003c')
  return `<script type="application/json" id="${LOCALE_ISLAND_ID}">${json}</script>`
}

/** 解析数据岛文本（webview 读取端）：非法载荷返回 null，永不抛错 */
export function parseLocaleIsland(text: string): LocaleIslandData | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as { lang?: unknown }).lang !== 'string' ||
    (parsed as { lang: string }).lang.length === 0 ||
    typeof (parsed as { messages?: unknown }).messages !== 'object' ||
    (parsed as { messages: unknown }).messages === null ||
    Array.isArray((parsed as { messages: unknown }).messages)
  ) {
    return null
  }
  const messages = (parsed as { messages: Record<string, unknown> }).messages
  for (const value of Object.values(messages)) {
    if (typeof value !== 'string') {
      return null
    }
  }
  return { lang: (parsed as { lang: string }).lang, messages: messages as Record<string, string> }
}
