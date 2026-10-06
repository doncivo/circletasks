import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as limits from '../../../src/domain/sync/limits';
import type { IsoDateTime } from '../../../src/domain/types';
import type { EpochId, PublishedDeviceState } from '../../../src/domain/sync/format';
import type { DeviceId } from '../../../src/domain/types';
import { maintain } from '../../../src/sync/maintenance';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-02, ADR 0011 §21 point 3 : anciennes époques supprimées par leur écrivain quand tous les actifs (non expirés, non oubliés)
 * annoncent l'époque courante, jamais au bout d'un délai ; la constante morte `OLD_EPOCH_RETENTION_MS` est retirée. Horloge simulée.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function pairOfDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  for (let r = 0; r < 3; r += 1) {
    for (const d of devices) {
      syncFolders(devices);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
  syncFolders(devices);
  return [a, b];
}

/** A applique partout une restauration : il ouvre l'époque suivante ; B n'a encore rien lu. */
async function applyEverywhere(a: SimDevice): Promise<void> {
  a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
  await a.service.chooseRestoreOption('apply-everywhere');
}

const ownEpochs = (d: SimDevice): number => d.folder.devices.get(d.id)?.epochs.size ?? 0;
const deleted = (d: SimDevice): number => d.logger.entries.filter((e) => e.event === 'old-epochs-deleted').length;

describe('anciennes époques (ADR 0011 §21 point 3)', () => {
  it('constante morte retirée : aucune rétention à 30 jours', () => {
    expect('OLD_EPOCH_RETENTION_MS' in limits).toBe(false);
  });

  it('un actif encore dans l’ancienne époque la retient, même après 30 jours ; supprimée dès qu’il annonce la nouvelle', async () => {
    const [a, b] = await pairOfDevices();
    await applyEverywhere(a);
    await a.cycle();
    expect(ownEpochs(a)).toBe(2);
    a.clock.advance(31 * DAY);
    await a.cycle();
    expect(ownEpochs(a)).toBe(2);
    expect(deleted(a)).toBe(0);
    syncFolders(devices);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    expect(deleted(a)).toBe(1);
    expect(ownEpochs(a)).toBe(1);
  });

  it('un actif expiré (180 jours sans synchroniser) ne retient pas l’ancienne époque', async () => {
    const [a] = await pairOfDevices();
    await applyEverywhere(a);
    await a.cycle();
    expect(ownEpochs(a)).toBe(2);
    a.clock.advance(limits.DEVICE_EXPIRY_MS + DAY);
    await a.cycle();
    expect(deleted(a)).toBe(1);
    expect(ownEpochs(a)).toBe(1);
  });

  it('un oublié ne retient pas l’ancienne époque', async () => {
    const [a, b] = await pairOfDevices();
    await applyEverywhere(a);
    await a.cycle();
    expect(ownEpochs(a)).toBe(2);
    expect(deleted(a)).toBe(0);
    expect(await a.service.forgetDevice(b.id)).toEqual({ kind: 'done' });
    await a.cycle();
    expect(deleted(a)).toBe(1);
    expect(ownEpochs(a)).toBe(1);
  });

  it('réinitialisation active (keepOldEpochs) : rien supprimé, même quand tous les actifs annoncent l’époque courante', async () => {
    const [a, b] = await pairOfDevices();
    await applyEverywhere(a);
    syncFolders(devices);
    await b.cycle();
    syncFolders(devices);
    expect(ownEpochs(a)).toBe(2);
    // Mêmes entrées qu'à l'étape 7 du cycle de A (B annonce l'époque courante).
    const scan = await a.platform.scan({ keep: [b.id] });
    const accepted = new Map<DeviceId, PublishedDeviceState>(scan.devices.filter((d) => d.deviceId !== a.id && d.state).map((d) => [d.deviceId, d.state as PublishedDeviceState]));
    const ownScan = scan.devices.find((d) => d.deviceId === a.id) ?? null;
    const epoch = ownScan?.state?.epoch as EpochId;
    expect(accepted.get(b.id)?.epoch).toBe(epoch);
    const deps = { data: a.data, platform: a.platform, hlc: a.hlc, clock: a.clock, deviceId: a.id, devicePlatform: 'windows' as const, appVersion: '0.4.0', sv: SCHEMA_VERSION, logger: a.logger };
    const input = { epoch, head: { epoch, segment: 0, record: 0, hlc: null, stateSeq: 0 }, accepted, ownScan, rows: await a.data.repos.sync.getStates() };
    await maintain(deps, { ...input, keepOldEpochs: true });
    expect(ownEpochs(a)).toBe(2);
    expect(deleted(a)).toBe(0);
    // Témoin : la même entrée sans réinitialisation supprime l'ancienne époque.
    await maintain(deps, input);
    expect(ownEpochs(a)).toBe(1);
    expect(deleted(a)).toBe(1);
  });
});
