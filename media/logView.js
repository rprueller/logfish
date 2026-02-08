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

  const state = {
    lines: [],
    rules: [],
    debounceMs: 250,
    caseSensitive: false
  };

  let renderScheduled = false;
  let debounceTimer = null;
  let virtualScrollTop = 0;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

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
    return `<div class="${cls}"><span class="txt">${escapeHtml(line.t)}</span></div>`;
  };

  const renderNumberLine = (line) => `<div class="row"><span class="ln">${line.n}</span></div>`;

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

    const start = Math.max(0, Math.floor(virtualScrollTop / lineHeight) - 20);
    const end = Math.min(total, Math.ceil((virtualScrollTop + height) / lineHeight) + 20);

    if (layoutStyleEl) {
      const offset = start * lineHeight - virtualScrollTop;
      layoutStyleEl.textContent = `#rows { top: ${offset}px; }\n#lnRowsInner { top: ${offset}px; }`;
    }
    const visible = state.lines.slice(start, end);
    let maxDigits = 1;
    for (const line of visible) {
      const digits = String(line.n).length;
      if (digits > maxDigits) {
        maxDigits = digits;
      }
    }
    if (viewport) {
      viewport.style.setProperty('--ln-width', `calc(${maxDigits}ch + 20px)`);
    }
    rows.innerHTML = visible.map(renderTextLine).join('');
    if (lnRowsInner) {
      lnRowsInner.innerHTML = visible.map(renderNumberLine).join('');
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
    }

    if (horizontalDelta !== 0 || (maxScrollTop > 0 && verticalDelta !== 0)) {
      event.preventDefault();
    }
  };

  if (hscroll) {
    hscroll.addEventListener('wheel', handleWheel, { passive: false });
  } else {
    viewport.addEventListener('wheel', handleWheel, { passive: false });
  }
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
      event.preventDefault();
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
        state.lines.push(...(message.lines || []));
        scheduleRender();
        break;
      }
      case 'reset': {
        state.lines = [];
        virtualScrollTop = 0;
        updateScrollbar();
        scheduleRender();
        break;
      }
      case 'end': {
        const stats = message.stats || { totalLines: null, matchedLines: 0, truncated: false };
        const note = stats.truncated ? ' (truncated)' : '';
        // if (typeof stats.totalLines === 'number') {
        //   setStatus(`${stats.matchedLines}/${stats.totalLines} lines${note}`);
        // } else {
        //   setStatus(`${stats.matchedLines} lines${note}`);
        // }
        setStatus(`${stats.matchedLines} lines${note}`);
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
