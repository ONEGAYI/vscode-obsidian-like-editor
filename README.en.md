# Vsidian

English | **[中文](https://github.com/ONEGAYI/vsidian/blob/main/README.md)**

An Obsidian-like Markdown editing experience in VS Code: a source-text-based editor with **live preview + reading** dual views.

## Features

- **Dual-view editor**: the live preview is backed by a full-document CodeMirror 6 instance (no DOM outside the viewport); reading mode renders markdown-it blocks mounted on demand — performance stays flat on 100k-line / 100k-block documents.
- **Three-state cycling**: the title-bar button cycles **Live preview → Reading → Source editor**; the last-used mode is remembered globally across windows, and source positions are preserved when switching. `.md` / `.markdown` files open with Vsidian by default — right-click "Open With…" to revert to the native editor at any time.
- **Table editing**: well-formed tables render as a grid; click a cell to edit in place with the grid preserved; add/remove rows and columns from hover controls; drag to reorder rows via the dotted handle; Tab / Shift+Tab navigate between cells; six row/column commands plus a bilingual "Create a Table" command in the Command Palette; typing `|` inside a cell is escaped automatically.
- **Links, images & wikilinks**: links and `[[wikilinks]]` reveal their source as the cursor enters, and open with a single click; wikilinks support `[[note]]`, `[[path/note]]`, `[[note|alias]]`, and `[[note#heading]]`; ambiguous names open a candidate picker, missing targets show a hint instead of silently creating files; local images load through a host channel, and dangerous schemes such as `file://` and `javascript:` are blocked.
- **Math rendering**: inline `$…$` and block `$$…$$` LaTeX formulas render in live preview and reading mode (KaTeX bundled locally, no CDN); the cursor entering a formula reveals its source for direct editing, parse failures fall back to readable raw text, and plain dollar amounts, escapes, and code spans are never misread as math.
- **Mermaid diagrams**: fenced code blocks tagged `mermaid` render as diagrams in live preview and reading mode (flowcharts, sequence diagrams, etc.; mermaid bundled locally and lazy-loaded, no CDN); the cursor entering a fence reveals its source for direct editing, syntax errors fall back to an error note with readable source that never swallows the rest of the document; light/dark themes are followed automatically, and links inside diagrams never navigate.
- **Task toggling**: click a checkbox in either view to write back to the source text, with undo support.
- **Find**: Ctrl+F / Cmd+F inside the editor (when the Vsidian editor is active).
- **Standalone settings page**: settings live in the extension's own settings page (not the VSCode Settings UI) — saved per user, restored on reopen, applied to open editors immediately.
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
| Cycle views | Title-bar button, or Command Palette "Vsidian: 切换到下一视图模式" |
| Back to source editor | Title-bar pencil button, or "Vsidian: 切换到源码编辑器" |
| Create a table | Command Palette "Vsidian: Create a Table" (localized) |
| Add/remove table rows & columns | Cell hover controls, or the six "表格：…" commands |
| Find | Ctrl+F / Cmd+F |
| Settings | "Vsidian: 打开设置", or the toolbar settings button |

Current settings: **show line numbers** (on by default) — the live preview gutter shows source-file line numbers, and table segments show the first row's number; reading mode never shows line numbers.

## Known limitations

- No support for Obsidian Canvas, whiteboards, the Obsidian plugin ecosystem, or note formats other than Markdown.
- The CSP allows `img-src https:` — any https image source is reachable (a design trade-off for remote image hosting; in theory usable as a tracking pixel).
- Tables with inconsistent column counts show as editable source instead of a grid.

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
