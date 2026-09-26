// 语言包数据岛契约（#93 i18n 基础设施）：<script type="application/json"> 非
// 执行脚本，不受 CSP script-src 约束；宿主 HTML 生成点注入，webview 首帧
// 读取装配。构建端负责 </script> 转义，解析端对任意文本永不抛错。
import { describe, it, expect } from 'vitest'
import {
  LOCALE_ISLAND_ID,
  buildLocaleIslandHtml,
  parseLocaleIsland,
} from '../../src/shared/locales/island'

describe('buildLocaleIslandHtml（宿主注入端）', () => {
  it('生成非执行 JSON 数据岛：type/id 固定，载荷含语言代码与完整语言包', () => {
    const html = buildLocaleIslandHtml('zh-cn', { 'settings.pageTitle': 'Vsidian 设置' })
    expect(html).toContain('<script type="application/json"')
    expect(html).toContain(`id="${LOCALE_ISLAND_ID}"`)
    expect(html).toContain('"lang":"zh-cn"')
    expect(html).toContain('"settings.pageTitle":"Vsidian 设置"')
    expect(html.trim().endsWith('</script>')).toBe(true)
  })

  it('词条含 </script> 时转义为 \\u003c，不提前闭合数据岛', () => {
    const html = buildLocaleIslandHtml('en', { 'a.x': '</script><script>alert(1)</script>' })
    expect(html).not.toContain('</script><script>')
    // 转义后解析仍还原原文（\u003c 由 JSON.parse 还原为 <）
    const json = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'))
    expect(parseLocaleIsland(json)?.messages['a.x']).toBe('</script><script>alert(1)</script>')
  })
})

describe('parseLocaleIsland（webview 解析端，永不抛错）', () => {
  it('合法载荷解析为 { lang, messages }', () => {
    const data = parseLocaleIsland('{"lang":"en","messages":{"a.b":"c"}}')
    expect(data).toEqual({ lang: 'en', messages: { 'a.b': 'c' } })
  })

  it('非法载荷返回 null：坏 JSON、形态不符、空语言代码、非字符串词条', () => {
    expect(parseLocaleIsland('not json')).toBeNull()
    expect(parseLocaleIsland('null')).toBeNull()
    expect(parseLocaleIsland('"str"')).toBeNull()
    expect(parseLocaleIsland('{"messages":{}}')).toBeNull()
    expect(parseLocaleIsland('{"lang":"","messages":{}}')).toBeNull()
    expect(parseLocaleIsland('{"lang":"en"}')).toBeNull()
    expect(parseLocaleIsland('{"lang":"en","messages":{"a":1}}')).toBeNull()
    expect(parseLocaleIsland('{"lang":"en","messages":[]}')).toBeNull()
  })
})
