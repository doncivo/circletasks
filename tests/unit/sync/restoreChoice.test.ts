import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EpochModule from '../../../src/domain/sync/epoch';
import type { EpochId } from '../../../src/domain/sync/format';
import type { DeviceId } from '../../../src/domain/types';
import { applyEverywhere } from '../../../src/sync/restoreChoice';
import type { SyncDeps } from '../../../src/sync/deps';
import { SCHEMA_VERSION, createSimDevice, setupFirst, type SimDevice } from '../../sim/syncDevice';

/**
 * « Appliquer partout » (ADR 0010 règle 1, ADR 0011 section 9 ; Y-02 critère 13 ; revue Y2 point 18) : l'époque ouverte est contrôlée
 * **avant** toute écriture ; une époque non croissante ne laisse ni instantané, ni état, ni changement de base.
 */

const forced: { epoch: EpochId | null } = { epoch: null };
vi.mock('../../../src/domain/sync/epoch', async (importOriginal) => {
  const original = await importOriginal<typeof EpochModule>();
  return { ...original, nextEpoch: (current: EpochId | null, opener: DeviceId) => forced.epoch ?? original.nextEpoch(current, opener) };
});

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let device: SimDevice | null = null;
afterEach(async () => {
  forced.epoch = null;
  await device?.close();
  device = null;
});

describe('« Appliquer partout » : contrôle de l’époque avant les écritures (revue Y2, point 18)', () => {
  it('époque non croissante : refus, aucun fichier écrit, base inchangée', async () => {
    const a = await createSimDevice(A_ID);
    device = a;
    await setupFirst(a);
    await a.cycle();
    const epoch = JSON.parse(String(await a.data.repos.sync.getMeta('epoch'))) as EpochId;
    const files = a.folder.fileNames(A_ID);
    const meta = await a.driver.select('SELECT key, value FROM sync_meta ORDER BY key');
    forced.epoch = epoch;
    const deps: SyncDeps = { data: a.data, platform: a.platform, hlc: a.hlc, clock: a.clock, deviceId: a.id, devicePlatform: 'windows', appVersion: '0.4.0', sv: SCHEMA_VERSION, logger: a.logger };
    await expect(applyEverywhere(deps)).rejects.toThrow('époque non croissante');
    expect(a.folder.fileNames(A_ID)).toEqual(files);
    expect(await a.driver.select('SELECT key, value FROM sync_meta ORDER BY key')).toEqual(meta);
  });
});
