import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const LOGFISH_VIEW_TYPE = 'logFish.viewer';
const FILE_ASSOCIATIONS_STATE_KEY = 'logFish.fileAssociations.applied';

type HighlightRule = {
  pattern: string;
  patternIgnoreCase?: boolean;
  color?: string;
  background?: string;
  fontStyle?: string;
  fontWeight?: string;
};

type HighlightRuleResolved = HighlightRule & {
  className: string;
};

type HighlightRuleGroup = {
  filePattern: string;
  filePatternIgnoreCase?: boolean;
  rules: HighlightRule[];
};

type HighlightRuleConfig = Array<HighlightRule | HighlightRuleGroup>;

type LogFishSettings = {
  highlightRules: HighlightRuleConfig;
  maxDisplayedLines: number;
  filterDelayMs: number;
  filterPersistence: FilterPersistence;
};

type EditorAssociations = Record<string, string>;

class LogFishDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose(): void {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

type StreamController = {
  cancel: () => void;
};

type FilterBackend = 'rg' | 'grep' | 'js';
type FilterPersistence = 'workspace' | 'global' | 'workspaceThenGlobal';

class LogFishProvider implements vscode.CustomReadonlyEditorProvider<LogFishDocument> {
  private readonly context: vscode.ExtensionContext;
  private filterBackend?: Promise<FilterBackend>;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new LogFishProvider(context);
    return vscode.window.registerCustomEditorProvider(LOGFISH_VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    });
  }

  async openCustomDocument(uri: vscode.Uri): Promise<LogFishDocument> {
    return new LogFishDocument(uri);
  }

  async resolveCustomEditor(document: LogFishDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };

    webview.html = this.getWebviewHtml(webview, this.context.extensionUri);

    let currentStream: StreamController | null = null;
    let currentFilter = this.readFilterState(document.uri, this.getSettings(document.uri));
    let currentCaseSensitive = false;

    const startStream = async (filterText: string, caseSensitive: boolean) => {
      if (currentStream) {
        currentStream.cancel();
        currentStream = null;
      }

      const settings = this.getSettings(document.uri);
      const backend = await this.getFilterBackend();
      const trimmedFilter = filterText.trim();
      const isEmptyFilter = trimmedFilter.length === 0;

      const useJs = backend === 'js' || isEmptyFilter;
      if (useJs) {
        const filterRegex = isEmptyFilter ? null : this.compileFilter(filterText, caseSensitive);
        if (filterRegex === null && !isEmptyFilter) {
          webview.postMessage({ type: 'error', message: 'Invalid filter regex.' });
          webview.postMessage({ type: 'reset' });
          return;
        }

        webview.postMessage({ type: 'reset' });

        currentStream = this.streamFileJs(
          document.uri,
          filterRegex,
          settings.maxDisplayedLines,
          (lines) => webview.postMessage({ type: 'append', lines }),
          (stats) => webview.postMessage({ type: 'end', stats }),
          {
            batchSize: isEmptyFilter ? 1000 : 200,
            highWaterMark: isEmptyFilter ? 256 * 1024 : 64 * 1024,
            stopAfterMax: isEmptyFilter
          }
        );
        return;
      }

      webview.postMessage({ type: 'reset' });

      const externalPattern = isEmptyFilter ? '^' : filterText;

      currentStream = this.streamFileExternal(
        document.uri,
        externalPattern,
        backend,
        caseSensitive,
        settings.maxDisplayedLines,
        (lines) => webview.postMessage({ type: 'append', lines }),
        (stats) => webview.postMessage({ type: 'end', stats }),
        (message) => webview.postMessage({ type: 'error', message })
      );
    };

    webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready': {
          const settings = this.getSettings(document.uri);
          const rules = await this.loadHighlightRules(document.uri, settings.highlightRules);
          const resolved = this.buildRuleStyles(rules);
          webview.postMessage({
            type: 'init',
            fileName: path.basename(document.uri.fsPath),
            rules: resolved.rules,
            cssText: resolved.cssText,
            debounceMs: settings.filterDelayMs,
            filterText: currentFilter,
            caseSensitive: currentCaseSensitive
          });
          await startStream(currentFilter, currentCaseSensitive);
          break;
        }
        case 'filterChanged': {
          currentFilter = String(message.value ?? '');
          if (typeof message.caseSensitive === 'boolean') {
            currentCaseSensitive = message.caseSensitive;
          }
          const settings = this.getSettings(document.uri);
          this.persistFilterState(document.uri, settings, currentFilter);
          await startStream(currentFilter, currentCaseSensitive);
          break;
        }
        case 'requestRules': {
          const settings = this.getSettings(document.uri);
          const rules = await this.loadHighlightRules(document.uri, settings.highlightRules);
          const resolved = this.buildRuleStyles(rules);
          webview.postMessage({ type: 'rulesUpdated', rules: resolved.rules, cssText: resolved.cssText });
          break;
        }
        default:
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      if (currentStream) {
        currentStream.cancel();
        currentStream = null;
      }
    });
  }

  private getSettings(uri: vscode.Uri): LogFishSettings {
    const config = vscode.workspace.getConfiguration('logFish', uri);
    return {
      highlightRules: config.get<HighlightRuleConfig>('highlightRules', []),
      maxDisplayedLines: config.get<number>('maxDisplayedLines', 1000000),
      filterDelayMs: config.get<number>('filterDelayMs', 250),
      filterPersistence: config.get<FilterPersistence>('filterPersistence', 'workspaceThenGlobal')
    };
  }

  private getFilterStateKey(uri: vscode.Uri): string {
    return 'logFish.filter';
  }

  private readFilterState(uri: vscode.Uri, settings: LogFishSettings): string {
    const key = this.getFilterStateKey(uri);
    switch (settings.filterPersistence) {
      case 'workspace':
        return this.context.workspaceState.get<string>(key, '');
      case 'global':
        return this.context.globalState.get<string>(key, '');
      case 'workspaceThenGlobal':
      default:
        return this.context.workspaceState.get<string>(key) ?? this.context.globalState.get<string>(key) ?? '';
    }
  }

  private persistFilterState(uri: vscode.Uri, settings: LogFishSettings, value: string): void {
    const key = this.getFilterStateKey(uri);
    switch (settings.filterPersistence) {
      case 'workspace':
        void this.context.workspaceState.update(key, value);
        break;
      case 'global':
        void this.context.globalState.update(key, value);
        break;
      case 'workspaceThenGlobal':
      default:
        void this.context.workspaceState.update(key, value);
        void this.context.globalState.update(key, value);
        break;
    }
  }

  private async loadHighlightRules(uri: vscode.Uri, fallback: HighlightRuleConfig): Promise<HighlightRule[]> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    let configRules: HighlightRuleConfig = fallback;

    if (folder) {
      const primaryRuleFile = vscode.Uri.joinPath(folder.uri, '.vscode', 'logfish.rules.json');
      const legacyRuleFile = vscode.Uri.joinPath(folder.uri, '.vscode', 'logreader.rules.json');
      const fromPrimary = await this.readRuleFile(primaryRuleFile);
      const fromLegacy = fromPrimary ? null : await this.readRuleFile(legacyRuleFile);
      const resolved = fromPrimary ?? fromLegacy;
      if (resolved) {
        configRules = resolved;
      }
    }

    return this.resolveHighlightRulesForFile(uri, configRules);
  }

  private async readRuleFile(uri: vscode.Uri): Promise<HighlightRuleConfig | null> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(data).toString('utf8');
      const parsed = JSON.parse(text) as HighlightRuleConfig | { rules: HighlightRuleConfig };
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && Array.isArray(parsed.rules)) {
        return parsed.rules;
      }
    } catch {
      return null;
    }
    return null;
  }

  private resolveHighlightRulesForFile(uri: vscode.Uri, configRules: HighlightRuleConfig): HighlightRule[] {
    const filePath = uri.fsPath;
    const resolved: HighlightRule[] = [];
    let foundGroup = false;
    for (const entry of configRules) {
      if (!foundGroup && this.isHighlightRuleGroup(entry)) {
        if (this.matchesFilePattern(filePath, entry.filePattern, entry.filePatternIgnoreCase)) {
          resolved.push(...entry.rules.filter((rule) => this.isHighlightRule(rule)));
          foundGroup = true;
        }
      } else if (this.isHighlightRule(entry)) {
        resolved.push(entry);
      }
    }
    return resolved;
  }

  private buildRuleStyles(rules: HighlightRule[]): { rules: HighlightRuleResolved[]; cssText: string } {
    const resolved: HighlightRuleResolved[] = [];
    const cssLines: string[] = [];
    let classCounter = 1;

    for (const rule of rules) {
      const className = `r${classCounter}`;
      classCounter += 1;

      const styleParts: string[] = [];
      if (rule.color) {
        styleParts.push(`color:${rule.color}`);
      }
      if (rule.background) {
        styleParts.push(`background:${rule.background}`);
      }
      if (rule.fontStyle) {
        styleParts.push(`font-style:${rule.fontStyle}`);
      }
      if (rule.fontWeight) {
        styleParts.push(`font-weight:${rule.fontWeight}`);
      }

      if (styleParts.length > 0) {
        cssLines.push(`.${className} { ${styleParts.join('; ')} }`);
      }

      resolved.push({ ...rule, className });
    }

    return { rules: resolved, cssText: cssLines.join('\n') };
  }

  private isHighlightRuleGroup(value: unknown): value is HighlightRuleGroup {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as HighlightRuleGroup;
    return typeof candidate.filePattern === 'string' && Array.isArray(candidate.rules);
  }

  private isHighlightRule(value: unknown): value is HighlightRule {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as HighlightRule;
    return typeof candidate.pattern === 'string';
  }

  private matchesFilePattern(filePath: string, pattern: string, patternIgnoreCase?: boolean): boolean {
    const flags = patternIgnoreCase ? 'ig' : 'g';
    try {
      const regex = new RegExp(pattern, flags);
      return regex.test(filePath);
    } catch {
      return false;
    }
  }

  private compileFilter(filterText: string, caseSensitive: boolean): RegExp | null {
    if (filterText.trim().length === 0) {
      return null;
    }

    try {
      if (caseSensitive) {
        return new RegExp(filterText);
      }
      return new RegExp(filterText, 'i');
    } catch {
      return null;
    }
  }

  private getFilterBackend(): Promise<FilterBackend> {
    if (!this.filterBackend) {
      this.filterBackend = this.detectFilterBackend();
    }
    return this.filterBackend;
  }

  private async detectFilterBackend(): Promise<FilterBackend> {
    if (await this.isCommandAvailable('rg', ['--version'])) {
      return 'rg';
    }
    if (await this.isCommandAvailable('grep', ['--version'])) {
      return 'grep';
    }
    return 'js';
  }

  private isCommandAvailable(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', () => resolve(true));
    });
  }

  private streamFileExternal(
    uri: vscode.Uri,
    filterText: string,
    backend: Exclude<FilterBackend, 'js'>,
    caseSensitive: boolean,
    maxDisplayedLines: number,
    onLines: (lines: { n: number; t: string }[]) => void,
    onEnd: (stats: { totalLines: number | null; matchedLines: number; truncated: boolean }) => void,
    onError: (message: string) => void
  ): StreamController {
    const caseFlag = caseSensitive ? [] : ['-i'];
    let args: string[];
    if (backend === 'rg') {
      args = [...caseFlag, '--no-messages', '--line-number', '--no-filename', '--color', 'never', '--text', '-e', filterText, uri.fsPath];
    } else {
      args = [...caseFlag, '-n', '-E', '-a', '--color=never', '-e', filterText, uri.fsPath];
    }
    const proc = spawn(backend, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let cancelled = false;
    let buffer = '';
    let matchedLines = 0;
    let truncated = false;
    let batch: { n: number; t: string }[] = [];
    let stderr = '';

    const flush = () => {
      if (batch.length > 0) {
        onLines(batch);
        batch = [];
      }
    };

    const pushLine = (line: string) => {
      if (!line) {
        return;
      }
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        return;
      }
      const lineNumberText = line.slice(0, colonIndex);
      const lineNumber = Number.parseInt(lineNumberText, 10);
      if (!Number.isFinite(lineNumber)) {
        return;
      }
      const content = line.slice(colonIndex + 1);

      matchedLines += 1;
      if (matchedLines <= maxDisplayedLines) {
        batch.push({ n: lineNumber, t: content });
        if (batch.length >= 200) {
          flush();
        }
      } else {
        truncated = true;
      }
    };

    proc.stdout.on('data', (chunk: string | Buffer) => {
      if (cancelled) {
        return;
      }
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const data = buffer + text;
      const parts = data.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (cancelled) {
          return;
        }
        pushLine(line);
      }
    });

    proc.stderr.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stderr.length < 2000) {
        stderr += text;
      }
    });

    const finish = (exitCode: number | null) => {
      if (cancelled) {
        return;
      }
      if (buffer.length > 0) {
        pushLine(buffer);
      }
      flush();

      const isError = exitCode !== null && exitCode >= 2;
      if (isError) {
        const message = stderr.trim() || 'Filter process failed.';
        onError(message);
      }
      onEnd({ totalLines: null, matchedLines, truncated });
    };

    proc.on('error', () => {
      if (cancelled) {
        return;
      }
      flush();
      onError(`Failed to run ${backend}.`);
      onEnd({ totalLines: null, matchedLines, truncated });
    });

    proc.on('close', finish);

    return {
      cancel: () => {
        cancelled = true;
        proc.kill();
      }
    };
  }

  private streamFileJs(
    uri: vscode.Uri,
    filterRegex: RegExp | null,
    maxDisplayedLines: number,
    onLines: (lines: { n: number; t: string }[]) => void,
    onEnd: (stats: { totalLines: number | null; matchedLines: number; truncated: boolean }) => void,
    options?: { batchSize?: number; highWaterMark?: number; stopAfterMax?: boolean }
  ): StreamController {
    const batchSize = options?.batchSize ?? 200;
    const highWaterMark = options?.highWaterMark ?? 64 * 1024;
    const stream = fs.createReadStream(uri.fsPath, {
      encoding: 'utf8',
      highWaterMark
    });

    let cancelled = false;
    let buffer = '';
    let lineNumber = 0;
    let matchedLines = 0;
    let truncated = false;
    let batch: { n: number; t: string }[] = [];
    let finished = false;

    const flush = () => {
      if (batch.length > 0) {
        onLines(batch);
        batch = [];
      }
    };

    const pushLine = (line: string) => {
      lineNumber += 1;
      if (filterRegex) {
        filterRegex.lastIndex = 0;
      }
      const matches = filterRegex ? filterRegex.test(line) : true;
      if (!matches) {
        return;
      }
      matchedLines += 1;
      if (matchedLines <= maxDisplayedLines) {
        batch.push({ n: lineNumber, t: line });
        if (batch.length >= batchSize) {
          flush();
        }
      } else {
        truncated = true;
        if (options?.stopAfterMax) {
          matchedLines = maxDisplayedLines;
          cancelled = true;
          stream.destroy();
        }
      }
    };

    const finish = (totalLines: number | null) => {
      if (finished) {
        return;
      }
      finished = true;
      onEnd({ totalLines, matchedLines, truncated });
    };

    stream.on('data', (chunk: string | Buffer) => {
      if (cancelled) {
        return;
      }

      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const data = buffer + text;
      const parts = data.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (cancelled) {
          return;
        }
        pushLine(line);
        if (cancelled) {
          flush();
          finish(null);
          return;
        }
      }
    });

    stream.on('end', () => {
      if (cancelled) {
        return;
      }
      if (buffer.length > 0) {
        pushLine(buffer);
      }
      flush();
      finish(lineNumber);
    });

    stream.on('error', () => {
      if (cancelled) {
        return;
      }
      flush();
      finish(lineNumber);
    });

    return {
      cancel: () => {
        cancelled = true;
        stream.destroy();
      }
    };
  }

  private getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logView.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logView.css'));

    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <style nonce="${nonce}" id="dynamicStyles"></style>
  <style nonce="${nonce}" id="layoutStyles"></style>
  <title>LogFish</title>
</head>
<body>
  <div class="toolbar">
    <input id="filterInput" type="text" placeholder="Filter (regex)" />
    <button id="case" class="case" type="button" aria-pressed="false" title="Match case">Aa</button>
    <div id="status" class="status">Ready</div>
  </div>
  <div id="viewport" class="viewport">
    <div id="lnRows" class="ln-rows">
      <div id="lnRowsInner" class="ln-rows-inner"></div>
    </div>
    <div id="hscroll" class="hscroll">
      <div id="rows" class="rows"></div>
    </div>
    <div id="scrollbar" class="scrollbar">
      <div id="scrollbarThumb" class="scrollbar-thumb"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i += 1) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}

const normalizeFileAssociations = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
};

const getAssociationTarget = (): vscode.ConfigurationTarget => {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
};

const syncFileAssociations = async (context: vscode.ExtensionContext): Promise<void> => {
  const logFishConfig = vscode.workspace.getConfiguration('logFish');
  const desired = normalizeFileAssociations(logFishConfig.get('fileAssociations', ['*.log']));
  const previous = context.workspaceState.get<string[]>(FILE_ASSOCIATIONS_STATE_KEY, []);
  const workbenchConfig = vscode.workspace.getConfiguration('workbench');
  const current = workbenchConfig.get<EditorAssociations>('editorAssociations', {});
  const next: EditorAssociations = { ...current };
  let modified = false;

  for (const pattern of previous) {
    if (!desired.includes(pattern) && next[pattern] === LOGFISH_VIEW_TYPE) {
      delete next[pattern];
      modified = true;
    }
  }

  for (const pattern of desired) {
    if (next[pattern] !== LOGFISH_VIEW_TYPE) {
      next[pattern] = LOGFISH_VIEW_TYPE;
      modified = true;
    }
  }

  if (modified) {
    try {
      await workbenchConfig.update('editorAssociations', next, getAssociationTarget());
    } catch (error) {
      console.warn('Failed to update editorAssociations for LogFish.', error);
    }
  }

  await context.workspaceState.update(FILE_ASSOCIATIONS_STATE_KEY, desired);
};

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(LogFishProvider.register(context));
  void syncFileAssociations(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('logFish.fileAssociations')) {
        void syncFileAssociations(context);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('logFish.openLog', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open Log File'
      });
      if (!picked || picked.length === 0) {
        return;
      }

      await vscode.commands.executeCommand('vscode.openWith', picked[0], LOGFISH_VIEW_TYPE);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('logFish.openInViewer', async (uri: vscode.Uri | vscode.Uri[] | undefined) => {
      if (!uri) {
        return;
      }
      const targets = Array.isArray(uri) ? uri : [uri];
      for (const target of targets) {
        await vscode.commands.executeCommand('vscode.openWith', target, LOGFISH_VIEW_TYPE);
      }
    })
  );
}

export function deactivate(): void {
  // Nothing to cleanup.
}
