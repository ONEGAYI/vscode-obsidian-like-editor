// 生效语言的宿主装配解析（#93/#96 收拢）：语言偏好（设置快照或变更回调
// values 的 general.language 项）按宿主显示语言解析为生效语言代码。
// 激活装配（extension.ts）、两个 HTML 生成点的数据岛注入
// （textEditorProvider / settingsPage）与语言切换检测共用同一组合——此前
// 四处复写 `resolveLocale(snapshot[LANGUAGE_KEY], env.language)`，收拢于此
// 防漂移。shared/locales 的 resolveLocale 是纯函数（不读 vscode），宿主侧
// env.language 的取值只在本模块出现。
import * as vscode from 'vscode'
import { resolveLocale, type LocaleCode } from '../shared/locales'
import { LANGUAGE_KEY } from '../shared/settings'

/**
 * 生效语言解析的宿主同形组合：values 为设置快照（getSnapshot()）或变更
 * 回调收到的 values 对象；未接线（undefined）视为缺省 auto——auto/缺省/
 * 非法偏好一律按宿主显示语言解析（zh 开头 → zh-cn，其余 → en）。
 */
export function hostLocale(values: Readonly<Record<string, unknown>> | undefined): LocaleCode {
  return resolveLocale(values?.[LANGUAGE_KEY], vscode.env.language)
}
