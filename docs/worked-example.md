# Writing like someone who knows the product

The three inputs — `context`, `history` and `mcp` — do different jobs, and they only add up to
something worth reading when all three are supplied. Alone, the model sees a stack trace and can
say little more than *"the locator timed out"*.

| Input | What it supplies | The sentence it makes possible |
| --- | --- | --- |
| `context` | The domain — what the app does, how the environments behave, what is known to be fragile | *"the nightly reseed had not finished, so the customer had no orders to approve"* |
| `history` | Time — how this same test behaved on previous runs, and what was suspected then | *"it has failed 4 times in 9 days, always on the same step, and never on `main`"* |
| `mcp` | The rest of the organisation — tickets, commits, pull requests, deploys, dashboards | *"a change to the orders endpoint landed 40 minutes before the first failure"* |

## The configuration

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

## What comes out

Same failure — an assertion that timed out on the orders table — analysed with all three inputs
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

## Getting there

- **Start with `context`.** The cheapest of the three and the one with the largest effect. Two or
  three sentences about the domain and the environment change the tone of every analysis.
- **Let the history build.** The first run has nothing to compare against; the value shows up around
  the fifth. In CI, persist `.playwright-ai/` between runs or commit it.
- **Add MCP last, one server at a time.** Each one widens what the model can check and lengthens the
  run. Start with the tracker, since tickets are what the model cites best.
- **Read the analyses and correct the note.** When the model keeps guessing something the team knows
  to be wrong, that belongs in `context` as a fact. A short note corrected five times beats a long
  one written once.
- **Watch the budget.** Tool calls happen inside `timeout` (60s by default). With several MCP
  servers, raise it and keep `maxToolRounds` at 4 or 5 — beyond that the model tends to browse
  rather than verify.
