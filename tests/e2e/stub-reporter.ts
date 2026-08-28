import { AIReporter } from '../../src/reporter.js';
import type { AIReporterOptions } from '../../src/types.js';
import { stubProvider } from './stub-provider.js';

/**
 * `AIReporter` wired to the stub provider, used by the inner end-to-end run.
 *
 * `jsonAttachment` is on so the run exercises both attachments; it stays a
 * default the outer test can override.
 */
export default class StubAIReporter extends AIReporter {
  constructor(options: AIReporterOptions = {}) {
    super({ jsonAttachment: true, ...options, provider: stubProvider, history: { enabled: false } });
  }
}
