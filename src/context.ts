import fs from 'node:fs';
import path from 'node:path';
import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import type { FailedStepInfo, FailureContext } from './types.js';

const SNIPPET_RADIUS = 10;
const MAX_STDIO_LINES = 20;
const DEFAULT_MAX_ERROR_CHARS = 4000;

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/**
 * Playwright's `titlePath()` starts with the root suite and the project name, both
 * of which can be empty, and repeats the file name. Only the meaningful segments
 * are kept, so keys stay readable and stable across projects.
 */
export function normaliseTitlePath(titlePath: string[], file: string): string[] {
  const base = path.basename(file);
  return titlePath.filter((segment) => segment.trim().length > 0 && segment !== base);
}

/**
 * Stable identity of a test across runs. Follows the shape used by
 * `playwright-smart-retry-plugin`: the file relative to the root, then the titles.
 */
export function getTestKey(rootDir: string, file: string, titlePath: string[]): string {
  return `${path.relative(rootDir, file)}::${normaliseTitlePath(titlePath, file).join(' > ')}`;
}

/** Strips the colour codes Playwright puts in its error messages. */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/** Keeps the head of a long string, marking where it was cut. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated, ${value.length - max} more characters]`;
}

/**
 * Reads the lines around `line` from `file`, prefixed with their line number and
 * with the failing line marked. Returns an empty string when the file is unreadable.
 */
export function readSourceSnippet(file: string, line: number): string {
  if (line <= 0) return '';
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const start = Math.max(0, line - 1 - SNIPPET_RADIUS);
    const end = Math.min(lines.length, line + SNIPPET_RADIUS);
    return lines
      .slice(start, end)
      .map((text, index) => {
        const number = start + index + 1;
        return `${number === line ? '>' : ' '} ${number} | ${text}`;
      })
      .join('\n');
  } catch {
    return '';
  }
}

/** Flattens the step tree, keeping only the steps that carry an error. */
export function collectFailedSteps(steps: readonly TestStep[]): FailedStepInfo[] {
  const failed: FailedStepInfo[] = [];
  const walk = (current: readonly TestStep[]): void => {
    for (const step of current) {
      if (step.error) {
        failed.push({
          title: step.title,
          category: step.category,
          error: stripAnsi(step.error.message ?? String(step.error)),
        });
      }
      walk(step.steps ?? []);
    }
  };
  walk(steps);
  return failed;
}

function toLines(chunks: TestResult['stdout']): string[] {
  return chunks
    .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString('utf-8')))
    .join('')
    .replace(ANSI_PATTERN, '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-MAX_STDIO_LINES);
}

/** The line the stack attributes to `file`, when it mentions it at all. */
function findLineInStack(stack: string, file: string): number | undefined {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:(\\d+):`).exec(stack);
  return match ? Number(match[1]) : undefined;
}

/**
 * Locates the line inside the test file where the failure surfaced, falling back to
 * the declaration line of the test when the stack does not mention the file.
 */
function resolveErrorLine(test: TestCase, result: TestResult): number {
  const stack = result.errors[0]?.stack ?? '';
  return findLineInStack(stack, test.location.file) ?? test.location.line;
}

/** Builds the serialisable description of a failure that is handed to the model. */
export function buildFailureContext(
  test: TestCase,
  result: TestResult,
  rootDir: string,
  maxErrorChars: number = DEFAULT_MAX_ERROR_CHARS,
): FailureContext {
  const error = result.errors[0] ?? result.error;
  const line = resolveErrorLine(test, result);

  return {
    key: getTestKey(rootDir, test.location.file, test.titlePath()),
    title: test.title,
    titlePath: normaliseTitlePath(test.titlePath(), test.location.file),
    file: path.relative(rootDir, test.location.file),
    line,
    project: test.parent?.project?.()?.name,
    tags: (test as TestCase & { tags?: string[] }).tags ?? [],
    retry: result.retry,
    retries: test.retries,
    durationMs: result.duration,
    status: result.status,
    errorMessage: truncate(stripAnsi(error?.message ?? ''), maxErrorChars),
    errorStack: truncate(stripAnsi(error?.stack ?? ''), maxErrorChars),
    sourceSnippet: readSourceSnippet(test.location.file, line),
    attachmentNames: result.attachments.map((attachment) => attachment.name),
    stdout: toLines(result.stdout),
    stderr: toLines(result.stderr),
    failedSteps: collectFailedSteps(result.steps ?? []),
  };
}
