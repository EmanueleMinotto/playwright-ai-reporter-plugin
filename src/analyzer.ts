import { runToolLoop, type ToolRunner } from './mcp/loop.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import type { AIProvider } from './providers/types.js';
import type { FailureAnalysis, FailureContext, FailureRecord, Hypothesis } from './types.js';

export const DISCLAIMER =
  'This was written by an AI from the failure data alone. Nobody has checked it, so treat it ' +
  'as a starting point and confirm it before acting on it.';

interface AnalyzeOptions {
  maxHypotheses: number;
  maxToolRounds: number;
  timeout: number;
  /** Already resolved and capped background about the project, may be empty. */
  extraContext?: string;
}

/** Extracts the JSON object from a reply that may be wrapped in prose or fences. */
export function extractJson(raw: string): unknown {
  const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(withoutFences);
  } catch {
    const start = withoutFences.indexOf('{');
    const end = withoutFences.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(withoutFences.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function toHypothesis(value: unknown): Hypothesis | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const cause = typeof candidate['cause'] === 'string' ? candidate['cause'].trim() : '';
  const reasoning = typeof candidate['reasoning'] === 'string' ? candidate['reasoning'].trim() : '';
  if (!cause || !reasoning) return undefined;

  const rawConfidence = Number(candidate['confidence']);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.5;
  const fix = candidate['suggestedFix'];

  return {
    cause,
    confidence,
    reasoning,
    evidence: toStringArray(candidate['evidence']),
    suggestedFix: typeof fix === 'string' && fix.trim().length > 0 ? fix.trim() : null,
  };
}

/**
 * Turns a raw model reply into hypotheses: keeps only well-formed ones, clamps the
 * confidences, sorts by descending likelihood and enforces the maximum count.
 */
export function parseHypotheses(raw: string, maxHypotheses: number): Hypothesis[] {
  const parsed = extractJson(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown> | undefined)?.['hypotheses'] as unknown);
  if (!Array.isArray(list)) return [];

  return list
    .map(toHypothesis)
    .filter((item): item is Hypothesis => item !== undefined)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxHypotheses);
}

/**
 * Asks the model why a test failed.
 *
 * Returns `undefined` when nothing usable came back, so the caller simply skips the
 * attachment instead of publishing an empty or malformed analysis.
 */
export async function analyzeFailure(
  provider: AIProvider,
  context: FailureContext,
  history: FailureRecord[],
  runner: ToolRunner | undefined,
  mcpServers: string[],
  options: AnalyzeOptions,
): Promise<FailureAnalysis | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);

  try {
    const raw = await runToolLoop(
      provider,
      [
        { role: 'system', content: buildSystemPrompt(options.maxHypotheses, mcpServers) },
        { role: 'user', content: buildUserPrompt(context, history, options.extraContext ?? '') },
      ],
      runner,
      { maxToolRounds: options.maxToolRounds, signal: controller.signal },
    );

    const hypotheses = parseHypotheses(raw, options.maxHypotheses);
    if (hypotheses.length === 0) return undefined;

    return {
      hypotheses,
      disclaimer: DISCLAIMER,
      provider: provider.name,
      model: provider.model,
      usedHistory: history.length > 0,
      usedMcpServers: mcpServers,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}
