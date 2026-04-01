// Rendering and display logic as a class

class Renderer {
  static OVERSCAN_ROWS = 20;
  static FETCH_CHUNK_SIZE = 300;
  static PREFETCH_PADDING = 500;

  constructor(state, dom, scrollManager, search, cacheManager, highlightRules, vscode) {
    this.state = state;
    this.dom = dom;
    this.scrollManager = scrollManager;
    this.search = search;
    this.cacheManager = cacheManager;
    this.highlightRules = highlightRules;
    this.vscode = vscode;
    this.renderScheduled = false;
    this.rangeSerial = 0;
  }

  renderTextRow(index, line) {
    if (!line) {
      return `<div class="row row-placeholder" data-index="${index}"><span class="ln"></span><span class="txt"></span></div>`;
    }
    const ruleIndex = this.highlightRules.checkRules(line.t);
    const className = ruleIndex >= 0 ? this.highlightRules.rules[ruleIndex].className : '';
    const isCurrent = this.state.currentLineExact && this.state.currentLineIndex === index;
    const classes = [className ? `row ${className}` : 'row', isCurrent ? 'is-current' : ''].filter(Boolean).join(' ');
    let txtHtml;
    if (this.search.match && this.search.match.filteredIndex === index) {
      const { matchStart, matchLength } = this.search.match;
      const before = Utils.escapeHtml(line.t.slice(0, matchStart));
      const matched = Utils.escapeHtml(line.t.slice(matchStart, matchStart + matchLength));
      const after = Utils.escapeHtml(line.t.slice(matchStart + matchLength));
      txtHtml = `${before}<span class="search-match">${matched}</span>${after}`;
    } else {
      txtHtml = Utils.escapeHtml(line.t);
    }
    return `<div class="${classes}" data-line="${line.n}" data-index="${index}"><span class="ln">${line.n}</span><span class="txt">${txtHtml}</span></div>`;
  }

  bumpSerial() {
    this.rangeSerial += 1;
    this.state.pendingRanges.clear();
  }

  getSerial() {
    return this.rangeSerial;
  }

  requestRange(start, count) {
    if (count <= 0 || this.state.totalLines <= 0) {
      return;
    }
    const safeStart = Utils.clamp(start, 0, Math.max(0, this.state.totalLines - 1));
    const safeCount = Math.min(count, this.state.totalLines - safeStart);
    if (safeCount <= 0) {
      return;
    }
    const key = `${this.state.version}:${safeStart}:${safeCount}`;
    if (this.state.pendingRanges.has(key)) {
      return;
    }
    this.state.pendingRanges.add(key);
    this.vscode.postMessage({
      type: 'requestRange',
      start: safeStart,
      count: safeCount,
      version: this.state.version,
      serial: this.rangeSerial
    });
  }

  ensureRangeLoaded(start, endExclusive) {
    if (this.state.totalLines <= 0) {
      return;
    }
    const safeStart = Utils.clamp(start, 0, this.state.totalLines);
    const safeEnd = Utils.clamp(endExclusive, 0, this.state.totalLines);
    if (safeStart >= safeEnd) {
      return;
    }

    let missingStart = -1;
    let missingCount = 0;

    for (let i = safeStart; i < safeEnd; i += 1) {
      const hasLine = this.state.cache.has(i);
      if (!hasLine) {
        if (missingStart < 0) {
          missingStart = i;
          missingCount = 1;
        } else {
          missingCount += 1;
        }

        if (missingCount >= Renderer.FETCH_CHUNK_SIZE) {
          this.requestRange(missingStart, missingCount);
          missingStart = -1;
          missingCount = 0;
        }
      } else if (missingStart >= 0) {
        this.requestRange(missingStart, missingCount);
        missingStart = -1;
        missingCount = 0;
      }
    }

    if (missingStart >= 0) {
      this.requestRange(missingStart, missingCount);
    }
  }

  scheduleRender() {
    if (this.renderScheduled) {
      return;
    }
    this.renderScheduled = true;
    requestAnimationFrame(() => this.render());
  }

  render() {
    this.renderScheduled = false;

    const lineHeight = this.scrollManager.getLineHeight();
    const total = this.state.totalLines;
    const height = this.scrollManager.getViewportHeight();
    const virtualScrollTop = this.scrollManager.getVirtualScrollTop();

    const start = Math.max(0, Math.floor(virtualScrollTop / lineHeight) - Renderer.OVERSCAN_ROWS);
    const end = Math.min(total, Math.ceil((virtualScrollTop + height) / lineHeight) + Renderer.OVERSCAN_ROWS);

    if (this.dom.layoutStyleEl) {
      const offset = start * lineHeight - virtualScrollTop;
      this.dom.layoutStyleEl.textContent = `#rows { top: ${offset}px; }`;
    }

    const prefetchStart = Math.max(0, start - Renderer.PREFETCH_PADDING);
    const prefetchEnd = Math.min(total, end + Renderer.PREFETCH_PADDING);
    this.ensureRangeLoaded(prefetchStart, prefetchEnd);

    const textHtml = [];
    let visibleMaxLineNumber = 0;

    for (let i = start; i < end; i += 1) {
      const line = this.cacheManager.getCachedLine(i);
      if (line && line.n > visibleMaxLineNumber) { visibleMaxLineNumber = line.n; }
      textHtml.push(this.renderTextRow(i, line));
    }

    const maxDigits = visibleMaxLineNumber > 0
      ? Math.max(1, String(visibleMaxLineNumber).length)
      : Math.max(1, String(Math.max(this.state.maxLineNumber, 1)).length);

    if (this.dom.viewport) {
      this.dom.viewport.style.setProperty('--ln-digits', String(maxDigits));
    }

    this.dom.rows.innerHTML = textHtml.join('');

    if (this.search.pendingHScroll) {
      this.search.pendingHScroll = false;
      if (this.dom.hscroll) {
        const matchEl = this.dom.rows.querySelector('.search-match');
        if (matchEl) {
          const hRect = this.dom.hscroll.getBoundingClientRect();
          const mRect = matchEl.getBoundingClientRect();
          const lnEl = this.dom.rows.querySelector('.ln');
          const lnWidth = lnEl ? lnEl.offsetWidth : 0;
          const leftPad = lnWidth + 8;
          const rightPad = 40;
          const relLeft = mRect.left - hRect.left + this.dom.hscroll.scrollLeft;
          const relRight = relLeft + mRect.width;
          const viewLeft = this.dom.hscroll.scrollLeft;
          const viewRight = viewLeft + this.dom.hscroll.clientWidth;
          if (relLeft < viewLeft + leftPad) {
            this.dom.hscroll.scrollLeft = Math.max(0, relLeft - leftPad);
          } else if (relRight > viewRight - rightPad) {
            this.dom.hscroll.scrollLeft = relRight - this.dom.hscroll.clientWidth + rightPad;
          }
        }
      }
    }

    this.scrollManager.updateScrollbar();
  }
}
