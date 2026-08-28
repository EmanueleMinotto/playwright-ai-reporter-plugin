import type { FailureAnalysis, Hypothesis } from './types.js';

/** Turns a confidence into words, for readers who do not think in percentages. */
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.7) return 'Fairly likely';
  if (confidence >= 0.4) return 'Possible';
  return 'Less likely';
}

function renderHypothesis(hypothesis: Hypothesis, index: number): string[] {
  const confidence = Math.round(hypothesis.confidence * 100);
  const lines = [
    `#### ${index + 1}. ${hypothesis.cause}`,
    `*${confidenceLabel(hypothesis.confidence)} — the AI rates this ${confidence}% likely.*`,
    '',
    `**Why the AI thinks so:** ${hypothesis.reasoning.replace(/\n/g, ' ')}`,
  ];

  if (hypothesis.evidence.length > 0) {
    lines.push('', '**What it looked at:**');
    hypothesis.evidence.forEach((item) => lines.push(`- ${item}`));
  }

  if (hypothesis.suggestedFix) {
    lines.push('', `**What could be tried:** ${hypothesis.suggestedFix}`);
  }

  lines.push('');
  return lines;
}

/** Renders the analysis as the markdown shown in the HTML report. */
export function toMarkdown(analysis: FailureAnalysis): string {
  const lines = [
    '### 🤖 Why this test may have failed',
    '',
    'An automated check of the application did not pass. An AI read what the check did and',
    'what went wrong, and wrote the guesses below. They are guesses, not answers: nobody has',
    'verified them yet, and the most likely one comes first.',
    '',
  ];

  analysis.hypotheses.forEach((hypothesis, index) => {
    lines.push(...renderHypothesis(hypothesis, index));
  });

  const history = analysis.usedHistory
    ? 'it also looked at how this check went in the past'
    : 'no past results of this check were available';
  const mcp =
    analysis.usedMcpServers.length > 0
      ? `; it queried ${analysis.usedMcpServers.join(', ')}`
      : '';

  lines.push(
    `_Written by ${analysis.provider} (model ${analysis.model}) — ${history}${mcp}. ${analysis.disclaimer}_`,
  );

  return lines.join('\n');
}

/** Renders the analysis as the machine-readable attachment. */
export function toJson(analysis: FailureAnalysis): string {
  return `${JSON.stringify(analysis, null, 2)}\n`;
}
