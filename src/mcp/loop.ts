import type {
  AIProvider,
  ChatMessage,
  ToolDefinition,
} from '../providers/types.js';

/** The subset of `McpHub` the loop needs, kept narrow so it is easy to fake in tests. */
export interface ToolRunner {
  getTools(): ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface ToolLoopOptions {
  maxToolRounds: number;
  signal?: AbortSignal;
}

/**
 * Runs the model until it answers with text instead of tool calls.
 *
 * Each round feeds the tool results back into the conversation. The round budget
 * is bounded, and on the last round the tools are withheld so the model is forced
 * to produce its answer.
 */
export async function runToolLoop(
  provider: AIProvider,
  messages: ChatMessage[],
  runner: ToolRunner | undefined,
  options: ToolLoopOptions,
): Promise<string> {
  const conversation = [...messages];
  const tools = runner?.getTools() ?? [];
  const rounds = tools.length > 0 ? Math.max(1, options.maxToolRounds) : 1;

  for (let round = 0; round < rounds; round += 1) {
    const isLastRound = round === rounds - 1;
    const response = await provider.complete({
      messages: conversation,
      ...(isLastRound || tools.length === 0 ? { jsonMode: true } : { tools }),
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (response.toolCalls.length === 0 || isLastRound) {
      return response.text;
    }

    conversation.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
    });

    const results = await Promise.all(
      response.toolCalls.map(async (call) => ({
        call,
        output: await runner!.callTool(call.name, call.arguments),
      })),
    );
    for (const { call, output } of results) {
      conversation.push({ role: 'tool', content: output, toolCallId: call.id });
    }
  }

  return '';
}
