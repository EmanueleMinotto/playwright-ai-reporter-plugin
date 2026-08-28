import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import type { FullConfig, TestCase, TestResult } from '@playwright/test/reporter';
import { AIReporter } from '../../src/reporter.js';
import type { AIProvider } from '../../src/providers/types.js';
import type { AIReporterOptions } from '../../src/types.js';

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ai-reporter-'));

const ANSWER = JSON.stringify({
  hypotheses: [
    { cause: 'The locator may resolve too early', confidence: 0.7, reasoning: 'timeout on row' },
  ],
});

function provider(text = ANSWER): AIProvider {
  return { name: 'fake', model: 'fake-1', complete: async () => ({ text, toolCalls: [] }) };
}

function fakeTest(title = 'case', retries = 0): TestCase {
  return {
    title,
    titlePath: () => ['suite', title],
    location: { file: path.join(rootDir, 'a.spec.ts'), line: 1, column: 1 },
    retries,
    parent: { project: () => undefined },
  } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    status: 'failed',
    retry: 0,
    duration: 1,
    errors: [{ message: 'timeout' }],
    attachments: [],
    stdout: [],
    stderr: [],
    steps: [],
    ...overrides,
  } as unknown as TestResult;
}

function makeReporter(options: AIReporterOptions = {}): AIReporter {
  const reporter = new AIReporter({
    provider: provider(),
    history: { enabled: false },
    ...options,
  });
  reporter.onBegin({ rootDir } as unknown as FullConfig);
  return reporter;
}

type Complete = jest.Mock<AIProvider['complete']>;

/** The user message of the first request the provider received. */
function userMessageOf(complete: Complete): string {
  const request = complete.mock.calls[0]![0];
  return request.messages.find((message) => message.role === 'user')?.content ?? '';
}

/** Runs one failure through the reporter and returns the prompt the provider saw. */
async function capturePrompt(options: AIReporterOptions = {}): Promise<string> {
  const complete = jest.fn(async () => ({ text: ANSWER, toolCalls: [] })) as Complete;
  const reporter = makeReporter({
    provider: { name: 'fake', model: 'fake-1', complete } as AIProvider,
    ...options,
  });

  reporter.onTestEnd(fakeTest(), fakeResult());
  await reporter.onEnd();

  return userMessageOf(complete);
}

describe('AIReporter', () => {
  it('attaches only the markdown analysis to a failed test', async () => {
    const reporter = makeReporter();
    const result = fakeResult();

    reporter.onTestEnd(fakeTest(), result);
    await reporter.onEnd();

    expect(result.attachments.map((attachment) => attachment.name)).toEqual([
      'ai-failure-analysis',
    ]);
    expect(result.attachments[0]!.contentType).toBe('text/markdown');
    expect(result.attachments[0]!.body!.toString('utf-8')).toContain('Why this test may have failed');
  });

  it('attaches the json analysis only when it is explicitly asked for', async () => {
    const reporter = makeReporter({ jsonAttachment: true });
    const result = fakeResult();

    reporter.onTestEnd(fakeTest(), result);
    await reporter.onEnd();

    expect(result.attachments.map((attachment) => attachment.name)).toEqual([
      'ai-failure-analysis',
      'ai-failure-analysis.json',
    ]);
    expect(result.attachments[1]!.contentType).toBe('application/json');
    expect(JSON.parse(result.attachments[1]!.body!.toString('utf-8')).hypotheses).toHaveLength(1);
  });

  it('does not call the provider from onTestEnd', () => {
    const complete = jest.fn(async () => ({ text: ANSWER, toolCalls: [] }));
    const reporter = makeReporter({
      provider: { name: 'fake', model: 'fake-1', complete } as AIProvider,
    });

    reporter.onTestEnd(fakeTest(), fakeResult());

    expect(complete).not.toHaveBeenCalled();
  });

  it('adds the configured context to the prompt, as a string or as a function', async () => {
    const fromString = await capturePrompt({ context: 'Staging is reseeded nightly.' });
    expect(fromString).toContain('## Project context');
    expect(fromString).toContain('Staging is reseeded nightly.');

    const seen: string[] = [];
    const fromFunction = await capturePrompt({
      context: (failure) => {
        seen.push(failure.title);
        return `Suite ${failure.titlePath.join(' > ')} covers checkout.`;
      },
    });
    expect(seen).toEqual(['case']);
    expect(fromFunction).toContain('covers checkout.');
  });

  it('sends no context section when the option is not set', async () => {
    expect(await capturePrompt()).not.toContain('## Project context');
  });

  it('caps a long context and warns about it once per run', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const complete = jest.fn(async () => ({ text: ANSWER, toolCalls: [] }));
    const reporter = makeReporter({
      provider: { name: 'fake', model: 'fake-1', complete } as AIProvider,
      context: 'x'.repeat(300),
      maxContextChars: 100,
    });

    reporter.onTestEnd(fakeTest('one'), fakeResult());
    reporter.onTestEnd(fakeTest('two'), fakeResult());
    await reporter.onEnd();

    expect(userMessageOf(complete)).toContain('… [truncated, 200 more characters]');
    expect(warn.mock.calls.filter(([message]) => String(message).includes('maxContextChars'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('analyses the failure anyway when the context function throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = makeReporter({
      context: () => {
        throw new Error('config unreachable');
      },
    });
    const result = fakeResult();

    reporter.onTestEnd(fakeTest(), result);
    await reporter.onEnd();

    expect(result.attachments).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config unreachable'));
    warn.mockRestore();
  });

  it('ignores passing tests and non-final attempts', async () => {
    const reporter = makeReporter();
    const passed = fakeResult({ status: 'passed' } as Partial<TestResult>);
    const willRetry = fakeResult({ retry: 0 } as Partial<TestResult>);
    const timedOut = fakeResult({ status: 'timedOut' } as Partial<TestResult>);

    reporter.onTestEnd(fakeTest(), passed);
    reporter.onTestEnd(fakeTest('retried', 1), willRetry);
    reporter.onTestEnd(fakeTest(), timedOut);
    await reporter.onEnd();

    expect(passed.attachments).toHaveLength(0);
    expect(willRetry.attachments).toHaveLength(0);
    expect(timedOut.attachments).toHaveLength(1);
  });

  it('attaches nothing when disabled through the options or the environment', async () => {
    const disabled = makeReporter({ enabled: false });
    const byOption = fakeResult();
    disabled.onTestEnd(fakeTest(), byOption);
    await disabled.onEnd();
    expect(byOption.attachments).toHaveLength(0);

    process.env['PLAYWRIGHT_AI_DISABLED'] = '1';
    try {
      const byEnv = fakeResult();
      const reporter = makeReporter();
      reporter.onTestEnd(fakeTest(), byEnv);
      await reporter.onEnd();
      expect(byEnv.attachments).toHaveLength(0);
    } finally {
      delete process.env['PLAYWRIGHT_AI_DISABLED'];
    }
  });

  it('attaches nothing when the model produces no usable hypothesis', async () => {
    const reporter = makeReporter({ provider: provider('I have no idea') });
    const result = fakeResult();

    reporter.onTestEnd(fakeTest(), result);
    await reporter.onEnd();

    expect(result.attachments).toHaveLength(0);
  });

  it('keeps the run green when the provider throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing: AIProvider = {
      name: 'fake',
      model: 'fake-1',
      complete: async () => {
        throw new Error('connection refused');
      },
    };
    const reporter = makeReporter({ provider: failing });
    const result = fakeResult();

    reporter.onTestEnd(fakeTest(), result);
    await expect(reporter.onEnd()).resolves.toBeUndefined();

    expect(result.attachments).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    warn.mockRestore();
  });

  it('caps the number of failures analysed per run', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reporter = makeReporter({ maxFailuresPerRun: 1 });
    const first = fakeResult();
    const second = fakeResult();

    reporter.onTestEnd(fakeTest('one'), first);
    reporter.onTestEnd(fakeTest('two'), second);
    await reporter.onEnd();

    expect(first.attachments).toHaveLength(1);
    expect(second.attachments).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('analysing the first 1'));
    warn.mockRestore();
  });

  it('resolves a relative history path against the config directory, not the test dir', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ai-project-'));
    const testDir = path.join(projectDir, 'tests');
    fs.mkdirSync(testDir);

    const reporter = new AIReporter({ provider: provider(), history: {} });
    reporter.onBegin({
      rootDir: testDir,
      configFile: path.join(projectDir, 'playwright.config.ts'),
    } as unknown as FullConfig);
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd();

    expect(fs.existsSync(path.join(projectDir, '.playwright-ai/failure-history.json'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.playwright-ai'))).toBe(false);
  });

  it('persists the failure and its hypotheses when the history is enabled', async () => {
    const historyPath = path.join(rootDir, 'history.json');
    const reporter = makeReporter({ history: { path: historyPath } });

    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd();

    const store = JSON.parse(fs.readFileSync(historyPath, 'utf-8')) as Record<
      string,
      { records: Array<{ status: string; hypotheses?: Array<{ cause: string }> }> }
    >;
    const entry = store['a.spec.ts::suite > case'];
    expect(entry!.records).toHaveLength(1);
    expect(entry!.records[0]!.status).toBe('failed');
    expect(entry!.records[0]!.hypotheses![0]!.cause).toContain('locator');
  });

  it('does nothing when no test failed', async () => {
    const complete = jest.fn(async () => ({ text: ANSWER, toolCalls: [] }));
    const reporter = makeReporter({
      provider: { name: 'fake', model: 'fake-1', complete } as AIProvider,
    });

    await reporter.onEnd();

    expect(complete).not.toHaveBeenCalled();
  });
});
