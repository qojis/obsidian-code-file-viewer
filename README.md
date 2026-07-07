# Code File Viewer

An Obsidian plugin that opens source-code and plain-text files (`.py`, `.ts`, `.sh`, `.sql`, `.yml`, `.rs`, `.go`, …) directly inside Obsidian in a **read-only view with syntax highlighting**.

Highlighting is done with **Obsidian's own bundled Prism** (the same engine that highlights ```` ```lang ```` code blocks in reading view), fetched at runtime via the official `loadPrism()` API. That means:

- No bundled highlighter → the plugin is a few KB and loads instantly.
- No conflicts with Obsidian's reading-view highlighting.
- Any language id that works in a fenced code block works here.
- Colors come from your theme's `--code-*` CSS variables, so the view matches every light/dark theme automatically.

## Features

- Registers configurable file extensions so they appear in the File Explorer, open in tabs, and can be linked like any other file.
- Read-only rendering — file contents are **never executed or modified**.
- Line-number gutter (toggleable), sticky during horizontal scroll.
- Toolbar with the detected language and a **Copy** button.
- Fully configurable `extension → language` mappings in settings, applied live.
- Large-file guard: files over ~1 MB render as plain text instead of freezing the UI.

## Installation (manual)

1. Create the folder `<your-vault>/.obsidian/plugins/code-file-viewer/`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into it.
3. In Obsidian: **Settings → Community plugins** → disable Restricted mode if needed → enable **Code File Viewer**.

## Configuration

**Settings → Code File Viewer**

- **Line numbers** — toggle the gutter.
- **Extension → language mappings** — one per line, `extension: language`. Language ids are Prism ids (`python`, `typescript`, `bash`, `markup`, …). Use `plain` to open a file type with no highlighting. Lines starting with `#` are comments.
- **Restore default mappings** — resets the list.

Notes:

- Extensions Obsidian already owns (`md`, `canvas`, `pdf`, images, audio, video) are ignored.
- If another plugin already claims an extension, that one mapping is skipped and a warning is logged to the developer console — the rest still work.
- Removing an extension mid-session uses a non-public API to unregister; if it doesn't take effect, toggle the plugin off/on.
- Once an extension is registered, matching files become visible in the File Explorer and are indexed — in a vault that contains a large code repo, that can be a lot of files.

## Development

```bash
# in <vault>/.obsidian/plugins/code-file-viewer/  (or symlink the repo there)
npm install
npm run dev      # watch mode; press Ctrl/Cmd+R in Obsidian to reload
npm run build    # type-check + production bundle → main.js
```

Project layout:

| File | Purpose |
| --- | --- |
| `main.ts` | Plugin, view, settings — all source |
| `styles.css` | Layout + Prism-token → Obsidian-theme-variable colors |
| `manifest.json` | Plugin metadata Obsidian reads |
| `esbuild.config.mjs` | Bundler config (`obsidian` kept external) |
| `versions.json` | Version → min-app-version map for releases |

### How it works (for hacking on it)

1. `onload()` registers a custom view type and calls `registerExtensions()` for every configured extension.
2. The view extends `TextFileView`; Obsidian hands it the file's text via `setViewData()`.
3. `render()` awaits `loadPrism()`, looks up the grammar for the mapped language, runs `Prism.tokenize()`, and converts the token stream **directly into DOM nodes** (no `innerHTML`, per Obsidian plugin guidelines).
4. Unknown grammar or oversized file → plain-text fallback with a note in the toolbar.

### Ideas for next steps

- Word-wrap toggle (needs per-line rendering to keep the gutter aligned).
- "Open in default app" toolbar action (`this.app.openWithDefaultApp(path)`).
- Editing support — swap the `<pre>` for a CodeMirror 6 `EditorView` (already shipped inside Obsidian).
