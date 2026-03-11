# LogFish (VS Code Extension)

Open massive log files in a custom editor with streaming, regex filtering, and per-line highlighting.

## Usage

- Run `LogFish: Open Log File` from the Command Palette.
- Or right-click a file in the Explorer and choose `Open in LogFish`.
- `*.log` files open in LogFish automatically (configurable via `workbench.editorAssociations`).

## Filtering

Two filter inputs appear at the top of the view:

- **Include filter** — only lines matching this regex are shown.
- **Exclude filter** — lines matching this regex are hidden (applied after the include filter).

Both filters accept regular expressions. The **Aa** button next to each input toggles case-sensitive matching for that filter. Leaving an input empty means no filtering is applied for that direction.

The extension tries `rg` (ripgrep) first, then `grep`, and falls back to the built-in JavaScript regex engine if neither is available.

### Saved Filters

Click the **▼** button on either filter input to open a dropdown of saved filters for that input. Selecting a saved filter applies it immediately. Filters can be saved and deleted from the same dropdown. Saved filters persist according to the `logFish.filterPersistence` setting.

## Search

Press **Ctrl+F** (or **Cmd+F** on macOS) to open the in-viewer search box. This searches within the currently filtered lines.

- **Enter** — next match.
- **Shift+Enter** — previous match.
- **Escape** — close search.

## Navigation

| Key | Action |
|-----|--------|
| **Ctrl+G** / **Cmd+G** | Go to line — prompts for a line number and jumps to the closest visible (unfiltered) line |
| **↑ / ↓** | Scroll one line |
| **Page Up / Page Down** | Scroll one page |
| **Home / End** | Jump to the start or end of the file |
| Mouse wheel | Scroll vertically; **Shift+wheel** scrolls horizontally |

## Highlight Rules

Highlight rules can come from either:

1. VS Code settings: `logFish.highlightRules`
2. Workspace override file: `.vscode/logfish.rules.json`

The `.vscode/logfish.rules.json` file can be either an array or an object with a `rules` key.
Rules can be plain per-line rules or grouped by file path regex. Standalone rules are global and
always apply. Grouped rules use the first matching `filePattern` only, so order matters.

Rule fields:
- `pattern`: Regex applied to each line.
- `patternIgnoreCase`: Optional boolean to ignore case for `pattern`.
- `color`: Optional text color (CSS value).
- `background`: Optional background color (CSS value).
- `fontStyle`: Optional font style (e.g. `"italic"`).
- `fontWeight`: Optional font weight (e.g. `"bold"`).

Group fields:
- `filePattern`: Regex applied to the full file path.
- `filePatternIgnoreCase`: Optional boolean to ignore case for `filePattern`.
- `rules`: Array of per-line rules.

```json
[
  {
    "pattern": "ERROR",
    "patternIgnoreCase": true,
    "color": "#fff",
    "background": "#c62828",
    "fontWeight": "bold"
  }
]
```

Grouped rules example:

```json
[
  {
    "filePattern": "/var/log/nginx/.*\\.log$",
    "filePatternIgnoreCase": true,
    "rules": [
      { "pattern": "404", "color": "#ffffff", "background": "#ef6c00" }
    ]
  },
  {
    "filePattern": "/var/log/app/.*\\.log$",
    "rules": [
      { "pattern": "ERROR", "color": "#ffffff", "background": "#c62828", "fontWeight": "bold" }
    ]
  }
]
```

## Settings

- `logFish.highlightRules`: Array of per-line highlight rules or grouped rules with `filePattern` (first matching group wins).
- `logFish.maxCachedLines`: Maximum number of matched lines cached in the UI while scrolling (default: `20000`).
- `logFish.filterDelayMs`: Debounce delay in ms before a changed filter triggers a re-read of the file (default: `250`).
- `logFish.filterPersistence`: Where to remember the last filter value. Options:
  - `"workspaceThenGlobal"` *(default)* — saves to both; workspace value takes priority on load.
  - `"workspace"` — saves per workspace only.
  - `"global"` — saves globally across all workspaces.
