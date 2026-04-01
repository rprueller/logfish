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
      scrollManager.rememberCenterLine();
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
    switch (event.key) {
      case 'ArrowUp':
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() - lineHeight);
        break;
      case 'ArrowDown':
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() + lineHeight);
        scrollManager.rememberCenterLine();
        break;
      case 'PageUp':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() - pageDelta);
        scrollManager.rememberCenterLine();
        break;
      case 'PageDown':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(scrollManager.getVirtualScrollTop() + pageDelta);
        scrollManager.rememberCenterLine();
        break;
      case 'Home':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(0);
        scrollManager.rememberCenterLine();
        break;
      case 'End':
        renderer.bumpSerial();
        scrollManager.setVirtualScrollTop(scrollManager.getMaxScrollTop());
        scrollManager.rememberCenterLine();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

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
      scrollManager.rememberCenterLine();
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
      scrollManager.rememberCenterLine();
      event.preventDefault();
    });
  }

  // Viewport selection
  if (dom.viewport) {
    dom.viewport.addEventListener('mouseup', (event) => {
      if (scrollManager.rememberLineFromSelection()) {
        return;
      }
      scrollManager.rememberLineFromEvent(event);
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
};

const setupMessageHandler = (state, dom, scrollManager, renderer, searchManager, cacheManager, highlightRules, vscode, uiHandlers) => {
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
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
        if (dom.dynamicStyleEl) {
          dom.dynamicStyleEl.textContent = message.cssText || '';
        }
        state.savedFilters = Array.isArray(message.savedFilters) ? message.savedFilters : [];
        state.savedExcludeFilters = Array.isArray(message.savedExcludeFilters) ? message.savedExcludeFilters : [];
        uiHandlers.setStatus('Loading…');
        if (dom.statusTotalEl) { dom.statusTotalEl.textContent = '…'; }
        if (dom.statusFilteredEl) { dom.statusFilteredEl.textContent = '…'; }
        scrollManager.setVirtualScrollTop(0);
        scrollManager.updateScrollbar();
        renderer.scheduleRender();
        break;
      }
      case 'reset': {
        state.version = Number.parseInt(String(message.version ?? `${state.version + 1}`), 10);
        cacheManager.clearCache();
        renderer.bumpSerial();
        state.totalLines = 0;
        state.matchedLines = 0;
        state.maxLineNumber = 0;
        scrollManager.setVirtualScrollTop(0);
        searchManager.match = null;
        renderer.scheduleRender();
        uiHandlers.setStatus('Loading…');
        break;
      }
      case 'modelReady': {
        const messageVersion = Number.parseInt(String(message.version ?? '-1'), 10);
        if (messageVersion !== state.version) {
          return;
        }
        state.indexing = false;
        const stats = message.stats || { totalLines: 0, matchedLines: 0, maxLineNumber: 0 };
        state.totalLines = Number.parseInt(String(stats.matchedLines || 0), 10);
        state.matchedLines = state.totalLines;
        state.maxLineNumber = Number.parseInt(String(stats.maxLineNumber || stats.totalLines || 0), 10);
        state.totalFileLines = Number.parseInt(String(stats.totalLines || 0), 10);

        if (scrollManager.getPendingScrollToRemembered()) {
          uiHandlers.requestClosestIndex();
        } else {
          scrollManager.setVirtualScrollTop(Utils.clamp(scrollManager.getVirtualScrollTop(), 0, scrollManager.getMaxScrollTop()));
          renderer.scheduleRender();
        }

        uiHandlers.updateStatusCounts();
        uiHandlers.setStatus(state.backendLabel || '—');
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
            uiHandlers.setStatus('Indexing…');
          }
          break;
        }

        if (phase === 'filtering') {
          state.indexing = false;
          const backendMatch = detail ? /\b(rg|grep|JS)\b/.exec(detail) : null;
          if (backendMatch) {
            state.backendLabel = backendMatch[1] === 'JS' ? 'js' : backendMatch[1];
          }
          if (dom.statusFilteredEl) { dom.statusFilteredEl.textContent = `${Utils.formatNumber(matched)}\u00a0matched`; }
          if (Number.isFinite(total) && total > 0 && processed > 0) {
            const pct = Math.min(100, Math.floor((processed / total) * 100));
            uiHandlers.setStatus(`${state.backendLabel || 'js'} ${pct}%`);
          } else {
            uiHandlers.setStatus(`${state.backendLabel || 'js'}…`);
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
        scrollManager.setPendingScrollToRemembered(false);
        if (index >= 0) {
          scrollManager.scrollToLineIndex(index);
        }
        renderer.scheduleRender();
        break;
      }
      case 'rulesUpdated': {
        state.rules = highlightRules.compile(message.rules || []);
        if (dom.dynamicStyleEl) {
          dom.dynamicStyleEl.textContent = message.cssText || '';
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
          searchManager.match = {
            filteredIndex: Number.parseInt(String(message.filteredIndex ?? '0'), 10),
            matchStart: Number.parseInt(String(message.matchStart ?? '0'), 10),
            matchLength: Number.parseInt(String(message.matchLength ?? '0'), 10)
          };
          searchManager.pendingHScroll = true;
          scrollManager.scrollToLineIndex(searchManager.match.filteredIndex);
          if (dom.searchStatusEl) { dom.searchStatusEl.textContent = ''; }
          renderer.scheduleRender();
        } else {
          searchManager.match = null;
          if (dom.searchStatusEl) { dom.searchStatusEl.textContent = 'No results'; }
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
