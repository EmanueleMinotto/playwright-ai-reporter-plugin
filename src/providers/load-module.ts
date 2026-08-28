/**
 * Imports an optional dependency at runtime.
 *
 * The specifier is kept in a variable on purpose: it prevents bundlers and the
 * TypeScript compiler from resolving `@anthropic-ai/sdk` and `openai` statically,
 * so users who stay on the default Ollama provider never have to install them.
 */
export async function loadOptionalModule(specifier: string): Promise<Record<string, unknown>> {
  try {
    const imported: unknown = await import(specifier);
    return imported as Record<string, unknown>;
  } catch {
    throw new Error(
      `The "${specifier}" package is required for this provider. Install it with \`npm i ${specifier}\`.`,
    );
  }
}
