import type { ClaudeConfig } from '../types.js';
import { loadOptionalModule } from './load-module.js';
import type {
  AIProvider,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ToolCall,
} from './types.js';

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

const MAX_TOKENS = 4096;

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessage {
  content?: AnthropicContentBlock[];
}

interface AnthropicClient {
  messages: {
    create(body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicMessage>;
  };
}

/**
 * Splits the conversation the way the Messages API expects: a top-level `system`
 * prompt, and `user`/`assistant` turns where tool results are content blocks.
 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  turns: Array<Record<string, unknown>>;
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const turns: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      turns.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
        ],
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      turns.push({ role: 'assistant', content: blocks });
      continue;
    }
    turns.push({ role: message.role, content: message.content });
  }
  return { system, turns };
}

/** Claude backend, used when an Anthropic API key is available. */
export class AnthropicProvider implements AIProvider {
  readonly name = 'claude';
  readonly model: string;
  private client?: AnthropicClient;

  constructor(
    model?: string,
    private readonly config: ClaudeConfig = {},
  ) {
    this.model = model ?? DEFAULT_CLAUDE_MODEL;
  }

  private async getClient(): Promise<AnthropicClient> {
    if (!this.client) {
      const module = await loadOptionalModule('@anthropic-ai/sdk');
      const Anthropic = (module['default'] ?? module['Anthropic']) as new (
        options: Record<string, unknown>,
      ) => AnthropicClient;
      this.client = new Anthropic({
        apiKey: this.config.apiKey ?? process.env['ANTHROPIC_API_KEY'],
        ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
      });
    }
    return this.client;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const client = await this.getClient();
    const { system, turns } = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: turns,
    };
    if (system) body['system'] = system;
    if (request.tools?.length) {
      body['tools'] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const response = await client.messages.create(
      body,
      request.signal ? { signal: request.signal } : undefined,
    );

    const blocks = response.content ?? [];
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === 'tool_use' && block.name)
      .map((block, index) => ({
        id: block.id ?? `claude-${index}`,
        name: block.name!,
        arguments: block.input ?? {},
      }));

    return { text, toolCalls };
  }
}
