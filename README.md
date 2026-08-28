# playwright-ai-reporter-plugin

[![CI](https://github.com/EmanueleMinotto/playwright-ai-reporter-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/EmanueleMinotto/playwright-ai-reporter-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/playwright-ai-reporter-plugin)](https://www.npmjs.com/package/playwright-ai-reporter-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Playwright reporter that, for every failed test, attaches **at most three hypotheses** about why
it failed — ranked by likelihood, each justified by the evidence it used, and with a suggested fix
whenever one can be inferred.

The plugin never claims to know the cause. It guesses, out loud, and says how sure it is.

---

## How it works

1. `onTestEnd` records the failure and returns immediately. No model is called there: Playwright
   does not await that hook, and only the final attempt of a test is worth analysing.
2. `onEnd` builds a context for each failure — error, stack, the source around the failing line,
   failed steps, stdout/stderr, and what this same test did in previous runs — plus whatever the
   `context` option adds about the project, and asks the model.
3. One attachment is pushed onto the failed `TestResult`: `ai-failure-analysis` (markdown, what you
   read in the HTML report), written for someone who has never used Playwright and does not work
   in QA. Set `jsonAttachment: true` to also get `ai-failure-analysis.json` for anything
   downstream; it is off by default.
4. The failure and the hypotheses generated for it are appended to the history file, so the next
   run knows what was suspected last time.

---

## Installation

```bash
npm install --save-dev playwright-ai-reporter-plugin
```

The default provider is [Ollama](https://ollama.com/), running locally — no API key, no data
leaving your machine:

```bash
ollama serve
ollama pull qwen3:8b
```

---

## Basic setup

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
> **Reporter order matters.** The analyses are attached in `onEnd`, so any reporter that has to see
> them — `html`, `json`, `junit`, your own — must be registered *after* this one. With the order
> reversed the run still passes, but the report is built before the attachments exist.

> [!NOTE]
> Looking for the analysis in the HTML report? Open it with `npx playwright show-report` and expand
> the failed test. Grepping `playwright-report/index.html` for `ai-failure-analysis` finds nothing
> even when it is there: the report embeds all its data as a base64 zip inside that file.

---

## Configuration

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

### Options reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | `'ollama' \| 'claude' \| 'openai' \| AIProvider` | auto-detected | Backend to use. A custom implementation is accepted. |
| `model` | `string` | per provider | `qwen3:8b`, `claude-sonnet-5` or `gpt-5`. |
| `ollama` | `{ host }` | `http://127.0.0.1:11434` | Ollama endpoint. |
| `claude` | `{ apiKey, baseURL }` | `ANTHROPIC_API_KEY` | Anthropic credentials. |
| `openai` | `{ apiKey, baseURL }` | `OPENAI_API_KEY` | OpenAI credentials. |
| `history` | `HistoryConfig` | enabled | Failure history, see below. |
| `mcp` | `Record<string, McpServerConfig>` | — | MCP servers exposed to the model as tools. |
| `maxHypotheses` | `number` | `3` | Upper bound on the hypotheses kept. |
| `concurrency` | `number` | `2` | Failures analysed in parallel. |
| `timeout` | `number` | `60000` | Per-failure budget, tool calls included. |
| `maxFailuresPerRun` | `number` | `20` | Safety valve on a red run. |
| `maxToolRounds` | `number` | `4` | Provider round-trips per failure when MCP is configured. |
| `maxErrorChars` | `number` | `4000` | Characters kept from the message and the stack. |
| `context` | `string \| (failure) => string \| Promise<string>` | — | Background about the application, see below. |
| `maxContextChars` | `number` | `2000` | Characters kept from `context`. |
| `jsonAttachment` | `boolean` | `false` | Set to `true` to also attach `ai-failure-analysis.json`. |
| `enabled` | `boolean` | `true` | Set to `false` to turn the plugin off. |

Set `PLAYWRIGHT_AI_DISABLED=1` to disable the plugin without touching the config — useful for local
runs where you do not want to wait for a model.

### Telling the model about your project

The prompt is built from what Playwright knows: the error, the stack, the source, the failed steps,
the history. Everything else — what the application does, how the environment behaves, which parts
are known to be fragile — has to come from you. `context` adds it to the prompt as a
`Project context` section. It matters more than it looks: the analyses are written for readers who
do not know the test suite, and describing what a *user* would have seen requires knowing what the
application is for.

```ts
// A fixed note, the common case.
context: `
  B2B order portal. Customers place orders, admins approve them.
  Staging is reseeded every night at 02:00; runs started before then see stale data.
  The payment step talks to the Stripe sandbox, which is occasionally slow.
`,
```

A function is called once per failure and receives the same `FailureContext` handed to the model,
so the note can depend on the test at hand:

```ts
context: (failure) =>
  failure.tags.includes('@payments')
    ? 'Payments run against the Stripe sandbox, rate-limited to 5 requests per second.'
    : 'This suite covers the public catalogue, which is served from a CDN cache.',
```

It may return a promise, and it is fail-soft: if it throws, the failure is analysed without the
context and a warning is printed.

Keep it short. The prompt already carries the stack, the source and the past runs, and a long note
dilutes them as much as it helps. Anything beyond `maxContextChars` (2000 by default) is cut, with
a single warning per run. This is reference material for the model, not instructions: it cannot
change how the analysis is written or how it is formatted.

---

## Choosing the AI

Ollama is the default because it needs no credentials. When none is named, the plugin picks a
provider from the environment: `ANTHROPIC_API_KEY` → Claude, then `OPENAI_API_KEY` → OpenAI, then
Ollama.

```ts
// Claude
['playwright-ai-reporter-plugin/reporter', { provider: 'claude', model: 'claude-sonnet-5' }]

// OpenAI, or any OpenAI-compatible gateway
['playwright-ai-reporter-plugin/reporter', {
  provider: 'openai',
  openai: { baseURL: 'https://my-gateway.example.com/v1' },
}]
```

`@anthropic-ai/sdk` and `openai` are optional dependencies, imported only when the matching
provider is used.

### A provider of your own

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

---

## Failure history

When a history file exists, the past outcomes of the same test are part of the prompt: dates,
statuses, error messages, the commit each run was on, and the hypotheses suggested at the time.
That is what lets the model say *"this locator has failed 3 times in the last 7 days"* instead of
looking at a single run in isolation.

The file lives at `.playwright-ai/failure-history.json` by default, relative to the directory that
holds your `playwright.config.ts`. It is written atomically and pruned by age (`ttl`) and by count
(`maxEntriesPerTest`). Add it to `.gitignore`, or commit it if you want the history shared across
the team.

### Persisting the history in GitHub Actions

```yaml
- uses: actions/cache@v4
  with:
    path: .playwright-ai
    key: playwright-ai-history-${{ github.run_id }}
    restore-keys: playwright-ai-history-
```

---

## MCP servers

Any number of MCP servers can be attached. Their tools are exposed to the model, namespaced by the
key you gave the server (`jira__search_issues`), and the model calls them when they could confirm
or rule out a hypothesis. Both transports are supported:

```ts
mcp: {
  // stdio: a local process
  jira: { command: 'npx', args: ['-y', '@some/jira-mcp'], env: { JIRA_URL: '…' } },
  // streamable HTTP: a remote server
  github: { url: 'https://api.githubcopilot.com/mcp/', headers: { authorization: 'Bearer …' } },
}
```

The loop is bounded by `maxToolRounds`, and the tools are withheld on the last round so the model
has to produce its answer. Everything here is fail-soft: a server that cannot be reached is
reported once and skipped — an unavailable Jira never breaks a test run.

Tool calling requires a model that supports it. `qwen3:8b` does; smaller Ollama models often do
not, in which case the plugin still works, just without the extra context.

---

## Output

Attached to every failed test as `ai-failure-analysis`. The model is told to write for a reader who
has never used Playwright and does not work in QA: it describes what a user of the application
would have seen, avoids test-automation jargon, and explains any term it cannot avoid.

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

With `jsonAttachment: true`, the same analysis is also attached as `ai-failure-analysis.json`
(off by default):

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

A hypothesis is kept only when it carries both a cause and a justification; confidences are clamped
to `[0, 1]`, the list is sorted by descending confidence and truncated to `maxHypotheses`. When
nothing usable comes back, no attachment is added and the run is unaffected.

---

## Example

`examples/` is a runnable demo with three intentionally broken tests:

```bash
ollama serve
ollama pull qwen3:8b

cd examples
npm install
npx playwright test
npx playwright show-report
```

`OLLAMA_MODEL` picks another model you already have, without editing the config:

```bash
OLLAMA_MODEL=llama3.2 npx playwright test
```

Run it twice: the second run gets the first one's hypotheses in its prompt, and starts citing them
as evidence (`previously suspected: race condition (80%)`).

---

## Cost and failure modes

- The model is called once per failed test, at most `maxFailuresPerRun` times per run.
- A missing Ollama, a missing API key, a malformed answer or an unreachable MCP server produce a
  single `[playwright-ai-reporter]` warning; the run's own result is never changed.
- The plugin only ever *adds* attachments. It does not fail, retry, skip or re-order tests.

---

## License

[MIT](LICENSE)
