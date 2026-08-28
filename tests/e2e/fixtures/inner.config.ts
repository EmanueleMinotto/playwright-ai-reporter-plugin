import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Configuration of the inner run driven by `attachment.spec.ts`.
 *
 * The AI reporter is registered *before* `json`, which is the whole point of the
 * exercise: the attachments it pushes in `onEnd` must be visible to the reporter
 * that serialises the run.
 */
export default defineConfig({
  testDir: './inner',
  reporter: [
    ['../stub-reporter.ts'],
    [
      'json',
      {
        outputFile:
          process.env['INNER_JSON_OUTPUT'] ?? path.join(process.cwd(), 'test-results/inner.json'),
      },
    ],
    [
      'html',
      {
        open: 'never',
        outputFolder:
          process.env['INNER_HTML_OUTPUT'] ?? path.join(process.cwd(), 'test-results/inner-html'),
      },
    ],
  ],
});
