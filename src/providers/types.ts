/** A message in the conversation handed to the model. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on `tool` messages: the call this message answers. */
  toolCallId?: string;
  /** Set on `assistant` messages that requested tools, so providers can replay them. */
  toolCalls?: ToolCall[];
}

/** A tool the model may call, described with a JSON Schema for its arguments. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** Ask the provider for a JSON object when no tools are expected. */
  jsonMode?: boolean;
  /** Abort signal enforcing the per-failure timeout. */
  signal?: AbortSignal;
}

export interface CompletionResponse {
  /** Text produced by the model, empty when it only requested tools. */
  text: string;
  /** Tools the model wants called before it can answer. */
  toolCalls: ToolCall[];
}

/**
 * Minimal contract every backend implements. Custom implementations can be passed
 * straight to the reporter through the `provider` option.
 */
export interface AIProvider {
  /** Identifier reported in the attachment, e.g. `ollama`. */
  readonly name: string;
  /** Model identifier reported in the attachment. */
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}
