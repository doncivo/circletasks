import { expect, it } from 'vitest';
import { parseStoredSegmentGaps, SyncStateUnreadableError } from '../../../src/domain/sync/stored';

/**
 * Y-TECH-02, septième revue, point 2 (QA-6) : la date de première constatation d'un trou (`sync_meta.segmentGaps`, `since`) est validée
 * comme `parseStoredIso` (aller-retour `toISOString`) : une date impossible est illisible, jamais acceptée.
 */

const ENTRY = { epoch: 'e0001-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', segment: 0, author: null, seq: null };
const raw = (since: string): string => JSON.stringify({ 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': { ...ENTRY, since } });
const quiet = { log: () => undefined };

it('QA-6 segmentGaps.since impossible (31 février) : illisible comme parseStoredIso', () => {
  expect(() => parseStoredSegmentGaps(raw('2026-02-31T08:00:00.000Z'), 'x', quiet)).toThrow(SyncStateUnreadableError);
});

it('segmentGaps.since valide : lu tel quel', () => {
  expect(parseStoredSegmentGaps(raw('2026-02-28T08:00:00.000Z'), 'x', quiet).get('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as never)?.since).toBe('2026-02-28T08:00:00.000Z');
});
