import * as vscode from 'vscode';
import * as path from 'path';
import { LOGFISH_VIEW_TYPE } from './Types';
import type { LogFishSettings, HighlightRuleConfig, HighlightRuleProfile } from './Types';
import { LogFishDocument } from './LogFishDocument';
import { IndexedFileModel } from './IndexedFileModel';
import { FilterPersistenceManager } from './FilterPersistenceManager';
import { HighlightRuleManager } from './HighlightRuleManager';
import { FilterBackendDetector } from './FilterBackendDetector';
import { getWebviewHtml } from './WebviewHtml';

export class LogFishProvider implements vscode.CustomReadonlyEditorProvider<LogFishDocument> {
  private readonly filterPersistence: FilterPersistenceManager;
  private readonly highlightRules: HighlightRuleManager;
  private readonly backendDetector: FilterBackendDetector;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.filterPersistence = new FilterPersistenceManager(context);
    this.highlightRules = new HighlightRuleManager();
    this.backendDetector = new FilterBackendDetector();
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

    webview.html = getWebviewHtml(webview, this.context.extensionUri);

    const model = new IndexedFileModel(document.uri);
    const settings0 = this.getSettings(document.uri);
    let currentFilter = this.filterPersistence.readFilterState(settings0);
    let currentExcludeFilter = this.filterPersistence.readExcludeFilterState(settings0);
    let currentCaseSensitive = false;
    let currentCaseSensitiveExclude = false;
    let modelVersion = 0;
    let latestRangeSerial = 0;
    let filterChangedDuringIndex = false;
    let currentProfiles: HighlightRuleProfile[] = [];
    let currentProfileName: string | null = null;

    const loadModel = async (
      filterText: string,
      excludeText: string,
      caseSensitive: boolean,
      caseSensitiveExclude: boolean
    ) => {
      modelVersion += 1;
      const version = modelVersion;
      latestRangeSerial = 0;
      model.cancelActiveFilter();
      webview.postMessage({ type: 'reset', version });

      const settings = this.getSettings(document.uri);
      const hasAnyFilter = filterText.trim().length > 0 || excludeText.trim().length > 0;

      try {
        const backend = hasAnyFilter ? await this.backendDetector.getFilterBackend() : 'js';
        const stats = await model.buildFilteredModel(
          filterText,
          excludeText,
          caseSensitive,
          caseSensitiveExclude,
          backend,
          (update) => {
            if (version !== modelVersion) {
              return;
            }
            webview.postMessage({ type: 'progress', version, progress: update });
          }
        );
        if (version !== modelVersion) {
          return;
        }
        webview.postMessage({ type: 'modelReady', version, stats });
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
          const rulesResult = await this.highlightRules.loadRulesAndProfiles(document.uri, settings.highlightRules);
          currentProfiles = rulesResult.profiles;
          currentProfileName = rulesResult.autoSelectedName;
          const activeRules = currentProfileName
            ? this.highlightRules.getProfileRules(currentProfiles, currentProfileName)
            : [];
          const resolved = this.highlightRules.buildRuleStyles(activeRules);
          webview.postMessage({
            type: 'init',
            fileName: path.basename(document.uri.fsPath),
            rules: resolved.rules,
            cssText: resolved.cssText,
            debounceMs: settings.filterDelayMs,
            maxCachedLines: settings.maxCachedLines,
            filterText: currentFilter,
            excludeFilterText: currentExcludeFilter,
            savedFilters: this.filterPersistence.readSavedFilters(settings),
            savedExcludeFilters: this.filterPersistence.readSavedExcludeFilters(settings),
            caseSensitive: currentCaseSensitive,
            caseSensitiveExclude: currentCaseSensitiveExclude,
            profiles: currentProfiles.map((p) => p.name),
            activeProfileName: currentProfileName
          });
          filterChangedDuringIndex = false;
          await loadModel(currentFilter, currentExcludeFilter, currentCaseSensitive, currentCaseSensitiveExclude);
          if (filterChangedDuringIndex) {
            filterChangedDuringIndex = false;
            await loadModel(currentFilter, currentExcludeFilter, currentCaseSensitive, currentCaseSensitiveExclude);
          }
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
          this.filterPersistence.persistFilterState(settings, currentFilter);
          this.filterPersistence.persistExcludeFilterState(settings, currentExcludeFilter);
          if (!model.isIndexed) {
            filterChangedDuringIndex = true;
            break;
          }
          await loadModel(currentFilter, currentExcludeFilter, currentCaseSensitive, currentCaseSensitiveExclude);
          break;
        }
        case 'requestRange': {
          const start = Number.parseInt(String(message.start ?? '0'), 10);
          const count = Number.parseInt(String(message.count ?? '0'), 10);
          const version = Number.parseInt(String(message.version ?? '-1'), 10);
          const serial = Number.parseInt(String(message.serial ?? '0'), 10);
          latestRangeSerial = Math.max(latestRangeSerial, serial);
          if (version !== modelVersion) {
            return;
          }
          const lines = await model.getFilteredSlice(start, count);
          if (version !== modelVersion || serial < latestRangeSerial) {
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
          const result = model.findClosestFilteredIndex(lineNumber);
          webview.postMessage({ type: 'closestIndexResult', version, index: result.index, exact: result.exact });
          break;
        }
        case 'setHighlightProfile': {
          const profileName = String(message.name ?? '');
          if (!currentProfiles.find((p) => p.name === profileName)) { break; }
          currentProfileName = profileName;
          const rules = this.highlightRules.getProfileRules(currentProfiles, currentProfileName);
          const resolved = this.highlightRules.buildRuleStyles(rules);
          webview.postMessage({ type: 'rulesUpdated', rules: resolved.rules, cssText: resolved.cssText });
          break;
        }
        case 'requestRules': {
          const settings = this.getSettings(document.uri);
          const rulesResult = await this.highlightRules.loadRulesAndProfiles(document.uri, settings.highlightRules);
          currentProfiles = rulesResult.profiles;
          if (!currentProfileName || !currentProfiles.find((p) => p.name === currentProfileName)) {
            currentProfileName = rulesResult.autoSelectedName;
          }
          const rules = currentProfileName
            ? this.highlightRules.getProfileRules(currentProfiles, currentProfileName)
            : [];
          const resolved = this.highlightRules.buildRuleStyles(rules);
          webview.postMessage({ type: 'rulesUpdated', rules: resolved.rules, cssText: resolved.cssText });
          break;
        }
        case 'saveFilter': {
          const value = String(message.value ?? '');
          const kind = String(message.kind ?? 'include');
          const settings = this.getSettings(document.uri);
          if (kind === 'exclude') {
            const filters = this.filterPersistence.addToSavedExcludeFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'exclude', filters });
          } else {
            const filters = this.filterPersistence.addToSavedFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'include', filters });
          }
          break;
        }
        case 'deleteFilter': {
          const value = String(message.value ?? '');
          const kind = String(message.kind ?? 'include');
          const settings = this.getSettings(document.uri);
          if (kind === 'exclude') {
            const filters = this.filterPersistence.deleteFromSavedExcludeFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'exclude', filters });
          } else {
            const filters = this.filterPersistence.deleteFromSavedFilters(settings, value);
            webview.postMessage({ type: 'savedFiltersUpdated', kind: 'include', filters });
          }
          break;
        }
        case 'searchNext': {
          const query = String(message.query ?? '');
          const caseSensitive = Boolean(message.caseSensitive);
          const fromIndex = Number.parseInt(String(message.fromIndex ?? '-1'), 10);
          const fromMatchStart = Number.parseInt(String(message.fromMatchStart ?? '-1'), 10);
          const fromMatchLength = Number.parseInt(String(message.fromMatchLength ?? '0'), 10);
          const direction = message.direction === 'prev' ? 'prev' : 'next';
          const version = Number.parseInt(String(message.version ?? '-1'), 10);
          if (version !== modelVersion || !query) {
            return;
          }
          try {
            const result = await model.searchFilteredLines(
              query,
              caseSensitive,
              fromIndex,
              fromMatchStart,
              fromMatchLength,
              direction
            );
            if (version !== modelVersion) {
              return;
            }
            if (result) {
              webview.postMessage({
                type: 'searchResult',
                version,
                found: true,
                filteredIndex: result.filteredIndex,
                matchStart: result.matchStart,
                matchLength: result.matchLength,
                lineNumber: model.getFilteredLineNumber(result.filteredIndex)
              });
            } else {
              webview.postMessage({ type: 'searchResult', version, found: false });
            }
          } catch {
            // ignore search errors (e.g. cancelled)
          }
          break;
        }
        case 'requestGotoLine': {
          const version = Number.parseInt(String(message.version ?? '-1'), 10);
          if (version !== modelVersion) {
            return;
          }
          const input = await vscode.window.showInputBox({
            prompt: 'Go to line',
            placeHolder: 'Line number',
            validateInput: (value) => {
              const num = Number.parseInt(value, 10);
              if (!Number.isFinite(num) || num < 1) {
                return 'Please enter a valid line number';
              }
              return '';
            }
          });
          if (!input) {
            return;
          }
          const lineNumber = Number.parseInt(input, 10);
          const index = model.findClosestFilteredIndex(lineNumber);
          webview.postMessage({ type: 'gotoLine', version, index });
          break;
        }
        default:
          break;
      }
    });

    const configDisposable = vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('logFish', document.uri)) { return; }
      const settings = this.getSettings(document.uri);
      const rulesResult = await this.highlightRules.loadRulesAndProfiles(document.uri, settings.highlightRules);
      currentProfiles = rulesResult.profiles;
      if (!currentProfileName || !currentProfiles.find((p) => p.name === currentProfileName)) {
        currentProfileName = rulesResult.autoSelectedName;
      }
      const rules = currentProfileName
        ? this.highlightRules.getProfileRules(currentProfiles, currentProfileName)
        : [];
      const resolved = this.highlightRules.buildRuleStyles(rules);
      webview.postMessage({
        type: 'settingsUpdated',
        debounceMs: settings.filterDelayMs,
        maxCachedLines: settings.maxCachedLines,
        savedFilters: this.filterPersistence.readSavedFilters(settings),
        savedExcludeFilters: this.filterPersistence.readSavedExcludeFilters(settings),
        profiles: currentProfiles.map((p) => p.name),
        activeProfileName: currentProfileName,
        rules: resolved.rules,
        cssText: resolved.cssText
      });
    });

    webviewPanel.onDidDispose(() => {
      model.cancelActiveFilter();
      configDisposable.dispose();
    });
  }

  private getSettings(uri: vscode.Uri): LogFishSettings {
    const config = vscode.workspace.getConfiguration('logFish', uri);
    return {
      highlightRules: config.get<HighlightRuleConfig>('highlightRules', []),
      maxCachedLines: config.get<number>('maxCachedLines', 100000),
      filterDelayMs: config.get<number>('filterDelayMs', -1),
      filterPersistence: config.get('filterPersistence', 'workspaceThenGlobal')
    };
  }
}
