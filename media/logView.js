(() => {
  const vscode = acquireVsCodeApi();

  // Get DOM elements
  const dom = new DOMElements();

  // Create state and cache manager
  const state = new AppState();
  const cacheManager = new CacheManager(state);

  // Create scroll manager
  const highlightRules = new HighlightRules();
  let renderer;
  const scrollManager = new ScrollManager(state, dom, () => renderer.scheduleRender(), cacheManager);

  // Create search manager
  const searchManager = new SearchManager(state, dom, scrollManager, null, vscode);

  // Create renderer
  renderer = new Renderer(state, dom, scrollManager, searchManager, cacheManager, highlightRules, vscode);

  // Update renderer reference in search manager
  searchManager.renderer = renderer;

  // UI Helper functions
  const uiHelpers = {
    debounceTimer: null,
    setStatus(message) {
      if (dom.statusOpEl) { dom.statusOpEl.textContent = message; }
    },
    updateStatusCounts() {
      if (dom.statusTotalEl) {
        dom.statusTotalEl.textContent = state.totalFileLines > 0
          ? `${Utils.formatNumber(state.totalFileLines)} total`
          : '…';
      }
      if (dom.statusFilteredEl) {
        dom.statusFilteredEl.textContent = state.totalFileLines > 0
          ? `${Utils.formatNumber(state.matchedLines)} matched`
          : '…';
      }
    },
    updateCaseUi() {
      if (dom.caseButton) {
        dom.caseButton.classList.toggle('is-active', state.caseSensitive);
        dom.caseButton.setAttribute('aria-pressed', String(state.caseSensitive));
      }
      if (dom.caseExcludeButton) {
        dom.caseExcludeButton.classList.toggle('is-active', state.caseSensitiveExclude);
        dom.caseExcludeButton.setAttribute('aria-pressed', String(state.caseSensitiveExclude));
      }
    },
    setCaseSensitive(value) {
      state.caseSensitive = value;
      this.updateCaseUi();
    },
    setCaseSensitiveExclude(value) {
      state.caseSensitiveExclude = value;
      this.updateCaseUi();
    },
    postFilterChanged() {
      if (!state.indexing) { this.setStatus('Filtering...'); }
      if (!Number.isFinite(scrollManager.getRememberedLine())) {
        scrollManager.rememberCenterLine();
      }
      scrollManager.setPendingScrollToRemembered(Number.isFinite(scrollManager.getRememberedLine()));
      vscode.postMessage({
        type: 'filterChanged',
        value: dom.filterInput ? dom.filterInput.value : '',
        excludeValue: dom.excludeFilterInput ? dom.excludeFilterInput.value : '',
        caseSensitive: state.caseSensitive,
        caseSensitiveExclude: state.caseSensitiveExclude
      });
    },
    requestClosestIndex() {
      if (!scrollManager.getPendingScrollToRemembered() || !Number.isFinite(scrollManager.getRememberedLine())) {
        return;
      }
      vscode.postMessage({
        type: 'requestClosestIndex',
        lineNumber: scrollManager.getRememberedLine(),
        version: state.version
      });
    },
    includeWidget: null,
    excludeWidget: null
  };

  // Create filter widgets
  uiHelpers.includeWidget = new FilterWidget(
    dom.filterInput,
    dom.filterToggle,
    dom.filterDropdown,
    'include',
    state,
    vscode,
    uiHelpers
  );

  uiHelpers.excludeWidget = new FilterWidget(
    dom.excludeFilterInput,
    dom.excludeFilterToggle,
    dom.excludeFilterDropdown,
    'exclude',
    state,
    vscode,
    uiHelpers
  );

  // Setup all event handlers
  setupEventHandlers(state, dom, scrollManager, renderer, searchManager, cacheManager, vscode, uiHelpers);

  // Setup message handlers
  setupMessageHandler(state, dom, scrollManager, renderer, searchManager, cacheManager, highlightRules, vscode, uiHelpers);

  // Signal ready to extension
  vscode.postMessage({ type: 'ready' });
})();

