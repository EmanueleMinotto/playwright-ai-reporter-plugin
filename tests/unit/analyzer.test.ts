import { analyzeFailure, extractJson, parseHypotheses } from '../../src/analyzer.js';
import type { AIProvider, CompletionRequest, CompletionResponse } from '../../src/providers/types.js';
import type { FailureContext } from '../../src/types.js';

const context: FailureContext = {
  key: 'tests/a.spec.ts::case',
  title: 'case',
  titlePath: ['case'],
  file: 'tests/a.spec.ts',
  line: 1,
  tags: [],
  retry: 0,
  retries: 0,
  durationMs: 10,
  status: 'failed',
  errorMessage: 'boom',
  errorStack: '',
  sourceSnippet: '',
  attachmentNames: [],
  stdout: [],
  stderr: [],
  failedSteps: [],
};

function providerReturning(text: string): AIProvider {
  return {
    name: 'fake',
    model: 'fake-1',
    complete: async (_request: CompletionRequest): Promise<CompletionResponse> => ({
      text,
      toolCalls: [],
    }),
  };
}

const options = { maxHypotheses: 3, maxToolRounds: 4, timeout: 1000 };

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips code fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers an object embedded in prose', () => {
    expect(extractJson('Here you go: {"a":1} — hope it helps')).toEqual({ a: 1 });
  });

  it('returns undefined when there is no object', () => {
    expect(extractJson('no json at all')).toBeUndefined();
  });
});

describe('parseHypotheses', () => {
  const raw = JSON.stringify({
    hypotheses: [
      { cause: 'low', confidence: 0.1, reasoning: 'because', evidence: ['stack'] },
      { cause: 'high', confidence: 2, reasoning: 'because', suggestedFix: 'do this' },
      { cause: 'mid', confidence: 0.5, reasoning: 'because' },
      { cause: 'extra', confidence: 0.4, reasoning: 'because' },
    ],
  });

  it('sorts by descending confidence, clamps it and enforces the maximum', () => {
    const hypotheses = parseHypotheses(raw, 3);
    expect(hypotheses.map((item) => item.cause)).toEqual(['high', 'mid', 'extra']);
    expect(hypotheses[0]!.confidence).toBe(1);
    expect(hypotheses[0]!.suggestedFix).toBe('do this');
  });

  it('drops hypotheses without a cause or a justification', () => {
    const partial = JSON.stringify({
      hypotheses: [
        { cause: 'unjustified', confidence: 0.9 },
        { reasoning: 'no cause', confidence: 0.9 },
        { cause: 'kept', confidence: 0.3, reasoning: 'justified' },
      ],
    });
    expect(parseHypotheses(partial, 3).map((item) => item.cause)).toEqual(['kept']);
  });

  it('normalises a missing fix to null and a missing evidence list to an empty array', () => {
    const [hypothesis] = parseHypotheses(
      JSON.stringify({ hypotheses: [{ cause: 'c', confidence: 0.5, reasoning: 'r' }] }),
      3,
    );
    expect(hypothesis!.suggestedFix).toBeNull();
    expect(hypothesis!.evidence).toEqual([]);
  });

  it('defaults an unusable confidence to 0.5', () => {
    const [hypothesis] = parseHypotheses(
      JSON.stringify({ hypotheses: [{ cause: 'c', confidence: 'high', reasoning: 'r' }] }),
      3,
    );
    expect(hypothesis!.confidence).toBe(0.5);
  });

  it('accepts a bare array as well', () => {
    expect(parseHypotheses('[{"cause":"c","confidence":0.4,"reasoning":"r"}]', 3)).toHaveLength(1);
  });

  it('returns nothing for an unparsable reply', () => {
    expect(parseHypotheses('the test failed because of flakiness', 3)).toEqual([]);
  });
});

describe('analyzeFailure', () => {
  it('builds the analysis and records the provenance', async () => {
    const provider = providerReturning(
      JSON.stringify({ hypotheses: [{ cause: 'c', confidence: 0.8, reasoning: 'r' }] }),
    );

    const analysis = await analyzeFailure(
      provider,
      context,
      [{ date: '2026-08-01T10:00:00.000Z', status: 'failed', errorMessage: 'boom' }],
      undefined,
      ['jira'],
      options,
    );

    expect(analysis).toBeDefined();
    expect(analysis!.hypotheses).toHaveLength(1);
    expect(analysis!.provider).toBe('fake');
    expect(analysis!.model).toBe('fake-1');
    expect(analysis!.usedHistory).toBe(true);
    expect(analysis!.usedMcpServers).toEqual(['jira']);
    expect(analysis!.disclaimer).toMatch(/written by an AI/);
  });

  it('returns undefined when the reply yields no usable hypothesis', async () => {
    const analysis = await analyzeFailure(
      providerReturning('sorry, I cannot help'),
      context,
      [],
      undefined,
      [],
      options,
    );
    expect(analysis).toBeUndefined();
  });

  it('reports that no history was used when there is none', async () => {
    const provider = providerReturning(
      JSON.stringify({ hypotheses: [{ cause: 'c', confidence: 0.8, reasoning: 'r' }] }),
    );
    const analysis = await analyzeFailure(provider, context, [], undefined, [], options);
    expect(analysis!.usedHistory).toBe(false);
  });
});
