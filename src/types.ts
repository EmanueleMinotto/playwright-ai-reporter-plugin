import type { AIProvider } from './providers/types.js';

/** Built-in provider identifiers. */
export type ProviderName = 'ollama' | 'claude' | 'openai';

/** Configuration for the local Ollama server. */
export interface OllamaConfig {
  /**
   * Base URL of the Ollama HTTP API.
   * @default "http://127.0.0.1:11434"
   */
  host?: string;
}

/** Configuration for the Anthropic (Claude) provider. */
export interface ClaudeConfig {
  /**
   * API key. Falls back to `process.env.ANTHROPIC_API_KEY`.
   */
  apiKey?: string;
  /**
   * Custom base URL, for proxies or gateways.
   */
  baseURL?: string;
}

/** Configuration for the OpenAI provider. */
export interface OpenAIConfig {
  /**
   * API key. Falls back to `process.env.OPENAI_API_KEY`.
   */
  apiKey?: string;
  /**
   * Custom base URL, for Azure or OpenAI-compatible gateways.
   */
  baseURL?: string;
}

/** An MCP server reachable by spawning a local process that speaks stdio. */
export interface McpStdioServerConfig {
  /** Executable to spawn, e.g. `npx`. */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Extra environment variables for the spawned process. */
  env?: Record<string, string>;
}

/** An MCP server reachable over streamable HTTP. */
export interface McpHttpServerConfig {
  /** Endpoint of the MCP server. */
  url: string;
  /** Extra headers, typically for authentication. */
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Persistence options for the failure history. */
export interface HistoryConfig {
  /**
   * Whether the history is read and written at all.
   * @default true
   */
  enabled?: boolean;
  /**
   * Path of the history file, relative to the Playwright `rootDir` unless absolute.
   * @default ".playwright-ai/failure-history.json"
   */
  path?: string;
  /**
   * Maximum number of records kept per test.
   * @default 10
   */
  maxEntriesPerTest?: number;
  /**
   * How long a record is kept, as a duration string (`30d`, `12h`, `90m`).
   * @default "30d"
   */
  ttl?: string;
}

/**
 * Extra background added to the prompt, either fixed or computed for each failure.
 * See {@link AIReporterOptions.context}.
 */
export type PromptContext =
  | string
  | ((failure: FailureContext) => string | Promise<string>);

/** Options accepted by the reporter in `playwright.config.ts`. */
export interface AIReporterOptions {
  /**
   * Provider to use. When omitted, the plugin auto-detects one from the environment
   * (`ANTHROPIC_API_KEY` then `OPENAI_API_KEY`) and falls back to Ollama.
   * A custom `AIProvider` implementation is also accepted.
   */
  provider?: ProviderName | AIProvider;
  /**
   * Model identifier. Defaults are per provider: `qwen3:8b` (Ollama),
   * `claude-sonnet-5` (Claude), `gpt-5` (OpenAI).
   */
  model?: string;
  ollama?: OllamaConfig;
  claude?: ClaudeConfig;
  openai?: OpenAIConfig;
  history?: HistoryConfig;
  /**
   * MCP servers exposed to the model as callable tools, keyed by a short name
   * used to namespace their tools (`jira__search_issues`).
   */
  mcp?: Record<string, McpServerConfig>;
  /**
   * Maximum number of hypotheses kept per failure.
   * @default 3
   */
  maxHypotheses?: number;
  /**
   * How many failures are analysed concurrently.
   * @default 2
   */
  concurrency?: number;
  /**
   * Per-failure timeout in milliseconds, covering the whole tool-calling loop.
   * @default 60000
   */
  timeout?: number;
  /**
   * Safety valve: analyse at most this many failures per run.
   * @default 20
   */
  maxFailuresPerRun?: number;
  /**
   * Maximum number of provider round-trips per failure when MCP tools are available.
   * @default 4
   */
  maxToolRounds?: number;
  /**
   * Maximum number of characters kept from the error message and stack.
   * @default 4000
   */
  maxErrorChars?: number;
  /**
   * Background about the application the tests exercise — what it does, how the
   * environment behaves, conventions of the team — added to the prompt as a
   * `Project context` section. Either a fixed string or a function called once per
   * failure, so the context can depend on the test at hand.
   *
   * This is reference material for the model, not instructions: it cannot change how
   * the analysis is written or how it is formatted. Long values are cut at
   * `maxContextChars`.
   */
  context?: PromptContext;
  /**
   * Maximum number of characters kept from `context`.
   * @default 2000
   */
  maxContextChars?: number;
  /**
   * Set to `true` to also attach the raw analysis as `ai-failure-analysis.json`,
   * for dashboards or scripts that consume the report. The human-readable
   * markdown attachment is always added.
   * @default false
   */
  jsonAttachment?: boolean;
  /**
   * Set to `false` to disable the plugin. Also disabled when the
   * `PLAYWRIGHT_AI_DISABLED` environment variable is set to a non-empty value.
   * @default true
   */
  enabled?: boolean;
}

/** A single failing step, as reported by Playwright. */
export interface FailedStepInfo {
  title: string;
  category: string;
  error?: string;
}

/** Everything the model is told about one failure. */
export interface FailureContext {
  /** Stable identity of the test, shared with the history store. */
  key: string;
  title: string;
  titlePath: string[];
  file: string;
  line: number;
  project?: string;
  tags: string[];
  retry: number;
  retries: number;
  durationMs: number;
  status: string;
  errorMessage: string;
  errorStack: string;
  /** Source lines around the failing location, already numbered. */
  sourceSnippet: string;
  /** Names of the attachments Playwright itself produced (screenshot, trace, video). */
  attachmentNames: string[];
  stdout: string[];
  stderr: string[];
  failedSteps: FailedStepInfo[];
}

/** One hypothesis about the cause of a failure. */
export interface Hypothesis {
  /** The hypothesis itself, one sentence, phrased as a possibility. */
  cause: string;
  /** Estimated likelihood, between 0 and 1. */
  confidence: number;
  /** Why this hypothesis is plausible, citing the evidence used. */
  reasoning: string;
  /** Concrete references backing the hypothesis (stack frames, history, MCP results). */
  evidence: string[];
  /** How to fix it, or `null` when nothing can be inferred. */
  suggestedFix: string | null;
}

/** The analysis attached to a failed test. */
export interface FailureAnalysis {
  /** At most `maxHypotheses` entries, sorted by descending confidence. */
  hypotheses: Hypothesis[];
  /** Reminder that these are unverified guesses. */
  disclaimer: string;
  provider: string;
  model: string;
  usedHistory: boolean;
  usedMcpServers: string[];
  generatedAt: string;
}

/** One historical occurrence of a test outcome. */
export interface FailureRecord {
  date: string;
  status: string;
  errorMessage: string;
  /** Commit the run was executed against, when it could be determined. */
  commit?: string;
  /** Hypotheses generated for that occurrence, kept as a feedback loop. */
  hypotheses?: Array<Pick<Hypothesis, 'cause' | 'confidence'>>;
}

/** Per-test history, keyed by `getTestKey()`. */
export interface FailureHistoryEntry {
  title: string;
  titlePath: string[];
  file: string;
  records: FailureRecord[];
}

export type FailureHistoryStore = Record<string, FailureHistoryEntry>;
