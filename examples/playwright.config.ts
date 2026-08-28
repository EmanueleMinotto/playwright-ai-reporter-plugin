import { defineConfig } from '@playwright/test';

/**
 * Demo configuration, wired to a local Ollama.
 *
 * Start it first:
 *
 * ```bash
 * ollama serve
 * ollama pull qwen3:8b
 * ```
 *
 * Set `OLLAMA_MODEL` to try another model you already have, e.g. `llama3.2`.
 *
 * Note the reporter order: the AI reporter must come before `html`, otherwise the
 * HTML report is built before the attachments exist.
 */
export default defineConfig({
  testDir: './tests',
  reporter: [
    [
      '../src/reporter.ts',
      {
        provider: 'ollama',
        model: process.env['OLLAMA_MODEL'] ?? 'qwen3:8b',
        history: { path: '.playwright-ai/failure-history.json' },
        context:
          'Demo suite of the plugin itself. The tests here fail on purpose, ' +
          'to show what the analysis looks like.',
        // Uncomment to let the model query your own systems:
        // mcp: {
        //   github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        // },
      },
    ],
    ['list'],
    ['html', { open: 'never' }],
  ],
});
