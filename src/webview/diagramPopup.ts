// 图表弹窗（工单 #111，规格契约 4–5）：webview 内全屏模态浮层，放大浏览
// 图形化代码块的渲染结果。内容为打开时快照（按围栏源码经渲染管线取图，
// 缓存优先），工具条「刷新」按当前源码重取；缩放写 SVG 的 width/height
// （viewBox 矢量重排保清晰），transform 只承担平移——不用 transform:scale
// 光栅化拉伸。键盘（+/-/0/方向/Esc）只在弹窗内生效；关闭恢复先前焦点。
// 导出经 setDiagramExportSender 注入的出站通道交宿主另存为（SVG 矢量、
// PNG 光栅化失败时按规格降级为仅 SVG 并提示）。
import { t } from '../shared/i18n'
import { graphicRendererFor } from './graphicRenderers'
import {
  rasterizeDiagramPng,
  readSvgIntrinsicSize,
  serializeDiagramSvg,
  type IntrinsicSize,
} from './diagramExport'
import {
  containFitTransform,
  panTransform,
  POPUP_PAN_KEY_STEP,
  POPUP_ZOOM_STEP,
  zoomAtTransform,
  type PopupTransform,
} from './diagramPopupGeometry'

export const DIAGRAM_POPUP_CLASS_NAMES = {
  overlay: 'vsidian-diagram-overlay',
  backdrop: 'vsidian-diagram-backdrop',
  stage: 'vsidian-diagram-stage',
  media: 'vsidian-diagram-media',
  error: 'vsidian-diagram-error',
  toolbar: 'vsidian-diagram-toolbar',
  zoomOut: 'vsidian-diagram-zoom-out',
  zoomLabel: 'vsidian-diagram-zoom-label',
  zoomIn: 'vsidian-diagram-zoom-in',
  reset: 'vsidian-diagram-reset',
  refresh: 'vsidian-diagram-refresh',
  exportSvg: 'vsidian-diagram-export-svg',
  exportPng: 'vsidian-diagram-export-png',
  close: 'vsidian-diagram-close',
} as const

/** 导出出站消息（宿主侧补 sessionId/docUri 后走 diagram.export） */
export interface DiagramExportRequest {
  kind: 'diagram.export'
  reqId: number
  format: 'svg' | 'png'
  fileName: string
  /** SVG 为文档文本；PNG 为 dataURL 去前缀的 base64 */
  content: string
}

let exportSender: ((req: DiagramExportRequest) => void) | null = null
let exportReqSeq = 0

/** 装配导出通道（syncController.mount 注入；出站时补会话字段） */
export function setDiagramExportSender(sender: ((req: DiagramExportRequest) => void) | null): void {
  exportSender = sender
}

function sendExport(format: 'svg' | 'png', language: string, content: string): void {
  if (!exportSender) {
    return
  }
  exportReqSeq += 1
  exportSender({
    kind: 'diagram.export',
    reqId: exportReqSeq,
    format,
    fileName: `${language.toLowerCase()}-diagram.${format}`,
    content,
  })
}

// ---- 单例浮层状态 ----

interface PopupState {
  overlay: HTMLElement
  stage: HTMLElement
  media: HTMLElement
  toolbar: HTMLElement
  zoomLabel: HTMLElement
  language: string
  code: string
  /** 当前快照的 SVG 字符串与内在尺寸（导出与缩放基准） */
  svg: string | null
  intrinsic: IntrinsicSize
  transform: PopupTransform
  /** 装载代次：丢弃过期异步结果（刷新连点/关闭后回插） */
  loadSeq: number
  prevFocus: HTMLElement | null
  prevBodyOverflow: string
  cleanups: Array<() => void>
}

let popup: PopupState | null = null

export function isDiagramPopupOpen(): boolean {
  return popup !== null
}

export function closeDiagramPopup(): void {
  if (!popup) {
    return
  }
  const p = popup
  popup = null
  for (const cleanup of p.cleanups) {
    cleanup()
  }
  p.overlay.remove()
  document.body.style.overflow = p.prevBodyOverflow
  if (p.prevFocus && p.prevFocus.isConnected) {
    p.prevFocus.focus()
  }
}

function applyTransform(p: PopupState): void {
  const svg = p.media.querySelector('svg')
  if (svg instanceof SVGSVGElement) {
    svg.style.removeProperty('max-width')
    svg.style.width = `${Math.round(p.intrinsic.w * p.transform.scale)}px`
    svg.style.height = `${Math.round(p.intrinsic.h * p.transform.scale)}px`
  }
  // 缩放写实际尺寸（矢量重排）；transform 只承担平移
  p.media.style.transform = `translate(${p.transform.panX}px, ${p.transform.panY}px)`
  p.zoomLabel.textContent = `${Math.round(p.transform.scale * 100)}%`
}

function zoomBy(p: PopupState, factor: number, anchor?: { x: number; y: number }): void {
  // 缺省锚点 {0,0} = 舞台中心（坐标约定见 diagramPopupGeometry）
  const point = anchor ?? { x: 0, y: 0 }
  p.transform = zoomAtTransform(p.transform, point, factor)
  applyTransform(p)
}

function toolbarButton(
  className: string,
  label: string,
  icon: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  btn.setAttribute('aria-label', label)
  btn.title = label
  btn.innerHTML = icon
  btn.disabled = disabled
  btn.addEventListener('click', onClick)
  return btn
}

const TB_ICON = {
  minus:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3.5 8h9"></path></svg>',
  plus:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"></path></svg>',
  reset:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"></path><path d="M13 2.8v2.4h-2.4"></path></svg>',
  refresh:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9L13.5 5.5"></path><path d="M13.5 2.5v3h-3"></path><path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9L2.5 10.5"></path><path d="M2.5 13.5v-3h3"></path></svg>',
  download:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v7.5"></path><path d="M5 7.5l3 3 3-3"></path><path d="M2.5 13.5h11"></path></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"></path></svg>',
}

async function loadSnapshot(p: PopupState): Promise<void> {
  const seq = ++p.loadSeq
  const renderer = graphicRendererFor(p.language)
  const result = renderer
    ? await renderer.renderSvg(p.code)
    : { ok: false as const, message: t('decor.mermaidUnavailable') }
  if (popup !== p || seq !== p.loadSeq) {
    return // 已关闭或已有更新的装载在途
  }
  if (!result.ok) {
    p.svg = null
    p.media.textContent = ''
    const error = document.createElement('div')
    error.className = DIAGRAM_POPUP_CLASS_NAMES.error
    error.setAttribute('role', 'note')
    error.textContent = result.message
    p.media.appendChild(error)
    for (const btn of p.toolbar.querySelectorAll('button')) {
      if (!btn.classList.contains(DIAGRAM_POPUP_CLASS_NAMES.close)) {
        btn.disabled = true
      }
    }
    return
  }
  p.svg = result.svg
  p.intrinsic = readSvgIntrinsicSize(result.svg) ?? { w: 960, h: 540 }
  p.media.textContent = ''
  const tpl = document.createElement('template')
  tpl.innerHTML = result.svg
  p.media.appendChild(tpl.content)
  for (const btn of p.toolbar.querySelectorAll('button')) {
    btn.disabled = false
  }
  p.transform = containFitTransform(
    { w: p.stage.clientWidth, h: p.stage.clientHeight },
    p.intrinsic,
  )
  applyTransform(p)
}

async function exportPng(p: PopupState): Promise<void> {
  if (!p.svg) {
    return
  }
  const serialized = serializeDiagramSvg(p.svg, p.intrinsic)
  const dataUrl = await rasterizeDiagramPng(serialized, p.intrinsic)
  if (!dataUrl) {
    // 规格契约 6：PNG 光栅化不可用时降级为仅 SVG，明确提示（不静默砍）
    window.alert(t('graphic.exportPngUnavailable'))
    return
  }
  sendExport('png', p.language, dataUrl.slice('data:image/png;base64,'.length))
}

/** 打开图表弹窗（单例：再次打开先关闭旧的） */
export function openGraphicPopup(language: string, code: string): void {
  closeDiagramPopup()
  const renderer = graphicRendererFor(language)
  if (!renderer) {
    return
  }
  const overlay = document.createElement('div')
  overlay.className = DIAGRAM_POPUP_CLASS_NAMES.overlay
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', t('graphic.popup'))
  const backdrop = document.createElement('div')
  backdrop.className = DIAGRAM_POPUP_CLASS_NAMES.backdrop
  const stage = document.createElement('div')
  stage.className = DIAGRAM_POPUP_CLASS_NAMES.stage
  stage.tabIndex = -1
  const media = document.createElement('div')
  media.className = DIAGRAM_POPUP_CLASS_NAMES.media
  stage.appendChild(media)
  const toolbar = document.createElement('div')
  toolbar.className = DIAGRAM_POPUP_CLASS_NAMES.toolbar
  toolbar.setAttribute('role', 'toolbar')
  const zoomLabel = document.createElement('span')
  zoomLabel.className = DIAGRAM_POPUP_CLASS_NAMES.zoomLabel
  zoomLabel.textContent = '100%'
  const state: PopupState = {
    overlay,
    stage,
    media,
    toolbar,
    zoomLabel,
    language: language.trim(),
    code,
    svg: null,
    intrinsic: { w: 960, h: 540 },
    transform: { scale: 1, panX: 0, panY: 0 },
    loadSeq: 0,
    prevFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    prevBodyOverflow: document.body.style.overflow,
    cleanups: [],
  }
  toolbar.append(
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.zoomOut, t('graphic.popupZoomOut'), TB_ICON.minus, () =>
      zoomBy(state, 1 / POPUP_ZOOM_STEP)),
    zoomLabel,
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.zoomIn, t('graphic.popupZoomIn'), TB_ICON.plus, () =>
      zoomBy(state, POPUP_ZOOM_STEP)),
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.reset, t('graphic.popupReset'), TB_ICON.reset, () => {
      state.transform = containFitTransform(
        { w: stage.clientWidth, h: stage.clientHeight },
        state.intrinsic,
      )
      applyTransform(state)
    }),
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.refresh, t('graphic.popupRefresh'), TB_ICON.refresh, () => {
      void loadSnapshot(state)
    }),
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.exportSvg, t('graphic.popupExportSvg'), TB_ICON.download, () => {
      if (state.svg) {
        sendExport('svg', state.language, serializeDiagramSvg(state.svg, state.intrinsic))
      }
    }),
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.exportPng, t('graphic.popupExportPng'), TB_ICON.download, () => {
      void exportPng(state)
    }),
    toolbarButton(DIAGRAM_POPUP_CLASS_NAMES.close, t('graphic.popupClose'), TB_ICON.close, () =>
      closeDiagramPopup()),
  )
  overlay.append(backdrop, stage, toolbar)
  document.body.appendChild(overlay)
  document.body.style.overflow = 'hidden'

  // 滚轮缩放（光标锚点；preventDefault 阻止页面滚动）
  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const rect = stage.getBoundingClientRect()
    zoomBy(
      state,
      event.deltaY < 0 ? POPUP_ZOOM_STEP : 1 / POPUP_ZOOM_STEP,
      { x: event.clientX - (rect.left + rect.width / 2), y: event.clientY - (rect.top + rect.height / 2) },
    )
  }
  stage.addEventListener('wheel', onWheel, { passive: false })

  // 拖拽平移 + 点空白关闭（拖拽落点不算点击）
  let dragging = false
  let moved = false
  let lastX = 0
  let lastY = 0
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || event.target === toolbar || toolbar.contains(event.target as Node)) {
      return
    }
    dragging = true
    moved = false
    lastX = event.clientX
    lastY = event.clientY
    stage.setPointerCapture(event.pointerId)
    stage.classList.add('vsidian-diagram-stage--dragging')
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) {
      return
    }
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    if (Math.abs(dx) + Math.abs(dy) > 0) {
      moved = true
    }
    lastX = event.clientX
    lastY = event.clientY
    state.transform = panTransform(state.transform, dx, dy)
    applyTransform(state)
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!dragging) {
      return
    }
    dragging = false
    stage.classList.remove('vsidian-diagram-stage--dragging')
    if (stage.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId)
    }
    if (!moved && (event.target === stage || event.target === backdrop)) {
      closeDiagramPopup()
    }
  }
  stage.addEventListener('pointerdown', onPointerDown)
  stage.addEventListener('pointermove', onPointerMove)
  stage.addEventListener('pointerup', onPointerUp)
  backdrop.addEventListener('click', () => closeDiagramPopup())

  // 键盘：+/-/0 缩放、方向平移、Esc 关闭；只在弹窗内生效（stopPropagation
  // 不外溢；stage 已夺焦，CM6 正文不参与）
  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault()
        event.stopPropagation()
        zoomBy(state, POPUP_ZOOM_STEP)
        break
      case '-':
        event.preventDefault()
        event.stopPropagation()
        zoomBy(state, 1 / POPUP_ZOOM_STEP)
        break
      case '0':
        event.preventDefault()
        event.stopPropagation()
        state.transform = containFitTransform(
          { w: stage.clientWidth, h: stage.clientHeight },
          state.intrinsic,
        )
        applyTransform(state)
        break
      case 'ArrowLeft':
        event.preventDefault()
        event.stopPropagation()
        state.transform = panTransform(state.transform, POPUP_PAN_KEY_STEP, 0)
        applyTransform(state)
        break
      case 'ArrowRight':
        event.preventDefault()
        event.stopPropagation()
        state.transform = panTransform(state.transform, -POPUP_PAN_KEY_STEP, 0)
        applyTransform(state)
        break
      case 'ArrowUp':
        event.preventDefault()
        event.stopPropagation()
        state.transform = panTransform(state.transform, 0, POPUP_PAN_KEY_STEP)
        applyTransform(state)
        break
      case 'ArrowDown':
        event.preventDefault()
        event.stopPropagation()
        state.transform = panTransform(state.transform, 0, -POPUP_PAN_KEY_STEP)
        applyTransform(state)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closeDiagramPopup()
        break
      default:
        break
    }
  }
  overlay.addEventListener('keydown', onKeyDown)

  state.cleanups.push(() => {
    stage.removeEventListener('wheel', onWheel)
    stage.removeEventListener('pointerdown', onPointerDown)
    stage.removeEventListener('pointermove', onPointerMove)
    stage.removeEventListener('pointerup', onPointerUp)
    overlay.removeEventListener('keydown', onKeyDown)
  })

  popup = state
  stage.focus()
  void loadSnapshot(state)
}
