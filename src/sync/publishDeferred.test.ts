import { describe, expect, it } from 'vitest';
import { epochId } from '../domain/sync/format';
import type { SyncStatusWarning } from '../domain/syncBanners';
import type { DeviceId } from '../domain/types';
import { createMemorySyncLogger } from './log';
import { deferred, type PublishFacts } from './orphanEpoch';

/**
 * Y-FIX-02, revue M1 : journal `publish-deferred` et cause nommée de `publish-blocked`. Un refus pendant une première publication ouverte par
 * une trace locale (`inflight`, `local-head`) nomme `first-publication-state-refused` ; un refus de l'exception `openedHere` (borne ouverte
 * sans trace, `source` nulle) garde `state-refused`, sans cause.
 */

const EPOCH = epochId(1, '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId);
const FACTS: PublishFacts = { opened: false, state: 'missing', files: 1, ignored: 0, acks: 0, localSeq: 0, currentEpoch: EPOCH, inflight: null, head: null, snapshot: null, ownEpochs: [], unreadable: 0 };

function run(first: Parameters<typeof deferred>[2], refused: boolean): { reason: unknown; warnings: SyncStatusWarning[] } {
  const logger = createMemorySyncLogger();
  const seen: SyncStatusWarning[] = ['publish-blocked'];
  deferred(logger, refused, first, FACTS, seen);
  return { reason: logger.entries.find((e) => e.event === 'publish-deferred')?.detail.reason, warnings: seen };
}

describe('deferred : cause nommée de publish-blocked (revue M1)', () => {
  it('refus avec une trace locale : first-publication-state-refused', () => {
    for (const source of ['inflight', 'local-head'] as const) expect(run({ covers: true, source, unexplained: 0 }, true)).toEqual({ reason: 'first-publication-state-refused', warnings: ['publish-blocked', 'first-publication-state-refused'] });
  });

  it('refus de l’exception openedHere (source nulle) : state-refused, aucune cause', () => {
    expect(run({ covers: true, source: null, unexplained: 0 }, true)).toEqual({ reason: 'state-refused', warnings: ['publish-blocked'] });
  });

  it('refus ordinaire (règle actuelle, aucune borne) : state-refused ; refus de publier sans trace : own-state-missing', () => {
    expect(run(null, true)).toEqual({ reason: 'state-refused', warnings: ['publish-blocked'] });
    expect(run({ covers: false, source: null, unexplained: 0 }, false)).toEqual({ reason: 'own-state-missing', warnings: ['publish-blocked'] });
  });

  it('fichier non expliqué : unexplained-files avec son compteur', () => {
    expect(run({ covers: false, source: 'inflight', unexplained: 2 }, false)).toEqual({ reason: 'unexplained-files', warnings: ['publish-blocked', 'unexplained-files'] });
  });
});
