(() => {
  const vscode = acquireVsCodeApi();

  const filterInput = document.getElementById('filterInput');
  const statusEl = document.getElementById('status');
  const viewport = document.getElementById('viewport');
  const hscroll = document.getElementById('hscroll');
  const lnRowsInner = document.getElementById('lnRowsInner');
  const rows = document.getElementById('rows');
  const scrollbar = document.getElementById('scrollbar');
  const scrollbarThumb = document.getElementById('scrollbarThumb');
  const dynamicStyleEl = document.getElementById('dynamicStyles');
  const layoutStyleEl = document.getElementById('layoutStyles');
  const caseButton = document.getElementById('case');

  const OVERSCAN_ROWS = 20;
  const FETCH_CHUNK_SIZE = 300;
  const PREFETCH_PADDING = 250;

  const state = {
    rules: [],
    debounceMs: 250,
    caseSensitive: false,
    maxCachedLines: 20000,
    version: 0,
    totalLines: 0,
    matchedLines: 0,
    maxLineNumber: 0,
    cache: new Map(),
    pendingRanges: new Set()
  };

  let renderScheduled = false;
  let debounceTimer = null;
  let virtualScrollTop = 0;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;
  let rememberedLine = null;
  let pendingScrollToRemembered = false;

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
    if (!caseButton) {
      return;
    }
    caseButton.classList.toggle('is-active', state.caseSensitive);
    caseButton.setAttribute('aria-pressed', String(state.caseSensitive));
  };

  const setCaseSensitive = (value) => {
    state.caseSensitive = value;
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

  const postFilterChanged = () => {
    if (!filterInput) {
      return;
    }
    if (!Number.isFinite(rememberedLine)) {
      rememberCenterLine();
    }
    pendingScrollToRemembered = Number.isFinite(rememberedLine);
    vscode.postMessage({
      type: 'filterChanged',
      value: filterInput.value,
      caseSensitive: state.caseSensitive
    });
  };

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
      return `<div class="row row-placeholder" data-index="${index}"><span class="txt"></span></div>`;
    }
    const ruleIndex = checkRules(line.t);
    const className = ruleIndex >= 0 ? state.rules[ruleIndex].className : '';
    const classes = className ? `row ${className}` : 'row';
    return `<div class="${classes}" data-line="${line.n}" data-index="${index}"><span class="txt">${escapeHtml(line.t)}</span></div>`;
  };

  const renderNumberRow = (index, line) => {
    const text = line ? String(line.n) : '';
    return `<div class="row" data-index="${index}"><span class="ln">${text}</span></div>`;
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
      layoutStyleEl.textContent = `#rows { top: ${offset}px; }\n#lnRowsInner { top: ${offset}px; }`;
    }

    const prefetchStart = Math.max(0, start - PREFETCH_PADDING);
    const prefetchEnd = Math.min(total, end + PREFETCH_PADDING);
    ensureRangeLoaded(prefetchStart, prefetchEnd);

    const maxDigits = Math.max(1, String(Math.max(state.maxLineNumber, 1)).length);
    const textHtml = [];
    const numberHtml = lnRowsInner ? [] : null;

    for (let i = start; i < end; i += 1) {
      const line = getCachedLine(i);
      textHtml.push(renderTextRow(i, line));
      if (numberHtml) {
        numberHtml.push(renderNumberRow(i, line));
      }
    }

    if (viewport) {
      viewport.style.setProperty('--ln-width', `calc(${maxDigits}ch + 20px)`);
    }

    rows.innerHTML = textHtml.join('');
    if (lnRowsInner && numberHtml) {
      lnRowsInner.innerHTML = numberHtml.join('');
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

  filterInput.addEventListener('input', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    setStatus('Filtering...');
    debounceTimer = setTimeout(() => {
      postFilterChanged();
    }, state.debounceMs);
  });

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
        if (typeof message.caseSensitive === 'boolean') {
          setCaseSensitive(message.caseSensitive);
        } else {
          updateCaseUi();
        }
        if (dynamicStyleEl) {
          dynamicStyleEl.textContent = message.cssText || '';
        }
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
      case 'error': {
        setStatus(message.message || 'Error');
        break;
      }
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
