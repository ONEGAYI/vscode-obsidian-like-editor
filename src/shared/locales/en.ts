// 英文语言包（#93 i18n 基础设施）——字典单一事实源的【类型基准】：
// `MessageKey = keyof typeof en`，zh-cn.ts 以 `Record<MessageKey, string>`
// 约束（缺键/多键即 tsc 编译失败，编译期 parity）。
//
// 翻译约定（规格「翻译流程与术语」）：术语以 docs/specs/i18n.md 附录术语表
// 为唯一术语源；按钮与动作用祈使动词，标题与标签名词短语，描述为完整句、
// 句尾句号，sentence case。#93 入基础设施词条；#95 补设置页框架、快捷键
// 分页、设置项定义（setting.*）与宿主消息（host.*）词条（键前缀分组见
// 规格「字典架构」表）。
export const en = {
  // ---- settings.（设置页框架：标题、搜索、分类、保存状态、空状态）----
  /** 设置页面板标题（宿主 createWebviewPanel 标题与页面 h1 同源） */
  'settings.pageTitle': 'Vsidian Settings',
  'settings.searchPlaceholder': 'Search settings…',
  'settings.searchAriaLabel': 'Search all settings',
  'settings.navLabel': 'Options',
  'settings.navAriaLabel': 'Setting categories',
  'settings.saving': 'Saving…',
  'settings.saveDone': 'Settings saved',
  'settings.saveFailed': 'Failed to save the setting; the currently effective value has been restored. Please try again.',
  /** 默认分类（侧栏入口、搜索分组与空 section 兜底共用） */
  'settings.editorCategory': 'Editor',
  'settings.searchResults': 'Search results',
  'settings.searchCount': 'Settings found: {count}',
  'settings.searchEmpty': 'No matching settings found. Try other keywords.',
  'settings.editorSubtitle': 'Adjust how the live preview is displayed. Changes are saved automatically.',
  'settings.empty': 'Nothing to configure yet.',
  'settings.groupDisplay': 'Display',

  // ---- keybindingSettings.（快捷键分页：标题、模式标签、状态、搜索、按钮）----
  'keybindingSettings.title': 'Keybindings',
  'keybindingSettings.description': 'Manage keybindings for Vsidian actions. Conflict checks cover Vsidian internals; effective keys from VS Code and other extensions cannot be fully queried.',
  'keybindingSettings.modeLive': 'Live preview',
  'keybindingSettings.modeReading': 'Reading',
  /** entries 副文案的模式段（顿号连接） */
  'keybindingSettings.modeBoth': 'Live preview, reading',
  /** 行首模式标签（中点连接） */
  'keybindingSettings.modeLiveReading': 'Live preview · Reading',
  /** 冲突文案中操作名的连接符（zh 顿号 / en 逗号加空格） */
  'keybindingSettings.nameSeparator': ', ',
  'keybindingSettings.saving': 'Saving…',
  'keybindingSettings.saved': 'Keybinding saved and effective immediately.',
  'keybindingSettings.saveFailedStorage': 'Failed to save; the currently effective bindings have been restored.',
  'keybindingSettings.conflictInternal': 'Conflict within Vsidian: {names}',
  'keybindingSettings.conflictSave': 'Conflict within Vsidian: {names}. You can replace the original binding.',
  'keybindingSettings.conflictReset': 'Restoring the default conflicts with {names}. You can replace the original binding.',
  'keybindingSettings.conflictRow': 'Conflicts with {names}.',
  'keybindingSettings.invalid': 'Invalid keybinding; not saved.',
  'keybindingSettings.resetFailed': 'Failed to restore the default.',
  'keybindingSettings.searchNamePlaceholder': 'Search action names',
  'keybindingSettings.searchKeyPlaceholder': 'Search by keybinding',
  'keybindingSettings.searchKeyCaption': 'Search by keys',
  'keybindingSettings.resetAll': 'Reset all to defaults',
  'keybindingSettings.noMatch': 'No matching actions.',
  'keybindingSettings.unbound': 'Unbound',
  'keybindingSettings.addBinding': 'Add binding',
  'keybindingSettings.clearBindings': 'Clear bindings',
  'keybindingSettings.resetDefault': 'Reset to default',
  'keybindingSettings.recordPlaceholder': 'Press a single chord or two consecutive chords',
  'keybindingSettings.saveBinding': 'Save binding',
  'keybindingSettings.replaceConflicts': 'Replace original binding',

  // ---- setting.（设置项定义 title/description，经 titleKey/descriptionKey 取词）----
  'setting.editorLineNumbers.title': 'Show line numbers',
  'setting.editorLineNumbers.description': 'Show source file line numbers in the left gutter of the live preview (not shown in reading view).',
  'setting.codeblockCard.title': 'Code block card',
  'setting.codeblockCard.description': 'Collapse a fenced code block into a card when the cursor leaves it: hide the fence markers and show a language header bar. Turn off to restore the plain source fence look.',
  'setting.codeblockLineNumbers.title': 'Line numbers inside cards',
  'setting.codeblockLineNumbers.description': 'Show per-block line numbers at the start of each line inside the card (counting from 1 per block; fence lines excluded). Requires "Code block card".',
  'setting.codeblockCopyButton.title': 'Copy button',
  'setting.codeblockCopyButton.description': 'Show a copy button on the card header on hover; click to copy the whole block (without fence lines). Requires "Code block card".',
  'setting.codeblockHighlight.title': 'Syntax highlighting',
  'setting.codeblockHighlight.description': 'Colorize code block content by language (also applies to plain fences when the card is off; unrecognized languages fall back to plain text).',
  /** 测试钩子 fixture 定义（VSIDIAN_TEST_HOOKS 注入设置页的占位开关） */
  'setting.testFlag.title': 'Test flag',

  // ---- host.（宿主通知、确认框、QuickPick、链接拦截反馈）----
  'host.conflictInputCopied': 'Unconfirmed input copied to clipboard',
  'host.noConflictInputToCopy': 'No unconfirmed input to copy',
  'host.copyConflictInput': 'Copy unconfirmed input',
  'host.discardAndResync': 'Discard local changes and resync',
  'host.confirmResume': 'This will discard the unconfirmed local changes in the "{name}" editor and resync with the on-disk/authoritative content. Consider copying the unconfirmed input first.',
  'host.conflictPaused': 'Editing of "{name}" is paused: the external change and the unconfirmed input cannot be merged safely. The unconfirmed input is kept and can be retrieved at any time.',
  'host.panelClosedWithInput': 'The editor for "{name}" was closed (or the connection dropped) with unsaved unconfirmed input: {text}',
  'host.wikilinkUnsupported': 'Unsupported wikilink form "[[{target}]]" (block references ^ and embeds ![[…]] belong to a later phase): kept as-is',
  'host.wikilinkNoWorkspace': 'The current document is not in any workspace folder: wikilink targets are resolved against the workspace, so jumping is unavailable with no folder open (the link text is kept)',
  'host.wikilinkNotFound': 'Wikilink target not found: [[{target}]] (looked up on demand within the current workspace; files are never created automatically)',
  'host.wikilinkAmbiguousPick': 'Multiple wikilink targets found for "{target}"; choose the note to open',
  'host.wikilinkHeadingMissing': 'Opened {link} in the target document, but the heading "{heading}" was not found (heading matching: trimmed, whitespace-collapsed, case-insensitive ATX headings)',
  'host.rejectDiffContext': 'View switching is not supported in diff views',
  'host.rejectPanelNotReady': 'The Vsidian panel is not ready yet; please retry shortly',
  'host.rejectAlreadySource': 'Already in the source editor',
  'host.noActiveMarkdown': 'Focus a Markdown document first (a Vsidian panel or a .md source editor) before switching view modes',
  'host.noPanelForFind': 'Focus a Vsidian editor panel first before using find in the editor',
  'host.readOnlyTableOp': 'Reading view is read-only: switch to live preview before running table operations',
  'host.noPanelForTableCreate': 'Focus a Vsidian editor panel first before creating a table',
  'host.noPanelForTableOp': 'Focus a Vsidian editor panel first (with the cursor inside a table) before running table operations',
  'host.blockedLinkEmpty': 'The link target is empty (blank or anchor-only): in-document anchors are not supported in this phase',
  'host.blockedLinkScheme': 'Link protocol "{scheme}" is not allowed: only http/https and in-workspace paths are supported',
  'host.blockedLinkEscape': 'The link points outside the workspace and was blocked: {detail}',
  'host.blockedLinkWindowsDrive': 'Windows drive-letter path links are not supported on remote (POSIX) workspaces',
  'host.externalOpenFailed': 'Failed to open the external link: {url}',
  'host.linkNotFound': 'Link target not found: {href} (resolved relative to the current document directory)',
  /** 运行时设置定义注册（测试钩子/懒注册）的拒绝原因 */
  'host.invalidSettingDefinition': 'Invalid definition: {definition}',
  'host.duplicateSettingKey': 'Setting key already exists: {key}',
} as const satisfies Record<string, string>

/** 字典键：点分扁平键，以本包为类型基准（编译期检查 t() 取词键） */
export type MessageKey = keyof typeof en
