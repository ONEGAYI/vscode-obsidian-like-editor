// 图形化代码块右上角按钮组（工单 #111）：edit（编辑源码，仅实时预览）
// 与 popup（弹窗预览，双视图）两枚纯图标按钮，悬停显现由 CSS 承担（规格
// 契约 1）。实时预览 widget 与阅读挂载钩子共用（liveCodeCard.buildCopyButton
// 同款风格：内联 SVG、mousedown preventDefault 防抢焦点、aria-label/title
// 走 t()）。按钮 DOM 是路径级通用件——语言差异只体现在回调，由注册表
// 驱动的调用方注入。
import { t } from '../shared/i18n'

export const GRAPHIC_CHROME_CLASS_NAMES = {
  /** 渲染容器与按钮组的定位包裹层（position:relative 宿主） */
  frame: 'vsidian-graphic-frame',
  /** 按钮组根（absolute 右上；仅在渲染成功态显示，CSS 兄弟选择器驱动） */
  chrome: 'vsidian-graphic-chrome',
  edit: 'vsidian-graphic-chrome-edit',
  popup: 'vsidian-graphic-chrome-popup',
} as const

export interface GraphicChromeActions {
  /** 编辑源码（仅实时预览装配——派发选区进围栏触发源码显形；阅读视图
   *  不提供该按钮） */
  onEdit?: () => void
  /** 弹窗预览（打开图表弹窗） */
  onPopup: () => void
}

function buildChromeButton(
  className: string,
  labelKey: 'graphic.editSource' | 'graphic.popup',
  icon: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = className
  const label = t(labelKey)
  btn.setAttribute('aria-label', label)
  btn.title = label
  btn.innerHTML = icon
  // 阻断 CM6 的点击落位（live 侧防误触；阅读侧无副作用），与卡片按钮同款
  btn.addEventListener('mousedown', (event) => {
    event.preventDefault()
  })
  btn.addEventListener('click', () => {
    onClick()
  })
  return btn
}

const EDIT_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5.5 4L2 8l3.5 4"></path><path d="M10.5 4L14 8l-3.5 4"></path>' +
  '<path d="M8.8 3.5L7.2 12.5"></path></svg>'

const POPUP_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"></rect>' +
  '<path d="M6 2.5v3M2.5 6h3"></path><path d="M9.5 13.5v-3M13.5 9.5h-3"></path></svg>'

/** 按钮组 DOM：edit（可选，居左）+ popup（居右） */
export function buildGraphicChrome(actions: GraphicChromeActions): HTMLElement {
  const chrome = document.createElement('div')
  chrome.className = GRAPHIC_CHROME_CLASS_NAMES.chrome
  chrome.setAttribute('role', 'group')
  if (actions.onEdit) {
    chrome.appendChild(
      buildChromeButton(GRAPHIC_CHROME_CLASS_NAMES.edit, 'graphic.editSource', EDIT_ICON, actions.onEdit),
    )
  }
  chrome.appendChild(
    buildChromeButton(GRAPHIC_CHROME_CLASS_NAMES.popup, 'graphic.popup', POPUP_ICON, actions.onPopup),
  )
  return chrome
}

/** 把既有渲染容器包进定位 frame 并挂按钮组（阅读挂载钩子用；幂等——
 *  已是 frame 子节点则原样返回）。frame 上不携带渲染语义，仅承担
 *  position:relative 与按钮宿主，重渲染只清空内层容器。 */
export function wrapGraphicFrame(inner: HTMLElement, actions: GraphicChromeActions): HTMLElement {
  const existing = inner.parentElement
  if (existing && existing.classList.contains(GRAPHIC_CHROME_CLASS_NAMES.frame)) {
    return existing
  }
  const frame = document.createElement('div')
  frame.className = GRAPHIC_CHROME_CLASS_NAMES.frame
  inner.replaceWith(frame)
  frame.append(inner, buildGraphicChrome(actions))
  return frame
}
