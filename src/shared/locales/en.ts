// 英文语言包（#93 i18n 基础设施）——字典单一事实源的【类型基准】：
// `MessageKey = keyof typeof en`，zh-cn.ts 以 `Record<MessageKey, string>`
// 约束（缺键/多键即 tsc 编译失败，编译期 parity）。
//
// 翻译约定（规格「翻译流程与术语」）：术语以 docs/specs/i18n.md 附录术语表
// 为唯一术语源；按钮与动作用祈使动词，标题与标签名词短语，描述为完整句、
// 句尾句号，sentence case。#93 入基础设施词条；#94 补编辑器 webview 呈现面
// （common/format/sidebar/find/conflict/outline/outlineMenu/table/codeblock/
// decor）；#95 补设置页框架、快捷键分页、设置项定义（setting.*）与宿主消息
// （host.*）词条（键前缀分组见规格「字典架构」表）。
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
  /** 设置页「常规」分组标题（#96 general.* 设置项的归属分组） */
  'settings.generalSection': 'General',
  /** 设置页「常规」分组副文案（对齐「编辑器」分组的说明句式） */
  'settings.generalSectionDescription':
    'Adjust basic Vsidian behavior. Changes save automatically.',

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
  /** 设置项「界面语言」（#96 general.language，经 titleKey/descriptionKey 取词） */
  'setting.language.title': 'Interface language',
  'setting.language.description':
    'The display language for interface text. Auto follows the VS Code display language (Simplified Chinese in Chinese environments, English otherwise); an explicit choice no longer follows it. Changes take effect immediately.',
  /** 语言下拉 auto 档显示名（随当前语言取词；具体语言为静态自名不自译） */
  'setting.languageAuto': 'Auto',
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

  // ---- #94 编辑器 webview 呈现面 ----

  /** 跨面通用：快捷键提示前缀与多键位连接符（zh 顿号、en 逗号） */
  'common.keybindingHint': 'Keybinding: {keys}',
  'common.keySeparator': ', ',

  /** 快捷操作工具条 22 条操作标题（兼作命令 title 的 NLS 生成源，#97 映射） */
  'format.bold': 'Bold',
  'format.italic': 'Italic',
  'format.strikethrough': 'Strikethrough',
  'format.highlight': 'Highlight',
  'format.inlineCode': 'Inline code',
  'format.heading1': 'Heading 1',
  'format.heading2': 'Heading 2',
  'format.heading3': 'Heading 3',
  'format.heading4': 'Heading 4',
  'format.heading5': 'Heading 5',
  'format.heading6': 'Heading 6',
  'format.headingNone': 'Remove heading',
  'format.bulletList': 'Bullet list',
  'format.orderedList': 'Numbered list',
  'format.taskList': 'Task list',
  'format.quote': 'Quote',
  'format.codeBlock': 'Code block',
  'format.link': 'Link',
  'format.clearInline': 'Clear inline formatting',
  'format.inlineMath': 'Insert inline math',
  'format.blockMath': 'Insert block math',
  'format.wikilink': 'Insert wikilink',
  'format.horizontalRule': 'Insert horizontal rule',

  /** 快捷操作工具条框架（分组、标题菜单；非命令标题，不进 #97 映射） */
  'format.toolbarAria': 'Formatting quick actions',
  'format.groupText': 'Text',
  'format.groupParagraph': 'Paragraph',
  'format.groupInsert': 'Insert',
  'format.heading': 'Heading',
  'format.headingMenu': 'Heading level',
  /** 标题菜单里「无标题」档的文字图标（与 H1–H6 同宽槽位，取正文术语缩写） */
  'format.bodyText': 'Body',
  'format.insertTable': 'Insert table',

  /** 右侧栏（顶栏按钮与侧栏切换） */
  'sidebar.settings': 'Open Vsidian settings',
  'sidebar.quickActions': 'Quick actions',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',

  /** 查找控件 */
  'find.placeholder': 'Find',
  'find.label': 'Find in document',
  'find.caseToggle': 'Ignore case',
  'find.prev': 'Previous match',
  'find.next': 'Next match',
  'find.close': 'Close find',

  /** 外部修改冲突横幅 */
  'conflict.bannerText':
    'An external change was detected that cannot be synced safely: writing back is paused, and your local input is kept and will not be overwritten.',
  'conflict.copyUnconfirmed': 'Copy unconfirmed input',
  'conflict.resume': 'Discard local changes and resync',

  /** 大纲面板（标题、空态、折叠滑块、搜索工具条） */
  'outline.label': 'Outline',
  'outline.empty': 'No headings',
  'outline.chevron': 'Collapse or expand',
  'outline.searchPlaceholder': 'Input to search',
  'outline.searchLabel': 'Search headings',
  'outline.jumpBottom': 'Jump to end of note',
  'outline.reset': 'Reset',
  'outline.noMatch': 'No match',
  'outline.expandLevels': 'Outline expand level',
  'outline.collapseAll': 'Collapse all',
  'outline.expandLevel1': 'Expand to level 1',
  'outline.expandLevel2': 'Expand to level 2',
  'outline.expandLevel3': 'Expand to level 3',
  'outline.expandLevel4': 'Expand to level 4',
  'outline.expandLevel5': 'Expand to level 5',
  'outline.renameHeading': 'Rename heading',

  /** 大纲右键菜单 */
  'outlineMenu.expandRecursively': 'Expand recursively',
  'outlineMenu.collapseSiblings': 'Collapse siblings',
  'outlineMenu.expandSiblings': 'Expand siblings',
  'outlineMenu.copy': 'Copy',
  'outlineMenu.copyHeading': 'Heading',
  'outlineMenu.copySiblings': 'Heading and sibling headings',
  'outlineMenu.copyChildren': 'Heading and child headings',
  'outlineMenu.copyLink': 'Heading link',
  'outlineMenu.copySection': 'Section content',
  'outlineMenu.adjustLevel': 'Adjust level',
  'outlineMenu.levelUp': 'Increase by one level',
  'outlineMenu.levelUpRecursive': 'Increase by one level recursively',
  'outlineMenu.levelDown': 'Decrease by one level',
  'outlineMenu.levelDownRecursive': 'Decrease by one level recursively',
  'outlineMenu.rename': 'Rename',
  'outlineMenu.delete': 'Delete',

  /** 表格可见行控件 */
  'table.controls': 'Table controls',
  'table.insertColumnRight': 'Add column on the right',
  'table.insertRowBelow': 'Add row at the bottom',
  'table.selectRow': 'Select or drag row {n}',
  'table.selectColumn': 'Select or drag column {n}',

  /** 代码块卡片 */
  'codeblock.copy': 'Copy code',
  'codeblock.expand': 'Expand code block',
  'codeblock.collapse': 'Collapse code block',

  /** 图片/公式/任务/Mermaid 装饰与错误占位 */
  'decor.taskCheck': 'Check task',
  'decor.taskUncheck': 'Uncheck task',
  'decor.emptyCell': 'Empty cell',
  'decor.mathError': 'Math failed to parse: source text is shown; move the cursor in to edit',
  'decor.imageError': 'Image failed to load ({reason}). Click to retry',
  'decor.unknownReason': 'unknown reason',
  'decor.mermaidUnavailable': 'Diagram renderer unavailable (mermaid.js failed to load)',
  'decor.mermaidError': 'Diagram failed to render: {message}',

  // ---- #97 manifest NLS（命令 title 与 displayName/description 生成源）----
  // 工具条 22 条命令直接复用上方 format.* 既有键（FORMAT_OPERATIONS 的
  // titleKey，见 scripts/genNls.mjs 映射）；其余命令的键按 id 推导：
  // onegayi.vsidian.<suffix> → command.<suffix>.title（既有唯一键
  // command.table.create.title 天然吻合该规则，单轨收编，不留双轨）。
  // 这些 command.* 键同时是 KEYBINDING_OPERATIONS extra/UI 源操作名的
  // titleKey（快捷键页与命令面板同源，无第二套文案）。
  /** 扩展市场 displayName / description（含 customEditors displayName 同源） */
  'manifest.displayName': 'Vsidian',
  'manifest.description': 'Obsidian-like Markdown editing: live preview + reading views',

  'command.toggleViewMode.title': 'Switch to the next view mode',
  'command.mode.toReading.title': 'Switch to reading view',
  'command.mode.toSource.title': 'Switch to the source editor',
  'command.mode.toLive.title': 'Switch to live preview',
  'command.find.title': 'Find (in the editor)',
  'command.find.next.title': 'Next match',
  'command.find.previous.title': 'Previous match',
  'command.table.create.title': 'Create a table',
  'command.table.insertRowAbove.title': 'Table: insert row above',
  'command.table.insertRowBelow.title': 'Table: insert row below',
  'command.table.deleteRow.title': 'Table: delete row',
  'command.table.insertColumnLeft.title': 'Table: insert column left',
  'command.table.insertColumnRight.title': 'Table: insert column right',
  'command.table.deleteColumn.title': 'Table: delete column',
  'command.openSettings.title': 'Open settings',
  'command.ui.sidebarToggle.title': 'Expand or collapse the sidebar',
  'command.ui.outlineToggle.title': 'Show or hide the outline',
  'command.ui.outlineSearch.title': 'Search headings',
  'command.ui.outlineJumpBottom.title': 'Jump to end of note',
  'command.ui.outlineReset.title': 'Reset outline',
  'command.ui.outlineCollapseAll.title': 'Collapse all outline headings',
  'command.ui.outlineExpandAll.title': 'Expand all outline headings',
} as const satisfies Record<string, string>

/** 字典键：点分扁平键，以本包为类型基准（编译期检查 t() 取词键） */
export type MessageKey = keyof typeof en
