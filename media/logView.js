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

  const state = {
    lines: [],
    rules: [],
    debounceMs: 250,
    caseSensitive: false
  };

  // View state for virtual scrolling and filter restore behavior.
  let renderScheduled = false;
  let debounceTimer = null;
  let virtualScrollTop = 0;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;
  let rememberedLine = null;
  let pendingScrollToRemembered = false;
  let pendingLineTarget = null;
  // Buffer lines during filtering; swap into view once filtering ends.
  let pendingLines = null;

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

  const postFilterChanged = () => {
    if (!filterInput) {
      return;
    }
    // Capture the current context before filtering so we can restore it later.
    if (!Number.isFinite(rememberedLine)) {
      rememberCenterLine();
    }
    pendingLineTarget = Number.isFinite(rememberedLine) ? rememberedLine : null;
    pendingScrollToRemembered = true;
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

  const renderTextLine = (line) => {
    const ruleIndex = checkRules(line.t);
    const className = ruleIndex >= 0 ? state.rules[ruleIndex].className : '';
    const cls = className ? `row ${className}` : 'row';
    return `<div class="${cls}" data-line="${line.n}"><span class="txt">${escapeHtml(line.t)}</span></div>`;
  };

  const renderNumberLine = (line) => `<div class="row" data-line="${line.n}"><span class="ln">${line.n}</span></div>`;

  const getLineHeight = () => {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--line-height');
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 20;
  };

  const getViewportHeight = () => (hscroll ? hscroll.clientHeight : viewport.clientHeight);

  const getTotalHeight = () => state.lines.length * getLineHeight();

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
    if (!state.lines.length) {
      return;
    }
    const lineHeight = getLineHeight();
    const center = virtualScrollTop + getViewportHeight() / 2;
    const index = clamp(Math.floor(center / lineHeight), 0, state.lines.length - 1);
    const line = state.lines[index];
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

  const findClosestLineIndex = (lineNumber) => {
    if (!state.lines.length) {
      return -1;
    }
    let lo = 0;
    let hi = state.lines.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const current = state.lines[mid].n;
      if (current === lineNumber) {
        return mid;
      }
      if (current < lineNumber) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (lo >= state.lines.length) {
      return state.lines.length - 1;
    }
    if (hi < 0) {
      return 0;
    }
    const loDiff = Math.abs(state.lines[lo].n - lineNumber);
    const hiDiff = Math.abs(state.lines[hi].n - lineNumber);
    return loDiff < hiDiff ? lo : hi;
  };

  const scrollToLineIndex = (index) => {
    if (!Number.isFinite(index) || index < 0) {
      return;
    }
    const lineHeight = getLineHeight();
    const targetTop = index * lineHeight - (getViewportHeight() / 2 - lineHeight / 2);
    setVirtualScrollTop(targetTop);
  };

  const scrollToRememberedLine = () => {
    if (!pendingScrollToRemembered) {
      return;
    }
    pendingScrollToRemembered = false;
    const targetLine = pendingLineTarget;
    pendingLineTarget = null;
    if (!Number.isFinite(targetLine)) {
      return;
    }
    const index = findClosestLineIndex(targetLine);
    if (index < 0) {
      return;
    }
    scrollToLineIndex(index);
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

  const render = () => {
    renderScheduled = false;

    const lineHeight = getLineHeight();
    const total = state.lines.length;
    const height = getViewportHeight();

    const start = Math.max(0, Math.floor(virtualScrollTop / lineHeight) - OVERSCAN_ROWS);
    const end = Math.min(total, Math.ceil((virtualScrollTop + height) / lineHeight) + OVERSCAN_ROWS);

    if (layoutStyleEl) {
      const offset = start * lineHeight - virtualScrollTop;
      layoutStyleEl.textContent = `#rows { top: ${offset}px; }\n#lnRowsInner { top: ${offset}px; }`;
    }

    let maxDigits = 1;
    const textHtml = [];
    const numberHtml = lnRowsInner ? [] : null;
    for (let i = start; i < end; i += 1) {
      const line = state.lines[i];
      if (!line) {
        continue;
      }
      const digits = String(line.n).length;
      if (digits > maxDigits) {
        maxDigits = digits;
      }
      textHtml.push(renderTextLine(line));
      if (numberHtml) {
        numberHtml.push(renderNumberLine(line));
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
    const horizontalDelta = event.deltaX !== 0 ? event.deltaX : (event.shiftKey ? event.deltaY : 0);
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
      if (filterInput.value) {
        setStatus('Filtering...');
        postFilterChanged();
      }
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'init': {
        state.rules = compileRules(message.rules || []);
        state.debounceMs = message.debounceMs || 250;
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
      case 'append': {
        if (!pendingLines) {
          pendingLines = [];
        }
        pendingLines.push(...(message.lines || []));
        break;
      }
      case 'reset': {
        pendingLines = [];
        break;
      }
      case 'end': {
        const stats = message.stats || { totalLines: null, matchedLines: 0, truncated: false };
        const note = stats.truncated ? ' (truncated)' : '';
        setStatus(`${stats.matchedLines} lines${note}`);
        // Swap in the newly filtered lines in one shot to avoid partial redraws.
        if (pendingLines !== null) {
          state.lines = pendingLines;
          pendingLines = null;
        }
        if (pendingScrollToRemembered) {
          scrollToRememberedLine();
        }
        const maxScrollTop = getMaxScrollTop();
        virtualScrollTop = clamp(virtualScrollTop, 0, maxScrollTop);
        updateScrollbar();
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
