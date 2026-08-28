import { jest } from '@jest/globals';
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAIProvider,
  detectProviderName,
  resolveProvider,
} from '../../src/providers/index.js';
import { DEFAULT_OLLAMA_MODEL } from '../../src/providers/ollama.js';
import type { AIProvider } from '../../src/providers/types.js';

describe('detectProviderName', () => {
  it('prefers Claude, then OpenAI, then falls back to Ollama', () => {
    expect(detectProviderName({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' })).toBe('claude');
    expect(detectProviderName({ OPENAI_API_KEY: 'k' })).toBe('openai');
    expect(detectProviderName({})).toBe('ollama');
  });
});

describe('resolveProvider', () => {
  it('returns a custom provider instance untouched', () => {
    const custom: AIProvider = {
      name: 'custom',
      model: 'x',
      complete: async () => ({ text: '', toolCalls: [] }),
    };
    expect(resolveProvider({ provider: custom })).toBe(custom);
  });

  it('builds the provider named in the options', () => {
    expect(resolveProvider({ provider: 'ollama' })).toBeInstanceOf(OllamaProvider);
    expect(resolveProvider({ provider: 'claude' })).toBeInstanceOf(AnthropicProvider);
    expect(resolveProvider({ provider: 'openai' })).toBeInstanceOf(OpenAIProvider);
  });

  it('defaults to Ollama and its default model', () => {
    const provider = resolveProvider({ provider: 'ollama' });
    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it('rejects an unknown provider name', () => {
    expect(() => resolveProvider({ provider: 'gemini' as 'ollama' })).toThrow(/Unknown provider/);
  });
});

describe('OllamaProvider', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(payload: unknown, ok = true): jest.Mock {
    const mock = jest.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'Server Error',
      json: async () => payload,
    }));
    globalThis.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it('posts the conversation to /api/chat and returns the text', async () => {
    const mock = mockFetch({ message: { content: '{"hypotheses":[]}' } });
    const provider = new OllamaProvider(undefined, { host: 'http://localhost:1234/' });

    const response = await provider.complete({
      messages: [{ role: 'user', content: 'why?' }],
      jsonMode: true,
    });

    expect(response.text).toBe('{"hypotheses":[]}');
    const [url, init] = mock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('http://localhost:1234/api/chat');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['model']).toBe(DEFAULT_OLLAMA_MODEL);
    expect(body['stream']).toBe(false);
    expect(body['format']).toBe('json');
  });

  it('sends the tool definitions instead of the json format when tools are available', async () => {
    const mock = mockFetch({ message: { content: '' } });
    const provider = new OllamaProvider('llama3.1');

    await provider.complete({
      messages: [{ role: 'user', content: 'why?' }],
      jsonMode: true,
      tools: [{ name: 'jira__search', description: 'search', inputSchema: { type: 'object' } }],
    });

    const [, init] = mock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['format']).toBeUndefined();
    expect(body['tools']).toHaveLength(1);
  });

  it('normalises tool calls, parsing string arguments', async () => {
    mockFetch({
      message: {
        content: '',
        tool_calls: [
          { function: { name: 'jira__search', arguments: '{"q":"flaky"}' } },
          { function: { name: 'github__issues', arguments: { state: 'open' } } },
          { function: {} },
        ],
      },
    });

    const response = await new OllamaProvider().complete({
      messages: [{ role: 'user', content: 'why?' }],
    });

    expect(response.toolCalls).toEqual([
      { id: 'ollama-0', name: 'jira__search', arguments: { q: 'flaky' } },
      { id: 'ollama-1', name: 'github__issues', arguments: { state: 'open' } },
    ]);
  });

  it('throws on a transport error and on an error payload', async () => {
    mockFetch({}, false);
    await expect(
      new OllamaProvider().complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/failed with 500/);

    mockFetch({ error: 'model not found' });
    await expect(
      new OllamaProvider().complete({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/model not found/);
  });
});
