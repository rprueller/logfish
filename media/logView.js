(() => {
  const vscode = acquireVsCodeApi();

  const filterInput = document.getElementById('filterInput');
  const statusEl = document.getElementById('status');
  const viewport = document.getElementById('viewport');
  const hscroll = document.getElementById('hscroll');
  const rows = document.getElementById('rows');
  const scrollbar = document.getElementById('scrollbar');
  const scrollbarThumb = document.getElementById('scrollbarThumb');
  const dynamicStyleEl = document.getElementById('dynamicStyles');
  const layoutStyleEl = document.getElementById('layoutStyles');
  const caseButton = document.getElementById('caseInclude');
  const caseExcludeButton = document.getElementById('caseExclude');
  const filterDropdown = document.getElementById('filterDropdown');
  const filterToggle = document.getElementById('filterToggle');
  const excludeFilterInput = document.getElementById('excludeFilterInput');
  const excludeFilterDropdown = document.getElementById('excludeFilterDropdown');
  const excludeFilterToggle = document.getElementById('excludeFilterToggle');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  const searchStatusEl = document.getElementById('searchStatus');
  const searchPrevBtn = document.getElementById('searchPrevBtn');
  const searchNextBtn = document.getElementById('searchNextBtn');
  const searchCloseBtn = document.getElementById('searchCloseBtn');

  const OVERSCAN_ROWS = 20;
  const FETCH_CHUNK_SIZE = 300;
  const PREFETCH_PADDING = 250;

  const state = {
    rules: [],
    debounceMs: 250,
    caseSensitive: false,
    caseSensitiveExclude: false,
    maxCachedLines: 20000,
    version: 0,
    totalLines: 0,
    matchedLines: 0,
    maxLineNumber: 0,
    cache: new Map(),
    pendingRanges: new Set(),
    savedFilters: [],
    savedExcludeFilters: []
  };

  let renderScheduled = false;
  let debounceTimer = null;
  let virtualScrollTop = 0;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;
  let rememberedLine = null;
  let pendingScrollToRemembered = false;

  const search = {
    visible: false,
    query: '',
    caseSensitive: false,
    match: null,   // { filteredIndex, matchStart, matchLength } | null
    searching: false,
    pendingHScroll: false
  };

  const escapeHtml = (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const setStatus = (message) => {
    statusEl.textContent = message;
  };

  const formatNumber = (value) => {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return Math.max(0, Math.trunc(value)).toLocaleString();
  };

  const updateCaseUi = () => {
    if (caseButton) {
      caseButton.classList.toggle('is-active', state.caseSensitive);
      caseButton.setAttribute('aria-pressed', String(state.caseSensitive));
    }
    if (caseExcludeButton) {
      caseExcludeButton.classList.toggle('is-active', state.caseSensitiveExclude);
      caseExcludeButton.setAttribute('aria-pressed', String(state.caseSensitiveExclude));
    }
  };

  const setCaseSensitive = (value) => {
    state.caseSensitive = value;
    updateCaseUi();
  };

  const setCaseSensitiveExclude = (value) => {
    state.caseSensitiveExclude = value;
    updateCaseUi();
  };

  const clearCache = () => {
    state.cache.clear();
    state.pendingRanges.clear();
  };

  const getCachedLine = (index) => {
    if (!state.cache.has(index)) {
      return null;
    }
    const value = state.cache.get(index);
    state.cache.delete(index);
    state.cache.set(index, value);
    return value;
  };

  const addCachedLine = (index, value) => {
    if (state.cache.has(index)) {
      state.cache.delete(index);
    }
    state.cache.set(index, value);
    while (state.cache.size > state.maxCachedLines) {
      const oldestKey = state.cache.keys().next().value;
      state.cache.delete(oldestKey);
    }
  };

  // ---------------------------------------------------------------------------
  // Generic filter-widget factory
  // kind: 'include' | 'exclude'
  // ---------------------------------------------------------------------------
  const makeFilterWidget = (inputEl, toggleEl, dropdownEl, kind) => {
    let open = false;

    const getSavedFilters = () =>
      kind === 'exclude' ? state.savedExcludeFilters : state.savedFilters;

    const renderDropdown = () => {
      if (!dropdownEl) { return; }
      const html = [];
      for (const filter of getSavedFilters()) {
        const esc = escapeHtml(filter);
        html.push(
          `<div class="filter-dropdown-item" data-value="${esc}">` +
          `<span class="filter-dropdown-text">${esc}</span>` +
          `<button class="filter-dropdown-delete" data-action="delete" data-value="${esc}" title="Delete">\u00d7</button>` +
          `</div>`
        );
      }
      const saveDisabled = inputEl && inputEl.value.trim() ? '' : ' disabled';
      html.push(
        `<div class="filter-dropdown-item filter-dropdown-save-row">` +
        `<span class="filter-dropdown-text filter-dropdown-save-label"></span>` +
        `<button class="filter-dropdown-save" data-action="save" title="Save current filter"${saveDisabled}>+</button>` +
        `</div>`
      );
      dropdownEl.innerHTML = html.join('');
    };

    const openDropdown = () => {
      if (!dropdownEl || open) { return; }
      open = true;
      renderDropdown();
      dropdownEl.removeAttribute('hidden');
      if (toggleEl) {
        toggleEl.innerHTML = '&#9650;';
        toggleEl.setAttribute('aria-expanded', 'true');
        toggleEl.title = 'Hide saved filters';
      }
    };

    const closeDropdown = () => {
      if (!dropdownEl || !open) { return; }
      open = false;
      dropdownEl.setAttribute('hidden', '');
      if (toggleEl) {
        toggleEl.innerHTML = '&#9660;';
        toggleEl.setAttribute('aria-expanded', 'false');
        toggleEl.title = 'Show saved filters';
      }
    };

    const isOpen = () => open;

    if (inputEl) {
      inputEl.addEventListener('input', () => {
        if (debounceTimer) { clearTimeout(debounceTimer); }
        setStatus('Filtering...');
        if (open) { renderDropdown(); }
        debounceTimer = setTimeout(postFilterChanged, state.debounceMs);
      });

      inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && open) {
          closeDropdown();
          event.preventDefault();
        } else if (event.key === 'Enter' && open) {
          if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
          postFilterChanged();
          closeDropdown();
          event.preventDefault();
        }
      });
    }

    if (toggleEl) {
      toggleEl.addEventListener('click', () => {
        if (open) { closeDropdown(); } else { openDropdown(); }
      });
    }

    document.addEventListener('pointerdown', (event) => {
      if (!open) { return; }
      const target = event.target;
      if (!(target instanceof Element)) { return; }
      const wrap = toggleEl ? toggleEl.closest('.filter-wrap') : null;
      if (wrap && wrap.contains(target)) { return; }
      closeDropdown();
    });

    if (dropdownEl) {
      dropdownEl.addEventListener('mousedown', (event) => { event.preventDefault(); });

      dropdownEl.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) { return; }

        const deleteBtn = target.closest('[data-action="delete"]');
        if (deleteBtn) {
          vscode.postMessage({ type: 'deleteFilter', kind, value: deleteBtn.dataset.value ?? '' });
          return;
        }

        if (target.closest('[data-action="save"]')) {
          const val = inputEl ? inputEl.value : '';
          if (val.trim()) {
            vscode.postMessage({ type: 'saveFilter', kind, value: val });
          }
          return;
        }

        const item = target.closest('.filter-dropdown-item[data-value]');
        if (item) {
          const val = item.dataset.value ?? '';
          if (inputEl) {
            inputEl.value = val;
            if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
            postFilterChanged();
          }
          vscode.postMessage({ type: 'saveFilter', kind, value: val });
          closeDropdown();
        }
      });
    }

    return { openDropdown, closeDropdown, isOpen, renderDropdown };
  };

  // Post the current state of both filters to the extension host.
  const postFilterChanged = () => {
    if (!Number.isFinite(rememberedLine)) {
      rememberCenterLine();
    }
    pendingScrollToRemembered = Number.isFinite(rememberedLine);
    vscode.postMessage({
      type: 'filterChanged',
      value: filterInput ? filterInput.value : '',
      excludeValue: excludeFilterInput ? excludeFilterInput.value : '',
      caseSensitive: state.caseSensitive,
      caseSensitiveExclude: state.caseSensitiveExclude
    });
  };

  const includeWidget = makeFilterWidget(filterInput, filterToggle, filterDropdown, 'include');
  const excludeWidget = makeFilterWidget(excludeFilterInput, excludeFilterToggle, excludeFilterDropdown, 'exclude');

  const compileRules = (rules) => {
    const compiled = [];
    for (const rule of rules) {
      if (!rule || !rule.pattern) {
        continue;
      }
      const flags = rule.patternIgnoreCase ? 'ig' : 'g';
      try {
        const regex = new RegExp(rule.pattern, flags);
        const className = typeof rule.className === 'string' ? rule.className : '';
        compiled.push({ regex, className });
      } catch {
        // Ignore invalid rules.
      }
    }
    return compiled;
  };

  const checkRules = (text) => {
    if (!state.rules.length || text.length === 0) {
      return -1;
    }
    for (let i = 0; i < state.rules.length; i++) {
      const rule = state.rules[i];
      rule.regex.lastIndex = 0;
      if (rule.regex.test(text)) {
        return i;
      }
    }
    return -1;
  };

  const renderTextRow = (index, line) => {
    if (!line) {
      return `<div class="row row-placeholder" data-index="${index}"><span class="ln"></span><span class="txt"></span></div>`;
    }
    const ruleIndex = checkRules(line.t);
    const className = ruleIndex >= 0 ? state.rules[ruleIndex].className : '';
    const classes = className ? `row ${className}` : 'row';
    let txtHtml;
    if (search.match && search.match.filteredIndex === index) {
      const { matchStart, matchLength } = search.match;
      const before = escapeHtml(line.t.slice(0, matchStart));
      const matched = escapeHtml(line.t.slice(matchStart, matchStart + matchLength));
      const after = escapeHtml(line.t.slice(matchStart + matchLength));
      txtHtml = `${before}<span class="search-match">${matched}</span>${after}`;
    } else {
      txtHtml = escapeHtml(line.t);
    }
    return `<div class="${classes}" data-line="${line.n}" data-index="${index}"><span class="ln">${line.n}</span><span class="txt">${txtHtml}</span></div>`;
  };

  const getLineHeight = () => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--line-height');
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 20;
  };

  const getViewportHeight = () => (hscroll ? hscroll.clientHeight : viewport.clientHeight);

  const getTotalHeight = () => state.totalLines * getLineHeight();

  const getMaxScrollTop = () => Math.max(0, getTotalHeight() - getViewportHeight());

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const setVirtualScrollTop = (value) => {
    const maxScrollTop = getMaxScrollTop();
    const next = clamp(value, 0, maxScrollTop);
    if (next === virtualScrollTop) {
      return;
    }
    virtualScrollTop = next;
    scheduleRender();
    updateScrollbar();
  };

  const rememberLine = (lineNumber) => {
    if (!Number.isFinite(lineNumber)) {
      return;
    }
    rememberedLine = lineNumber;
  };

  const rememberCenterLine = () => {
    if (state.totalLines === 0) {
      return;
    }
    const lineHeight = getLineHeight();
    const center = virtualScrollTop + getViewportHeight() / 2;
    const index = clamp(Math.floor(center / lineHeight), 0, state.totalLines - 1);
    const line = getCachedLine(index);
    if (line) {
      rememberLine(line.n);
    }
  };

  const getLineNumberFromElement = (element) => {
    if (!element || typeof element.closest !== 'function') {
      return null;
    }
    const row = element.closest('.row');
    if (!row || !row.dataset) {
      return null;
    }
    const lineNumber = Number.parseInt(row.dataset.line || '', 10);
    return Number.isFinite(lineNumber) ? lineNumber : null;
  };

  const isEditableElement = (element) => {
    if (!element) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const getLineNumberFromNode = (node) => {
    if (!node) {
      return null;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return getLineNumberFromElement(element);
  };

  const rememberLineFromEvent = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return false;
    }
    const lineNumber = getLineNumberFromElement(target);
    if (!Number.isFinite(lineNumber)) {
      return false;
    }
    rememberLine(lineNumber);
    return true;
  };

  const rememberLineFromSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }
    const range = selection.getRangeAt(0);
    const lineNumber = getLineNumberFromNode(range.startContainer);
    if (!Number.isFinite(lineNumber)) {
      return false;
    }
    rememberLine(lineNumber);
    return true;
  };

  const requestClosestIndex = () => {
    if (!pendingScrollToRemembered || !Number.isFinite(rememberedLine)) {
      return;
    }
    vscode.postMessage({
      type: 'requestClosestIndex',
      lineNumber: rememberedLine,
      version: state.version
    });
  };

  const scrollToLineIndex = (index) => {
    if (!Number.isFinite(index) || index < 0) {
      return;
    }
    const lineHeight = getLineHeight();
    const targetTop = index * lineHeight - (getViewportHeight() / 2 - lineHeight / 2);
    setVirtualScrollTop(targetTop);
  };

  const getThumbMetrics = () => {
    const trackHeight = scrollbar ? scrollbar.clientHeight : 0;
    const totalHeight = getTotalHeight();
    if (trackHeight <= 0 || totalHeight <= 0) {
      return { trackHeight, thumbHeight: trackHeight, maxThumbTop: 0 };
    }
    const viewHeight = getViewportHeight();
    const ratio = viewHeight / totalHeight;
    const thumbHeight = clamp(Math.round(trackHeight * ratio), 20, trackHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    return { trackHeight, thumbHeight, maxThumbTop };
  };

  const updateScrollbar = () => {
    if (!scrollbar || !scrollbarThumb) {
      return;
    }
    const maxScrollTop = getMaxScrollTop();
    const { thumbHeight, maxThumbTop } = getThumbMetrics();
    scrollbarThumb.style.height = `${thumbHeight}px`;
    if (maxScrollTop <= 0 || maxThumbTop <= 0) {
      scrollbarThumb.style.transform = 'translateY(0px)';
      return;
    }
    const thumbTop = maxThumbTop * (virtualScrollTop / maxScrollTop);
    scrollbarThumb.style.transform = `translateY(${thumbTop}px)`;
  };

  const requestRange = (start, count) => {
    if (count <= 0 || state.totalLines <= 0) {
      return;
    }
    const safeStart = clamp(start, 0, Math.max(0, state.totalLines - 1));
    const safeCount = Math.min(count, state.totalLines - safeStart);
    if (safeCount <= 0) {
      return;
    }
    const key = `${state.version}:${safeStart}:${safeCount}`;
    if (state.pendingRanges.has(key)) {
      return;
    }
    state.pendingRanges.add(key);
    vscode.postMessage({
      type: 'requestRange',
      start: safeStart,
      count: safeCount,
      version: state.version
    });
  };

  const ensureRangeLoaded = (start, endExclusive) => {
    if (state.totalLines <= 0) {
      return;
    }
    const safeStart = clamp(start, 0, state.totalLines);
    const safeEnd = clamp(endExclusive, 0, state.totalLines);
    if (safeStart >= safeEnd) {
      return;
    }

    let missingStart = -1;
    let missingCount = 0;

    for (let i = safeStart; i < safeEnd; i += 1) {
      const hasLine = state.cache.has(i);
      if (!hasLine) {
        if (missingStart < 0) {
          missingStart = i;
          missingCount = 1;
        } else {
          missingCount += 1;
        }

        if (missingCount >= FETCH_CHUNK_SIZE) {
          requestRange(missingStart, missingCount);
          missingStart = -1;
          missingCount = 0;
        }
      } else if (missingStart >= 0) {
        requestRange(missingStart, missingCount);
        missingStart = -1;
        missingCount = 0;
      }
    }

    if (missingStart >= 0) {
      requestRange(missingStart, missingCount);
    }
  };

  const render = () => {
    renderScheduled = false;

    const lineHeight = getLineHeight();
    const total = state.totalLines;
    const height = getViewportHeight();

    const start = Math.max(0, Math.floor(virtualScrollTop / lineHeight) - OVERSCAN_ROWS);
    const end = Math.min(total, Math.ceil((virtualScrollTop + height) / lineHeight) + OVERSCAN_ROWS);

    if (layoutStyleEl) {
      const offset = start * lineHeight - virtualScrollTop;
      layoutStyleEl.textContent = `#rows { top: ${offset}px; }`;
    }

    const prefetchStart = Math.max(0, start - PREFETCH_PADDING);
    const prefetchEnd = Math.min(total, end + PREFETCH_PADDING);
    ensureRangeLoaded(prefetchStart, prefetchEnd);

    const maxDigits = Math.max(1, String(Math.max(state.maxLineNumber, 1)).length);
    const textHtml = [];

    for (let i = start; i < end; i += 1) {
      textHtml.push(renderTextRow(i, getCachedLine(i)));
    }

    if (viewport) {
      viewport.style.setProperty('--ln-digits', String(maxDigits));
    }

    rows.innerHTML = textHtml.join('');

    if (search.pendingHScroll) {
      search.pendingHScroll = false;
      if (hscroll) {
        const matchEl = rows.querySelector('.search-match');
        if (matchEl) {
          const hRect = hscroll.getBoundingClientRect();
          const mRect = matchEl.getBoundingClientRect();
          const lnEl = rows.querySelector('.ln');
          const lnWidth = lnEl ? lnEl.offsetWidth : 0;
          const leftPad = lnWidth + 8;
          const rightPad = 40;
          const relLeft = mRect.left - hRect.left + hscroll.scrollLeft;
          const relRight = relLeft + mRect.width;
          const viewLeft = hscroll.scrollLeft;
          const viewRight = viewLeft + hscroll.clientWidth;
          if (relLeft < viewLeft + leftPad) {
            hscroll.scrollLeft = Math.max(0, relLeft - leftPad);
          } else if (relRight > viewRight - rightPad) {
            hscroll.scrollLeft = relRight - hscroll.clientWidth + rightPad;
          }
        }
      }
    }

    updateScrollbar();
  };

  const scheduleRender = () => {
    if (renderScheduled) {
      return;
    }
    renderScheduled = true;
    requestAnimationFrame(render);
  };

  const handleWheel = (event) => {
    const maxScrollTop = getMaxScrollTop();
    const horizontalDelta = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (horizontalDelta !== 0) {
      if (hscroll) {
        hscroll.scrollLeft += horizontalDelta;
      }
    }

    let verticalDelta = event.deltaY;
    if (event.shiftKey && event.deltaX === 0) {
      verticalDelta = 0;
    }
    if (maxScrollTop > 0 && verticalDelta !== 0) {
      setVirtualScrollTop(virtualScrollTop + verticalDelta);
      rememberCenterLine();
    }

    if (horizontalDelta !== 0 || (maxScrollTop > 0 && verticalDelta !== 0)) {
      event.preventDefault();
    }
  };

  const handleKeydown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      event.stopPropagation();
      if (!search.visible) {
        showSearch();
      } else if (search.query) {
        doSearchNext('next');
      } else {
        if (searchInput) { searchInput.focus(); }
      }
      return;
    }
    if (isEditableElement(document.activeElement)) {
      return;
    }
    const lineHeight = getLineHeight();
    const pageDelta = Math.max(lineHeight, getViewportHeight() - lineHeight);
    switch (event.key) {
      case 'ArrowUp':
        setVirtualScrollTop(virtualScrollTop - lineHeight);
        break;
      case 'ArrowDown':
        setVirtualScrollTop(virtualScrollTop + lineHeight);
        break;
      case 'PageUp':
        setVirtualScrollTop(virtualScrollTop - pageDelta);
        break;
      case 'PageDown':
        setVirtualScrollTop(virtualScrollTop + pageDelta);
        break;
      case 'Home':
        setVirtualScrollTop(0);
        break;
      case 'End':
        setVirtualScrollTop(getMaxScrollTop());
        break;
      default:
        return;
    }
    rememberCenterLine();
    event.preventDefault();
  };

  if (hscroll) {
    hscroll.addEventListener('wheel', handleWheel, { passive: false });
  } else {
    viewport.addEventListener('wheel', handleWheel, { passive: false });
  }

  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('resize', () => {
    updateScrollbar();
    scheduleRender();
  });

  if (scrollbar && scrollbarThumb) {
    scrollbarThumb.addEventListener('pointerdown', (event) => {
      dragging = true;
      dragStartY = event.clientY;
      dragStartScrollTop = virtualScrollTop;
      scrollbarThumb.classList.add('is-dragging');
      scrollbarThumb.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    scrollbarThumb.addEventListener('pointermove', (event) => {
      if (!dragging) {
        return;
      }
      const { maxThumbTop } = getThumbMetrics();
      if (maxThumbTop <= 0) {
        return;
      }
      const deltaY = event.clientY - dragStartY;
      const maxScrollTop = getMaxScrollTop();
      const scrollDelta = (deltaY / maxThumbTop) * maxScrollTop;
      setVirtualScrollTop(dragStartScrollTop + scrollDelta);
      rememberCenterLine();
      event.preventDefault();
    });

    const endDrag = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      scrollbarThumb.classList.remove('is-dragging');
      scrollbarThumb.releasePointerCapture(event.pointerId);
      event.preventDefault();
    };

    scrollbarThumb.addEventListener('pointerup', endDrag);
    scrollbarThumb.addEventListener('pointercancel', endDrag);

    scrollbar.addEventListener('pointerdown', (event) => {
      if (event.target === scrollbarThumb) {
        return;
      }
      const rect = scrollbar.getBoundingClientRect();
      const { thumbHeight, maxThumbTop } = getThumbMetrics();
      if (maxThumbTop <= 0) {
        return;
      }
      const clickY = event.clientY - rect.top;
      const thumbTop = clamp(clickY - thumbHeight / 2, 0, maxThumbTop);
      const maxScrollTop = getMaxScrollTop();
      const ratio = maxThumbTop > 0 ? thumbTop / maxThumbTop : 0;
      setVirtualScrollTop(ratio * maxScrollTop);
      rememberCenterLine();
      event.preventDefault();
    });
  }

  if (viewport) {
    viewport.addEventListener('mouseup', (event) => {
      if (rememberLineFromSelection()) {
        return;
      }
      rememberLineFromEvent(event);
    });
  }

  if (caseButton) {
    caseButton.addEventListener('click', () => {
      setCaseSensitive(!state.caseSensitive);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      setStatus('Filtering...');
      postFilterChanged();
    });
  }

  if (caseExcludeButton) {
    caseExcludeButton.addEventListener('click', () => {
      setCaseSensitiveExclude(!state.caseSensitiveExclude);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      setStatus('Filtering...');
      postFilterChanged();
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
        state.rules = compileRules(message.rules || []);
        state.debounceMs = message.debounceMs || 250;
        state.maxCachedLines = Math.max(500, Number.parseInt(String(message.maxCachedLines || '20000'), 10) || 20000);
        if (filterInput && typeof message.filterText === 'string') {
          filterInput.value = message.filterText;
        }
        if (excludeFilterInput && typeof message.excludeFilterText === 'string') {
          excludeFilterInput.value = message.excludeFilterText;
        }
        if (typeof message.caseSensitive === 'boolean') {
          state.caseSensitive = message.caseSensitive;
        }
        if (typeof message.caseSensitiveExclude === 'boolean') {
          state.caseSensitiveExclude = message.caseSensitiveExclude;
        }
        updateCaseUi();
        if (dynamicStyleEl) {
          dynamicStyleEl.textContent = message.cssText || '';
        }
        state.savedFilters = Array.isArray(message.savedFilters) ? message.savedFilters : [];
        state.savedExcludeFilters = Array.isArray(message.savedExcludeFilters) ? message.savedExcludeFilters : [];
        setStatus('Loading...');
        virtualScrollTop = 0;
        updateScrollbar();
        scheduleRender();
        break;
      }
      case 'reset': {
        state.version = Number.parseInt(String(message.version ?? `${state.version + 1}`), 10);
        clearCache();
        state.totalLines = 0;
        state.matchedLines = 0;
        state.maxLineNumber = 0;
        virtualScrollTop = 0;
        search.match = null;
        scheduleRender();
        setStatus('Loading...');
        break;
      }
      case 'modelReady': {
        const messageVersion = Number.parseInt(String(message.version ?? '-1'), 10);
        if (messageVersion !== state.version) {
          return;
        }
        const stats = message.stats || { totalLines: 0, matchedLines: 0, maxLineNumber: 0 };
        state.totalLines = Number.parseInt(String(stats.matchedLines || 0), 10);
        state.matchedLines = state.totalLines;
        state.maxLineNumber = Number.parseInt(String(stats.maxLineNumber || stats.totalLines || 0), 10);

        if (pendingScrollToRemembered) {
          requestClosestIndex();
        } else {
          virtualScrollTop = clamp(virtualScrollTop, 0, getMaxScrollTop());
          scheduleRender();
        }

        setStatus(`${state.matchedLines} lines`);
        updateScrollbar();
        scheduleRender();
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
          if (Number.isFinite(total) && total > 0) {
            const pct = Math.min(100, Math.floor((processed / total) * 100));
            setStatus(`Indexing ${pct}% (${formatNumber(processed)}/${formatNumber(total)} bytes)`);
          } else {
            setStatus(detail || 'Indexing...');
          }
          break;
        }

        if (phase === 'filtering') {
          if (Number.isFinite(total) && total > 0 && processed > 0) {
            const pct = Math.min(100, Math.floor((processed / total) * 100));
            setStatus(`Filtering ${pct}% (${formatNumber(matched)} matches)`);
          } else {
            setStatus(detail ? `${detail} (${formatNumber(matched)} matches)` : `Filtering... (${formatNumber(matched)} matches)`);
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
          addCachedLine(line.i, { n: line.n, t: String(line.t ?? '') });
        }
        scheduleRender();
        break;
      }
      case 'closestIndexResult': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) {
          return;
        }
        const index = Number.parseInt(String(message.index ?? '-1'), 10);
        pendingScrollToRemembered = false;
        if (index >= 0) {
          scrollToLineIndex(index);
        }
        scheduleRender();
        break;
      }
      case 'rulesUpdated': {
        state.rules = compileRules(message.rules || []);
        if (dynamicStyleEl) {
          dynamicStyleEl.textContent = message.cssText || '';
        }
        scheduleRender();
        break;
      }
      case 'savedFiltersUpdated': {
        if (message.kind === 'exclude') {
          state.savedExcludeFilters = Array.isArray(message.filters) ? message.filters : [];
          if (excludeWidget.isOpen()) { excludeWidget.renderDropdown(); }
        } else {
          state.savedFilters = Array.isArray(message.filters) ? message.filters : [];
          if (includeWidget.isOpen()) { includeWidget.renderDropdown(); }
        }
        break;
      }
      case 'searchResult': {
        const version = Number.parseInt(String(message.version ?? '-1'), 10);
        if (version !== state.version) { return; }
        search.searching = false;
        if (message.found) {
          search.match = {
            filteredIndex: Number.parseInt(String(message.filteredIndex ?? '0'), 10),
            matchStart: Number.parseInt(String(message.matchStart ?? '0'), 10),
            matchLength: Number.parseInt(String(message.matchLength ?? '0'), 10)
          };
          search.pendingHScroll = true;
          scrollToLineIndex(search.match.filteredIndex);
          if (searchStatusEl) { searchStatusEl.textContent = ''; }
          scheduleRender();
        } else {
          search.match = null;
          if (searchStatusEl) { searchStatusEl.textContent = 'No results'; }
          scheduleRender();
        }
        break;
      }
      case 'error': {
        setStatus(message.message || 'Error');
        break;
      }
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  const showSearch = () => {
    if (!searchBox) { return; }
    search.visible = true;
    searchBox.removeAttribute('hidden');
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  };

  const hideSearch = () => {
    if (!searchBox) { return; }
    search.visible = false;
    search.match = null;
    searchBox.setAttribute('hidden', '');
    scheduleRender();
  };

  const doSearchNext = (direction) => {
    const query = searchInput ? searchInput.value : '';
    if (!query) { return; }
    search.query = query;
    search.searching = true;
    if (searchStatusEl) { searchStatusEl.textContent = '…'; }
    const fromIndex = search.match
      ? search.match.filteredIndex
      : Math.max(-1, Math.floor(virtualScrollTop / getLineHeight()) - 1);
    const fromMatchStart = search.match ? search.match.matchStart : -1;
    const fromMatchLength = search.match ? search.match.matchLength : 0;
    vscode.postMessage({
      type: 'searchNext',
      query,
      caseSensitive: search.caseSensitive,
      fromIndex,
      fromMatchStart,
      fromMatchLength,
      direction: direction || 'next',
      version: state.version
    });
  };

  if (searchInput) {
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        doSearchNext(event.shiftKey ? 'prev' : 'next');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        hideSearch();
      }
    });
  }

  if (searchCloseBtn) {
    searchCloseBtn.addEventListener('click', () => hideSearch());
  }

  if (searchNextBtn) {
    searchNextBtn.addEventListener('click', () => doSearchNext('next'));
  }

  if (searchPrevBtn) {
    searchPrevBtn.addEventListener('click', () => doSearchNext('prev'));
  }
})();
