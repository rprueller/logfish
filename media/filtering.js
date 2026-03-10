// Filter widget functionality as a class

class FilterWidget {
  constructor(inputEl, toggleEl, dropdownEl, kind, state, vscode, callbacks) {
    this.inputEl = inputEl;
    this.toggleEl = toggleEl;
    this.dropdownEl = dropdownEl;
    this.kind = kind;
    this.state = state;
    this.vscode = vscode;
    this.callbacks = callbacks;
    this.open = false;

    this.setupListeners();
  }

  getSavedFilters() {
    return this.kind === 'exclude' ? this.state.savedExcludeFilters : this.state.savedFilters;
  }

  renderDropdown() {
    if (!this.dropdownEl) { return; }
    const html = [];
    for (const filter of this.getSavedFilters()) {
      const esc = Utils.escapeHtml(filter);
      html.push(
        `<div class="filter-dropdown-item" data-value="${esc}">` +
        `<span class="filter-dropdown-text">${esc}</span>` +
        `<button class="filter-dropdown-delete" data-action="delete" data-value="${esc}" title="Delete">\u00d7</button>` +
        `</div>`
      );
    }
    const saveDisabled = this.inputEl && this.inputEl.value.trim() ? '' : ' disabled';
    html.push(
      `<div class="filter-dropdown-item filter-dropdown-save-row">` +
      `<span class="filter-dropdown-text filter-dropdown-save-label"></span>` +
      `<button class="filter-dropdown-save" data-action="save" title="Save current filter"${saveDisabled}>+</button>` +
      `</div>`
    );
    this.dropdownEl.innerHTML = html.join('');
  }

  openDropdown() {
    if (!this.dropdownEl || this.open) { return; }
    this.open = true;
    this.renderDropdown();
    this.dropdownEl.removeAttribute('hidden');
    if (this.toggleEl) {
      this.toggleEl.innerHTML = '&#9650;';
      this.toggleEl.setAttribute('aria-expanded', 'true');
      this.toggleEl.title = 'Hide saved filters';
    }
  }

  closeDropdown() {
    if (!this.dropdownEl || !this.open) { return; }
    this.open = false;
    this.dropdownEl.setAttribute('hidden', '');
    if (this.toggleEl) {
      this.toggleEl.innerHTML = '&#9660;';
      this.toggleEl.setAttribute('aria-expanded', 'false');
      this.toggleEl.title = 'Show saved filters';
    }
  }

  isOpen() {
    return this.open;
  }

  setupListeners() {
    if (this.inputEl) {
      this.inputEl.addEventListener('input', () => {
        if (this.callbacks.debounceTimer) { clearTimeout(this.callbacks.debounceTimer); }
        this.callbacks.setStatus('Filtering...');
        if (this.open) { this.renderDropdown(); }
        this.callbacks.debounceTimer = setTimeout(() => this.callbacks.postFilterChanged(), this.state.debounceMs);
      });

      this.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.open) {
          this.closeDropdown();
          event.preventDefault();
        } else if (event.key === 'Enter' && this.open) {
          if (this.callbacks.debounceTimer) { clearTimeout(this.callbacks.debounceTimer); this.callbacks.debounceTimer = null; }
          this.callbacks.postFilterChanged();
          this.closeDropdown();
          event.preventDefault();
        }
      });
    }

    if (this.toggleEl) {
      this.toggleEl.addEventListener('click', () => {
        if (this.open) { this.closeDropdown(); } else { this.openDropdown(); }
      });
    }

    document.addEventListener('pointerdown', (event) => {
      if (!this.open) { return; }
      const target = event.target;
      if (!(target instanceof Element)) { return; }
      const wrap = this.toggleEl ? this.toggleEl.closest('.filter-wrap') : null;
      if (wrap && wrap.contains(target)) { return; }
      this.closeDropdown();
    });

    if (this.dropdownEl) {
      this.dropdownEl.addEventListener('mousedown', (event) => { event.preventDefault(); });

      this.dropdownEl.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) { return; }

        const deleteBtn = target.closest('[data-action="delete"]');
        if (deleteBtn) {
          this.vscode.postMessage({ type: 'deleteFilter', kind: this.kind, value: deleteBtn.dataset.value ?? '' });
          return;
        }

        if (target.closest('[data-action="save"]')) {
          const val = this.inputEl ? this.inputEl.value : '';
          if (val.trim()) {
            this.vscode.postMessage({ type: 'saveFilter', kind: this.kind, value: val });
          }
          return;
        }

        const item = target.closest('.filter-dropdown-item[data-value]');
        if (item) {
          const val = item.dataset.value ?? '';
          if (this.inputEl) {
            this.inputEl.value = val;
            if (this.callbacks.debounceTimer) { clearTimeout(this.callbacks.debounceTimer); this.callbacks.debounceTimer = null; }
            this.callbacks.postFilterChanged();
          }
          this.vscode.postMessage({ type: 'saveFilter', kind: this.kind, value: val });
          this.closeDropdown();
        }
      });
    }
  }
}
