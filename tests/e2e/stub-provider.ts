import type { AIProvider } from '../../src/providers/types.js';

/**
 * A provider that answers with a fixed, well-formed analysis.
 *
 * The end-to-end suite is about the plugin's plumbing — that the attachments reach
 * the reporters — so it must not depend on a running Ollama or on any API key.
 */
export const stubProvider: AIProvider = {
  name: 'stub',
  model: 'stub-1',
  complete: async () => ({
    text: JSON.stringify({
      hypotheses: [
        {
          cause: 'The assertion may compare values of different types',
          confidence: 0.8,
          reasoning: 'The error shows a strict equality check between two different literals',
          evidence: ['error message'],
          suggestedFix: 'Assert on the value the code actually produces',
        },
      ],
    }),
    toolCalls: [],
  }),
};
