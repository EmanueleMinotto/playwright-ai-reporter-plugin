import { toJson, toMarkdown } from '../../src/format.js';
import type { FailureAnalysis } from '../../src/types.js';

const analysis: FailureAnalysis = {
  hypotheses: [
    {
      cause: 'A race condition may leave the table empty',
      confidence: 0.72,
      reasoning: 'The timeout fires on getByRole("row")',
      evidence: ['stack dashboard.spec.ts:42', 'history: 3/5 failures in the last 7d'],
      suggestedFix: 'Replace waitForTimeout(500) with expect(locator).toBeVisible()',
    },
    {
      cause: 'The fixture data may not have been seeded',
      confidence: 0.2,
      reasoning: 'stdout shows no seeding line',
      evidence: [],
      suggestedFix: null,
    },
  ],
  disclaimer: 'These are AI-generated hypotheses, not verified diagnoses.',
  provider: 'ollama',
  model: 'qwen3:8b',
  usedHistory: true,
  usedMcpServers: ['jira', 'github'],
  generatedAt: '2026-08-27T09:00:00.000Z',
};

describe('toMarkdown', () => {
  it('renders ranked, justified hypotheses with their provenance', () => {
    expect(toMarkdown(analysis)).toMatchInlineSnapshot(`
"### 🤖 Why this test may have failed

An automated check of the application did not pass. An AI read what the check did and
what went wrong, and wrote the guesses below. They are guesses, not answers: nobody has
verified them yet, and the most likely one comes first.

#### 1. A race condition may leave the table empty
*Fairly likely — the AI rates this 72% likely.*

**Why the AI thinks so:** The timeout fires on getByRole("row")

**What it looked at:**
- stack dashboard.spec.ts:42
- history: 3/5 failures in the last 7d

**What could be tried:** Replace waitForTimeout(500) with expect(locator).toBeVisible()

#### 2. The fixture data may not have been seeded
*Less likely — the AI rates this 20% likely.*

**Why the AI thinks so:** stdout shows no seeding line

_Written by ollama (model qwen3:8b) — it also looked at how this check went in the past; it queried jira, github. These are AI-generated hypotheses, not verified diagnoses._"
`);
  });

  it('spells out the absence of history and MCP servers', () => {
    const markdown = toMarkdown({ ...analysis, usedHistory: false, usedMcpServers: [] });
    expect(markdown).toContain('no past results of this check were available');
    expect(markdown).not.toContain('it queried');
  });

  it('flattens multi-line reasoning into a single readable sentence', () => {
    const markdown = toMarkdown({
      ...analysis,
      hypotheses: [{ ...analysis.hypotheses[0]!, reasoning: 'first\nsecond' }],
    });
    expect(markdown).toContain('**Why the AI thinks so:** first second');
  });

  it('translates the confidence into words', () => {
    const wording = (confidence: number) =>
      toMarkdown({ ...analysis, hypotheses: [{ ...analysis.hypotheses[0]!, confidence }] });
    expect(wording(0.9)).toContain('Fairly likely');
    expect(wording(0.5)).toContain('Possible');
    expect(wording(0.1)).toContain('Less likely');
  });
});

describe('toJson', () => {
  it('emits the analysis verbatim as pretty JSON', () => {
    expect(JSON.parse(toJson(analysis))).toEqual(analysis);
    expect(toJson(analysis).endsWith('\n')).toBe(true);
  });
});
