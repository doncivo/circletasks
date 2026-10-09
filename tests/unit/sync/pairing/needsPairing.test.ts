import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../../../src/domain/clock';
import { createHlcClock } from '../../../../src/domain/hlc';
import type { DeviceAck, EpochId } from '../../../../src/domain/sync/format';
import { asEntityId, type DeviceId, type Hlc } from '../../../../src/domain/types';
import { DbError } from '../../../../src/db/driver';
import type { DataAccess } from '../../../../src/db/repositories';
import { openTestDb, type TestDb } from '../../../../src/db/repositories/sql/testSetup';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from '../../../../src/platform/sync';
import type { SyncReason, SyncStatus } from '../../../../src/platform/sync/types';
import { createSyncService, silentSyncLogger, startSyncScheduler } from '../../../../src/sync';

/**
 * Y-IOS-02 (point de contrôle d'Ali, IPA 0.2.1) : un appareil dont le dossier contient les données chiffrées du PC et qui n'a pas la clé
 * reste « à associer » (phase `needs-pairing`), même quand l'état local est illisible (base occupée) ; aucune boucle de cycles sans issue ;
 * « Réinitialiser la synchronisation » refusé sans clé (`key-missing`), avant tout cycle et toute boîte native ; un Trousseau indisponible
 * reste une erreur visible distincte (`vault-unavailable`), jamais lue comme « clé absente ».
 */

const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b1');
const PC = '70000000-0000-4000-8000-000000000009' as DeviceId;
const NOW = '2026-10-08T08:00:00.000Z';

let db: TestDb;

beforeEach(async () => {
  db = await openTestDb(PHONE, NOW);
});

afterEach(async () => {
  await db.close();
});

/** Le PC a créé la clé et publié ; l'iPhone a choisi le même dossier, sans clé (création refusée : `folder-has-data`). */
async function phoneWithoutKey(): Promise<MemorySyncPlatform> {
  const folder = new MemorySyncFolder('icloud');
  const pc = createMemorySyncPlatform({ folder, nowMs: () => db.clock.nowMs() });
  await pc.folder.choose();
  await pc.key.create();
  await pc.bindDevice(PC);
  const epoch = `e0001-${PC}` as EpochId;
  const hlc = `000001759651200-0000-${PC}` as Hlc;
  await pc.appendJournal({ epoch, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc, records: ['{}'] });
  await pc.writeState({
    sv: 14,
    state: { deviceId: PC, platform: 'windows', appVersion: '0.2.1', sm: 1, sv: 14, epoch, stateSeq: 1, head: { epoch, segment: 1, record: 1, hlc, stateSeq: 1 }, acks: new Map<DeviceId, DeviceAck>(), snapshot: null, purgeHorizon: null, lastSyncHlc: hlc, forgotten: [], reset: null },
  });
  const phone = createMemorySyncPlatform({ folder, platform: 'ios', nowMs: () => db.clock.nowMs() });
  await phone.folder.choose();
  await expect(phone.key.create()).rejects.toMatchObject({ code: 'folder-has-data' });
  await phone.bindDevice(PHONE);
  return phone;
}

/** Base dont `sync_meta` est illisible (« database is locked ») tant que `locked.on` est vrai. */
function lockableData(): { readonly data: DataAccess; readonly locked: { on: boolean } } {
  const locked = { on: true };
  const sync = db.data.repos.sync;
  const lockedSync = new Proxy(sync, {
    get(target, prop, receiver) {
      if (prop === 'getMeta') {
        return async (key: string) => {
          if (locked.on) throw new DbError('busy', 'database is locked');
          return target.getMeta(key);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { data: { ...db.data, repos: { ...db.data.repos, sync: lockedSync } }, locked };
}

function phoneService(platform: MemorySyncPlatform, data: DataAccess = db.data) {
  return createSyncService({ data, platform, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), clock: db.clock, deviceId: PHONE, devicePlatform: 'ios', sv: 14, appVersion: '0.2.3', logger: silentSyncLogger, setTimeout: () => 0, clearTimeout: () => undefined });
}

describe('appareil sans clé : toujours « à associer » (Y-IOS-02)', () => {
  it('cycle sans clé : phase needs-pairing, aucun appareil lu, aucune erreur ; deux cycles de suite, même état', async () => {
    const phone = await phoneWithoutKey();
    const service = phoneService(phone);
    await service.syncNow('open');
    expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null, devices: [] });
    await service.syncNow('timer');
    expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null });
  });

  it('état local illisible (base occupée) pendant le cycle : needs-pairing (jamais l’erreur générique), état illisible signalé à part', async () => {
    const phone = await phoneWithoutKey();
    const { data, locked } = lockableData();
    const service = phoneService(phone, data);
    await service.syncNow('open');
    const status = service.status();
    expect(status.phase).toBe('needs-pairing');
    expect(status.errorCode).toBeNull();
    // Aucun échec silencieux : la lecture en échec reste visible (bandeau « État de la synchro inaccessible »).
    expect(status.stateUnreadable).toBe(true);
    locked.on = false;
    await service.syncNow('manual');
    expect(service.status().phase).toBe('needs-pairing');
    expect(service.status().stateUnreadable).toBeUndefined();
  });

  it('avec la clé, la même base occupée reste une erreur visible (code réel), jamais « à associer »', async () => {
    const folder = new MemorySyncFolder('icloud');
    const pc = createMemorySyncPlatform({ folder, nowMs: () => db.clock.nowMs() });
    await pc.folder.choose();
    await pc.key.create();
    await pc.bindDevice(PHONE);
    const { data } = lockableData();
    const service = phoneService(pc, data);
    await service.syncNow('open');
    expect(service.status().phase).toBe('error');
    expect(service.status().phase).not.toBe('needs-pairing');
  });

  it('Trousseau indisponible (iPhone verrouillé) : erreur `vault-unavailable` distincte, jamais « à associer »', async () => {
    const phone = await phoneWithoutKey();
    phone.testing.setVaultAvailable(false);
    const service = phoneService(phone);
    await service.syncNow('open');
    expect(service.status()).toMatchObject({ phase: 'error', errorCode: 'vault-unavailable' });
    phone.testing.setVaultAvailable(true);
    await service.syncNow('open');
    expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null });
  });

  it('« Réinitialiser la synchronisation » refusé sans clé : key-missing, aucun cycle, aucune boîte native, aucune clé créée', async () => {
    const phone = await phoneWithoutKey();
    const service = phoneService(phone);
    await service.syncNow('open');
    const before = phone.testing.consentPrompts();
    const outcome = await service.resetSync();
    expect(outcome).toEqual({ kind: 'failed', code: 'key-missing' });
    expect(phone.testing.consentPrompts()).toBe(before);
    expect((await phone.key.status()).present).toBe(false);
    expect(service.status().reset?.failure?.code).toBe('key-missing');
  });
});

describe('planificateur : aucune boucle sans clé (Y-IOS-02)', () => {
  function fakeDocument() {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
      set(state: DocumentVisibilityState) {
        doc.visibilityState = state;
        for (const l of listeners) l();
      },
    };
    return doc;
  }

  it('phase needs-pairing : ni cycle des 5 minutes ni cycle de masquage ; l’ouverture relit l’état ; associé : cycles repris', async () => {
    const clock = createManualClock(NOW);
    const reasons: SyncReason[] = [];
    let phase: SyncStatus['phase'] = 'needs-pairing';
    const doc = fakeDocument();
    const scheduler = startSyncScheduler(
      { syncNow: async (r) => void reasons.push(r), status: () => ({ phase }) as SyncStatus },
      { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined, hideDeadlineMs: 25_000 },
    );
    expect(reasons).toEqual(['open']);
    clock.advance(30 * 60_000);
    await scheduler.tick();
    doc.set('hidden');
    expect(reasons).toEqual(['open']);
    doc.set('visible');
    expect(reasons).toEqual(['open', 'open']);
    phase = 'idle';
    clock.advance(5 * 60_000);
    await scheduler.tick();
    doc.set('hidden');
    expect(reasons).toEqual(['open', 'open', 'timer', 'hide']);
    scheduler.dispose();
  });

  it('Trousseau indisponible : les cycles continuent (la clé est relue dès le déverrouillage)', async () => {
    const clock = createManualClock(NOW);
    const reasons: SyncReason[] = [];
    const doc = fakeDocument();
    const scheduler = startSyncScheduler(
      { syncNow: async (r) => void reasons.push(r), status: () => ({ phase: 'error', errorCode: 'vault-unavailable' }) as SyncStatus },
      { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined },
    );
    clock.advance(5 * 60_000);
    await scheduler.tick();
    expect(reasons).toEqual(['open', 'timer']);
    scheduler.dispose();
  });
});
