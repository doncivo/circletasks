import { describe, expect, it } from 'vitest';
import table from '../../../tests/fixtures/sync/first-publication-bound.json';
import type { DeviceId } from '../types';
import { canPublish, listedFilesForPublish, type OwnEpochListing } from './epoch';
import { localBoundCovers } from './firstPublication';
import { epochId } from './format';

/**
 * Y-FIX-02 (ADR 0011 §30), critère 8 : règle de la borne locale, en table (`tests/fixtures/sync/first-publication-bound.json`), et forme
 * de `publishAllowed` qui s'en sert : `canPublish(...) || localBoundCovers(...).covers` (sans état propre ni accusé).
 */

const ME = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PC = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const CURRENT = epochId(1, PC);
const OTHER = epochId(1, ME);
const at = (role: string) => (role === 'current' ? CURRENT : OTHER);

interface Case {
  readonly id: string;
  readonly name: string;
  readonly localSeq: number;
  readonly inflight: { readonly epoch: string; readonly segment: number } | null;
  readonly head: { readonly epoch: string; readonly segment: number } | null;
  readonly snapshot: { readonly epoch: string; readonly seq: number } | null;
  readonly epochs: readonly { readonly role: string; readonly segments: readonly number[]; readonly snapshots: readonly number[] }[];
  readonly unreadable: number;
  readonly covers: boolean;
  readonly source: string | null;
  readonly unexplained: number;
  readonly publishAllowed: boolean;
}

const cases = table.cases as readonly Case[];

describe('localBoundCovers : table first-publication-bound.json (critère 8)', () => {
  it('les cas (a) à (i) de la fiche sont tous présents', () => {
    const ids = cases.map((c) => c.id);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) expect(ids).toContain(id);
  });

  for (const c of cases) {
    it(`(${c.id}) ${c.name}`, () => {
      const ownEpochs: OwnEpochListing[] = c.epochs.map((e) => ({ epoch: at(e.role), segments: [...e.segments], snapshots: [...e.snapshots] }));
      const files = listedFilesForPublish(ownEpochs, { currentEpoch: CURRENT, announced: [] }).counted;
      const bound = localBoundCovers({
        currentEpoch: CURRENT,
        localSeq: c.localSeq,
        inflight: c.inflight ? { epoch: at(c.inflight.epoch), segment: c.inflight.segment } : null,
        head: c.head ? { epoch: at(c.head.epoch), segment: c.head.segment } : null,
        snapshot: c.snapshot ? { epoch: at(c.snapshot.epoch), seq: c.snapshot.seq } : null,
        ownEpochs,
        files,
        unreadable: c.unreadable,
      });
      expect(bound).toEqual({ covers: c.covers, source: c.source, unexplained: c.unexplained });
      expect(canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: files, localStateSeq: c.localSeq }) || bound.covers).toBe(c.publishAllowed);
    });
  }
});
