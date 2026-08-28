import { jest } from '@jest/globals';
import { runToolLoop, type ToolRunner } from '../../src/mcp/loop.js';
import type {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  ToolDefinition,
} from '../../src/providers/types.js';

const tool: ToolDefinition = {
  name: 'jira__search',
  description: 'search issues',
  inputSchema: { type: 'object' },
};

function scriptedProvider(responses: CompletionResponse[]): {
  provider: AIProvider;
  requests: CompletionRequest[];
} {
  const requests: CompletionRequest[] = [];
  const provider: AIProvider = {
    name: 'fake',
    model: 'fake-1',
    complete: async (request) => {
      requests.push(request);
      return responses[requests.length - 1] ?? { text: '', toolCalls: [] };
    },
  };
  return { provider, requests };
}

function runner(tools: ToolDefinition[], output = 'JIRA-1 flaky dashboard'): ToolRunner {
  return {
    getTools: () => tools,
    callTool: jest.fn(async () => output) as ToolRunner['callTool'],
  };
}

describe('runToolLoop', () => {
  it('returns the first answer when no tools are configured', async () => {
    const { provider, requests } = scriptedProvider([{ text: '{"hypotheses":[]}', toolCalls: [] }]);

    const text = await runToolLoop(provider, [{ role: 'user', content: 'why?' }], undefined, {
      maxToolRounds: 4,
    });

    expect(text).toBe('{"hypotheses":[]}');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.jsonMode).toBe(true);
    expect(requests[0]!.tools).toBeUndefined();
  });

  it('feeds tool results back and returns the follow-up answer', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'jira__search', arguments: { q: 'flaky' } }] },
      { text: '{"hypotheses":[{"cause":"c"}]}', toolCalls: [] },
    ]);
    const hub = runner([tool]);

    const text = await runToolLoop(provider, [{ role: 'user', content: 'why?' }], hub, {
      maxToolRounds: 4,
    });

    expect(text).toBe('{"hypotheses":[{"cause":"c"}]}');
    expect(hub.callTool).toHaveBeenCalledWith('jira__search', { q: 'flaky' });

    const second = requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1' }] });
    expect(second.at(-1)).toEqual({
      role: 'tool',
      content: 'JIRA-1 flaky dashboard',
      toolCallId: 'c1',
    });
  });

  it('withholds the tools on the last round so the model has to answer', async () => {
    const { provider, requests } = scriptedProvider([
      { text: '', toolCalls: [{ id: 'c1', name: 'jira__search', arguments: {} }] },
      { text: 'final', toolCalls: [] },
    ]);

    const text = await runToolLoop(provider, [{ role: 'user', content: 'why?' }], runner([tool]), {
      maxToolRounds: 2,
    });

    expect(text).toBe('final');
    expect(requests[0]!.tools).toHaveLength(1);
    expect(requests[1]!.tools).toBeUndefined();
    expect(requests[1]!.jsonMode).toBe(true);
  });

  it('treats a runner without tools as no runner at all', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'answer', toolCalls: [] }]);

    const text = await runToolLoop(provider, [{ role: 'user', content: 'why?' }], runner([]), {
      maxToolRounds: 4,
    });

    expect(text).toBe('answer');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools).toBeUndefined();
  });
});
