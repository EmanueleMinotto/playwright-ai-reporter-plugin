/** Name of the human-readable attachment. */
export const ATTACHMENT_MARKDOWN = 'ai-failure-analysis';

/** Name of the machine-readable attachment. */
export const ATTACHMENT_JSON = 'ai-failure-analysis.json';

/** Prefix of everything the plugin prints. */
export const LOG_PREFIX = '[playwright-ai-reporter]';

/** Defaults applied when an option is not set. */
export const DEFAULTS = {
  maxHypotheses: 3,
  concurrency: 2,
  timeout: 60_000,
  maxFailuresPerRun: 20,
  maxToolRounds: 4,
  maxErrorChars: 4000,
  maxContextChars: 2000,
} as const;
