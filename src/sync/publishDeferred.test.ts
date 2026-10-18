import { afterEach, describe, expect, it } from 'vitest';
import { createSimDevice, SCHEMA_VERSION, setupFirst, type SimDevice } from '../../tests/sim/syncDevice';
import { SyncPlatformError } from '../platform/sync/types';
import { createSyncService, HIDE_SYNC_DEADLINE_MS } from './index';
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

describe('openedHere et io sur l’état (contre-revue S2)', () => {
  let device: SimDevice | null = null;
  afterEach(async () => {
    await device?.close();
    device = null;
  });

  it('échec io de l’état d’une époque ouverte ici et jamais publiée : erreur io visible, aucun publish-deferred trompeur', async () => {
    const b = await createSimDevice('ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb', { name: 'iPhone' });
    device = b;
    await setupFirst(b);
    const service = (platform: typeof b.platform, deadlineProbe?: (unit: string) => void) =>
      createSyncService({ data: b.data, platform, hlc: b.hlc, clock: b.clock, deviceId: b.id, devicePlatform: 'ios', sv: SCHEMA_VERSION, appVersion: '0.4.0', logger: b.logger, setTimeout: () => 0, clearTimeout: () => undefined, ...(deadlineProbe ? { deadlineProbe } : {}) });
    // Époque ouverte, instantané écrit, échéance du cycle hide juste avant l'état : exception openedHere au cycle suivant.
    b.service = service(b.platform, (unit) => {
      if (unit === 'write-state') b.clock.advance(HIDE_SYNC_DEADLINE_MS);
    });
    await b.service.syncNow('hide', { deadlineAt: b.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    await b.restart();
    b.service = service({ ...b.platform, writeState: () => Promise.reject(new SyncPlatformError('io')) });
    const before = b.logger.entries.length;
    await b.service.syncNow('manual');
    const s = b.service.status();
    const logged = b.logger.entries.slice(before);
    expect(logged.filter((e) => e.event === 'own-state-recovered')).toHaveLength(1);
    expect(s.errorCode).toBe('io');
    expect(logged.filter((e) => e.event === 'publish-deferred')).toEqual([]);
    expect(s.warnings ?? []).not.toContain('first-publication-state-refused');
  });
});
