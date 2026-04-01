// Scroll and viewport management as a class

class ScrollManager {
  constructor(state, dom, scheduleRender, cacheManager) {
    this.state = state;
    this.dom = dom;
    this.scheduleRender = scheduleRender;
    this.cacheManager = cacheManager;
    this.virtualScrollTop = 0;
  }

  getLineHeight() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--line-height');
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 20;
  }

  getViewportHeight() {
    return (this.dom.hscroll ? this.dom.hscroll.clientHeight : this.dom.viewport.clientHeight);
  }

  getTotalHeight() {
    return this.state.totalLines * this.getLineHeight();
  }

  getMaxScrollTop() {
    return Math.max(0, this.getTotalHeight() - this.getViewportHeight());
  }

  getVirtualScrollTop() {
    return this.virtualScrollTop;
  }

  setVirtualScrollTop(value) {
    const maxScrollTop = this.getMaxScrollTop();
    const next = Utils.clamp(value, 0, maxScrollTop);
    if (next === this.virtualScrollTop) {
      return;
    }
    this.virtualScrollTop = next;
    this.scheduleRender();
    this.updateScrollbar();
  }

  getThumbMetrics() {
    const trackHeight = this.dom.scrollbar ? this.dom.scrollbar.clientHeight : 0;
    const totalHeight = this.getTotalHeight();
    if (trackHeight <= 0 || totalHeight <= 0) {
      return { trackHeight, thumbHeight: trackHeight, maxThumbTop: 0 };
    }
    const viewHeight = this.getViewportHeight();
    const ratio = viewHeight / totalHeight;
    const thumbHeight = Utils.clamp(Math.round(trackHeight * ratio), 20, trackHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    return { trackHeight, thumbHeight, maxThumbTop };
  }

  updateScrollbar() {
    if (!this.dom.scrollbar || !this.dom.scrollbarThumb) {
      return;
    }
    const maxScrollTop = this.getMaxScrollTop();
    const { thumbHeight, maxThumbTop } = this.getThumbMetrics();
    this.dom.scrollbarThumb.style.height = `${thumbHeight}px`;
    if (maxScrollTop <= 0 || maxThumbTop <= 0) {
      this.dom.scrollbarThumb.style.transform = 'translateY(0px)';
      return;
    }
    const thumbTop = maxThumbTop * (this.virtualScrollTop / maxScrollTop);
    this.dom.scrollbarThumb.style.transform = `translateY(${thumbTop}px)`;
  }

  scrollToLineIndex(index) {
    if (!Number.isFinite(index) || index < 0) {
      return;
    }
    const lineHeight = this.getLineHeight();
    const targetTop = index * lineHeight - (this.getViewportHeight() / 2 - lineHeight / 2);
    this.setVirtualScrollTop(targetTop);
  }
}
