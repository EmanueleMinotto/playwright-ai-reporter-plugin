import path from 'node:path';
import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { analyzeFailure } from './analyzer.js';
import { buildFailureContext } from './context.js';
import { toJson, toMarkdown } from './format.js';
import { FailureHistoryManager, resolveCommit } from './history.js';
import { resolvePromptContext } from './prompt.js';
import { McpHub } from './mcp/client.js';
import { resolveProvider } from './providers/index.js';
import { mapWithConcurrency } from './concurrency.js';
import { ATTACHMENT_JSON, ATTACHMENT_MARKDOWN, DEFAULTS, LOG_PREFIX } from './constants.js';
import type {
  AIReporterOptions,
  FailureAnalysis,
  FailureContext,
  FailureHistoryStore,
} from './types.js';

/**
 * Attaches AI-generated hypotheses to every failed test.
 *
 * The analysis runs in `onEnd`, not in `onTestEnd`: Playwright does not await
 * `onTestEnd`. Register this reporter *before* `html`, `json` or any other reporter
 * that has to see the attachments.
 *
 * ```ts
 * reporter: [['playwright-ai-reporter-plugin/reporter', { provider: 'ollama' }], ['html']]
 * ```
 */
export class AIReporter implements Reporter {
  private readonly options: AIReporterOptions;
  private readonly queue: Array<{ test: TestCase; result: TestResult }> = [];
  private rootDir = process.cwd();
  private projectDir = process.cwd();
  /** The truncation warning is worth printing once, not once per failure. */
  private warnedAboutContextLength = false;

  constructor(options: AIReporterOptions = {}) {
    this.options = options;
  }

  onBegin(config: FullConfig): void {
    this.rootDir = config.rootDir;
    // `rootDir` is the common ancestor of the test directories, so it often points
    // inside `tests/`. The history belongs next to the config instead.
    this.projectDir = config.configFile ? path.dirname(config.configFile) : config.rootDir;
  }

  /**
   * Records the failure. Synchronous by design: the model is never called here,
   * only the final attempt of a test is worth analysing.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.isEnabled()) return;
    if (result.status !== 'failed' && result.status !== 'timedOut') return;
    if (result.retry < test.retries) return;
    this.queue.push({ test, result });
  }

  async onEnd(): Promise<void> {
    if (!this.isEnabled() || this.queue.length === 0) return;

    const maxFailures = this.options.maxFailuresPerRun ?? DEFAULTS.maxFailuresPerRun;
    const batch = this.queue.slice(0, maxFailures);
    if (this.queue.length > batch.length) {
      this.warn(
        `${this.queue.length} failures found, analysing the first ${batch.length} ` +
          '(raise "maxFailuresPerRun" to analyse more).',
      );
    }

    const history = new FailureHistoryManager(this.projectDir, this.options.history ?? {});
    const historyEnabled = this.options.history?.enabled !== false;
    const store: FailureHistoryStore = historyEnabled ? history.load() : {};

    const hub = await this.connectMcp();

    try {
      const provider = resolveProvider(this.options);
      const contexts = batch.map(({ test, result }) =>
        buildFailureContext(
          test,
          result,
          this.rootDir,
          this.options.maxErrorChars ?? DEFAULTS.maxErrorChars,
        ),
      );

      const analyses = await mapWithConcurrency(
        contexts,
        this.options.concurrency ?? DEFAULTS.concurrency,
        async (context) => {
          try {
            return await analyzeFailure(
              provider,
              context,
              historyEnabled ? history.getRelevant(store, context.key) : [],
              hub,
              hub?.getConnectedServers() ?? [],
              {
                maxHypotheses: this.options.maxHypotheses ?? DEFAULTS.maxHypotheses,
                maxToolRounds: this.options.maxToolRounds ?? DEFAULTS.maxToolRounds,
                timeout: this.options.timeout ?? DEFAULTS.timeout,
                extraContext: await this.resolveContext(context),
              },
            );
          } catch (error) {
            this.warn(`Could not analyse "${context.title}": ${String(error)}`);
            return undefined;
          }
        },
      );

      analyses.forEach((analysis, index) => {
        if (analysis) this.attach(batch[index]!.result, analysis);
      });

      if (historyEnabled) {
        this.persist(history, store, contexts, analyses);
      }
    } finally {
      await hub?.close();
    }
  }

  printsToStdio(): boolean {
    return true;
  }

  private isEnabled(): boolean {
    if (process.env['PLAYWRIGHT_AI_DISABLED']) return false;
    return this.options.enabled !== false;
  }

  private async connectMcp(): Promise<McpHub | undefined> {
    const servers = this.options.mcp;
    if (!servers || Object.keys(servers).length === 0) return undefined;
    const hub = new McpHub(servers, (message) => this.warn(message));
    try {
      await hub.connect();
    } catch (error) {
      this.warn(`MCP setup failed, continuing without it: ${String(error)}`);
    }
    return hub;
  }

  /**
   * Resolves the configured project context for one failure. Fail-soft: a `context`
   * function that throws costs the analysis its background, never the analysis itself.
   */
  private async resolveContext(context: FailureContext): Promise<string> {
    if (this.options.context === undefined) return '';

    const maxChars = this.options.maxContextChars ?? DEFAULTS.maxContextChars;
    try {
      const { text, truncated } = await resolvePromptContext(
        this.options.context,
        context,
        maxChars,
      );
      if (truncated && !this.warnedAboutContextLength) {
        this.warnedAboutContextLength = true;
        this.warn(
          `"context" truncated to ${maxChars} characters ` +
            '(raise "maxContextChars" to send more).',
        );
      }
      return text;
    } catch (error) {
      this.warn(`Could not resolve "context" for "${context.title}": ${String(error)}`);
      return '';
    }
  }

  /** Mutates the shared `TestResult` so downstream reporters pick the analysis up. */
  private attach(result: TestResult, analysis: FailureAnalysis): void {
    result.attachments.push({
      name: ATTACHMENT_MARKDOWN,
      contentType: 'text/markdown',
      body: Buffer.from(toMarkdown(analysis), 'utf-8'),
    });

    // Opt-in: the JSON is for machines, and it only clutters the report otherwise.
    if (this.options.jsonAttachment === true) {
      result.attachments.push({
        name: ATTACHMENT_JSON,
        contentType: 'application/json',
        body: Buffer.from(toJson(analysis), 'utf-8'),
      });
    }
  }

  private persist(
    history: FailureHistoryManager,
    store: FailureHistoryStore,
    contexts: FailureContext[],
    analyses: Array<FailureAnalysis | undefined>,
  ): void {
    const commit = resolveCommit(this.projectDir);
    const date = new Date().toISOString();

    contexts.forEach((context, index) => {
      const analysis = analyses[index];
      history.record(
        store,
        context.key,
        { title: context.title, titlePath: context.titlePath, file: context.file },
        {
          date,
          status: context.status,
          errorMessage: context.errorMessage,
          ...(commit ? { commit } : {}),
          ...(analysis
            ? {
                hypotheses: analysis.hypotheses.map(({ cause, confidence }) => ({
                  cause,
                  confidence,
                })),
              }
            : {}),
        },
      );
    });

    history.save(store);
  }

  private warn(message: string): void {
    console.warn(`${LOG_PREFIX} ${message}`);
  }
}

export default AIReporter;
