# LogFish (VS Code Extension)

Open massive log files in a custom editor with streaming + regex filtering + per-line highlighting.

## Usage

- Run `LogFish: Open Log File` from the Command Palette.
- Or use explorer context menu and `Open in LogFish`.
- Or open a file matching `logFish.fileAssociations` (defaults to `*.log`).

## Filter

Use the filter input at the top of the view. The extension will try `rg` (ripgrep) first, then `grep`,
and only fall back to the built-in JavaScript regex engine if neither command is available.

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

- `logFish.fileAssociations`: Glob patterns to associate with the LogFish custom editor.
- `logFish.highlightRules`: Array of per-line highlight rules or grouped rules with `filePattern` (first matching group wins).
- `logFish.maxDisplayedLines`: Limit for lines kept in the UI (default 1000000).
- `logFish.filterDelayMs`: Debounce time for the filter input.
