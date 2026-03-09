import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const LOGFISH_VIEW_TYPE = 'logFish.viewer';
const SAVED_FILTERS_KEY = 'logFish.savedFilters';
const SAVED_EXCLUDE_FILTERS_KEY = 'logFish.savedExcludeFilters';
const EXCLUDE_FILTER_STATE_KEY = 'logFish.excludeFilter';

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
  maxCachedLines: number;
  filterDelayMs: number;
  filterPersistence: FilterPersistence;
};

type FilterBackend = 'rg' | 'grep' | 'js';
type FilterPersistence = 'workspace' | 'global' | 'workspaceThenGlobal';

type LinePayload = {
  i: number;
  n: number;
  t: string;
};

type FilteredModelStats = {
  totalLines: number;
  matchedLines: number;
  maxLineNumber: number;
};

type ProgressUpdate = {
  phase: 'indexing' | 'filtering';
  processed: number;
  total: number | null;
  matched: number;
  detail?: string;
};

type CancelableTask = {
  cancel: () => void;
};

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

class IndexedFileModel {
  private readonly uri: vscode.Uri;
  private indexed = false;
  private lineStarts: number[] = [];
  private lineEnds: number[] = [];

  private filteredLineNumbers: number[] = [];
  private filteredStarts: number[] = [];
  private filteredEnds: number[] = [];

  private activeFilterTask: CancelableTask | null = null;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  cancelActiveFilter(): void {
    if (this.activeFilterTask) {
      this.activeFilterTask.cancel();
      this.activeFilterTask = null;
    }
  }

  async ensureIndexed(onProgress?: (update: ProgressUpdate) => void): Promise<void> {
    if (this.indexed) {
      return;
    }

    const stats = await fs.promises.stat(this.uri.fsPath);
    const fileSize = stats.size;

    const starts: number[] = [];
    const ends: number[] = [];

    if (fileSize === 0) {
      this.lineStarts = starts;
      this.lineEnds = ends;
      this.filteredLineNumbers = [];
      this.filteredStarts = [];
      this.filteredEnds = [];
      this.indexed = true;
      onProgress?.({ phase: 'indexing', processed: 0, total: 0, matched: 0, detail: 'Indexed 0 lines' });
      return;
    }

    onProgress?.({ phase: 'indexing', processed: 0, total: fileSize, matched: 0, detail: 'Building line index' });

    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(this.uri.fsPath);
      let lineStart = 0;
      let absoluteOffset = 0;
      let previousByte: number | null = null;
      let lastProgressAt = Date.now();

      stream.on('data', (chunk: Buffer | string) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        for (let i = 0; i < data.length; i += 1) {
          const byte = data[i];
          if (byte === 0x0a) {
            let lineEnd = absoluteOffset + i;
            if (previousByte === 0x0d && lineEnd > lineStart) {
              lineEnd -= 1;
            }
            starts.push(lineStart);
            ends.push(lineEnd);
            lineStart = absoluteOffset + i + 1;
          }
          previousByte = byte;
        }
        absoluteOffset += data.length;
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          onProgress?.({
            phase: 'indexing',
            processed: absoluteOffset,
            total: fileSize,
            matched: starts.length,
            detail: 'Building line index'
          });
          lastProgressAt = now;
        }
      });

      stream.on('error', (error) => reject(error));
      stream.on('end', () => {
        if (lineStart < fileSize) {
          starts.push(lineStart);
          ends.push(fileSize);
        }
        resolve();
      });
    });

    this.lineStarts = starts;
    this.lineEnds = ends;
    this.filteredLineNumbers = [];
    this.filteredStarts = [];
    this.filteredEnds = [];
    this.indexed = true;
    onProgress?.({
      phase: 'indexing',
      processed: fileSize,
      total: fileSize,
      matched: this.lineStarts.length,
      detail: `Indexed ${this.lineStarts.length} lines`
    });
  }

  async buildFilteredModel(
    filterText: string,
    excludeText: string,
    caseSensitive: boolean,
    caseSensitiveExclude: boolean,
    backend: FilterBackend,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<FilteredModelStats> {
    await this.ensureIndexed(onProgress);
    this.cancelActiveFilter();

    const totalLines = this.lineStarts.length;
    const maxLineNumber = totalLines;
    const trimmedFilter = filterText.trim();
    const trimmedExclude = excludeText.trim();

    onProgress?.({
      phase: 'filtering',
      processed: 0,
      total: totalLines,
      matched: 0,
      detail: 'Preparing filter'
    });

    if (trimmedFilter.length === 0 && trimmedExclude.length === 0) {
      const allNumbers: number[] = new Array(totalLines);
      const allStarts: number[] = new Array(totalLines);
      const allEnds: number[] = new Array(totalLines);
      for (let i = 0; i < totalLines; i += 1) {
        allNumbers[i] = i + 1;
        allStarts[i] = this.lineStarts[i];
        allEnds[i] = this.lineEnds[i];
      }
      this.filteredLineNumbers = allNumbers;
      this.filteredStarts = allStarts;
      this.filteredEnds = allEnds;
      onProgress?.({
        phase: 'filtering',
        processed: totalLines,
        total: totalLines,
        matched: totalLines,
        detail: 'No filter applied'
      });
      return {
        totalLines,
        matchedLines: totalLines,
        maxLineNumber
      };
    }

    // --- Exclude pass ---
    let excludedLineNumbers: Set<number> | null = null;
    if (trimmedExclude.length > 0) {
      excludedLineNumbers = new Set<number>();
      const excludeSet = excludedLineNumbers;
      const markExcluded = (lineNumber: number) => { excludeSet.add(lineNumber); };
      if (backend === 'rg' || backend === 'grep') {
        await this.filterWithExternalTool(excludeText, backend, caseSensitiveExclude, markExcluded, totalLines, onProgress);
      } else {
        await this.filterWithJs(excludeText, caseSensitiveExclude, markExcluded, totalLines, onProgress);
      }
    }

    const starts: number[] = [];
    const ends: number[] = [];
    const lineNumbers: number[] = [];

    const appendLine = (lineNumber: number) => {
      if (excludedLineNumbers && excludedLineNumbers.has(lineNumber)) {
        return;
      }
      const idx = lineNumber - 1;
      if (idx < 0 || idx >= this.lineStarts.length) {
        return;
      }
      lineNumbers.push(lineNumber);
      starts.push(this.lineStarts[idx]);
      ends.push(this.lineEnds[idx]);
    };

    if (trimmedFilter.length === 0) {
      // No include filter: start from all lines, only exclude applies.
      for (let i = 1; i <= totalLines; i += 1) {
        appendLine(i);
      }
    } else {
      if (backend === 'rg' || backend === 'grep') {
        await this.filterWithExternalTool(filterText, backend, caseSensitive, appendLine, totalLines, onProgress);
      } else {
        await this.filterWithJs(filterText, caseSensitive, appendLine, totalLines, onProgress);
      }
    }

    this.filteredLineNumbers = lineNumbers;
    this.filteredStarts = starts;
    this.filteredEnds = ends;

    onProgress?.({
      phase: 'filtering',
      processed: totalLines,
      total: totalLines,
      matched: lineNumbers.length,
      detail: 'Filter complete'
    });

    return {
      totalLines,
      matchedLines: lineNumbers.length,
      maxLineNumber: lineNumbers.length > 0 ? lineNumbers[lineNumbers.length - 1] : 0
    };
  }

  private filterWithExternalTool(
    filterText: string,
    backend: Exclude<FilterBackend, 'js'>,
    caseSensitive: boolean,
    onMatch: (lineNumber: number) => void,
    totalLines: number,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const caseFlag = caseSensitive ? [] : ['-i'];
      const args =
        backend === 'rg'
          ? [
              ...caseFlag,
              '--no-messages',
              '--line-number',
              '--no-filename',
              '--color',
              'never',
              '--text',
              '-e',
              filterText,
              this.uri.fsPath
            ]
          : [...caseFlag, '-n', '-E', '-a', '--color=never', '-e', filterText, this.uri.fsPath];

      const proc = spawn(backend, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let buffer = '';
      let stderr = '';
      let cancelled = false;
      let matched = 0;
      const progressTimer = setInterval(() => {
        onProgress?.({
          phase: 'filtering',
          processed: 0,
          total: totalLines,
          matched,
          detail: `Filtering with ${backend}`
        });
      }, 300);

      this.activeFilterTask = {
        cancel: () => {
          cancelled = true;
          proc.kill();
        }
      };

      const parseLine = (line: string) => {
        if (!line) {
          return;
        }
        const colonIndex = line.indexOf(':');
        if (colonIndex < 0) {
          return;
        }
        const lineNumber = Number.parseInt(line.slice(0, colonIndex), 10);
        if (!Number.isFinite(lineNumber)) {
          return;
        }
        matched += 1;
        onMatch(lineNumber);
      };

      proc.stdout.on('data', (chunk: Buffer | string) => {
        if (cancelled) {
          return;
        }
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const data = buffer + text;
        const parts = data.split(/\r?\n/);
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          parseLine(line);
        }
      });

      proc.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderr.length < 2000) {
          stderr += text;
        }
      });

      proc.on('error', (error) => {
        clearInterval(progressTimer);
        if (cancelled) {
          resolve();
          return;
        }
        reject(error);
      });

      proc.on('close', (exitCode) => {
        clearInterval(progressTimer);
        this.activeFilterTask = null;
        if (cancelled) {
          resolve();
          return;
        }

        if (buffer.length > 0) {
          parseLine(buffer);
        }

        // rg/grep exit code 1 means "no matches".
        if (exitCode !== null && exitCode > 1) {
          reject(new Error(stderr.trim() || `Failed to run ${backend}.`));
          return;
        }
        onProgress?.({
          phase: 'filtering',
          processed: totalLines,
          total: totalLines,
          matched,
          detail: `Filtered with ${backend}`
        });
        resolve();
      });
    });
  }

  private filterWithJs(
    filterText: string,
    caseSensitive: boolean,
    onMatch: (lineNumber: number) => void,
    totalLines: number,
    onProgress?: (update: ProgressUpdate) => void
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let regex: RegExp;
      try {
        regex = caseSensitive ? new RegExp(filterText) : new RegExp(filterText, 'i');
      } catch {
        reject(new Error('Invalid filter regex.'));
        return;
      }

      const stream = fs.createReadStream(this.uri.fsPath, {
        encoding: 'utf8',
        highWaterMark: 64 * 1024
      });
      let cancelled = false;
      let buffer = '';
      let lineNumber = 0;
      let matched = 0;
      let lastProgressAt = Date.now();

      this.activeFilterTask = {
        cancel: () => {
          cancelled = true;
          stream.destroy();
        }
      };

      const pushLine = (line: string) => {
        lineNumber += 1;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          matched += 1;
          onMatch(lineNumber);
        }
        const now = Date.now();
        if (now - lastProgressAt >= 250) {
          onProgress?.({
            phase: 'filtering',
            processed: lineNumber,
            total: totalLines,
            matched,
            detail: 'Filtering with JS'
          });
          lastProgressAt = now;
        }
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
          pushLine(line);
        }
      });

      stream.on('error', (error) => {
        this.activeFilterTask = null;
        if (cancelled) {
          resolve();
          return;
        }
        reject(error);
      });

      stream.on('end', () => {
        this.activeFilterTask = null;
        if (cancelled) {
          resolve();
          return;
        }
        if (buffer.length > 0) {
          pushLine(buffer);
        }
        onProgress?.({
          phase: 'filtering',
          processed: totalLines,
          total: totalLines,
          matched,
          detail: 'Filtered with JS'
        });
        resolve();
      });
    });
  }

  async getFilteredSlice(start: number, count: number): Promise<LinePayload[]> {
    await this.ensureIndexed();

    const safeStart = Math.max(0, start);
    const safeCount = Math.max(0, count);
    const safeEnd = Math.min(this.filteredStarts.length, safeStart + safeCount);
    if (safeStart >= safeEnd) {
      return [];
    }

    const result: LinePayload[] = [];

    const mergeGapBytes = 256;
    const maxMergedBytes = 512 * 1024;
    type ReadSegment = {
      startIndex: number;
      endIndex: number;
      byteStart: number;
      byteEnd: number;
    };

    const segments: ReadSegment[] = [];
    let segmentStartIndex = safeStart;
    let segmentEndIndex = safeStart;
    let segmentByteStart = this.filteredStarts[safeStart];
    let segmentByteEnd = this.filteredEnds[safeStart];

    for (let i = safeStart + 1; i < safeEnd; i += 1) {
      const nextStart = this.filteredStarts[i];
      const nextEnd = this.filteredEnds[i];
      const gap = Math.max(0, nextStart - segmentByteEnd);
      const mergedBytes = nextEnd - segmentByteStart;
      const canMerge = gap <= mergeGapBytes && mergedBytes <= maxMergedBytes;

      if (canMerge) {
        segmentEndIndex = i;
        if (nextEnd > segmentByteEnd) {
          segmentByteEnd = nextEnd;
        }
      } else {
        segments.push({
          startIndex: segmentStartIndex,
          endIndex: segmentEndIndex,
          byteStart: segmentByteStart,
          byteEnd: segmentByteEnd
        });
        segmentStartIndex = i;
        segmentEndIndex = i;
        segmentByteStart = nextStart;
        segmentByteEnd = nextEnd;
      }
    }

    segments.push({
      startIndex: segmentStartIndex,
      endIndex: segmentEndIndex,
      byteStart: segmentByteStart,
      byteEnd: segmentByteEnd
    });

    const handle = await fs.promises.open(this.uri.fsPath, 'r');
    try {
      for (const segment of segments) {
        const segmentLength = Math.max(0, segment.byteEnd - segment.byteStart);
        const segmentBuffer = segmentLength > 0 ? Buffer.allocUnsafe(segmentLength) : Buffer.alloc(0);
        if (segmentLength > 0) {
          await handle.read(segmentBuffer, 0, segmentLength, segment.byteStart);
        }

        for (let i = segment.startIndex; i <= segment.endIndex; i += 1) {
          const byteStart = this.filteredStarts[i] - segment.byteStart;
          const byteEnd = this.filteredEnds[i] - segment.byteStart;
          const startOffset = Math.max(0, byteStart);
          const endOffset = Math.max(startOffset, byteEnd);
          const text = segmentBuffer.toString('utf8', startOffset, endOffset);
          result.push({
            i,
            n: this.filteredLineNumbers[i],
            t: text
          });
        }
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  findClosestFilteredIndex(lineNumber: number): number {
    if (this.filteredLineNumbers.length === 0) {
      return -1;
    }

    let lo = 0;
    let hi = this.filteredLineNumbers.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const current = this.filteredLineNumbers[mid];
      if (current === lineNumber) {
        return mid;
      }
      if (current < lineNumber) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (lo >= this.filteredLineNumbers.length) {
      return this.filteredLineNumbers.length - 1;
    }
    if (hi < 0) {
      return 0;
    }

    const loDiff = Math.abs(this.filteredLineNumbers[lo] - lineNumber);
    const hiDiff = Math.abs(this.filteredLineNumbers[hi] - lineNumber);
    return loDiff < hiDiff ? lo : hi;
  }
}

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

    const model = new IndexedFileModel(document.uri);
    let currentFilter = this.readFilterState(document.uri, this.getSettings(document.uri));
    let currentExcludeFilter = this.readExcludeFilterState(document.uri, this.getSettings(document.uri));
    let currentCaseSensitive = false;
    let currentCaseSensitiveExclude = false;
    let modelVersion = 0;

    const loadModel = async (filterText: string, excludeText: string, caseSensitive: boolean, caseSensitiveExclude: boolean) => {
      modelVersion += 1;
      const version = modelVersion;
      model.cancelActiveFilter();
      webview.postMessage({ type: 'reset', version });

      const settings = this.getSettings(document.uri);
      const hasAnyFilter = filterText.trim().length > 0 || excludeText.trim().length > 0;

      try {
        const backend = hasAnyFilter ? await this.getFilterBackend() : 'js';
        const stats = await model.buildFilteredModel(filterText, excludeText, caseSensitive, caseSensitiveExclude, backend, (update) => {
          if (version !== modelVersion) {
            return;
          }
          webview.postMessage({
            type: 'progress',
            version,
            progress: update
          });
        });
        if (version !== modelVersion) {
          return;
        }

        webview.postMessage({
          type: 'modelReady',
          version,
          stats
        });
      } catch (error) {
        if (version !== modelVersion) {
          return;
        }
        const message = error instanceof Error ? error.message : 'Filtering failed.';
        webview.postMessage({ type: 'error', message });
      }

      if (settings.maxCachedLines <= 0) {
        webview.postMessage({ type: 'error', message: 'logFish.maxCachedLines must be greater than 0.' });
      }
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
            maxCachedLines: settings.maxCachedLines,
            filterText: currentFilter,
            excludeFilterText: currentExcludeFilter,
            savedFilters: this.readSavedFilters(settings),
            savedExcludeFilters: this.readSavedExcludeFilters(settings),
            caseSensitive: currentCaseSensitive,
            caseSensitiveExclude: currentCaseSensitiveExclude
          });
          await loadModel(currentFilter, currentExcludeFilter, currentCaseSensitive, currentCaseSensitiveExclude);
          break;
        }
        case 'filterChanged': {
          currentFilter = String(message.value ?? '');
          currentExcludeFilter = String(message.excludeValue ?? '');
          if (typeof message.caseSensitive === 'boolean') {
            currentCaseSensitive = message.caseSensitive;
          }
          if (typeof message.caseSensitiveExclude === 'boolean') {
            currentCaseSensitiveExclude = message.caseSensitiveExclude;
          }
          const settings = this.getSettings(document.uri);
          this.persistFilterState(document.uri, settings, currentFilter);
          this.persistExcludeFilterState(document.uri, settings, currentExcludeFilter);
          await loadModel(currentFilter, currentExcludeFilter, currentCaseSensitive, currentCaseSensitiveExclude);
          break;
        }
        case 'requestRange': {
          const start = Number.parseInt(String(message.start ?? '0'), 10);
          const count = Number.parseInt(String(message.count ?? '0'), 10);
          const version = Number.parseInt(String(message.version ?? '-1'), 10);
          if (version !== modelVersion) {
            return;
          }
          const lines = await model.getFilteredSlice(start, count);
          if (version !== modelVersion) {
            return;
          }
          webview.postMessage({ type: 'rangeData', version, start, count, lines });
          break;
        }
        case 'requestClosestIndex': {
          const lineNumber = Number.parseInt(String(message.lineNumber ?? '-1'), 10);
          const version = Number.parseInt(String(message.version ?? '-1'), 10);
          if (version !== modelVersion || !Number.isFinite(lineNumber) || lineNumber < 1) {
            return;
          }
          const index = model.findClosestFilteredIndex(lineNumber);
          webview.postMessage({ type: 'closestIndexResult', version, index });
          break;
        }
        case 'requestRules': {
          const settings = this.getSettings(document.uri);
          const rules = await this.loadHighlightRules(document.uri, settings.highlightRules);
          const resolved = this.buildRuleStyles(rules);
          webview.postMessage({ type: 'rulesUpdated', rules: resolved.rules, cssText: resolved.cssText });
          break;
        }
        case 'saveFilter': {
          const value = String(message.value ?? '');
          const kind = String(message.kind ?? 'include');
          const settings = this.getSettings(document.uri);
          if (kind === 'exclude') {
            const filters = this.addToSavedExcludeFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'exclude', filters });
          } else {
            const filters = this.addToSavedFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'include', filters });
          }
          break;
        }
        case 'deleteFilter': {
          const value = String(message.value ?? '');
          const kind = String(message.kind ?? 'include');
          const settings = this.getSettings(document.uri);
          if (kind === 'exclude') {
            const filters = this.deleteFromSavedExcludeFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'exclude', filters });
          } else {
            const filters = this.deleteFromSavedFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'include', filters });
          }
          break;
        }
        default:
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      model.cancelActiveFilter();
    });
  }

  private getSettings(uri: vscode.Uri): LogFishSettings {
    const config = vscode.workspace.getConfiguration('logFish', uri);
    return {
      highlightRules: config.get<HighlightRuleConfig>('highlightRules', []),
      maxCachedLines: config.get<number>('maxCachedLines', 100000),
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

  private readExcludeFilterState(uri: vscode.Uri, settings: LogFishSettings): string {
    const key = EXCLUDE_FILTER_STATE_KEY;
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

  private persistExcludeFilterState(uri: vscode.Uri, settings: LogFishSettings, value: string): void {
    const key = EXCLUDE_FILTER_STATE_KEY;
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

  private readSavedExcludeFilters(settings: LogFishSettings): string[] {
    switch (settings.filterPersistence) {
      case 'workspace':
        return this.context.workspaceState.get<string[]>(SAVED_EXCLUDE_FILTERS_KEY, []);
      case 'global':
        return this.context.globalState.get<string[]>(SAVED_EXCLUDE_FILTERS_KEY, []);
      case 'workspaceThenGlobal':
      default:
        return (
          this.context.workspaceState.get<string[]>(SAVED_EXCLUDE_FILTERS_KEY) ??
          this.context.globalState.get<string[]>(SAVED_EXCLUDE_FILTERS_KEY) ??
          []
        );
    }
  }

  private persistSavedExcludeFilters(settings: LogFishSettings, filters: string[]): void {
    switch (settings.filterPersistence) {
      case 'workspace':
        void this.context.workspaceState.update(SAVED_EXCLUDE_FILTERS_KEY, filters);
        break;
      case 'global':
        void this.context.globalState.update(SAVED_EXCLUDE_FILTERS_KEY, filters);
        break;
      case 'workspaceThenGlobal':
      default:
        void this.context.workspaceState.update(SAVED_EXCLUDE_FILTERS_KEY, filters);
        void this.context.globalState.update(SAVED_EXCLUDE_FILTERS_KEY, filters);
        break;
    }
  }

  private addToSavedExcludeFilters(settings: LogFishSettings, value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) { return this.readSavedExcludeFilters(settings); }
    const current = this.readSavedExcludeFilters(settings);
    const deduped = [trimmed, ...current.filter((f) => f !== trimmed)];
    this.persistSavedExcludeFilters(settings, deduped);
    return deduped;
  }

  private deleteFromSavedExcludeFilters(settings: LogFishSettings, value: string): string[] {
    const current = this.readSavedExcludeFilters(settings);
    const updated = current.filter((f) => f !== value);
    this.persistSavedExcludeFilters(settings, updated);
    return updated;
  }

  private readSavedFilters(settings: LogFishSettings): string[] {
    switch (settings.filterPersistence) {
      case 'workspace':
        return this.context.workspaceState.get<string[]>(SAVED_FILTERS_KEY, []);
      case 'global':
        return this.context.globalState.get<string[]>(SAVED_FILTERS_KEY, []);
      case 'workspaceThenGlobal':
      default:
        return (
          this.context.workspaceState.get<string[]>(SAVED_FILTERS_KEY) ??
          this.context.globalState.get<string[]>(SAVED_FILTERS_KEY) ??
          []
        );
    }
  }

  private persistSavedFilters(settings: LogFishSettings, filters: string[]): void {
    switch (settings.filterPersistence) {
      case 'workspace':
        void this.context.workspaceState.update(SAVED_FILTERS_KEY, filters);
        break;
      case 'global':
        void this.context.globalState.update(SAVED_FILTERS_KEY, filters);
        break;
      case 'workspaceThenGlobal':
      default:
        void this.context.workspaceState.update(SAVED_FILTERS_KEY, filters);
        void this.context.globalState.update(SAVED_FILTERS_KEY, filters);
        break;
    }
  }

  private addToSavedFilters(settings: LogFishSettings, value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return this.readSavedFilters(settings);
    }
    const current = this.readSavedFilters(settings);
    const deduped = [trimmed, ...current.filter((f) => f !== trimmed)];
    this.persistSavedFilters(settings, deduped);
    return deduped;
  }

  private deleteFromSavedFilters(settings: LogFishSettings, value: string): string[] {
    const current = this.readSavedFilters(settings);
    const updated = current.filter((f) => f !== value);
    this.persistSavedFilters(settings, updated);
    return updated;
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
    <div class="filter-rows">
      <div class="filter-row">
        <div class="filter-wrap">
          <input id="filterInput" type="text" placeholder="Include filter (regex)" />
          <button id="filterToggle" class="filter-toggle" type="button" title="Show saved filters" aria-expanded="false">&#9660;</button>
          <div id="filterDropdown" class="filter-dropdown" hidden></div>
        </div>
        <button id="caseInclude" class="case" type="button" aria-pressed="false" title="Match case (include)">Aa</button>
      </div>
      <div class="filter-row">
        <div class="filter-wrap">
          <input id="excludeFilterInput" type="text" placeholder="Exclude filter (regex)" />
          <button id="excludeFilterToggle" class="filter-toggle filter-toggle--exclude" type="button" title="Show saved exclude filters" aria-expanded="false">&#9660;</button>
          <div id="excludeFilterDropdown" class="filter-dropdown" hidden></div>
        </div>
        <button id="caseExclude" class="case" type="button" aria-pressed="false" title="Match case (exclude)">Aa</button>
      </div>
    </div>
    <div id="status" class="status">Ready</div>
  </div>
  <div id="viewport" class="viewport">
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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(LogFishProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('logFish.openLog', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open File'
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
