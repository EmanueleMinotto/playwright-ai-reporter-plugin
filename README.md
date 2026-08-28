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

## Writing like someone who knows the product

The three inputs — MCP, history and `context` — do different jobs, and they only add up to
something worth reading when all three are supplied. Alone, the model sees a stack trace and can
say little more than *"the locator timed out"*. Together they give it what an experienced QA
engineer has and a stack trace does not: what the application is for, what this test has been
doing lately, and what the rest of the organisation already knows about it.

| Input | What it supplies | The sentence it makes possible |
| --- | --- | --- |
| `context` | The domain — what the app does, how the environments behave, what is known to be fragile | *"the nightly reseed had not finished, so the customer had no orders to approve"* |
| `history` | Time — how this same test behaved on the previous runs, and what was suspected then | *"it has failed 4 times in 9 days, always on the same step, and never on `main`"* |
| `mcp` | The rest of the organisation — tickets, commits, pull requests, deploys, dashboards | *"a change to the orders endpoint landed 40 minutes before the first failure"* |

### The configuration

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['playwright-ai-reporter-plugin/reporter', {
      provider: 'claude',
      model: 'claude-sonnet-5',

      // 1. Time: keep a month of runs, shared across the team by committing the file.
      history: {
        enabled: true,
        path: '.playwright-ai/failure-history.json',
        maxEntriesPerTest: 10,
        ttl: '30d',
      },

      // 2. The organisation: the model queries these when they could confirm a hypothesis.
      mcp: {
        jira: {
          command: 'npx',
          args: ['-y', '@some/jira-mcp'],
          env: { JIRA_URL: 'https://acme.atlassian.net', JIRA_TOKEN: process.env.JIRA_TOKEN! },
        },
        github: {
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        },
      },
      maxToolRounds: 4,

      // 3. The domain: what nobody can infer from the code.
      context: (failure) => {
        const shared = `
          B2B order portal. Customers place orders, admins approve them.
          Staging is reseeded nightly at 02:00 UTC; runs started before it finishes see no orders.
          Feature flags are read at page load, not per request.
        `;

        if (failure.tags.includes('@payments')) {
          return `${shared}
            Payments go through the Stripe sandbox: rate-limited to 5 rps, and it returns 402 for
            the test card ending 0341 by design.`;
        }

        if (failure.file.includes('admin/')) {
          return `${shared}
            The admin area is behind SSO. Its session expires after 15 minutes, which is shorter
            than the longest suites.`;
        }

        return shared;
      },
      maxContextChars: 2000,
    }],
    ['html'],
  ],
});
```

The `context` function receives the same `FailureContext` handed to the model, so `tags`, `file`,
`project`, `title` and `retry` are all available to decide which note applies. It may be async —
reading the current deploy from an internal endpoint is a legitimate use — and it is fail-soft: if
it throws, the failure is still analysed, just without the note.

### What comes out

Same failure, an assertion that timed out on the orders table, analysed with all three inputs
available:

```markdown
### 🤖 Why this test may have failed

An automated check of the application did not pass. An AI read what the check did and
what went wrong, and wrote the guesses below. They are guesses, not answers: nobody has
verified them yet, and the most likely one comes first.

#### 1. The overnight data refresh may not have finished before the check started
*Likely — the AI rates this 78% likely.*

**Why the AI thinks so:** The check looks for orders belonging to a sample customer, and the
sample data for this environment is recreated every night at 02:00 UTC. This run started at
02:04, four minutes into that window. The three earlier failures of this same check all started
between 02:00 and 02:10, and the runs that started later in the morning all passed.

**What it looked at:**
- the check waited 5 seconds for a row in the orders table and never saw one
- this check failed 4 times in the last 9 days, every time in a run started between 02:00 and 02:10
- last week the AI already suspected the same cause here, at 61% — one week later the pattern holds
- no code touching orders was merged in that period (github: no matching pull requests)

**What could be tried:** Either start the nightly run after the refresh is known to be finished, or
have the check create the orders it needs instead of relying on the ones the refresh provides. The
second option makes the check independent of when it runs.

#### 2. A recent change to the orders endpoint may have altered what the page receives
*Possible — the AI rates this 15% likely.*

**Why the AI thinks so:** A change to the orders API was released the day before the first of these
failures, and the ticket describing it mentions a new response format. That would explain an empty
table even with the data present — but it would also have broken the morning runs, and it did not.

**What it looked at:**
- JIRA-4127, "paginate GET /orders", closed 10 days ago
- github: pull request #892, merged the same day
- the same check passed 11 times since that release

**What could be tried:** Open the page by hand against staging in the middle of the morning. If the
orders show up, this can be ruled out and the first guess is the one to act on.

_Written by claude (model claude-sonnet-5) — it also looked at how this check went in the past; it
queried jira, github. This was written by an AI from the failure data alone. Nobody has checked it,
so treat it as a starting point and confirm it before acting on it._
```

What makes this read like a person rather than a summariser is not the prose. It is that the second
hypothesis is argued *down*: the model found a plausible-looking ticket, weighed it against the
eleven passing runs since that release, and said so. The evidence for that move came from three
places at once — the ticket from MCP, the passing runs from the history, the significance of `02:00`
from `context` — and none of them is in the stack trace.

### Getting there

- **Start with `context`.** It is the cheapest of the three and the one with the largest effect.
  Two or three sentences about the domain and the environment change the tone of every analysis.
- **Let the history build.** The first run has nothing to compare against; the value shows up around
  the fifth. In CI, persist `.playwright-ai/` between runs (see above) or commit it.
- **Add MCP last, one server at a time.** Each one widens what the model can check and lengthens the
  run. Start with the tracker, since tickets are what the model cites best.
- **Read the analyses and correct the note.** When the model keeps guessing something the team knows
  to be wrong, that belongs in `context` as a fact. This is the loop that turns the note into
  institutional knowledge — a short note that has been corrected five times beats a long one written
  once.
- **Watch the budget.** Tool calls happen inside `timeout` (60s by default). With several MCP
  servers, raise it and keep `maxToolRounds` at 4 or 5 — beyond that the model tends to browse
  rather than verify.

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
