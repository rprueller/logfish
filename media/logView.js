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
    setStatus(status, set_op = true) {
      if (set_op) {
        if (dom.statusBackend) { dom.statusBackend.textContent = ''; }
        if (dom.statusOp) { dom.statusOp.textContent = status; }
      } else {
        if (dom.statusBackend) { dom.statusBackend.textContent = status; }
      }
      if (dom.profileDropdown) { dom.profileDropdown.hidden = true; }
      if (dom.profileSelector) {
        dom.profileSelector.hidden = set_op;
        dom.profileSelector.style.display = set_op ? "none" : "block";
      }
      if (dom.statusOp) {
        dom.statusOp.hidden = !set_op;
        dom.statusOp.style.display = set_op ? "block" : "none"
      }
    },
    updateStatusCounts() {
      if (dom.statusTotalNum) {
        dom.statusTotalNum.textContent = state.totalFileLines > 0
          ? `${Utils.formatNumber(state.totalFileLines)}`
          : '-';
      }
      if (dom.statusFilteredNum) {
        dom.statusFilteredNum.textContent = state.totalFileLines > 0
          ? `${Utils.formatNumber(state.matchedLines)}`
          : '-';
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
      vscode.postMessage({
        type: 'filterChanged',
        value: dom.filterInput ? dom.filterInput.value : '',
        excludeValue: dom.excludeFilterInput ? dom.excludeFilterInput.value : '',
        caseSensitive: state.caseSensitive,
        caseSensitiveExclude: state.caseSensitiveExclude
      });
    },
    requestClosestIndex() {
      if (state.currentLine === null) { return; }
      vscode.postMessage({
        type: 'requestClosestIndex',
        lineNumber: state.currentLine,
        version: state.version
      });
    },
    pushHistory(lineNumber) {
      state.history = state.history.slice(0, state.historyIndex + 1);
      if (state.history[state.history.length - 1] === lineNumber) { // also works for empty arrays
        return;
      }
      if (state.history.length >= 200) {
        state.history.shift();
      }
      state.history.push(lineNumber);
      state.historyIndex = state.history.length - 1;
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
  setupMessageHandler(state, dom, scrollManager, renderer, searchManager, cacheManager, highlightRules, uiHelpers);

  // Signal ready to extension
  vscode.postMessage({ type: 'ready' });
})();

