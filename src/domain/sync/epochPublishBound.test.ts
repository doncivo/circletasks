import { describe, expect, it } from 'vitest';
import table from '../../../tests/fixtures/sync/publish-bound.json';
import type { DeviceId } from '../types';
import { epochId, type EpochId } from './format';
import { canPublish, listedFilesForPublish, type OwnEpochListing } from './epoch';
import { relistedOrphanEpochs } from './orphanRelist';

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : règle de comptage des fichiers listés qui bornent la publication (critères 1 à 5) et choix des
 * époques à réarmer (critères 6 et 8). Table commune avec Rust (`tests/fixtures/sync/publish-bound.json`, `sync_publish_bound.rs`).
 */

const ME = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PC = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const CURRENT = epochId(1, PC);
const OTHER = epochId(1, ME);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

interface Case {
  readonly name: string;
  readonly epochs: readonly { readonly role: string; readonly announced: boolean; readonly segments: number; readonly snapshots: number; readonly abandoned?: boolean }[];
  readonly counted: number;
  readonly ignored: number;
  readonly canPublish: boolean;
  readonly rustBounds?: boolean;
}

describe('listedFilesForPublish : table commune publish-bound.json', () => {
  for (const c of table.cases as readonly Case[]) {
    it(c.name, () => {
      const listing: OwnEpochListing[] = c.epochs.map((e) => ({ epoch: e.role === 'current' ? CURRENT : OTHER, segments: range(e.segments), snapshots: range(e.snapshots) }));
      const announced = c.epochs.filter((e) => e.announced).map((e) => (e.role === 'current' ? CURRENT : OTHER));
      const ignored = c.epochs.find((e) => e.abandoned === true) ? OTHER : null;
      const result = listedFilesForPublish(listing, { currentEpoch: CURRENT, announced, ignored });
      expect(result).toEqual({ counted: c.counted, ignoredSnapshots: c.ignored });
      // Appareil sans état propre, sans accusé, `stateSeq` 0 : seul le comptage décide.
      expect(canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: result.counted, localStateSeq: 0 })).toBe(c.canPublish);
      // Parité avec Rust : une époque non courante borne si et seulement si `rebuild_own` la retient (segment authentifié).
      if (c.rustBounds !== undefined) expect(result.counted > 0).toBe(c.rustBounds);
    });
  }

  it('critère 2 : des segments de n’importe quelle époque bornent toujours, même avec une orpheline ignorée à côté', () => {
    const old = epochId(1, '00000000-0000-4000-8000-000000000000' as DeviceId);
    const r = listedFilesForPublish(
      [
        { epoch: old, segments: [3], snapshots: [] },
        { epoch: OTHER, segments: [], snapshots: [1] },
      ],
      { currentEpoch: CURRENT, announced: [] },
    );
    expect(r).toEqual({ counted: 1, ignoredSnapshots: 1 });
    expect(canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: r.counted, localStateSeq: 0 })).toBe(false);
  });

  it('une trace locale (stateSeq > 0) refuse toujours, même sans fichier qui borne', () => {
    const r = listedFilesForPublish([{ epoch: OTHER, segments: [], snapshots: [1] }], { currentEpoch: CURRENT, announced: [] });
    expect(canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: r.counted, localStateSeq: 3 })).toBe(false);
  });

  it('l’époque abandonnée qui est l’époque courante compte (jamais ignorée)', () => {
    expect(listedFilesForPublish([{ epoch: CURRENT, segments: [], snapshots: [1] }], { currentEpoch: CURRENT, announced: [], ignored: CURRENT })).toEqual({ counted: 1, ignoredSnapshots: 0 });
  });
});

describe('relistedOrphanEpochs : réarmement du mémo perdu', () => {
  const base = {
    self: ME,
    ownEpochs: [{ epoch: OTHER, segments: [], snapshots: [1] }] as OwnEpochListing[],
    currentEpoch: CURRENT,
    localEpoch: CURRENT as EpochId | null,
    ownAnnounced: CURRENT as EpochId | null,
    announced: [] as EpochId[],
  };

  it('cas de la séance : orpheline ef50 (plus grande que 56d4), instantané seul, état propre connu dans 56d4', () => {
    expect(relistedOrphanEpochs(base)).toEqual([OTHER]);
  });

  it('jamais sans son propre état publié connu', () => {
    expect(relistedOrphanEpochs({ ...base, ownAnnounced: null })).toEqual([]);
  });

  it('jamais l’époque courante, l’époque locale, ni une époque annoncée (par soi, un état ou un accusé d’un autre appareil)', () => {
    expect(relistedOrphanEpochs({ ...base, currentEpoch: OTHER, localEpoch: OTHER, ownAnnounced: OTHER })).toEqual([]);
    expect(relistedOrphanEpochs({ ...base, localEpoch: OTHER })).toEqual([]);
    expect(relistedOrphanEpochs({ ...base, ownAnnounced: OTHER })).toEqual([]);
    expect(relistedOrphanEpochs({ ...base, announced: [OTHER] })).toEqual([]);
  });

  it('jamais une époque qui contient un segment, ni une époque sans instantané', () => {
    expect(relistedOrphanEpochs({ ...base, ownEpochs: [{ epoch: OTHER, segments: [1], snapshots: [1] }] })).toEqual([]);
    expect(relistedOrphanEpochs({ ...base, ownEpochs: [{ epoch: OTHER, segments: [], snapshots: [] }] })).toEqual([]);
  });

  it('jamais une époque ouverte par un autre appareil', () => {
    const foreign = epochId(2, 'ffffffff-ffff-4fff-8fff-ffffffffffff' as DeviceId);
    expect(relistedOrphanEpochs({ ...base, ownEpochs: [{ epoch: foreign, segments: [], snapshots: [1] }] })).toEqual([]);
  });

  it('listing transitoire : une époque plus ancienne que la courante dont les segments sont cachés n’est jamais retenue', () => {
    const self = '00000000-0000-4000-8000-000000000001' as DeviceId;
    const older = epochId(1, self);
    const current = epochId(2, PC);
    expect(relistedOrphanEpochs({ ...base, self, currentEpoch: current, localEpoch: current, ownAnnounced: current, ownEpochs: [{ epoch: older, segments: [], snapshots: [1] }] })).toEqual([]);
  });

  it('plusieurs restes : triés, le plus petit d’abord', () => {
    const second = epochId(2, ME);
    expect(relistedOrphanEpochs({ ...base, ownEpochs: [{ epoch: second, segments: [], snapshots: [1] }, { epoch: OTHER, segments: [], snapshots: [2] }] })).toEqual([OTHER, second]);
  });
});
