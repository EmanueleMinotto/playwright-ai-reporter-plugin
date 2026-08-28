import type { OpenAIConfig } from '../types.js';
import { loadOptionalModule } from './load-module.js';
import type {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
} from './types.js';

export const DEFAULT_OPENAI_MODEL = 'gpt-5';

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAICompletion {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }>;
}

interface OpenAIClient {
  chat: {
    completions: {
      create(
        body: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ): Promise<OpenAICompletion>;
    };
  };
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/** OpenAI backend, used when an OpenAI API key is available. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  readonly model: string;
  private client?: OpenAIClient;

  constructor(
    model?: string,
    private readonly config: OpenAIConfig = {},
  ) {
    this.model = model ?? DEFAULT_OPENAI_MODEL;
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      const module = await loadOptionalModule('openai');
      const OpenAI = (module['default'] ?? module['OpenAI']) as new (
        options: Record<string, unknown>,
      ) => OpenAIClient;
      this.client = new OpenAI({
        apiKey: this.config.apiKey ?? process.env['OPENAI_API_KEY'],
        ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
      });
    }
    return this.client;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const client = await this.getClient();

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toOpenAIMessage),
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
      body['response_format'] = { type: 'json_object' };
    }

    const response = await client.chat.completions.create(
      body,
      request.signal ? { signal: request.signal } : undefined,
    );

    const message = response.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
      .filter((call) => Boolean(call.function?.name))
      .map((call, index) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: call.id ?? `openai-${index}`, name: call.function!.name!, arguments: args };
      });

    return { text: message?.content ?? '', toolCalls };
  }
}
