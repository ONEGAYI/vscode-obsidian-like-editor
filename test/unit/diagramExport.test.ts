// 图表导出序列化契约（工单 #111）：内在尺寸读取与独立 SVG 文档序列化。
// 光栅化走真实浏览器（test/browser），此处钉住纯逻辑。
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  readSvgIntrinsicSize,
  serializeDiagramSvg,
} from '../../src/webview/diagramExport'

const SAMPLE =
  '<svg id="mmd-r1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150" ' +
  'style="max-width: 512px;"><g id="n"><rect width="300" height="150"></rect></g></svg>'

describe('readSvgIntrinsicSize', () => {
  it('viewBox 优先', () => {
    expect(readSvgIntrinsicSize(SAMPLE)).toEqual({ w: 300, h: 150 })
  })

  it('无 viewBox 时回退 width/height 属性', () => {
    expect(readSvgIntrinsicSize('<svg width="120.5" height="60"></svg>')).toEqual({ w: 120.5, h: 60 })
  })

  it('无可读尺寸返回 null', () => {
    expect(readSvgIntrinsicSize('<svg></svg>')).toBeNull()
  })
})

describe('serializeDiagramSvg', () => {
  it('剥 max-width、按内在尺寸固化 width/height、保留根 id 与命名空间', () => {
    const out = serializeDiagramSvg(SAMPLE, { w: 300, h: 150 })
    expect(out).toContain('width="300"')
    expect(out).toContain('height="150"')
    expect(out).not.toContain('max-width')
    // 根 id 保留：mermaid 内嵌 <style> 以 #id 前缀选择，剥除即失色
    expect(out).toContain('id="mmd-r1"')
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('无内在尺寸时按 960×540 兜底', () => {
    const out = serializeDiagramSvg('<svg id="a"></svg>', null)
    expect(out).toContain('width="960"')
    expect(out).toContain('height="540"')
  })
})
