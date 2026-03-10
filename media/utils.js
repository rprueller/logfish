// Utility helper functions as static class

class Utils {
  static escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  static formatNumber(value) {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return Math.max(0, Math.trunc(value)).toLocaleString();
  }

  static clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  static isEditableElement(element) {
    if (!element) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    const tag = element.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  static getLineNumberFromElement(element) {
    if (!element || typeof element.closest !== 'function') {
      return null;
    }
    const row = element.closest('.row');
    if (!row || !row.dataset) {
      return null;
    }
    const lineNumber = Number.parseInt(row.dataset.line || '', 10);
    return Number.isFinite(lineNumber) ? lineNumber : null;
  }

  static getLineNumberFromNode(node) {
    if (!node) {
      return null;
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return this.getLineNumberFromElement(element);
  }
}
