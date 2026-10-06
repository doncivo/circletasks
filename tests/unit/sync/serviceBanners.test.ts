import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../../src/domain/hlc';
import { SYNCING_BANNER_DELAY_MS } from '../../../src/domain/sync/limits';
import { asEntityId, type DeviceId } from '../../../src/domain/types';
import { openTestDb, type TestDb } from '../../../src/db/repositories/sql/testSetup';
import { createMemorySyncPlatform, type SyncFolderInfo, type SyncPlatform } from '../../../src/platform/sync';
import { createMemorySyncLogger, createSyncService } from '../../../src/sync';

/**
 * Service de synchro et bandeaux A-09 (revue, points 2 et 3) : un abonné qui lève n'empêche ni les autres abonnés ni la synchro, et
 * il est journalisé ; la phase `syncing` d'un cycle porte l'heure de début du cycle (seuil unique de « Synchro en cours »).
 * Minuterie injectée déclenchée à la main, horloge manuelle : aucun délai réel.
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
let db: TestDb;

beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-06T08:00:00.000Z');
});

afterEach(async () => {
  await db.close();
});

function make(platform: SyncPlatform) {
  const logger = createMemorySyncLogger();
  const timers: { handler: () => void; ms: number }[] = [];
  const service = createSyncService({
    data: db.data,
    platform,
    hlc: createHlcClock({ clock: db.clock, deviceId: SELF }),
    clock: db.clock,
    deviceId: SELF,
    sv: 1,
    logger,
    setTimeout: (handler, ms) => timers.push({ handler, ms }),
    clearTimeout: () => undefined,
  });
  return { service, logger, timers };
}

describe('abonnés de l’état (revue A-09, point 2)', () => {
  it('un abonné qui lève : les autres sont prévenus, la synchro continue, l’incident est journalisé sans contenu', async () => {
    const { service, logger } = make(createMemorySyncPlatform());
    const seen: string[] = [];
    service.subscribe(() => {
      throw new Error('écran cassé');
    });
    service.subscribe(() => seen.push(service.status().phase));
    await service.syncNow('manual');
    expect(seen).toContain('not-configured');
    expect(logger.entries.map((e) => e.event)).toContain('status-listener-failed');
    expect(JSON.stringify(logger.entries)).not.toContain('écran cassé');
    await service.syncNow('manual');
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe('« Synchro en cours » : un seul seuil (revue A-09, point 3)', () => {
  it('cycle sans travail bloqué 1,5 s : phase syncing publiée au seuil, avec l’heure de début du cycle ; retirée à la fin', async () => {
    const base = createMemorySyncPlatform();
    let release: (info: SyncFolderInfo) => void = () => undefined;
    const held = new Promise<SyncFolderInfo>((resolve) => (release = resolve));
    const platform: SyncPlatform = { ...base, folder: { ...base.folder, info: () => held } };
    const { service, timers } = make(platform);
    const startedAt = db.clock.nowMs();
    const running = service.syncNow('timer');
    await Promise.resolve();
    expect(timers.map((t) => t.ms)).toEqual([SYNCING_BANNER_DELAY_MS]);
    db.clock.advance(1_500);
    timers[0]?.handler();
    expect(service.status().phase).toBe('syncing');
    expect(service.status().cycleStartedAt).toBe(startedAt);
    release({ configured: false, label: null, kind: 'unknown', pinned: false });
    await running;
    expect(service.status().phase).toBe('not-configured');
    expect(service.status().cycleStartedAt ?? null).toBeNull();
  });
});
