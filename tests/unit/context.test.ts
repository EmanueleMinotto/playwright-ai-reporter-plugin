import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import {
  buildFailureContext,
  collectFailedSteps,
  getTestKey,
  normaliseTitlePath,
  readSourceSnippet,
  stripAnsi,
  truncate,
} from '../../src/context.js';

const rootDir = '/repo';

function fakeTest(file: string, line = 12): TestCase {
  return {
    title: 'shows the dashboard',
    titlePath: () => ['dashboard.spec.ts', 'dashboard', 'shows the dashboard'],
    location: { file, line, column: 3 },
    retries: 1,
    tags: ['@smoke'],
    parent: { project: () => ({ name: 'chromium' }) },
  } as unknown as TestCase;
}

function fakeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    status: 'failed',
    retry: 1,
    duration: 4321,
    errors: [],
    attachments: [],
    stdout: [],
    stderr: [],
    steps: [],
    ...overrides,
  } as unknown as TestResult;
}

describe('normaliseTitlePath', () => {
  it('drops the empty root and project segments and the repeated file name', () => {
    expect(normaliseTitlePath(['', '', 'a.spec.ts', 'suite', 'case'], '/repo/tests/a.spec.ts')).toEqual(
      ['suite', 'case'],
    );
  });

  it('keeps a real project name', () => {
    expect(normaliseTitlePath(['', 'chromium', 'a.spec.ts', 'case'], '/repo/a.spec.ts')).toEqual([
      'chromium',
      'case',
    ]);
  });
});

describe('stripAnsi', () => {
  it('removes the colour codes Playwright adds to its errors', () => {
    const coloured = '\u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m).toBe';
    expect(stripAnsi(coloured)).toBe('expect(locator).toBe');
  });

  it('leaves plain brackets alone', () => {
    expect(stripAnsi('array[0] and [tag]')).toBe('array[0] and [tag]');
  });
});

describe('getTestKey', () => {
  it('joins the path relative to the root dir with the title path', () => {
    expect(getTestKey(rootDir, '/repo/tests/a.spec.ts', ['suite', 'case'])).toBe(
      'tests/a.spec.ts::suite > case',
    );
  });

  it('ignores the empty and duplicated segments Playwright emits', () => {
    expect(getTestKey(rootDir, '/repo/tests/a.spec.ts', ['', '', 'a.spec.ts', 'case'])).toBe(
      'tests/a.spec.ts::case',
    );
  });
});

describe('truncate', () => {
  it('leaves short values untouched', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('marks how much was cut', () => {
    const result = truncate('x'.repeat(30), 10);
    expect(result.startsWith('x'.repeat(10))).toBe(true);
    expect(result).toContain('20 more characters');
  });
});

describe('readSourceSnippet', () => {
  it('numbers the lines and marks the failing one', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ai-src-')), 'a.spec.ts');
    fs.writeFileSync(file, ['one', 'two', 'three'].join('\n'));

    const snippet = readSourceSnippet(file, 2);
    expect(snippet).toContain('> 2 | two');
    expect(snippet).toContain('  1 | one');
  });

  it('returns an empty string for an unreadable file', () => {
    expect(readSourceSnippet('/does/not/exist.ts', 3)).toBe('');
  });
});

describe('collectFailedSteps', () => {
  it('walks nested steps and keeps only the ones carrying an error', () => {
    const steps = [
      {
        title: 'outer',
        category: 'test.step',
        steps: [
          { title: 'click', category: 'pw:api', error: { message: 'timeout' }, steps: [] },
          { title: 'ok', category: 'pw:api', steps: [] },
        ],
      },
    ] as unknown as TestStep[];

    expect(collectFailedSteps(steps)).toEqual([
      { title: 'click', category: 'pw:api', error: 'timeout' },
    ]);
  });
});

describe('buildFailureContext', () => {
  it('captures the identity, the error and the run metadata', () => {
    const context = buildFailureContext(
      fakeTest('/repo/tests/dashboard.spec.ts'),
      fakeResult({
        errors: [{ message: 'expected visible', stack: 'Error\n at /repo/tests/dashboard.spec.ts:42:5' }],
        attachments: [{ name: 'screenshot', contentType: 'image/png' }],
        stdout: ['hello\n'],
      } as unknown as Partial<TestResult>),
      rootDir,
    );

    expect(context.key).toBe('tests/dashboard.spec.ts::dashboard > shows the dashboard');
    expect(context.titlePath).toEqual(['dashboard', 'shows the dashboard']);
    expect(context.file).toBe('tests/dashboard.spec.ts');
    expect(context.line).toBe(42);
    expect(context.project).toBe('chromium');
    expect(context.tags).toEqual(['@smoke']);
    expect(context.retry).toBe(1);
    expect(context.retries).toBe(1);
    expect(context.errorMessage).toBe('expected visible');
    expect(context.attachmentNames).toEqual(['screenshot']);
    expect(context.stdout).toEqual(['hello']);
  });

  it('falls back to the declaration line when the stack does not mention the file', () => {
    const context = buildFailureContext(
      fakeTest('/repo/tests/dashboard.spec.ts', 7),
      fakeResult({ errors: [{ message: 'boom', stack: 'Error\n at internal' }] } as unknown as Partial<TestResult>),
      rootDir,
    );
    expect(context.line).toBe(7);
  });

  it('truncates the error to the configured budget', () => {
    const context = buildFailureContext(
      fakeTest('/repo/tests/dashboard.spec.ts'),
      fakeResult({ errors: [{ message: 'y'.repeat(500) }] } as unknown as Partial<TestResult>),
      rootDir,
      50,
    );
    expect(context.errorMessage).toContain('450 more characters');
  });
});
