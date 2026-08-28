import type { OllamaConfig } from '../types.js';
import type {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
} from './types.js';

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:8b';

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

interface OllamaResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  error?: string;
}

function toOllamaMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', content: message.content };
  }
  return { role: message.role, content: message.content };
}

function parseArguments(raw: OllamaToolCall['function']): Record<string, unknown> {
  const args = raw?.arguments;
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return args;
}

/**
 * Talks to a local Ollama server over its native `/api/chat` endpoint.
 * This is the default provider: it needs no API key and no network egress.
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';
  readonly model: string;
  private readonly host: string;

  constructor(model?: string, config: OllamaConfig = {}) {
    this.model = model ?? DEFAULT_OLLAMA_MODEL;
    this.host = (config.host ?? DEFAULT_OLLAMA_HOST).replace(/\/$/, '');
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: false,
      messages: request.messages.map(toOllamaMessage),
    };
    if (request.tools?.length) {
      body['tools'] = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    } else if (request.jsonMode) {
      body['format'] = 'json';
    }

    const response = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OllamaResponse;
    if (payload.error) throw new Error(`Ollama error: ${payload.error}`);

    const toolCalls: ToolCall[] = (payload.message?.tool_calls ?? [])
      .filter((call) => Boolean(call.function?.name))
      .map((call, index) => ({
        id: `ollama-${index}`,
        name: call.function!.name!,
        arguments: parseArguments(call.function),
      }));

    return { text: payload.message?.content ?? '', toolCalls };
  }
}
