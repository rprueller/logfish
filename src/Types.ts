export const LOGFISH_VIEW_TYPE = 'logFish.viewer';
export const SAVED_FILTERS_KEY = 'logFish.savedFilters';
export const SAVED_EXCLUDE_FILTERS_KEY = 'logFish.savedExcludeFilters';
export const EXCLUDE_FILTER_STATE_KEY = 'logFish.excludeFilter';

export type HighlightRule = {
  pattern: string;
  patternIgnoreCase?: boolean;
  color?: string;
  background?: string;
  fontStyle?: string;
  fontWeight?: string;
};

export type HighlightRuleResolved = HighlightRule & {
  className: string;
};

export type HighlightRuleGroup = {
  name?: string;
  filePattern: string;
  filePatternIgnoreCase?: boolean;
  rules: HighlightRule[];
};

export type HighlightRuleProfile = {
  name: string;
  rules: HighlightRule[];
};

export type HighlightRulesResult = {
  profiles: HighlightRuleProfile[];
  autoSelectedName: string | null;
};

export type HighlightRuleConfig = Array<HighlightRule | HighlightRuleGroup>;

export type LogFishSettings = {
  highlightRules: HighlightRuleConfig;
  maxCachedLines: number;
  filterDelayMs: number;
  filterPersistence: FilterPersistence;
};

export type FilterBackend = 'rg' | 'grep' | 'js';
export type FilterPersistence = 'workspace' | 'global' | 'workspaceThenGlobal';

export type LinePayload = {
  i: number;
  n: number;
  t: string;
};

export type FilteredModelStats = {
  totalLines: number;
  matchedLines: number;
  maxLineNumber: number;
};

export type ProgressUpdate = {
  phase: 'indexing' | 'filtering';
  processed: number;
  total: number | null;
  matched: number;
  detail?: string;
};

export type CancelableTask = {
  cancel: () => void;
};
