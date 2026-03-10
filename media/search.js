// Search functionality as a class

class SearchManager {
  constructor(state, dom, scrollManager, renderer, vscode) {
    this.state = state;
    this.dom = dom;
    this.scrollManager = scrollManager;
    this.renderer = renderer;
    this.vscode = vscode;
    
    this.visible = false;
    this.query = '';
    this.caseSensitive = false;
    this.match = null;   // { filteredIndex, matchStart, matchLength } | null
    this.searching = false;
    this.pendingHScroll = false;

    this.setupListeners();
  }

  setupListeners() {
    if (this.dom.searchInput) {
      this.dom.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.doSearchNext(event.shiftKey ? 'prev' : 'next');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          this.hideSearch();
        }
      });
    }

    if (this.dom.searchCloseBtn) {
      this.dom.searchCloseBtn.addEventListener('click', () => this.hideSearch());
    }

    if (this.dom.searchNextBtn) {
      this.dom.searchNextBtn.addEventListener('click', () => this.doSearchNext('next'));
    }

    if (this.dom.searchPrevBtn) {
      this.dom.searchPrevBtn.addEventListener('click', () => this.doSearchNext('prev'));
    }
  }

  showSearch() {
    if (!this.dom.searchBox) { return; }
    this.visible = true;
    this.dom.searchBox.removeAttribute('hidden');
    if (this.dom.searchInput) {
      this.dom.searchInput.focus();
      this.dom.searchInput.select();
    }
  }

  hideSearch() {
    if (!this.dom.searchBox) { return; }
    this.visible = false;
    this.match = null;
    this.dom.searchBox.setAttribute('hidden', '');
    this.renderer.scheduleRender();
  }

  doSearchNext(direction) {
    const query = this.dom.searchInput ? this.dom.searchInput.value : '';
    if (!query) { return; }
    this.query = query;
    this.searching = true;
    if (this.dom.searchStatusEl) { this.dom.searchStatusEl.textContent = '…'; }
    const fromIndex = this.match
      ? this.match.filteredIndex
      : Math.max(-1, Math.floor(this.scrollManager.getVirtualScrollTop() / this.scrollManager.getLineHeight()) - 1);
    const fromMatchStart = this.match ? this.match.matchStart : -1;
    const fromMatchLength = this.match ? this.match.matchLength : 0;
    this.vscode.postMessage({
      type: 'searchNext',
      query,
      caseSensitive: this.caseSensitive,
      fromIndex,
      fromMatchStart,
      fromMatchLength,
      direction: direction || 'next',
      version: this.state.version
    });
  }

  getSearch() {
    return {
      visible: this.visible,
      query: this.query,
      caseSensitive: this.caseSensitive,
      match: this.match,
      searching: this.searching,
      pendingHScroll: this.pendingHScroll
    };
  }
}
