import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FailureHistoryManager, parseDuration } from '../../src/history.js';
import type { FailureHistoryStore } from '../../src/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ai-history-'));
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const meta = { title: 'renders', titlePath: ['suite', 'renders'], file: 'a.spec.ts' };

describe('parseDuration', () => {
  it('converts minutes, hours and days to milliseconds', () => {
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('30d')).toBe(2_592_000_000);
  });

  it('rejects malformed durations', () => {
    expect(() => parseDuration('30 weeks')).toThrow(/Invalid duration/);
  });
});

describe('FailureHistoryManager', () => {
  it('defaults to .playwright-ai/failure-history.json under the root dir', () => {
    const root = tempDir();
    const manager = new FailureHistoryManager(root);
    expect(manager.getFilePath()).toBe(path.join(root, '.playwright-ai/failure-history.json'));
  });

  it('honours an absolute configured path', () => {
    const target = path.join(tempDir(), 'custom.json');
    const manager = new FailureHistoryManager(tempDir(), { path: target });
    expect(manager.getFilePath()).toBe(target);
  });

  it('round-trips a store through an atomic write', () => {
    const manager = new FailureHistoryManager(tempDir());
    const store: FailureHistoryStore = {};
    manager.record(store, 'a.spec.ts::renders', meta, {
      date: new Date().toISOString(),
      status: 'failed',
      errorMessage: 'boom',
    });
    manager.save(store);

    expect(manager.load()).toEqual(store);
    expect(fs.existsSync(`${manager.getFilePath()}.tmp`)).toBe(false);
  });

  it('returns an empty store when the file is missing or corrupted', () => {
    const manager = new FailureHistoryManager(tempDir());
    expect(manager.load()).toEqual({});

    fs.mkdirSync(path.dirname(manager.getFilePath()), { recursive: true });
    fs.writeFileSync(manager.getFilePath(), '{ not json');
    expect(manager.load()).toEqual({});
  });

  it('drops records older than the ttl', () => {
    const manager = new FailureHistoryManager(tempDir(), { ttl: '7d' });
    const store: FailureHistoryStore = {
      'a.spec.ts::renders': {
        ...meta,
        records: [
          { date: daysAgo(30), status: 'failed', errorMessage: 'old' },
          { date: daysAgo(1), status: 'failed', errorMessage: 'recent' },
        ],
      },
    };

    const relevant = manager.getRelevant(store, 'a.spec.ts::renders');
    expect(relevant).toHaveLength(1);
    expect(relevant[0]!.errorMessage).toBe('recent');
  });

  it('keeps at most maxEntriesPerTest records, newest first when read back', () => {
    const manager = new FailureHistoryManager(tempDir(), { maxEntriesPerTest: 2 });
    const store: FailureHistoryStore = {};
    for (const label of ['first', 'second', 'third']) {
      manager.record(store, 'a.spec.ts::renders', meta, {
        date: new Date().toISOString(),
        status: 'failed',
        errorMessage: label,
      });
    }

    expect(store['a.spec.ts::renders']!.records.map((record) => record.errorMessage)).toEqual([
      'second',
      'third',
    ]);
    expect(manager.getRelevant(store, 'a.spec.ts::renders')[0]!.errorMessage).toBe('third');
  });

  it('returns no history for an unknown test', () => {
    const manager = new FailureHistoryManager(tempDir());
    expect(manager.getRelevant({}, 'missing')).toEqual([]);
  });
});
