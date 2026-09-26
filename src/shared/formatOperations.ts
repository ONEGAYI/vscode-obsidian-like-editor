/** 格式与插入操作的统一注册表。快捷键管理和快速操作条消费同一 id。
 *  #94 起标题键化：titleKey 为字典消息键（format.*，兼作命令 title 的
 *  NLS 生成源），消费方经 t(op.titleKey) 取词渲染。 */
import type { MessageKey } from './locales/en'

export const FORMAT_OPERATIONS = [
  { id: 'bold', command: 'onegayi.vsidian.format.bold', titleKey: 'format.bold', mode: 'live', writes: true, defaultKey: 'ctrl+b' },
  { id: 'italic', command: 'onegayi.vsidian.format.italic', titleKey: 'format.italic', mode: 'live', writes: true, defaultKey: null },
  { id: 'strikethrough', command: 'onegayi.vsidian.format.strikethrough', titleKey: 'format.strikethrough', mode: 'live', writes: true, defaultKey: null },
  { id: 'inlineCode', command: 'onegayi.vsidian.format.inlineCode', titleKey: 'format.inlineCode', mode: 'live', writes: true, defaultKey: null },
  { id: 'highlight', command: 'onegayi.vsidian.format.highlight', titleKey: 'format.highlight', mode: 'live', writes: true, defaultKey: null },
  { id: 'heading1', command: 'onegayi.vsidian.format.heading1', titleKey: 'format.heading1', mode: 'live', writes: true, defaultKey: 'ctrl+1' },
  { id: 'heading2', command: 'onegayi.vsidian.format.heading2', titleKey: 'format.heading2', mode: 'live', writes: true, defaultKey: 'ctrl+2' },
  { id: 'heading3', command: 'onegayi.vsidian.format.heading3', titleKey: 'format.heading3', mode: 'live', writes: true, defaultKey: 'ctrl+3' },
  { id: 'heading4', command: 'onegayi.vsidian.format.heading4', titleKey: 'format.heading4', mode: 'live', writes: true, defaultKey: 'ctrl+4' },
  { id: 'heading5', command: 'onegayi.vsidian.format.heading5', titleKey: 'format.heading5', mode: 'live', writes: true, defaultKey: 'ctrl+5' },
  { id: 'heading6', command: 'onegayi.vsidian.format.heading6', titleKey: 'format.heading6', mode: 'live', writes: true, defaultKey: 'ctrl+6' },
  { id: 'headingNone', command: 'onegayi.vsidian.format.headingNone', titleKey: 'format.headingNone', mode: 'live', writes: true, defaultKey: 'ctrl+0' },
  { id: 'bulletList', command: 'onegayi.vsidian.format.bulletList', titleKey: 'format.bulletList', mode: 'live', writes: true, defaultKey: null },
  { id: 'orderedList', command: 'onegayi.vsidian.format.orderedList', titleKey: 'format.orderedList', mode: 'live', writes: true, defaultKey: null },
  { id: 'taskList', command: 'onegayi.vsidian.format.taskList', titleKey: 'format.taskList', mode: 'live', writes: true, defaultKey: null },
  { id: 'quote', command: 'onegayi.vsidian.format.quote', titleKey: 'format.quote', mode: 'live', writes: true, defaultKey: null },
  { id: 'codeBlock', command: 'onegayi.vsidian.format.codeBlock', titleKey: 'format.codeBlock', mode: 'live', writes: true, defaultKey: null },
  { id: 'link', command: 'onegayi.vsidian.format.link', titleKey: 'format.link', mode: 'live', writes: true, defaultKey: null },
  { id: 'clearInline', command: 'onegayi.vsidian.format.clearInline', titleKey: 'format.clearInline', mode: 'live', writes: true, defaultKey: null },
  { id: 'inlineMath', command: 'onegayi.vsidian.insert.inlineMath', titleKey: 'format.inlineMath', mode: 'live', writes: true, defaultKey: null },
  { id: 'blockMath', command: 'onegayi.vsidian.insert.blockMath', titleKey: 'format.blockMath', mode: 'live', writes: true, defaultKey: null },
  { id: 'wikilink', command: 'onegayi.vsidian.insert.wikilink', titleKey: 'format.wikilink', mode: 'live', writes: true, defaultKey: null },
] as const satisfies readonly ({ titleKey: MessageKey } & Record<string, unknown>)[]

export type FormatOperationId = (typeof FORMAT_OPERATIONS)[number]['id']

export function isFormatOperationId(value: unknown): value is FormatOperationId {
  return typeof value === 'string' && FORMAT_OPERATIONS.some((item) => item.id === value)
}
