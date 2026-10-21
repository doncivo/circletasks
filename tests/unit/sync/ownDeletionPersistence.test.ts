import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimDevice, SCHEMA_VERSION, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { deleteOwnTracked, observeOwnDeletions, readOwnDeleteFailures } from '../../../src/sync/ownDeletion';
import { CycleInterrupted } from '../../../src/sync/deadline';
import { SyncStateUnreadableError } from '../../../src/domain/sync/stored';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import type { SyncDeps } from '../../../src/sync/deps';
import type { EpochId } from '../../../src/domain/sync/format';
import { abandonOrphan, retryOrphanDeletion } from '../../../src/sync/orphanEpoch';
import { createSyncService } from '../../../src/sync/service';

const SELF = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EPOCH = `e0009-${SELF}` as EpochId;
let device: SimDevice;
let deps: SyncDeps;
beforeAll(warmSimDevices);
beforeEach(async () => {
  device = await createSimDevice(SELF);
  deps = { data: device.data, platform: { ...device.platform, deleteOwn: vi.fn(() => Promise.reject(new SyncPlatformError('io'))) }, hlc: device.hlc, clock: device.clock, deviceId: device.id, devicePlatform: device.devicePlatform, appVersion: '0.3.3', sv: SCHEMA_VERSION, logger: device.logger };
});
afterEach(async () => { await device.close(); });

describe('Y-IOS-02-FIX-01 : persistance et erreurs de suppression', () => {
  it('entretien orphelin : un compteur partiel garde sa cause et son intention', async () => {
    await device.data.repos.sync.setMeta('orphanEpoch', JSON.stringify({ epoch: EPOCH }));
    await deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true);
    const failure = await device.data.repos.sync.getMeta('orphanDeleteFailure');
    const own = { deviceId: device.id, kid: null, state: null, stateStatus: 'missing' as const, epochs: [{ epoch: EPOCH, segments: [], snapshots: [1, 2] }], pending: [] };
    await retryOrphanDeletion({ ...deps, platform: { ...deps.platform, deleteOwn: () => Promise.resolve(1) } }, own, `e0010-${SELF}` as EpochId);
    expect(await device.data.repos.sync.getMeta('orphanEpoch')).toBe(JSON.stringify({ epoch: EPOCH }));
    expect(await device.data.repos.sync.getMeta('orphanDeleteFailure')).toBe(failure);
  });

  it('une erreur persiste apres un lot partiellement reussi puis un redemarrage', async () => {
    const files = [{ epoch: EPOCH, kind: 's' as const, n: 1 }, { epoch: EPOCH, kind: 's' as const, n: 2 }];
    await deleteOwnTracked(deps, files);
    const failure = await device.data.repos.sync.getMeta('ownDeleteFailure');
    expect(failure).not.toBeNull();
    await deleteOwnTracked({ ...deps, platform: { ...deps.platform, deleteOwn: () => Promise.resolve(1) } }, files);
    expect(await device.data.repos.sync.getMeta('ownDeleteFailure')).toBe(failure);
    await device.restart();
    expect(await readOwnDeleteFailures(device.data.repos)).toMatchObject([{ code: 'io' }, { code: 'io' }]);
  });

  it('code et heure sont mis à jour ; un succès efface la cause, pas la preuve de suppression', async () => {
    await deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true);
    expect(JSON.parse((await device.data.repos.sync.getMeta('orphanDeleteFailure')) ?? 'null')).toMatchObject({ code: 'io', at: new Date(device.clock.nowMs()).toISOString() });
    device.clock.advance(60_000);
    await deleteOwnTracked({ ...deps, platform: { ...deps.platform, deleteOwn: () => Promise.reject(new SyncPlatformError('vault-unavailable')) } }, [{ epoch: EPOCH, kind: 'epoch' }], true);
    expect(await readOwnDeleteFailures(device.data.repos)).toMatchObject([{ code: 'vault-unavailable', at: new Date(device.clock.nowMs()).toISOString() }]);
    await deleteOwnTracked({ ...deps, platform: { ...deps.platform, deleteOwn: () => Promise.resolve(1) } }, [{ epoch: EPOCH, kind: 'epoch' }], true);
    expect(await readOwnDeleteFailures(device.data.repos)).toEqual([]);
    expect(await device.data.repos.sync.getMeta('orphanDeleteFailure')).toBeNull();
    expect(await device.data.repos.sync.getMeta('ownDeletionReceipts')).not.toBeNull();
  });

  it('le service restaure la cause avant tout cycle iCloud après redémarrage', async () => {
    await deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true);
    const scan = vi.spyOn(device.platform, 'scan');
    await device.restart();
    if (!device.service.status().ownDelete?.length) {
      await new Promise<void>((resolve) => {
        const stop = device.service.subscribe(() => { if (device.service.status().ownDelete?.length) { stop(); resolve(); } });
      });
    }
    expect(device.service.status().ownDelete).toMatchObject([{ code: 'io', epoch: EPOCH }]);
    expect(scan).not.toHaveBeenCalled();
  });

  it('la cause restaurée reste visible pendant un premier cycle déjà commencé et retenu au scan', async () => {
    await setupFirst(device);
    await deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true);
    const scan = device.platform.scan.bind(device.platform);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { started = resolve; });
    device.platform.scan = async (request) => {
      const result = await scan(request);
      started();
      await held;
      return result;
    };
    let markSyncing!: () => void;
    device.service = createSyncService({ ...deps, platform: device.platform, setTimeout: (handler) => { markSyncing = handler; return 0; }, clearTimeout: () => undefined });
    const cycle = device.cycle();
    markSyncing();
    try {
      await reached;
      if (!device.service.status().ownDelete?.length) {
        await new Promise<void>((resolve) => {
          const stop = device.service.subscribe(() => { if (device.service.status().ownDelete?.length) { stop(); resolve(); } });
        });
      }
      expect(device.service.status().phase).toBe('syncing');
      expect(device.service.status().ownDelete).toMatchObject([{ code: 'io' }]);
    } finally {
      release();
      await cycle;
    }
  });

  it('une interruption de cycle ne crée aucun échec', async () => {
    const interrupted = { ...deps, platform: { ...deps.platform, deleteOwn: () => Promise.reject(new CycleInterrupted('delete-own')) } };
    await expect(deleteOwnTracked(interrupted, [{ epoch: EPOCH, kind: 's', n: 1 }])).rejects.toBeInstanceOf(CycleInterrupted);
    expect(await readOwnDeleteFailures(device.data.repos)).toEqual([]);
  });

  it('un abandon refusé state-mismatch efface son échec sans effacer les autres preuves', async () => {
    await deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true);
    const refused = { ...deps, platform: { ...deps.platform, abandonOrphanEpoch: () => Promise.reject(new SyncPlatformError('state-mismatch')) } };
    expect(await abandonOrphan(refused, EPOCH)).toEqual({ kind: 'refused' });
    expect(await device.data.repos.sync.getMeta('orphanEpoch')).toBeNull();
    expect(await device.data.repos.sync.getMeta('orphanDeleteFailure')).toBeNull();
    expect(await readOwnDeleteFailures(device.data.repos)).toEqual([]);
    expect(await device.data.repos.sync.getMeta('ownDeletionReceipts')).not.toBeNull();
  });

  it('un scan incomplet garde la cause ; une absence confirmée la résout', async () => {
    await deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true);
    await observeOwnDeletions(deps, null, true);
    expect(await readOwnDeleteFailures(device.data.repos)).toHaveLength(1);
    await observeOwnDeletions(deps, null, false);
    expect(await readOwnDeleteFailures(device.data.repos)).toEqual([]);
  });

  it('une écriture de mémo refusée remonte, sans appeler le transport', async () => {
    const transaction = deps.data.transaction.bind(deps.data);
    deps.data.transaction = (run) => transaction((repos) => {
      const write = repos.sync.setMeta.bind(repos.sync);
      repos.sync.setMeta = (key, value) => key === 'orphanDeleteFailure' ? Promise.reject(new Error('disk full')) : write(key, value);
      return run(repos);
    });
    await expect(deleteOwnTracked(deps, [{ epoch: EPOCH, kind: 'epoch' }], true)).rejects.toThrow('disk full');
    expect(deps.platform.deleteOwn).not.toHaveBeenCalled();
  });

  it.each(['null', '{}', '[{}]', '{bad'])('un suivi illisible reste conservé (%s)', async (raw) => {
    await device.data.repos.sync.setMeta('ownDeletionReceipts', raw);
    await expect(readOwnDeleteFailures(device.data.repos)).rejects.toBeInstanceOf(SyncStateUnreadableError);
    expect(await device.data.repos.sync.getMeta('ownDeletionReceipts')).toBe(raw);
  });
});
