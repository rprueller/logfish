import * as vscode from 'vscode';
import {
  SAVED_FILTERS_KEY,
  SAVED_EXCLUDE_FILTERS_KEY,
  EXCLUDE_FILTER_STATE_KEY
} from './Types';
import type { LogFishSettings } from './Types';

const FILTER_STATE_KEY = 'logFish.filter';

export class FilterPersistenceManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  readFilterState(settings: LogFishSettings): string {
    switch (settings.filterPersistence) {
      case 'workspace':
        return this.context.workspaceState.get<string>(FILTER_STATE_KEY, '');
      case 'global':
        return this.context.globalState.get<string>(FILTER_STATE_KEY, '');
      case 'workspaceThenGlobal':
      default:
        return (
          this.context.workspaceState.get<string>(FILTER_STATE_KEY) ??
          this.context.globalState.get<string>(FILTER_STATE_KEY) ??
          ''
        );
    }
  }

  persistFilterState(settings: LogFishSettings, value: string): void {
    switch (settings.filterPersistence) {
      case 'workspace':
        void this.context.workspaceState.update(FILTER_STATE_KEY, value);
        break;
      case 'global':
        void this.context.globalState.update(FILTER_STATE_KEY, value);
        break;
      case 'workspaceThenGlobal':
      default:
        void this.context.workspaceState.update(FILTER_STATE_KEY, value);
        void this.context.globalState.update(FILTER_STATE_KEY, value);
        break;
    }
  }

  readExcludeFilterState(settings: LogFishSettings): string {
    switch (settings.filterPersistence) {
      case 'workspace':
        return this.context.workspaceState.get<string>(EXCLUDE_FILTER_STATE_KEY, '');
      case 'global':
        return this.context.globalState.get<string>(EXCLUDE_FILTER_STATE_KEY, '');
      case 'workspaceThenGlobal':
      default:
        return (
          this.context.workspaceState.get<string>(EXCLUDE_FILTER_STATE_KEY) ??
          this.context.globalState.get<string>(EXCLUDE_FILTER_STATE_KEY) ??
          ''
        );
    }
  }

  persistExcludeFilterState(settings: LogFishSettings, value: string): void {
    switch (settings.filterPersistence) {
      case 'workspace':
        void this.context.workspaceState.update(EXCLUDE_FILTER_STATE_KEY, value);
        break;
      case 'global':
        void this.context.globalState.update(EXCLUDE_FILTER_STATE_KEY, value);
        break;
      case 'workspaceThenGlobal':
      default:
        void this.context.workspaceState.update(EXCLUDE_FILTER_STATE_KEY, value);
        void this.context.globalState.update(EXCLUDE_FILTER_STATE_KEY, value);
        break;
    }
  }

  readSavedFilters(settings: LogFishSettings): string[] {
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

  persistSavedFilters(settings: LogFishSettings, filters: string[]): void {
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

  addToSavedFilters(settings: LogFishSettings, value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) {
      return this.readSavedFilters(settings);
    }
    const current = this.readSavedFilters(settings);
    const deduped = [trimmed, ...current.filter((f) => f !== trimmed)];
    this.persistSavedFilters(settings, deduped);
    return deduped;
  }

  deleteFromSavedFilters(settings: LogFishSettings, value: string): string[] {
    const current = this.readSavedFilters(settings);
    const updated = current.filter((f) => f !== value);
    this.persistSavedFilters(settings, updated);
    return updated;
  }

  readSavedExcludeFilters(settings: LogFishSettings): string[] {
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

  persistSavedExcludeFilters(settings: LogFishSettings, filters: string[]): void {
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

  addToSavedExcludeFilters(settings: LogFishSettings, value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed) { return this.readSavedExcludeFilters(settings); }
    const current = this.readSavedExcludeFilters(settings);
    const deduped = [trimmed, ...current.filter((f) => f !== trimmed)];
    this.persistSavedExcludeFilters(settings, deduped);
    return deduped;
  }

  deleteFromSavedExcludeFilters(settings: LogFishSettings, value: string): string[] {
    const current = this.readSavedExcludeFilters(settings);
    const updated = current.filter((f) => f !== value);
    this.persistSavedExcludeFilters(settings, updated);
    return updated;
  }
}
