// 图表弹窗几何纯函数契约（工单 #111）：缩放钳制、contain-fit、锚点缩放
// 与平移累加的数学不变量。
import { describe, expect, it } from 'vitest'
import {
  containFitTransform,
  panTransform,
  POPUP_SCALE_MAX,
  POPUP_SCALE_MIN,
  zoomAtTransform,
} from '../../src/webview/diagramPopupGeometry'

describe('containFitTransform', () => {
  it('宽图按宽度收敛、高图按高度收敛，结果居中', () => {
    const wide = containFitTransform({ w: 1000, h: 800 }, { w: 2000, h: 500 })
    expect(wide.scale).toBeCloseTo((1000 * 0.92) / 2000, 10)
    expect(wide.panX).toBe(0)
    expect(wide.panY).toBe(0)
    const tall = containFitTransform({ w: 1000, h: 800 }, { w: 500, h: 2000 })
    expect(tall.scale).toBeCloseTo((800 * 0.92) / 2000, 10)
  })

  it('小图放大补满不受用户缩放上限约束（上限只管缩放操作）', () => {
    const tiny = containFitTransform({ w: 1920, h: 1080 }, { w: 100, h: 60 })
    expect(tiny.scale).toBeGreaterThan(1)
  })
})

describe('zoomAtTransform', () => {
  it('锚点处图点缩放后不动（pan 重排公式）', () => {
    const state = { scale: 1, panX: 40, panY: -20 }
    const anchor = { x: 120, y: 60 }
    const next = zoomAtTransform(state, anchor, 2)
    expect(next.scale).toBe(2)
    expect(anchor.x - next.panX).toBeCloseTo((anchor.x - state.panX) * 2, 8)
    expect(anchor.y - next.panY).toBeCloseTo((anchor.y - state.panY) * 2, 8)
  })

  it('缩放钳制在 [MIN, MAX]', () => {
    let s = { scale: 1, panX: 0, panY: 0 }
    for (let i = 0; i < 100; i++) {
      s = zoomAtTransform(s, { x: 0, y: 0 }, 1.2)
    }
    expect(s.scale).toBe(POPUP_SCALE_MAX)
    let t = { scale: 1, panX: 0, panY: 0 }
    for (let i = 0; i < 100; i++) {
      t = zoomAtTransform(t, { x: 0, y: 0 }, 1 / 1.2)
    }
    expect(t.scale).toBe(POPUP_SCALE_MIN)
  })
})

describe('panTransform', () => {
  it('平移累加、缩放不变', () => {
    const next = panTransform({ scale: 2, panX: 10, panY: 10 }, -30, 5)
    expect(next).toEqual({ scale: 2, panX: -20, panY: 15 })
  })
})
