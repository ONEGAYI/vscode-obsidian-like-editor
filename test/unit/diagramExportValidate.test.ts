// 图表导出载荷校验契约（工单 #111）：白名单、上限、base64 严格性与
// 文件名清洗（纯逻辑，node 直驱）。
import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_EXPORT_LIMITS,
  documentDirPath,
  sanitizeExportFileName,
  validateDiagramExportPayload,
} from '../../src/host/diagramExportValidate'
import type { DiagramExportPayload } from '../../src/shared/protocol'

function payload(over: Partial<DiagramExportPayload> = {}): DiagramExportPayload {
  return {
    kind: 'diagram.export',
    sessionId: 's1',
    docUri: 'file:///d/a.md',
    reqId: 1,
    format: 'svg',
    fileName: 'mermaid-diagram.svg',
    content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    ...over,
  }
}

describe('validateDiagramExportPayload', () => {
  it('合法 SVG 与 base64 PNG 通过；非法格式拒绝', () => {
    expect(validateDiagramExportPayload(payload())).toBe(true)
    expect(
      validateDiagramExportPayload(payload({ format: 'png', content: 'aGVsbG8=', fileName: 'x.png' })),
    ).toBe(true)
    expect(validateDiagramExportPayload(payload({ format: 'exe' as 'svg' }))).toBe(false)
  })

  it('空内容与超上限拒绝；PNG 须严格 base64', () => {
    expect(validateDiagramExportPayload(payload({ content: '' }))).toBe(false)
    expect(
      validateDiagramExportPayload(payload({ content: 'x'.repeat(DIAGRAM_EXPORT_LIMITS.svgMaxChars + 1) })),
    ).toBe(false)
    expect(validateDiagramExportPayload(payload({ format: 'png', content: 'not base64!!' }))).toBe(false)
  })
})

describe('sanitizeExportFileName', () => {
  it('剥离路径成分与控制字符', () => {
    expect(sanitizeExportFileName('..\\evil\\name.svg', 'svg')).toBe('..evilname.svg')
    expect(sanitizeExportFileName('a/b:c*d?"<>|.svg', 'svg')).toBe('abcd.svg')
  })

  it('空/点/超长回退默认名', () => {
    expect(sanitizeExportFileName('', 'png')).toBe('diagram.png')
    expect(sanitizeExportFileName('   ', 'svg')).toBe('diagram.svg')
    expect(sanitizeExportFileName('x'.repeat(200), 'svg')).toBe('diagram.svg')
  })
})

describe('documentDirPath', () => {
  it('返回文档所在目录；无目录分隔回退 null（调用方走文件系统根）', () => {
    expect(documentDirPath('/d/notes/g.md')).toBe('/d/notes')
    expect(documentDirPath('/g.md')).toBe(null)
    expect(documentDirPath('g.md')).toBe(null)
  })
})
