// @vitest-environment jsdom
// webview 图片资源管理器契约（工单 #10）：
// 状态机：loading（占位）→ loaded（应用 src 且 img load 事件确认）/
// error（可点击重试的失败态）；离开视口 detach 释放（src 清空、条目回收）。
// 非直连图源经宿主 image.request/image.result 通道解析；https 直连不经宿主。
// 本层不写文档：任何路径都不得产生 edit.request（由使用方保证，本层只管
// 资源状态）。
import { describe, it, expect, vi } from 'vitest'
import { ImageResourceManager } from '../../src/webview/imageResource'

function makeManager() {
  const posted: Array<{ src: string; reqId: number }> = []
  const manager = new ImageResourceManager({
    isDirectSrc: (src) => /^https?:\/\//i.test(src),
    requestHost: (src, reqId) => posted.push({ src, reqId }),
  })
  return { manager, posted }
}

function img(): HTMLImageElement {
  return document.createElement('img')
}

function state(el: HTMLElement): string {
  return el.dataset['vsidianImgState'] ?? ''
}

describe('装载与占位状态', () => {
  it('attach 非直连图源：进入 loading 并经宿主通道请求（携带自增 reqId）', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './assets/图 片.png')
    expect(state(el)).toBe('loading')
    expect(el.getAttribute('src')).toBeNull()
    expect(posted).toEqual([{ src: './assets/图 片.png', reqId: 1 }])
    expect(el.classList.contains('vsidian-image')).toBe(true)
    expect(el.dataset['vsidianImgSrc']).toBe('./assets/图 片.png')
  })

  it('https 直连图源不经宿主：立即应用原始 src', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, 'https://example.com/x.png')
    expect(posted).toEqual([])
    expect(el.getAttribute('src')).toBe('https://example.com/x.png')
    expect(state(el)).toBe('loading') // 等 img load 事件确认
  })

  it('同一 src 的并发槽位复用在途请求（不重复发请求）', () => {
    const { manager, posted } = makeManager()
    const a = img()
    const b = img()
    manager.attach(a, './same.png')
    manager.attach(b, './same.png')
    expect(posted.length).toBe(1)
  })
})

describe('结果应用与状态迁移', () => {
  it('image.result ok：应用 src，img load 事件后进入 loaded', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './ok.png')
    manager.handleResult({ reqId: posted[0]!.reqId, ok: true, src: 'vscode-webview://res/ok.png' })
    expect(el.getAttribute('src')).toBe('vscode-webview://res/ok.png')
    expect(state(el)).toBe('loading')
    el.dispatchEvent(new Event('load'))
    expect(state(el)).toBe('loaded')
  })

  it('img error 事件（加载失败）进入 error 态并可点击重试', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './ok-but-broken.png')
    manager.handleResult({ reqId: posted[0]!.reqId, ok: true, src: 'vscode-webview://res/broken.png' })
    el.dispatchEvent(new Event('error'))
    expect(state(el)).toBe('error')
    expect(el.dataset['vsidianImgReason']).toBeDefined()
    // 重试：重新应用同一 src
    el.click()
    expect(state(el)).toBe('loading')
    expect(el.getAttribute('src')).toBe('vscode-webview://res/broken.png')
  })

  it('image.result 失败：进入 error 并带原因；点击重试发起新请求', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './missing.png')
    manager.handleResult({ reqId: posted[0]!.reqId, ok: false, reason: 'not-found' })
    expect(state(el)).toBe('error')
    expect(el.dataset['vsidianImgReason']).toBe('not-found')
    el.click()
    expect(state(el)).toBe('loading')
    expect(posted.length).toBe(2) // 新请求（新 reqId）
    expect(posted[1]!.reqId).toBeGreaterThan(posted[0]!.reqId)
    // 新结果到达后恢复
    manager.handleResult({ reqId: posted[1]!.reqId, ok: true, src: 'vscode-webview://res/now.png' })
    el.dispatchEvent(new Event('load'))
    expect(state(el)).toBe('loaded')
  })

  it('未知 reqId 的迟到结果被忽略', () => {
    const { manager } = makeManager()
    const el = img()
    manager.attach(el, './a.png')
    expect(() => manager.handleResult({ reqId: 999, ok: true, src: 'x' })).not.toThrow()
    expect(state(el)).toBe('loading')
  })

  it('错误态点击重试时阻断事件冒泡（不触发外层链接/容器点击）', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './e.png')
    manager.handleResult({ reqId: posted[0]!.reqId, ok: false, reason: 'not-found' })
    const outer = document.createElement('div')
    const onOuter = vi.fn()
    outer.addEventListener('click', onOuter)
    outer.appendChild(el)
    el.click()
    expect(onOuter).not.toHaveBeenCalled()
  })
})

describe('释放与回收', () => {
  it('detach 清空 src、解绑监听并回收条目：重新 attach 发起全新请求', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './r.png')
    manager.handleResult({ reqId: posted[0]!.reqId, ok: true, src: 'vscode-webview://res/r.png' })
    el.dispatchEvent(new Event('load'))
    manager.detach(el)
    expect(el.getAttribute('src')).toBeNull() // 释放解码位图
    expect(state(el)).toBe('') // 状态清空，不再是活动槽位
    // 旧监听已解绑：迟到 load 不再改状态
    el.dispatchEvent(new Event('load'))
    expect(state(el)).toBe('')
    // 条目已回收：同 src 重新 attach 是全新请求
    manager.attach(el, './r.png')
    expect(posted.length).toBe(2)
  })

  it('detachWithin 释放容器内全部图片槽位', () => {
    const { manager, posted } = makeManager()
    const root = document.createElement('div')
    for (const src of ['./1.png', './2.png']) {
      const el = img()
      root.appendChild(el)
      manager.attach(el, src)
    }
    const outside = img()
    manager.attach(outside, './3.png')
    expect(posted.length).toBe(3)
    manager.detachWithin(root)
    expect(root.querySelector('img')!.getAttribute('src')).toBeNull()
    expect(state(outside)).toBe('loading') // 容器外不受影响
  })

  it('sweep 清理已脱离文档的 live 槽位（CM6 widget 无销毁回调的兜底）', () => {
    const { manager, posted } = makeManager()
    const slot = document.createElement('span')
    document.body.appendChild(slot)
    manager.attach(slot, './s.png', (s, src) => {
      s.textContent = ''
      const image = document.createElement('img')
      image.src = src
      s.appendChild(image)
      return image
    })
    manager.handleResult({ reqId: posted[0]!.reqId, ok: true, src: 'vscode-webview://res/s.png' })
    slot.remove() // 模拟 CM6 把 widget 移出视口
    manager.sweep()
    expect(manager.getStates().loaded).toBe(0)
    expect(slot.querySelector('img')!.getAttribute('src')).toBeNull()
    // 阅读槽位（无 render 回调）不受 sweep 影响：生命周期由挂载钩子管理
    const reading = img()
    manager.attach(reading, './keep.png')
    manager.sweep()
    expect(reading.dataset['vsidianImgState']).toBe('loading')
  })

  it('在途请求的最后一个槽位 detach 后：结果到达不复活任何槽位', () => {
    const { manager, posted } = makeManager()
    const el = img()
    manager.attach(el, './ghost.png')
    manager.detach(el)
    manager.handleResult({ reqId: posted[0]!.reqId, ok: true, src: 'vscode-webview://res/g.png' })
    expect(state(el)).toBe('')
    expect(el.getAttribute('src')).toBeNull()
  })
})

describe('观测（view.state 探针数据源）', () => {
  it('getStates 按 loading/loaded/error 计数活动槽位', () => {
    const { manager, posted } = makeManager()
    const loading = img()
    const failed = img()
    manager.attach(loading, './a.png')
    manager.attach(failed, './b.png')
    expect(manager.getStates()).toEqual({ loading: 2, loaded: 0, error: 0 })
    manager.handleResult({ reqId: posted[1]!.reqId, ok: false, reason: 'not-found' })
    expect(manager.getStates()).toEqual({ loading: 1, loaded: 0, error: 1 })
  })
})

describe('live 视图的自定义渲染回调', () => {
  it('render 回调构建 img 子元素并由其 load/error 驱动状态', () => {
    const { manager, posted } = makeManager()
    const slot = document.createElement('span')
    manager.attach(slot, './live.png', (s, src) => {
      s.textContent = ''
      const image = document.createElement('img')
      image.src = src
      s.appendChild(image)
      return image
    })
    manager.handleResult({ reqId: posted[0]!.reqId, ok: true, src: 'vscode-webview://res/live.png' })
    const inner = slot.querySelector('img')
    expect(inner).not.toBeNull()
    expect(inner!.getAttribute('src')).toBe('vscode-webview://res/live.png')
    inner!.dispatchEvent(new Event('load'))
    expect(state(slot)).toBe('loaded')
    // detach 释放：内部 img 的 src 同样被清空
    manager.detach(slot)
    expect(inner!.getAttribute('src')).toBeNull()
  })
})
