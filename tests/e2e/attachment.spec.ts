import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { readHtmlReport } from './html-report.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const innerConfig = path.join(here, 'fixtures/inner.config.ts');

interface JsonReport {
  suites: Array<{
    specs: Array<{
      title: string;
      tests: Array<{
        results: Array<{
          status: string;
          attachments: Array<{ name: string; contentType: string; body?: string }>;
        }>;
      }>;
    }>;
  }>;
}

/**
 * Runs a nested Playwright suite with the plugin registered before the `json`
 * reporter, then inspects the report the way any downstream tool would.
 */
function runInnerSuite(env: Record<string, string> = {}): { report: JsonReport; htmlDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ai-e2e-'));
  const output = path.join(dir, 'inner-report.json');
  const htmlDir = path.join(dir, 'html');
  const result = spawnSync('npx', ['playwright', 'test', '--config', innerConfig], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, INNER_JSON_OUTPUT: output, INNER_HTML_OUTPUT: htmlDir, ...env },
  });

  expect(result.error, result.stderr).toBeUndefined();
  expect(fs.existsSync(output), `no report at ${output}\n${result.stdout}${result.stderr}`).toBe(
    true,
  );
  return { report: JSON.parse(fs.readFileSync(output, 'utf-8')) as JsonReport, htmlDir };
}



function attachmentsOf(report: JsonReport, specTitle: string) {
  const spec = report.suites
    .flatMap((suite) => suite.specs)
    .find((candidate) => candidate.title === specTitle);
  expect(spec, `spec "${specTitle}" missing from the report`).toBeDefined();
  return spec!.tests.flatMap((entry) => entry.results.flatMap((result) => result.attachments));
}

test('attaches the AI analysis to a failed test, visible to downstream reporters', () => {
  const attachments = attachmentsOf(runInnerSuite().report, 'fails on purpose');
  const names = attachments.map((attachment) => attachment.name);

  expect(names).toContain('ai-failure-analysis');
  expect(names).toContain('ai-failure-analysis.json');

  const markdown = attachments.find((attachment) => attachment.name === 'ai-failure-analysis')!;
  expect(markdown.contentType).toBe('text/markdown');
  expect(Buffer.from(markdown.body!, 'base64').toString('utf-8')).toContain(
    'Why this test may have failed',
  );

  const json = attachments.find((attachment) => attachment.name === 'ai-failure-analysis.json')!;
  const analysis = JSON.parse(Buffer.from(json.body!, 'base64').toString('utf-8')) as {
    hypotheses: Array<{ cause: string; confidence: number; reasoning: string }>;
  };
  expect(analysis.hypotheses.length).toBeGreaterThan(0);
  expect(analysis.hypotheses.length).toBeLessThanOrEqual(3);
  expect(analysis.hypotheses[0]!.reasoning).not.toBe('');
});

test('leaves passing tests untouched', () => {
  expect(attachmentsOf(runInnerSuite().report, 'passes')).toHaveLength(0);
});

test('the analysis reaches the HTML report too', () => {
  const { htmlDir } = runInnerSuite();

  // The HTML report inlines its data as a base64 zip, so it has to be inflated
  // before the attachments can be looked for — searching index.html as text finds
  // nothing even when the attachment is there.
  const html = readHtmlReport(htmlDir);
  const index = html.indexOf('fails on purpose');

  expect(index, 'the failing test is missing from the HTML report').toBeGreaterThan(-1);
  expect(
    html.slice(index, index + 4000).includes('ai-failure-analysis'),
    'the analysis is missing from the HTML report',
  ).toBe(true);
});

test('attaches nothing when PLAYWRIGHT_AI_DISABLED is set', () => {
  const attachments = attachmentsOf(
    runInnerSuite({ PLAYWRIGHT_AI_DISABLED: '1' }).report,
    'fails on purpose',
  );
  expect(attachments.map((attachment) => attachment.name)).not.toContain('ai-failure-analysis');
});
