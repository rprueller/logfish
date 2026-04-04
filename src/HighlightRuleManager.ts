import * as vscode from 'vscode';
import type {
  HighlightRule,
  HighlightRuleResolved,
  HighlightRuleGroup,
  HighlightRuleConfig,
  HighlightRuleProfile,
  HighlightRulesResult
} from './Types';

export class HighlightRuleManager {
  async loadRulesAndProfiles(uri: vscode.Uri, fallback: HighlightRuleConfig): Promise<HighlightRulesResult> {
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

    return this.buildProfiles(configRules, uri.fsPath);
  }

  getProfileRules(profiles: HighlightRuleProfile[], profileName: string): HighlightRule[] {
    const profile = profiles.find((p) => p.name === profileName);
    return profile ? profile.rules : [];
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

  private buildProfiles(configRules: HighlightRuleConfig, filePath: string): HighlightRulesResult {
    const profiles: HighlightRuleProfile[] = [];
    const globalRules: HighlightRule[] = [];
    let autoSelectedName: string | null = null;

    for (const entry of configRules) {
      if (this.isHighlightRuleGroup(entry)) {
        const effectiveName = entry.name || entry.filePattern;
        profiles.push({ name: effectiveName, rules: entry.rules.filter((r) => this.isHighlightRule(r)) });
        if (autoSelectedName === null && this.matchesFilePattern(filePath, entry.filePattern, entry.filePatternIgnoreCase)) {
          autoSelectedName = effectiveName;
        }
      } else if (this.isHighlightRule(entry)) {
        globalRules.push(entry);
      }
    }

    if (globalRules.length > 0) {
      profiles.push({ name: 'Default', rules: globalRules });
      if (autoSelectedName === null) {
        autoSelectedName = 'Default';
      }
    }

    return { profiles, autoSelectedName };
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
