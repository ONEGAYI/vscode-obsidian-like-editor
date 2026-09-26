# Vsidian

English | **[中文](https://github.com/ONEGAYI/vsidian/blob/main/README.md)**

An Obsidian-like Markdown editing experience in VS Code: a source-text-based editor with **live preview + reading** dual views.

## Features

- **Dual-view editor**: the live preview is backed by a full-document CodeMirror 6 instance (no DOM outside the viewport); reading mode renders markdown-it blocks mounted on demand — performance stays flat on 100k-line / 100k-block documents.
- **Three-state cycling**: the title-bar button cycles **Live preview → Reading → Source editor**; the last-used mode is remembered globally across windows, and source positions are preserved when switching. `.md` / `.markdown` files open with Vsidian by default — right-click "Open With…" to revert to the native editor at any time.
- **Right sidebar & outline**: the toolbar gear button opens the settings page; a toolbar toggle expands and collapses the right sidebar (thin/thick line icons, state remembered across panels). The **Outline** panel stays in sync with every heading (ATX/Setext semantics, pseudo-headings inside code fences or frontmatter excluded); click an entry to jump to it in either view, with a persistent highlight marking the section you are reading; a six-notch "knot-string" slider sets the expansion depth, per-entry chevrons collapse manually, and scrolling auto-expands the current path; the toolbar offers jump-to-end, reset, and heading search with hit-fragment highlighting; inline heading styles (bold, italic, inline code, strikethrough) and theme heading colors carry over; the context menu provides structural commands, five copy actions, level adjustment, rename (inline markup preserved), and whole-section delete; drag entries to reorder whole sections — nothing outside the moved section is touched, and one undo rolls it all back.
- **Table editing**: well-formed tables render as a grid; click a cell to edit, drag across cells for a rectangular selection, and copy it as a standalone Markdown table. Hover near an edge to add rows or columns; click a dotted handle to select a row or column, or drag it to reorder. Tab / Shift+Tab navigate between cells, and typing `|` inside a cell is escaped automatically; six row/column commands plus a bilingual "Create a Table" command live in the Command Palette.
- **Formatting commands**: in live preview, use the Command Palette to toggle bold, italic, strikethrough, inline code, headings, lists, quotes, code blocks, and links, clear inline styling, or insert math and wikilinks. An explicit selection takes priority; without one, inline formatting targets the current word. Each action is one undo step.
- **Quick actions**: the pen button in the editor toolbar expands an in-flow formatting bar. Common formats, a heading-level menu, math insertion, and table creation act on the original selection; the expanded state is remembered. Formatting writes are unavailable in reading mode.
- **Keybinding management**: the "Keybindings" page in the settings centralizes every bindable action (formatting, tables, find, view cycling, outline, etc.); record new bindings (chords supported), remove them one by one, clear all, or reset one/all to defaults — cleared bindings stay cleared across restarts and upgrades. Internal conflicts are detected by identical keys over overlapping scopes; write shortcuts only intercept keys while the live editor body has focus, leaving source mode and settings inputs untouched.
- **Bilingual interface (English / 简体中文)**: the editor, settings page, notifications, and command titles all resolve through locale packs; the "General → Interface language" setting offers Auto / 简体中文 / English, defaults to following VS Code's display language, and applies immediately.
- **Links, images & wikilinks**: links and `[[wikilinks]]` reveal their source as the cursor enters, and open with a single click; wikilinks support `[[note]]`, `[[path/note]]`, `[[note|alias]]`, and `[[note#heading]]`; ambiguous names open a candidate picker, missing targets show a hint instead of silently creating files; local images load through a host channel, and dangerous schemes such as `file://` and `javascript:` are blocked.
- **Math rendering**: inline `$…$` and block `$$…$$` LaTeX formulas render in live preview and reading mode (KaTeX bundled locally, no CDN); the cursor entering a formula reveals its source for direct editing, parse failures fall back to readable raw text, and plain dollar amounts, escapes, and code spans are never misread as math.
- **Mermaid diagrams**: fenced code blocks tagged `mermaid` render as diagrams in live preview and reading mode (flowcharts, sequence diagrams, etc.; mermaid bundled locally and lazy-loaded, no CDN); the cursor entering a fence reveals its source for direct editing, syntax errors fall back to an error note with readable source that never swallows the rest of the document; light/dark themes are followed automatically, and links inside diagrams never navigate.
- **Code block cards**: fenced code blocks collapse into cards once the cursor leaves — a language header band (colored badge + display name), in-card line numbers, a hover copy button (written with the document's line-ending style, so CRLF documents get CRLF), and a collapse chevron; a built-in highlight engine covers 17 languages (plus plain text, with aliases, dark/light VSCode-style palettes, and plain-text fallback for unrecognized languages), looking identical across live preview and reading; rendered fences such as mermaid show the same card shell and line numbers in the editing state.
- **Task toggling**: click a checkbox in either view to write back to the source text, with undo support.
- **Find**: Ctrl+F / Cmd+F inside the editor (when the Vsidian editor is active).
- **Standalone settings page**: settings live in the extension's own settings page (not the VSCode Settings UI) — category navigation and global name/description search help locate settings, with light/dark themes, narrow layouts and keyboard access. Settings are saved per user, restored on reopen and applied immediately; failed saves restore the active value with feedback.
- **Input & sync safety**: IME composition (e.g. Chinese input) is buffered so half-typed candidates never hit the file; when an external change cannot be synced safely, a conflict banner appears and local input is never lost.

## Installation

**Option 1: Extension Marketplace** (recommended)

1. In VS Code (1.86+), search for **Vsidian** in the Extensions view, or open the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=onegayi.vsidian).
2. Install and reload; open any `.md` file to enter the live preview.

**Option 2: Manual VSIX**

Download the latest `vsidian-*.vsix` from [GitHub Releases](https://github.com/ONEGAYI/vsidian/releases), then Command Palette → "Extensions: Install from VSIX…", pick the file and reload. For Remote SSH, install the same VSIX in the remote extension host (compatibility per [ADR-0001](docs/adr/0001-vscode-186-remote-support.md)).

## Quick reference

| Action | Entry point |
| --- | --- |
| Cycle views | Title-bar button, or Command Palette "Vsidian: Switch to the next view mode" |
| Back to source editor | Title-bar pencil button, or "Vsidian: Switch to the source editor" |
| Create a table | Command Palette "Vsidian: Create a Table" (localized) |
| Format text | Vsidian formatting commands in the Command Palette; Ctrl+B toggles bold, Ctrl+1–6 sets heading levels, and Ctrl+0 removes a heading (live editor only) |
| Quick actions | Click the pen button in the editor toolbar, choose a format or H1–H6/paragraph from the H⌄ menu, then click the pen button again to collapse |
| Keybindings | Settings "Keybindings" page: search actions, record new keys, clear or reset to defaults |
| Add table rows & columns | Hover near the bottom/right edge to reveal an add strip, or use the "Table: …" commands |
| Select and copy table cells | Drag across cells to select a rectangle; Ctrl+C / Cmd+C copies a complete Markdown table using the selection's first row as its header |
| Delete table content | Delete / Backspace clears a partial region, removes fully selected rows/columns, or deletes a fully selected table; Backspace at the start of an empty row's first cell removes that row |
| Reorder table rows & columns | Hover over the left/top edge for dotted handles; click to select or drag to the insertion line to move; the top row becomes the header |
| Find | Ctrl+F / Cmd+F |
| Right sidebar / outline | Toolbar toggle on the right; once open, click "Outline" |
| Outline interactions | Click an entry to jump; drag the slider for expansion depth; chevrons collapse; toolbar search & jump-to-end; right-click for the menu (copy / levels / rename / delete); drag entries to reorder sections |
| Code block cards | Fences collapse into cards once the cursor leaves; hover the header to copy the whole block; click the chevron to collapse, cursor enters to expand |
| Settings | "Vsidian: Open settings", or the toolbar gear button |

Current settings: **interface language** (Auto by default) — follows VS Code's display language, or pin to 简体中文 / English; changes apply immediately. **Show line numbers** (on by default) — the live preview gutter shows source-file line numbers, and table segments show the first row's number; reading mode never shows line numbers. **Code block cards / in-card line numbers / copy button / syntax highlighting** (on by default) — the card appearance plus three sub-toggles; highlighting is independent of the card (plain fences stay colored with the card off).

## Known limitations

- No support for Obsidian Canvas, whiteboards, the Obsidian plugin ecosystem, or note formats other than Markdown.
- The CSP allows `img-src https:` — any https image source is reachable (a design trade-off for remote image hosting; in theory usable as a tracking pixel).
- Tables with inconsistent column counts show as editable source instead of a grid.
- Code block cards: fences longer than 4096 lines skip syntax coloring (falling back to a plain-text card); language badges are glyph badges, not vector logos.

Please report issues at [Issues](https://github.com/ONEGAYI/vsidian/issues); see [CHANGELOG](CHANGELOG.md) for version history.

## Development

```bash
npm install                     # install pinned dependencies (all exact versions)
npm run compile                 # esbuild bundles + tsc type check
npm run test:unit               # vitest & launcher contract tests (no VSCode host)
npm run test:browser            # Playwright native-keyboard/IME table caret regression
npm run test:integration        # real 1.86.2 host integration tests
npm run release:check           # package + pre-release VSIX content & size inspection
npm run release                 # the above + create a GitHub Release with the VSIX
```

See the Chinese [README](https://github.com/ONEGAYI/vsidian/blob/main/README.md) for Windows-specific test-host details (dedicated desktop, job objects), performance measurement, and the release pipeline conventions in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
