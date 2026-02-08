# LogFish (VS Code Extension)

Open massive log files in a custom editor with streaming + regex filtering + per-line highlighting.

## Usage

- Run `LogFish: Open Log File` from the Command Palette.
- Or open a file matching `logFish.fileAssociations` (defaults to `*.log`).

## Filter

Use the filter input at the top of the view. The extension will try `rg` (ripgrep) first, then `grep`,
and only fall back to the built-in JavaScript regex engine if neither command is available.

## Highlight Rules

Highlight rules can come from either:

1. VS Code settings: `logFish.highlightRules`
2. Workspace override file: `.vscode/logfish.rules.json`

The `.vscode/logfish.rules.json` file can be either an array or an object with a `rules` key.
Rules can be plain per-line rules or grouped by file path regex.

```json
[
  { "pattern": "\\bERROR\\b", "color": "#fff", "background": "#c62828", "fontWeight": "bold" }
]
```

Grouped rules example:

```json
[
  {
    "filePattern": "/var/log/nginx/.*\\.log$",
    "rules": [
      { "pattern": "\\b404\\b", "color": "#ffffff", "background": "#ef6c00" }
    ]
  },
  {
    "filePattern": "/var/log/app/.*\\.log$",
    "rules": [
      { "pattern": "\\bERROR\\b", "color": "#ffffff", "background": "#c62828", "fontWeight": "bold" }
    ]
  }
]
```

## Settings

- `logFish.fileAssociations`: Glob patterns to associate with the LogFish custom editor.
- `logFish.highlightRules`: Array of per-line highlight rules or grouped rules with `filePattern`.
- `logFish.maxDisplayedLines`: Limit for lines kept in the UI (default 200000).
- `logFish.filterDelayMs`: Debounce time for the filter input.
