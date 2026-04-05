// Event handlers and listeners

const setupEventHandlers = (state, dom, scrollManager, renderer, searchManager, cacheManager, vscode, uiHandlers) => {
  const handleWheel = (event) => {
    const maxScrollTop = scrollManager.getMaxScrollTop();
    const horizontalDelta = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (horizontalDelta !== 0) {
      if (dom.hscroll) {
        dom.hscroll.scrollLeft += horizontalDelta;
      }
    }

    let verticalDelta = event.deltaY;
    if (event.shiftKey && event.deltaX === 0) {
      verticalDelta = 0;
    }
    if (maxScrollTop > 0 && verticalDelta !== 0) {
      scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() + verticalDelta);
    }

    if (horizontalDelta !== 0 || (maxScrollTop > 0 && verticalDelta !== 0)) {
      event.preventDefault();
    }
  };

  const handleKeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'g') {
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({
        type: 'requestGotoLine',
        version: state.version
      });
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      if (!searchManager.visible) {
        searchManager.showSearch();
      } else if (searchManager.query) {
        searchManager.doSearchNext('next');
      } else {
        if (dom.searchInput) { dom.searchInput.focus(); }
      }
      return;
    }
    if (Utils.isEditableElement(document.activeElement)) {
      return;
    }
    const lineHeight = scrollManager.getLineHeight();
    const pageDelta = Math.max(lineHeight, scrollManager.getViewportHeight() - lineHeight);
    const pageLines = Math.round(pageDelta / lineHeight);

    const updateCurrentLine = (newIndex) => {
      if (state.modelBusy || state.totalLines <= 0) { return; }
      const clamped = Utils.clamp(newIndex, 0, state.totalLines - 1);
      state.currentLineIndex = clamped;
      const cached = cacheManager.getCachedLine(clamped);
      if (cached) {
        state.currentLine = cached.n;
        state.currentLineExact = true;
      } else {
        state.currentLineExact = false;
      }
    };

    const baseIndex = state.currentLineIndex !== null
      ? state.currentLineIndex
      : Math.floor((scrollManager.getVirtualScrollTop() + scrollManager.getViewportHeight() / 2) / lineHeight);

    switch (event.key) {
      case 'ArrowUp':
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() - lineHeight);
        updateCurrentLine(baseIndex - 1);
        break;
      case 'ArrowDown':
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() + lineHeight);
        updateCurrentLine(baseIndex + 1);
        break;
      case 'PageUp':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() - pageDelta);
        updateCurrentLine(baseIndex - pageLines);
        break;
      case 'PageDown':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() + pageDelta);
        updateCurrentLine(baseIndex + pageLines);
        break;
      case 'Home':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(0);
        updateCurrentLine(0);
        break;
      case 'End':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(scrollManager.getMaxScrollTop());
        updateCurrentLine(state.totalLines - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const handleCurrentLineClick = (event) => {
    if (event.button !== 0) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    if (state.modelBusy) {
      return;
    }
    const lineNumber = Utils.getLineNumberFromElement(event.target);
    if (lineNumber === null) {
      return;
    }
    const filteredIndex = Utils.getFilteredIndexFromElement(event.target);
    if (filteredIndex === null) {
      return;
    }
    uiHandlers.pushHistory(lineNumber);
    state.currentLine = lineNumber;
    state.currentLineIndex = filteredIndex;
    state.currentLineExact = true;
    renderer.scheduleRender();
  };

  const navigateHistory = (delta) => {
    const newIndex = state.historyIndex + delta;
    if (newIndex < 0 || newIndex >= state.history.length) { return; }
    state.historyIndex = newIndex;
    state.currentLine = state.history[newIndex];
    state.currentLineExact = false;
    uiHandlers.requestClosestIndex();
  };

  // Back/forward mouse buttons
  window.addEventListener('mousedown', (event) => {
    if (event.button === 3) { event.preventDefault(); navigateHistory(-1); }
    else if (event.button === 4) { event.preventDefault(); navigateHistory(1); }
  });

  // Wheel events
  if (dom.hscroll) {
    dom.hscroll.addEventListener('wheel', handleWheel, { passive: false });
  } else if (dom.viewport) {
    dom.viewport.addEventListener('wheel', handleWheel, { passive: false });
  }

  // Keyboard events
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', () => {
    scrollManager.updateScrollbar();
    renderer.scheduleRender();
  });

  // Scrollbar drag
  if (dom.scrollbar && dom.scrollbarThumb) {
    let dragging = false;
    let dragStartY = 0;
    let dragStartScrollTop = 0;

    dom.scrollbarThumb.addEventListener('pointerdown', (event) => {
      dragging = true;
      dragStartY = event.clientY;
      dragStartScrollTop = scrollManager.getVirtualScrollTop();
      dom.scrollbarThumb.classList.add('is-dragging');
      dom.scrollbarThumb.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    dom.scrollbarThumb.addEventListener('pointermove', (event) => {
      if (!dragging) {
        return;
      }
      const { maxThumbTop } = scrollManager.getThumbMetrics();
      if (maxThumbTop <= 0) {
        return;
      }
      const deltaY = event.clientY - dragStartY;
      const maxScrollTop = scrollManager.getMaxScrollTop();
      const scrollDelta = (deltaY / maxThumbTop) * maxScrollTop;
      renderer.bumpSerial();
      scrollManager.setVirtualScrollTop(dragStartScrollTop + scrollDelta);
      event.preventDefault();
    });

    const endDrag = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      dom.scrollbarThumb.classList.remove('is-dragging');
      dom.scrollbarThumb.releasePointerCapture(event.pointerId);
      event.preventDefault();
    };

    dom.scrollbarThumb.addEventListener('pointerup', endDrag);
    dom.scrollbarThumb.addEventListener('pointercancel', endDrag);

    dom.scrollbar.addEventListener('pointerdown', (event) => {
      if (event.target === dom.scrollbarThumb) {
        return;
      }
      const rect = dom.scrollbar.getBoundingClientRect();
      const { thumbHeight, maxThumbTop } = scrollManager.getThumbMetrics();
      if (maxThumbTop <= 0) {
        return;
      }
      const clickY = event.clientY - rect.top;
      const thumbTop = Utils.clamp(clickY - thumbHeight / 2, 0, maxThumbTop);
      const maxScrollTop = scrollManager.getMaxScrollTop();
      const ratio = maxThumbTop > 0 ? thumbTop / maxThumbTop : 0;
      renderer.bumpSerial();
      scrollManager.setVirtualScrollTop(ratio * maxScrollTop);
      event.preventDefault();
    });
  }

  // Viewport click — sets the current line
  if (dom.viewport) {
    dom.viewport.addEventListener('mouseup', (event) => {
      handleCurrentLineClick(event);
    });
  }

  // Case buttons
  if (dom.caseButton) {
    dom.caseButton.addEventListener('click', () => {
      uiHandlers.setCaseSensitive(!state.caseSensitive);
      if (uiHandlers.debounceTimer) {
        clearTimeout(uiHandlers.debounceTimer);
        uiHandlers.debounceTimer = null;
      }
      uiHandlers.postFilterChanged();
    });
  }

  if (dom.caseExcludeButton) {
    dom.caseExcludeButton.addEventListener('click', () => {
      uiHandlers.setCaseSensitiveExclude(!state.caseSensitiveExclude);
      if (uiHandlers.debounceTimer) {
        clearTimeout(uiHandlers.debounceTimer);
        uiHandlers.debounceTimer = null;
      }
      uiHandlers.postFilterChanged();
    });
  }

  if (dom.profileToggle && dom.profileDropdown) {
    let profileOpen = false;
    const updateToggleText = (open) => {
      dom.profileName.textContent = (state.activeProfileName ?? '')
      dom.profileArrow.innerHTML = open ? '&#9650;' : '&#9660;';
    };
    const openProfile = () => {
      profileOpen = true;
      dom.profileDropdown.removeAttribute('hidden');
      updateToggleText(true);
    };
    const closeProfile = () => {
      profileOpen = false;
      dom.profileDropdown.setAttribute('hidden', '');
      updateToggleText(false);
    };
    dom.profileToggle.addEventListener('click', () => {
      if (profileOpen) { closeProfile(); } else { openProfile(); }
    });
    dom.profileDropdown.addEventListener('mousedown', (e) => { e.preventDefault(); });
    dom.profileDropdown.addEventListener('click', (event) => {
      const item = event.target.closest('.filter-dropdown-item[data-value]');
      if (!item) { return; }
      state.activeProfileName = item.dataset.value ?? '';
      vscode.postMessage({ type: 'setHighlightProfile', name: state.activeProfileName });
      closeProfile(); // also updates toggle text via updateToggleText
    });
    document.addEventListener('pointerdown', (event) => {
      if (!profileOpen) { return; }
      const target = event.target;
      if (!(target instanceof Element)) { return; }
      const wrap = dom.profileToggle.closest('.profile-wrap');
      if (wrap && wrap.contains(target)) { return; }
      closeProfile();
    });
  }
};

const populateProfileDropdown = (dom, state, profiles, activeProfileName) => {
  if (!dom.profileDropdown) { return; }
  dom.profileDropdown.innerHTML = '';
  for (const name of profiles) {
    const item = document.createElement('div');
    item.className = 'filter-dropdown-item';
    item.dataset.value = name;
    const text = document.createElement('span');
    text.className = 'filter-dropdown-text';
    text.textContent = name;
    item.appendChild(text);
    dom.profileDropdown.appendChild(item);
  }
  state.activeProfileName = activeProfileName ?? null;
  state.profileCount = profiles.length;
  if (dom.profileToggle) {
    dom.profileName.textContent = (state.activeProfileName ?? '')
    dom.profileArrow.innerHTML = '&#9660;';
    dom.profileToggle.hidden = state.modelBusy || profiles.length <= 1;
  }
};

const setupMessageHandler = (state, dom, scrollManager, renderer, searchManager, cacheManager, highlightRules, uiHandlers) => {
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
        state.totalFileLines = 0;
        state.rules = highlightRules.compile(message.rules || []);
        state.debounceMs = message.debounceMs || 250;
        state.maxCachedLines = Math.max(500, Number.parseInt(String(message.maxCachedLines || '20000'), 10) || 20000);
        if (dom.filterInput && typeof message.filterText === 'string') {
          dom.filterInput.value = message.filterText;
        }
        if (dom.excludeFilterInput && typeof message.excludeFilterText === 'string') {
          dom.excludeFilterInput.value = message.excludeFilterText;
        }
        if (typeof message.caseSensitive === 'boolean') {
          state.caseSensitive = message.caseSensitive;
        }
        if (typeof message.caseSensitiveExclude === 'boolean') {
          state.caseSensitiveExclude = message.caseSensitiveExclude;
        }
        uiHandlers.updateCaseUi();
        if (dom.dynamicStyle) {
          dom.dynamicStyle.textContent = message.cssText || '';
        }
        state.savedFilters = Array.isArray(message.savedFilters) ? message.savedFilters : [];
        state.savedExcludeFilters = Array.isArray(message.savedExcludeFilters) ? message.savedExcludeFilters : [];
        populateProfileDropdown(dom, state, Array.isArray(message.profiles) ? message.profiles : [], message.activeProfileName ?? null);
        uiHandlers.setStatus('Loading...');
        uiHandlers.updateStatusCounts();
        scrollManager.setVirtualScrollTop(0);
        scrollManager.updateScrollbar();
        renderer.scheduleRender();
        break;
      }
      case 'reset': {
        state.version = Number.parseInt(String(message.version ?? `${state.version + 1}`), 10);
        state.modelBusy = true;
        if (dom.profileToggle) { dom.profileToggle.hidden = true; }
        state.currentLineIndex = null;
        state.currentLineExact = false;
        cacheManager.clearCache();
        renderer.bumpSerial();
        state.totalLines = 0;
        state.matchedLines = 0;
        state.maxLineNumber = 0;
        scrollManager.setVirtualScrollTop(0);
        searchManager.match = null;
        renderer.scheduleRender();
        uiHandlers.setStatus('Loading...');
        break;
      }
      case 'modelReady': {
        const messageVersion = Number.parseInt(String(message.version ?? '-1'), 10);
        if (messageVersion !== state.version) {
          return;
        }
        state.modelBusy = false;
        state.indexing = false;
        if (dom.profileToggle) { dom.profileToggle.hidden = state.profileCount <= 1; }
        const stats = message.stats || { totalLines: 0, matchedLines: 0, maxLineNumber: 0 };
        state.totalLines = Number.parseInt(String(stats.matchedLines || 0), 10);
        state.matchedLines = state.totalLines;
        state.maxLineNumber = Number.parseInt(String(stats.maxLineNumber || stats.totalLines || 0), 10);
        state.totalFileLines = Number.parseInt(String(stats.totalLines || 0), 10);
        if (state.currentLine !== null) {
          uiHandlers.requestClosestIndex();
        } else {
          scrollManager.setVirtualScrollTop(Utils.clamp(scrollManager.getVirtualScrollTop(), 0, scrollManager.getMaxScrollTop()));
          renderer.scheduleRender();
        }
        uiHandlers.updateStatusCounts();
        uiHandlers.setStatus(state.backendLabel || '-', false);
        scrollManager.updateScrollbar();
        renderer.scheduleRender();
        break;
      }
      case 'progress': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) {
          return;
        }
        const progress = message.progress || {};
        const phase = String(progress.phase || '');
        const processed = Number.parseInt(String(progress.processed ?? '0'), 10);
        const totalRaw = progress.total;
        const total = totalRaw === null || totalRaw === undefined ? null : Number.parseInt(String(totalRaw), 10);
        const matched = Number.parseInt(String(progress.matched ?? '0'), 10);
        const detail = typeof progress.detail === 'string' && progress.detail.length > 0 ? progress.detail : null;

        if (phase === 'indexing') {
          state.indexing = true;
          if (Number.isFinite(total) && total > 0) {
            const pct = Math.min(100, Math.floor((processed / total) * 100));
            uiHandlers.setStatus(`Indexing ${pct}%`);
          } else {
            uiHandlers.setStatus('Indexing...');
          }
          break;
        }

        if (phase === 'filtering') {
          state.indexing = false;
          const backendMatch = detail ? /\b(rg|grep|JS)\b/.exec(detail) : null;
          if (backendMatch) {
            state.backendLabel = backendMatch[1] === 'JS' ? 'js' : backendMatch[1];
          }
          if (dom.statusFilteredNum) { dom.statusFilteredNum.textContent = Utils.formatNumber(matched); }
          if (Number.isFinite(total) && total > 0 && processed > 0) {
            const pct = Math.min(100, Math.floor((processed / total) * 100));
            uiHandlers.setStatus(`${state.backendLabel || 'js'} ${pct}%`);
          } else {
            uiHandlers.setStatus(`${state.backendLabel || 'js'}...`);
          }
        }
        break;
      }
      case 'rangeData': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) {
          return;
        }
        const start = Number.parseInt(String(message.start ?? '0'), 10);
        const count = Number.parseInt(String(message.count ?? '0'), 10);
        const lines = message.lines || [];
        const key = `${version}:${start}:${count}`;
        state.pendingRanges.delete(key);
        for (const line of lines) {
          if (!line || !Number.isFinite(line.i)) {
            continue;
          }
          cacheManager.addCachedLine(line.i, { n: line.n, t: String(line.t ?? '') });
        }
        renderer.scheduleRender();
        break;
      }
      case 'closestIndexResult': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) {
          return;
        }
        const index = Number.parseInt(String(message.index ?? '-1'), 10);
        const exact = Boolean(message.exact);
        state.currentLineIndex = index >= 0 ? index : null;
        state.currentLineExact = exact && index >= 0;
        if (index >= 0) {
          scrollManager.scrollToLineIndex(index);
        }
        renderer.scheduleRender();
        break;
      }
      case 'settingsUpdated': {
        if (typeof message.debounceMs === 'number') { state.debounceMs = message.debounceMs; }
        if (typeof message.maxCachedLines === 'number') { state.maxCachedLines = Math.max(500, message.maxCachedLines); }
        if (Array.isArray(message.savedFilters)) { state.savedFilters = message.savedFilters; }
        if (Array.isArray(message.savedExcludeFilters)) { state.savedExcludeFilters = message.savedExcludeFilters; }
        state.rules = highlightRules.compile(message.rules || []);
        if (dom.dynamicStyle) { dom.dynamicStyle.textContent = message.cssText || ''; }
        populateProfileDropdown(dom, state, Array.isArray(message.profiles) ? message.profiles : [], message.activeProfileName ?? null);
        renderer.scheduleRender();
        break;
      }
      case 'rulesUpdated': {
        state.rules = highlightRules.compile(message.rules || []);
        if (dom.dynamicStyle) {
          dom.dynamicStyle.textContent = message.cssText || '';
        }
        renderer.scheduleRender();
        break;
      }
      case 'savedFiltersUpdated': {
        if (message.kind === 'exclude') {
          state.savedExcludeFilters = Array.isArray(message.filters) ? message.filters : [];
          if (uiHandlers.excludeWidget.isOpen()) { uiHandlers.excludeWidget.renderDropdown(); }
        } else {
          state.savedFilters = Array.isArray(message.filters) ? message.filters : [];
          if (uiHandlers.includeWidget.isOpen()) { uiHandlers.includeWidget.renderDropdown(); }
        }
        break;
      }
      case 'searchResult': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) { return; }
        searchManager.searching = false;
        if (message.found) {
          const filteredIndex = Number.parseInt(String(message.filteredIndex ?? '0'), 10);
          const lineNumber = Number.parseInt(String(message.lineNumber ?? '-1'), 10);
          searchManager.match = {
            filteredIndex,
            matchStart: Number.parseInt(String(message.matchStart ?? '0'), 10),
            matchLength: Number.parseInt(String(message.matchLength ?? '0'), 10)
          };
          if (lineNumber > 0) {
            uiHandlers.pushHistory(lineNumber);
            state.currentLine = lineNumber;
            state.currentLineIndex = filteredIndex;
            state.currentLineExact = true;
          }
          searchManager.pendingHScroll = true;
          scrollManager.scrollToLineIndex(filteredIndex);
          if (dom.searchStatus) { dom.searchStatus.textContent = ''; }
          renderer.scheduleRender();
        } else {
          searchManager.match = null;
          if (dom.searchStatus) { dom.searchStatus.textContent = 'No results'; }
          renderer.scheduleRender();
        }
        break;
      }
      case 'gotoLine': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) { return; }
        const index = Number.parseInt(String(message.index ?? '-1'), 10);
        if (index >= 0) {
          scrollManager.scrollToLineIndex(index);
          renderer.scheduleRender();
        }
        break;
      }
      case 'error': {
        uiHandlers.setStatus(message.message || 'Error');
        break;
      }
      default:
        break;
    }
  });
};
