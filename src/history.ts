import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FailureHistoryEntry,
  FailureHistoryStore,
  FailureRecord,
  HistoryConfig,
} from './types.js';

const DEFAULT_PATH = '.playwright-ai/failure-history.json';
const DEFAULT_MAX_ENTRIES_PER_TEST = 10;
const DEFAULT_TTL = '30d';

const DURATION_UNITS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses a duration string such as `30d`, `12h` or `90m` into milliseconds. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([mhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: "${value}". Expected a number followed by m, h or d.`);
  }
  return Number(match[1]) * DURATION_UNITS[match[2] as string]!;
}

/** Best-effort commit sha of the run, used to correlate failures with changes. */
export function resolveCommit(cwd: string): string | undefined {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'];
  if (process.env['CI_COMMIT_SHA']) return process.env['CI_COMMIT_SHA'];
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Reads and writes the failure history the plugin feeds back into later prompts.
 * Every operation is fail-soft: a missing or corrupted store is treated as empty.
 */
export class FailureHistoryManager {
  private readonly filePath: string;
  private readonly maxEntriesPerTest: number;
  private readonly ttlMs: number;

  constructor(rootDir: string, config: HistoryConfig = {}) {
    const configured = config.path ?? DEFAULT_PATH;
    this.filePath = path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
    this.maxEntriesPerTest = config.maxEntriesPerTest ?? DEFAULT_MAX_ENTRIES_PER_TEST;
    this.ttlMs = parseDuration(config.ttl ?? DEFAULT_TTL);
  }

  /** Absolute path of the store, exposed for logging and tests. */
  getFilePath(): string {
    return this.filePath;
  }

  /** Loads the store, returning an empty one when it is missing or unparsable. */
  load(): FailureHistoryStore {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as FailureHistoryStore;
    } catch {
      return {};
    }
  }

  /** Writes the store atomically, so an interrupted run never leaves a partial file. */
  save(store: FailureHistoryStore): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
      fs.renameSync(temp, this.filePath);
    } catch {
      // Persisting the history is a convenience, never a reason to fail a run.
    }
  }

  /** Appends a record to a test's history, pruning by TTL and by count. */
  record(
    store: FailureHistoryStore,
    key: string,
    meta: Pick<FailureHistoryEntry, 'title' | 'titlePath' | 'file'>,
    record: FailureRecord,
  ): void {
    const entry: FailureHistoryEntry = store[key] ?? { ...meta, records: [] };
    entry.title = meta.title;
    entry.titlePath = meta.titlePath;
    entry.file = meta.file;
    entry.records = this.prune([...entry.records, record]);
    store[key] = entry;
  }

  /** Records still within the TTL for a given test, newest first. */
  getRelevant(store: FailureHistoryStore, key: string): FailureRecord[] {
    const entry = store[key];
    if (!entry) return [];
    return this.prune(entry.records).slice().reverse();
  }

  private prune(records: FailureRecord[]): FailureRecord[] {
    const threshold = Date.now() - this.ttlMs;
    return records
      .filter((record) => {
        const time = Date.parse(record.date);
        return Number.isNaN(time) ? false : time >= threshold;
      })
      .slice(-this.maxEntriesPerTest);
  }
}
