// 图表导出序列化与光栅化（工单 #111，webview 侧）：
// - serializeDiagramSvg：SVG 字符串 → 可落盘的独立 SVG 文档（清 max-width、
//   按内在尺寸固化 width/height、补 xmlns）。纯 DOM 操作（jsdom 单测直驱）。
// - rasterizeDiagramPng：SVG → canvas → PNG dataURL。真实浏览器路径；环境
//   不支持（jsdom/画布或 CSP 拦截）返回 null，调用方按规格降级为仅 SVG。
//   已知边界：mermaid htmlLabels 走 foreignObject，SVG-as-image 语境下
//   部分引擎不渲染该内容——PNG 保真度由浏览器回归实测，属规格显式风险项。
export interface IntrinsicSize {
  w: number
  h: number
}

/** 从 SVG 字符串读内在尺寸：viewBox 优先，其次 width/height 属性 */
export function readSvgIntrinsicSize(svg: string): IntrinsicSize | null {
  const viewBox = /viewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg)
  if (viewBox) {
    const w = Number(viewBox[3])
    const h = Number(viewBox[4])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { w, h }
    }
  }
  const m = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg)
  if (m) {
    const w = Number(m[1])
    const h = Number(m[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { w, h }
    }
  }
  return null
}

function parseSvg(svg: string): SVGSVGElement | null {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg' || !('setAttribute' in root)) {
    return null
  }
  return root as unknown as SVGSVGElement
}

/**
 * 序列化为独立 SVG 文档：克隆根节点、剥 max-width（useMaxWidth 产物会
 * 自适应容器宽度，落盘后无法自持）、按内在尺寸固化 width/height、确保
 * xmlns 命名空间。根 id 原样保留（mermaid 内嵌 <style> 以 #id 前缀选择）。
 */
export function serializeDiagramSvg(svg: string, intrinsic: IntrinsicSize | null): string {
  const root = parseSvg(svg)
  if (!root) {
    return svg
  }
  const size = intrinsic ?? { w: 960, h: 540 }
  // style 属性级清洗（不依赖 CSSOM：部分引擎对 SVG 根的 .style 惰性构建）
  const styleAttr = root.getAttribute('style')
  if (styleAttr !== null) {
    const cleaned = styleAttr.replace(/(^|;)\s*max-width:[^;]*;?/g, '').replace(/^[;\s]+|[;\s]+$/g, '')
    if (cleaned === '') {
      root.removeAttribute('style')
    } else {
      root.setAttribute('style', cleaned)
    }
  }
  if (!root.hasAttribute('xmlns')) {
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  }
  root.setAttribute('width', String(Math.round(size.w)))
  root.setAttribute('height', String(Math.round(size.h)))
  return new XMLSerializer().serializeToString(root)
}

/**
 * SVG → PNG dataURL（前缀 data:image/png;base64,）。失败返回 null：
 * 环境不支持 canvas/Image（jsdom）或图片解码失败。pixelRatio 控制光栅
 * 分辨率（默认 2×，导出更清晰）。
 */
export async function rasterizeDiagramPng(
  svg: string,
  intrinsic: IntrinsicSize | null,
  pixelRatio = 2,
): Promise<string | null> {
  const size = intrinsic ?? { w: 960, h: 540 }
  // canvas 上下文不可用（jsdom、禁用 canvas 的环境）先于图片装载判定——
  // 否则装载承诺悬挂，导出路径卡死
  const probe = document.createElement('canvas')
  if (typeof probe.getContext !== 'function' || probe.getContext('2d') === null) {
    return null
  }
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg image decode failed'))
      img.src = dataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(size.w * pixelRatio))
    canvas.height = Math.max(1, Math.round(size.h * pixelRatio))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return null
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
