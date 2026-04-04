// State management as a class

class AppState {
  constructor() {
    this.rules = [];
    this.debounceMs = 250;
    this.caseSensitive = false;
    this.caseSensitiveExclude = false;
    this.maxCachedLines = 100000;
    this.version = 0;
    this.totalLines = 0;
    this.matchedLines = 0;
    this.maxLineNumber = 0;
    this.cache = new Map();
    this.pendingRanges = new Set();
    this.savedFilters = [];
    this.savedExcludeFilters = [];
    this.totalFileLines = 0;
    this.backendLabel = '';
    this.indexing = false;
    this.modelBusy = false;
    this.currentLine = null;
    this.currentLineIndex = null;
    this.currentLineExact = false;
    this.history = [];
    this.historyIndex = -1;
    this.activeProfileName = null;
    this.profileCount = 0;
  }
}

// Cache manager as a class
class CacheManager {
  constructor(state) {
    this.state = state;
  }

  getCachedLine(index) {
    if (!this.state.cache.has(index)) {
      return null;
    }
    const value = this.state.cache.get(index);
    this.state.cache.delete(index);
    this.state.cache.set(index, value);
    return value;
  }

  addCachedLine(index, value) {
    if (this.state.cache.has(index)) {
      this.state.cache.delete(index);
    }
    this.state.cache.set(index, value);
    while (this.state.cache.size > this.state.maxCachedLines) {
      const oldestKey = this.state.cache.keys().next().value;
      this.state.cache.delete(oldestKey);
    }
  }

  clearCache() {
    this.state.cache.clear();
    this.state.pendingRanges.clear();
  }
}
