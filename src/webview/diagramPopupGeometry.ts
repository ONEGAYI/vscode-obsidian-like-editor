// 图表弹窗几何纯函数（工单 #111）：缩放/平移/contain-fit 的数学内核，
// 与 DOM 解耦（node 单测直驱）。约定：平移量以舞台中心为原点（内容居中
// 布局 + translate 摆位），缩放锚点公式保持光标下方的图点不动。
export interface PopupTransform {
  scale: number
  panX: number
  panY: number
}

/** 缩放范围（对齐参考实现 0.05–40×） */
export const POPUP_SCALE_MIN = 0.05
export const POPUP_SCALE_MAX = 40
/** 滚轮/按钮单步缩放倍率 */
export const POPUP_ZOOM_STEP = 1.2
/** contain-fit 留边系数（整图可见且留 8% 边距） */
export const POPUP_FIT_MARGIN = 0.92
/** 方向键单步平移（px） */
export const POPUP_PAN_KEY_STEP = 40
/** 无尺寸信息时的兜底内在尺寸（对齐参考实现） */
export const POPUP_FALLBACK_SIZE = { w: 960, h: 540 } as const

export function clampScale(scale: number): number {
  return Math.min(POPUP_SCALE_MAX, Math.max(POPUP_SCALE_MIN, scale))
}

/** contain-fit：整图按舞台留边可见（允许小图放大补满，不设上限——上限
 *  只约束用户缩放操作）；结果居中（pan = 0） */
export function containFitTransform(
  viewport: { w: number; h: number },
  content: { w: number; h: number },
): PopupTransform {
  const cw = Math.max(content.w, 1)
  const ch = Math.max(content.h, 1)
  const scale = clampScale(
    Math.min((viewport.w * POPUP_FIT_MARGIN) / cw, (viewport.h * POPUP_FIT_MARGIN) / ch),
  )
  return { scale, panX: 0, panY: 0 }
}

/** 锚点缩放：anchor 为「光标相对舞台中心」的坐标；保持 anchor 处的图点
 *  缩放后仍在 anchor（pan' = anchor − (anchor − pan) × 新旧比） */
export function zoomAtTransform(
  state: PopupTransform,
  anchor: { x: number; y: number },
  factor: number,
): PopupTransform {
  const scale = clampScale(state.scale * factor)
  const ratio = scale / state.scale
  return {
    scale,
    panX: anchor.x - (anchor.x - state.panX) * ratio,
    panY: anchor.y - (anchor.y - state.panY) * ratio,
  }
}

/** 平移累加 */
export function panTransform(state: PopupTransform, dx: number, dy: number): PopupTransform {
  return { scale: state.scale, panX: state.panX + dx, panY: state.panY + dy }
}
