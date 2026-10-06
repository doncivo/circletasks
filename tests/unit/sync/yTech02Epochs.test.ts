import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as limits from '../../../src/domain/sync/limits';
import type { IsoDateTime } from '../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

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
});
