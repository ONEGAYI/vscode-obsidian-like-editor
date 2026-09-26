// Vsidian 独立设置页面板（#33）：createWebviewPanel 装配的宿主级 webview
// （非 custom editor——打开设置页不要求任何文档）。
//
// 装配照抄 custom editor 的成熟链路（textEditorProvider.buildWebviewHtml）：
// randomUUID nonce、四段 CSP、asWebviewUri 产物地址、资源根收紧到 out。
// 单例策略：已开着设置面板时再执行命令 reveal 已有面板而非叠加；
// retainContextWhenHidden 不开——隐藏即释放，重开时页面经 settings.get
// 重新拉取权威快照回显（与「重新打开后回显」验收天然对齐）。
//
// 持久化权威在宿主（SettingsService + globalState）：页面只回显与上送，
// 保存成功回 settings.changed、被拒回 settings.snapshot 恢复显示。
// #93 i18n：面板标题经 t() 取词（激活时已按生效语言装配宿主语言包）；
// HTML 生成点同步注入语言数据岛与 <html lang>（首帧文案即就绪）。
import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { isWebviewToHost } from '../shared/protocol'
import { t } from '../shared/i18n'
import { LANGUAGE_KEY } from '../shared/settings'
import { LOCALE_MESSAGES, resolveLocale, type LocaleCode } from '../shared/locales'
import { buildLocaleIslandHtml } from '../shared/locales/island'
import type { SettingsService } from './settingsService'
import type { KeybindingService } from './keybindingService'

/** 设置页面板 viewType（createWebviewPanel 无需清单声明，customEditors 才要求） */
export const SETTINGS_VIEW_TYPE = 'onegayi.vsidian.settings'

/** 面板标题：界面与标题栏明确归属 Vsidian（#93 起经语言包取词，随装配语言） */
export function settingsPageTitle(): string {
  return t('settings.pageTitle')
}

/** 设置页观测信息（测试钩子与集成断言用） */
export interface SettingsPageInfo {
  open: boolean
  /** webview 已装载并请求过快照（ready 握手完成） */
  ready: boolean
  title: string
}

export interface SettingsPageHandle {
  /** 打开（或 reveal 已有面板） */
  open(): void
  close(): void
  isOpen(): boolean
  getInfo(): SettingsPageInfo
  /** 经正式处理入口注入设置页 webview → 宿主消息（测试钩子通道） */
  injectMessage(message: unknown): void
}

export function createSettingsPage(
  context: vscode.ExtensionContext,
  service: SettingsService,
  keybindings: KeybindingService,
): SettingsPageHandle {
  let panel: vscode.WebviewPanel | undefined
  let ready = false

  /** 设置页 webview 消息处理（onDidReceiveMessage 与测试注入共用入口） */
  const handleMessage = (message: unknown): void => {
    if (!isWebviewToHost(message)) {
      return
    }
    const current = panel
    switch (message.kind) {
      case 'keybindings.get':
        void current?.webview.postMessage({ kind: 'keybindings.snapshot', overrides: keybindings.getSnapshot() })
        return
      case 'keybindings.set':
      case 'keybindings.reset':
      case 'keybindings.resetAll': {
        const result = message.kind === 'keybindings.set'
          ? keybindings.set(message.id, message.bindings, message.replaceConflicts)
          : message.kind === 'keybindings.reset'
            ? keybindings.reset(message.id, message.replaceConflicts)
            : keybindings.resetAll()
        void result.then((saved) => {
          if (!current || panel !== current) return
          void current.webview.postMessage({
            kind: saved.ok ? 'keybindings.changed' : 'keybindings.snapshot',
            overrides: saved.ok ? saved.overrides : keybindings.getSnapshot(),
            requestId: message.requestId, ok: saved.ok,
            ...(!saved.ok ? { reason: saved.reason, conflicts: saved.conflicts } : {}),
          })
        })
        return
      }
      case 'settings.get':
        ready = true
        void current?.webview.postMessage({
          kind: 'settings.snapshot',
          values: service.getSnapshot(),
        })
        return
      case 'settings.set': {
        void service.apply(message.values).then((result) => {
          // 持久化期间设置页可能已关闭或重新打开；旧面板的 webview getter
          // 在 dispose 后会抛错，旧保存结果也不应回信给新面板。
          if (!current || panel !== current) return
          // 成功：onChange 广播（provider 层接编辑器面板）之外，直接回发
          // 设置页自身 settings.changed 刷新回显；拒绝：以权威快照恢复显示
          const kind = result.ok ? 'settings.changed' : 'settings.snapshot'
          void current?.webview.postMessage({
            kind,
            values: result.ok ? result.values : service.getSnapshot(),
          })
        })
        return
      }
      default:
        return // 设置页不会发出其余消息，忽略
    }
  }

  const disposeSub = () => {
    panel = undefined
    ready = false
  }

  const open = (): void => {
    if (panel) {
      panel.reveal()
      return
    }
    const created = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      settingsPageTitle(),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // C-7 同口径收紧：设置页只加载自身产物（out/webview/settings.js|css）
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out')],
      },
    )
    panel = created
    created.webview.html = buildSettingsPageHtml(
      created.webview,
      context.extensionUri,
      resolveLocale(service.getSnapshot()[LANGUAGE_KEY], vscode.env.language),
    )
    const messageSub = created.webview.onDidReceiveMessage(handleMessage)
    created.onDidDispose(() => {
      messageSub.dispose()
      disposeSub()
    })
  }

  return {
    open,
    close: () => {
      panel?.dispose()
    },
    isOpen: () => panel !== undefined,
    getInfo: () => ({ open: panel !== undefined, ready, title: settingsPageTitle() }),
    injectMessage: handleMessage,
  }
}

/** 设置页 HTML：CSP 四段与产物地址装配（照抄 buildWebviewHtml 模式）；
 *  #93 同步注入 <html lang> 与语言数据岛（首帧文案即就绪，零字典字节进
 *  settings.js——语言包只经数据岛进入 webview） */
function buildSettingsPageHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  locale: LocaleCode,
): string {
  const nonce = randomUUID()
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'settings.js'),
  )
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'settings.css'),
  )
  const csp = [
    `default-src 'none'`,
    // 本页无图片资源（视图全 createElement/textContent），不放行远程图源
    `img-src ${webview.cspSource}`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `style-src ${webview.cspSource}`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styleUri}" rel="stylesheet">
<title>${settingsPageTitle()}</title>
</head>
<body>
<div id="app"></div>
${buildLocaleIslandHtml(locale, LOCALE_MESSAGES[locale])}
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}
