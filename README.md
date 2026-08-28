# playwright-ai-reporter-plugin

[![CI](https://github.com/EmanueleMinotto/playwright-ai-reporter-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/EmanueleMinotto/playwright-ai-reporter-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/playwright-ai-reporter-plugin)](https://www.npmjs.com/package/playwright-ai-reporter-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Playwright reporter that attaches, to every failed test, **at most three hypotheses** about why it
failed — ranked by likelihood, each justified by the evidence it used, with a suggested fix whenever
one can be inferred.

The plugin never claims to know the cause. It guesses, out loud, and says how sure it is.

## Quick start

```bash
npm install --save-dev playwright-ai-reporter-plugin
```

The default provider is [Ollama](https://ollama.com/), running locally — no API key, no data leaving
your machine:

```bash
ollama serve
ollama pull qwen3:8b
```

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['playwright-ai-reporter-plugin/reporter'],
    ['html'],
  ],
});
```

> [!IMPORTANT]
> **Reporter order matters.** Analyses are attached in `onEnd`, so any reporter that has to see them
> — `html`, `json`, `junit`, your own — must be registered *after* this one.

> [!NOTE]
> To read an analysis, open the report with `npx playwright show-report` and expand the failed test.
> Grepping `playwright-report/index.html` finds nothing: the report embeds its data as a base64 zip.

## How it works

1. `onTestEnd` records the failure and returns immediately — no model call there; only the final
   attempt of a test is worth analysing.
2. `onEnd` builds a context per failure (error, stack, source around the failing line, failed steps,
   stdout/stderr, previous runs of the same test, plus your `context` option) and asks the model.
3. One markdown attachment, `ai-failure-analysis`, is pushed onto the failed `TestResult`. Set
   `jsonAttachment: true` to also get `ai-failure-analysis.json`.
4. Failure and hypotheses are appended to the history file, so the next run knows what was suspected.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `'ollama' \| 'claude' \| 'openai' \| AIProvider` | auto-detected | Backend to use. A custom implementation is accepted. |
| `model` | `string` | per provider | `qwen3:8b`, `claude-sonnet-5` or `gpt-5`. |
| `ollama` | `{ host }` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `claude` | `{ apiKey, baseURL }` | `ANTHROPIC_API_KEY` | Anthropic credentials. |
| `openai` | `{ apiKey, baseURL }` | `OPENAI_API_KEY` | OpenAI credentials. |
| `history` | `HistoryConfig` | enabled | [Failure history](#failure-history). |
| `mcp` | `Record<string, McpServerConfig>` | — | [MCP servers](#mcp-servers) exposed to the model as tools. |
| `context` | `string \| (failure) => string \| Promise<string>` | — | [Background about the application](#project-context). |
| `maxContextChars` | `number` | `2000` | Characters kept from `context`. |
| `maxHypotheses` | `number` | `3` | Upper bound on the hypotheses kept. |
| `concurrency` | `number` | `2` | Failures analysed in parallel. |
| `timeout` | `number` | `60000` | Per-failure budget, tool calls included. |
| `maxFailuresPerRun` | `number` | `20` | Safety valve on a red run. |
| `maxToolRounds` | `number` | `4` | Provider round-trips per failure when MCP is configured. |
| `maxErrorChars` | `number` | `4000` | Characters kept from the message and the stack. |
| `jsonAttachment` | `boolean` | `false` | Also attach `ai-failure-analysis.json`. |
| `enabled` | `boolean` | `true` | Set to `false` to turn the plugin off. |

Set `PLAYWRIGHT_AI_DISABLED=1` to disable the plugin without touching the config.

<details>
<summary>A config using most of the options</summary>

```ts
reporter: [
  ['playwright-ai-reporter-plugin/reporter', {
    provider: 'ollama',
    model: 'qwen3:8b',
    ollama: { host: 'http://127.0.0.1:11434' },
    history: {
      enabled: true,
      path: '.playwright-ai/failure-history.json',
      maxEntriesPerTest: 10,
      ttl: '30d',
    },
    mcp: {
      jira: { command: 'npx', args: ['-y', '@some/jira-mcp'], env: { JIRA_URL: '…' } },
      github: { url: 'https://api.githubcopilot.com/mcp/' },
    },
    maxHypotheses: 3,
    concurrency: 2,
    timeout: 60_000,
    maxFailuresPerRun: 20,
    jsonAttachment: false,
    context: 'B2B order portal. Staging is reseeded every night at 02:00.',
    maxContextChars: 2000,
  }],
  ['html'],
],
```

</details>

## Providers

When none is named, the plugin picks from the environment: `ANTHROPIC_API_KEY` → Claude, then
`OPENAI_API_KEY` → OpenAI, then Ollama.

```ts
// Claude
['playwright-ai-reporter-plugin/reporter', { provider: 'claude', model: 'claude-sonnet-5' }]

// OpenAI, or any OpenAI-compatible gateway
['playwright-ai-reporter-plugin/reporter', {
  provider: 'openai',
  openai: { baseURL: 'https://my-gateway.example.com/v1' },
}]
```

`@anthropic-ai/sdk` and `openai` are optional dependencies, imported only when used.

<details>
<summary>A provider of your own</summary>

```ts
import type { AIProvider } from 'playwright-ai-reporter-plugin';

const myProvider: AIProvider = {
  name: 'internal',
  model: 'gateway-1',
  async complete({ messages, tools, jsonMode, signal }) {
    // …call whatever you run internally
    return { text: '{"hypotheses":[]}', toolCalls: [] };
  },
};
```

</details>

## Project context

The prompt is built from what Playwright knows. What the application does, how the environment
behaves and which parts are known to be fragile has to come from you: `context` adds it to the
prompt as a `Project context` section.

```ts
// A fixed note, the common case.
context: `
  B2B order portal. Customers place orders, admins approve them.
  Staging is reseeded every night at 02:00; runs started before then see stale data.
`,

// Or a function, called once per failure with the same FailureContext the model gets.
context: (failure) =>
  failure.tags.includes('@payments')
    ? 'Payments run against the Stripe sandbox, rate-limited to 5 requests per second.'
    : 'This suite covers the public catalogue, served from a CDN cache.',
```

The function may return a promise, and it is fail-soft: if it throws, the failure is analysed
without the context and a warning is printed. Keep the note short — the prompt already carries the
stack, the source and the past runs, and anything beyond `maxContextChars` is cut. It is reference
material for the model, not instructions: it cannot change how the analysis is written.

## Failure history

When a history file exists, the past outcomes of the same test are part of the prompt: dates,
statuses, error messages, the commit each run was on, and the hypotheses suggested at the time. That
is what lets the model say *"this locator has failed 3 times in the last 7 days"*.

The file lives at `.playwright-ai/failure-history.json`, relative to the directory holding your
`playwright.config.ts`. It is written atomically and pruned by age (`ttl`) and count
(`maxEntriesPerTest`). Add it to `.gitignore`, or commit it to share the history across the team.

In GitHub Actions:

```yaml
- uses: actions/cache@v4
  with:
    path: .playwright-ai
    key: playwright-ai-history-${{ github.run_id }}
    restore-keys: playwright-ai-history-
```

## MCP servers

Any number of MCP servers can be attached. Their tools are exposed to the model, namespaced by the
key you gave the server (`jira__search_issues`), and called when they could confirm or rule out a
hypothesis. Both transports are supported:

```ts
mcp: {
  // stdio: a local process
  jira: { command: 'npx', args: ['-y', '@some/jira-mcp'], env: { JIRA_URL: '…' } },
  // streamable HTTP: a remote server
  github: { url: 'https://api.githubcopilot.com/mcp/', headers: { authorization: 'Bearer …' } },
}
```

The loop is bounded by `maxToolRounds`, with tools withheld on the last round so the model has to
answer. Everything is fail-soft: an unreachable server is reported once and skipped. Tool calling
requires a model that supports it — `qwen3:8b` does, smaller Ollama models often do not.

> 📖 **[Worked example](docs/worked-example.md)** — what `context`, `history` and `mcp` look like
> when used together, and the analysis that comes out.

## Output

The model writes for a reader who has never used Playwright and does not work in QA: it describes
what a *user* would have seen and avoids test-automation jargon.

```markdown
### 🤖 Why this test may have failed

An automated check of the application did not pass. An AI read what the check did and
what went wrong, and wrote the guesses below. They are guesses, not answers: nobody has
verified them yet, and the most likely one comes first.

#### 1. The list of orders may still have been loading when the check looked at it
*Fairly likely — the AI rates this 72% likely.*

**Why the AI thinks so:** The check waited five seconds for the first row of the table and never saw it, while the page was still fetching the orders from the server.

**What it looked at:**
- the check gave up waiting for a row in the orders table
- this same check failed 3 times out of 5 in the last week, always in the same spot
- JIRA-1234, "dashboard sometimes empty"

**What could be tried:** Instead of pausing for a fixed half second, have the check wait until the table actually shows something. That removes the guesswork about how long loading takes.

#### 2. The sample data the check needs may not have been prepared
*Less likely — the AI rates this 21% likely.*

**Why the AI thinks so:** The run log has no line saying the sample orders were created, unlike the runs that passed.

**What it looked at:**
- the run log of this attempt

_Written by ollama (model qwen3:8b) — it also looked at how this check went in the past; it queried jira, github. This was written by an AI from the failure data alone. Nobody has checked it, so treat it as a starting point and confirm it before acting on it._
```

A hypothesis is kept only when it carries both a cause and a justification; confidences are clamped
to `[0, 1]`, the list is sorted by descending confidence and truncated to `maxHypotheses`. When
nothing usable comes back, no attachment is added and the run is unaffected.

<details>
<summary>The JSON attachment (<code>jsonAttachment: true</code>)</summary>

```jsonc
{
  "hypotheses": [
    {
      "cause": "A race condition may leave the table empty when the assertion runs",
      "confidence": 0.72,
      "reasoning": "The timeout fires on getByRole('row') while the stack shows the fetch still pending.",
      "evidence": ["stack dashboard.spec.ts:42", "history: 3/5 failures in the last 7d"],
      "suggestedFix": "replace waitForTimeout(500) with expect(locator).toBeVisible()"
    }
  ],
  "disclaimer": "This was written by an AI from the failure data alone. Nobody has checked it, so treat it as a starting point and confirm it before acting on it.",
  "provider": "ollama",
  "model": "qwen3:8b",
  "usedHistory": true,
  "usedMcpServers": ["jira", "github"],
  "generatedAt": "2026-08-27T09:00:00.000Z"
}
```

</details>

## Runnable demo

`examples/` holds three intentionally broken tests:

```bash
ollama serve && ollama pull qwen3:8b

cd examples
npm install
npx playwright test
npx playwright show-report
```

`OLLAMA_MODEL=llama3.2 npx playwright test` picks another model without editing the config. Run it
twice: the second run gets the first one's hypotheses in its prompt and starts citing them
(`previously suspected: race condition (80%)`).

## Cost and failure modes

- The model is called once per failed test, at most `maxFailuresPerRun` times per run.
- A missing Ollama, a missing API key, a malformed answer or an unreachable MCP server produce a
  single `[playwright-ai-reporter]` warning; the run's own result is never changed.
- The plugin only ever *adds* attachments. It does not fail, retry, skip or re-order tests.

## License

[MIT](LICENSE)
