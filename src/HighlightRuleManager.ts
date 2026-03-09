import * as vscode from 'vscode';
import type {
  HighlightRule,
  HighlightRuleResolved,
  HighlightRuleGroup,
  HighlightRuleConfig
} from './Types';

export class HighlightRuleManager {
  async loadHighlightRules(uri: vscode.Uri, fallback: HighlightRuleConfig): Promise<HighlightRule[]> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    let configRules: HighlightRuleConfig = fallback;

    if (folder) {
      const primaryRuleFile = vscode.Uri.joinPath(folder.uri, '.vscode', 'logfish.rules.json');
      const legacyRuleFile = vscode.Uri.joinPath(folder.uri, '.vscode', 'logreader.rules.json');
      const fromPrimary = await this.readRuleFile(primaryRuleFile);
      const fromLegacy = fromPrimary ? null : await this.readRuleFile(legacyRuleFile);
      const resolved = fromPrimary ?? fromLegacy;
      if (resolved) {
        configRules = resolved;
      }
    }

    return this.resolveHighlightRulesForFile(uri, configRules);
  }

  buildRuleStyles(rules: HighlightRule[]): { rules: HighlightRuleResolved[]; cssText: string } {
    const resolved: HighlightRuleResolved[] = [];
    const cssLines: string[] = [];
    let classCounter = 1;

    for (const rule of rules) {
      const className = `r${classCounter}`;
      classCounter += 1;

      const styleParts: string[] = [];
      if (rule.color) {
        styleParts.push(`--row-fg:${rule.color}`);
      }
      if (rule.background) {
        styleParts.push(`--row-bg:${rule.background}`);
      }
      if (rule.fontStyle) {
        styleParts.push(`font-style:${rule.fontStyle}`);
      }
      if (rule.fontWeight) {
        styleParts.push(`font-weight:${rule.fontWeight}`);
      }

      if (styleParts.length > 0) {
        cssLines.push(`.${className} { ${styleParts.join('; ')} }`);
      }

      resolved.push({ ...rule, className });
    }

    return { rules: resolved, cssText: cssLines.join('\n') };
  }

  private async readRuleFile(uri: vscode.Uri): Promise<HighlightRuleConfig | null> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(data).toString('utf8');
      const parsed = JSON.parse(text) as HighlightRuleConfig | { rules: HighlightRuleConfig };
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && Array.isArray(parsed.rules)) {
        return parsed.rules;
      }
    } catch {
      return null;
    }
    return null;
  }

  private resolveHighlightRulesForFile(uri: vscode.Uri, configRules: HighlightRuleConfig): HighlightRule[] {
    const filePath = uri.fsPath;
    const resolved: HighlightRule[] = [];
    let foundGroup = false;
    for (const entry of configRules) {
      if (!foundGroup && this.isHighlightRuleGroup(entry)) {
        if (this.matchesFilePattern(filePath, entry.filePattern, entry.filePatternIgnoreCase)) {
          resolved.push(...entry.rules.filter((rule) => this.isHighlightRule(rule)));
          foundGroup = true;
        }
      } else if (this.isHighlightRule(entry)) {
        resolved.push(entry);
      }
    }
    return resolved;
  }

  private isHighlightRuleGroup(value: unknown): value is HighlightRuleGroup {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as HighlightRuleGroup;
    return typeof candidate.filePattern === 'string' && Array.isArray(candidate.rules);
  }

  private isHighlightRule(value: unknown): value is HighlightRule {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as HighlightRule;
    return typeof candidate.pattern === 'string';
  }

  private matchesFilePattern(filePath: string, pattern: string, patternIgnoreCase?: boolean): boolean {
    const flags = patternIgnoreCase ? 'ig' : 'g';
    try {
      const regex = new RegExp(pattern, flags);
      return regex.test(filePath);
    } catch {
      return false;
    }
  }
}
