// Highlighting rules as a class

class HighlightRules {
  constructor() {
    this.rules = [];
  }

  compile(rules) {
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
    this.rules = compiled;
    return this.rules;
  }

  checkRules(text) {
    if (!this.rules.length || text.length === 0) {
      return -1;
    }
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      rule.regex.lastIndex = 0;
      if (rule.regex.test(text)) {
        return i;
      }
    }
    return -1;
  }
}
