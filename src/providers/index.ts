import type { AIReporterOptions, ProviderName } from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import type { AIProvider } from './types.js';

function isProvider(value: unknown): value is AIProvider {
  return typeof value === 'object' && value !== null && 'complete' in value;
}

/** Picks a provider from the environment when the user did not name one. */
export function detectProviderName(env: NodeJS.ProcessEnv = process.env): ProviderName {
  if (env['ANTHROPIC_API_KEY']) return 'claude';
  if (env['OPENAI_API_KEY']) return 'openai';
  return 'ollama';
}

/**
 * Resolves the configured backend.
 *
 * Precedence: an explicit `AIProvider` instance, then an explicit provider name,
 * then auto-detection from the environment, which falls back to local Ollama.
 */
export function resolveProvider(options: AIReporterOptions = {}): AIProvider {
  if (isProvider(options.provider)) return options.provider;

  const name = options.provider ?? detectProviderName();
  switch (name) {
    case 'claude':
      return new AnthropicProvider(options.model, options.claude);
    case 'openai':
      return new OpenAIProvider(options.model, options.openai);
    case 'ollama':
      return new OllamaProvider(options.model, options.ollama);
    default:
      throw new Error(`Unknown provider: "${String(name)}".`);
  }
}

export { AnthropicProvider, OllamaProvider, OpenAIProvider };
export type { AIProvider };
