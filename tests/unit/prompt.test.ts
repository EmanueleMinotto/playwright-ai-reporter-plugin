import {
  buildSystemPrompt,
  buildUserPrompt,
  formatHistory,
  resolvePromptContext,
} from '../../src/prompt.js';
import type { FailureContext, FailureRecord, PromptContext } from '../../src/types.js';

const context: FailureContext = {
  key: 'tests/a.spec.ts::suite > case',
  title: 'case',
  titlePath: ['suite', 'case'],
  file: 'tests/a.spec.ts',
  line: 42,
  project: 'chromium',
  tags: ['@smoke'],
  retry: 1,
  retries: 1,
  durationMs: 1234,
  status: 'failed',
  errorMessage: 'expected locator to be visible',
  errorStack: 'Error: expected locator to be visible\n at tests/a.spec.ts:42:5',
  sourceSnippet: '> 42 | await expect(row).toBeVisible();',
  attachmentNames: ['screenshot'],
  stdout: ['loading dashboard'],
  stderr: [],
  failedSteps: [{ title: 'expect.toBeVisible', category: 'expect', error: 'timeout 5000ms' }],
};

describe('buildSystemPrompt', () => {
  it('states the hypothesis budget and the hypothetical framing', () => {
    const prompt = buildSystemPrompt(3, []);
    expect(prompt).toContain('at most 3 hypotheses');
    expect(prompt).toContain('Always answer in English');
    expect(prompt).toContain('You are guessing, not diagnosing');
    expect(prompt).toContain('"hypotheses"');
  });

  it('targets readers who know neither Playwright nor QA', () => {
    const prompt = buildSystemPrompt(3, []);
    expect(prompt).toContain('not QA engineers and have never used Playwright');
    expect(prompt).toContain('plain, everyday English');
    expect(prompt).toContain('Explain any technical term');
  });

  it('mentions the connected MCP servers only when there are any', () => {
    expect(buildSystemPrompt(3, [])).not.toContain('Tools from these systems');
    expect(buildSystemPrompt(3, ['jira', 'github'])).toContain('jira, github');
  });
});

describe('formatHistory', () => {
  it('renders nothing for an empty history', () => {
    expect(formatHistory([])).toBe('');
  });

  it('includes the commit and the hypotheses suspected previously', () => {
    const records: FailureRecord[] = [
      {
        date: '2026-08-01T10:00:00.000Z',
        status: 'failed',
        errorMessage: 'timeout\nsecond line',
        commit: 'abcdef1234567890',
        hypotheses: [{ cause: 'race condition', confidence: 0.7 }],
      },
    ];

    const rendered = formatHistory(records);
    expect(rendered).toContain('commit abcdef12');
    expect(rendered).toContain('error: timeout');
    expect(rendered).not.toContain('second line');
    expect(rendered).toContain('previously suspected: race condition (70%)');
  });
});

describe('buildUserPrompt', () => {
  it('includes the identity, the error, the source and the failed steps', () => {
    const prompt = buildUserPrompt(context, []);
    expect(prompt).toContain('Test: suite > case');
    expect(prompt).toContain('File: tests/a.spec.ts:42');
    expect(prompt).toContain('Project: chromium');
    expect(prompt).toContain('attempt 2 of 2');
    expect(prompt).toContain('## Error message');
    expect(prompt).toContain('## Source around the failure');
    expect(prompt).toContain('[expect] expect.toBeVisible — timeout 5000ms');
    expect(prompt).toContain('## stdout (tail)');
  });

  it('omits empty sections', () => {
    const prompt = buildUserPrompt(context, []);
    expect(prompt).not.toContain('## stderr (tail)');
    expect(prompt).not.toContain('## Past outcomes of this test');
  });

  it('adds the history section when past outcomes exist', () => {
    const prompt = buildUserPrompt(context, [
      { date: '2026-08-01T10:00:00.000Z', status: 'failed', errorMessage: 'timeout' },
    ]);
    expect(prompt).toContain('## Past outcomes of this test');
  });

  it('puts the project context first, and omits it when there is none', () => {
    const prompt = buildUserPrompt(context, [], 'The app is a B2B order portal.');
    expect(prompt.indexOf('## Project context')).toBe(0);
    expect(prompt).toContain('The app is a B2B order portal.');
    expect(prompt.indexOf('## Project context')).toBeLessThan(prompt.indexOf('## Test'));

    expect(buildUserPrompt(context, [])).not.toContain('## Project context');
  });
});

describe('resolvePromptContext', () => {
  it('returns nothing when the option is not configured', async () => {
    await expect(resolvePromptContext(undefined, context, 100)).resolves.toEqual({
      text: '',
      truncated: false,
    });
  });

  it('uses a fixed string as it is', async () => {
    const resolved = await resolvePromptContext('  staging is reseeded nightly  ', context, 100);
    expect(resolved).toEqual({ text: 'staging is reseeded nightly', truncated: false });
  });

  it('calls a function with the failure, synchronous or asynchronous', async () => {
    const sync = await resolvePromptContext((failure) => `about ${failure.title}`, context, 100);
    expect(sync.text).toBe('about case');

    const async = await resolvePromptContext(
      async (failure) => `tags: ${failure.tags.join(',')}`,
      context,
      100,
    );
    expect(async.text).toBe('tags: @smoke');
  });

  it('ignores empty and non-string results', async () => {
    await expect(resolvePromptContext('   ', context, 100)).resolves.toEqual({
      text: '',
      truncated: false,
    });
    const notAString = (() => 42) as unknown as PromptContext;
    await expect(resolvePromptContext(notAString, context, 100)).resolves.toEqual({
      text: '',
      truncated: false,
    });
  });

  it('caps a long context and says that it did', async () => {
    const resolved = await resolvePromptContext('x'.repeat(50), context, 10);
    expect(resolved.truncated).toBe(true);
    expect(resolved.text).toContain('xxxxxxxxxx\n… [truncated, 40 more characters]');
  });

  it('lets the caller deal with a throwing function', async () => {
    await expect(
      resolvePromptContext(() => {
        throw new Error('no config');
      }, context, 100),
    ).rejects.toThrow('no config');
  });
});
