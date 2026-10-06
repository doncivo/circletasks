import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parsePublishedStateText } from '../../../../src/domain/sync/parse';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { closeAll, setupRoom, settle, W_ID, type Room } from './resetKit';

/**
 * Y-TECH-02 (revue, point 6 ; ADR 0011 §21 point 2) : rotation dans l'époque `n` (entrée `closed` publiée), réinitialisation perdue,
 * republication unique sous l'ancienne clé : acceptée par `memory.ts` (Rust ramène own.json à `n` sans entrée), jamais `state-mismatch`
 * parce que l'état relu porterait encore `closed`. Horloge simulée, aucun délai réel.
 */

const room: Room = { devices: [] };
beforeAll(warmSimDevices);
afterEach(() => closeAll(room));

const closedOf = (d: SimDevice, of: string) => parsePublishedStateText(d.folder.devices.get(of)?.state?.lines[0]?.text ?? '')?.closed;

describe('réinitialisation perdue après une rotation (§21 point 2)', () => {
  it('le perdant republie son état sous K sans closed, sans state-mismatch', async () => {
    const [a, w] = (await setupRoom(room, [W_ID])) as [SimDevice, SimDevice];
    await w.createTask('W1');
    await w.cycle();
    const real = w.platform.appendJournal.bind(w.platform);
    let refused = false;
    w.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
    w.clock.advance(1_000);
    await w.createTask('W2');
    await w.cycle();
    w.platform.appendJournal = real;
    expect(closedOf(w, w.id)).toEqual([{ segment: 1, records: 1 }]);
    await settle(room.devices, 2);

    expect((await a.service.resetSync()).kind).toBe('started');
    expect((await w.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    const status = await w.cycle();
    expect(status.phase).toBe('reset-required');
    expect(status.reset).toMatchObject({ step: 'superseded', superseded: true, by: a.id });
    expect(w.logger.entries.filter((e) => e.event === 'write-state-failed')).toEqual([]);
    expect(status.reset?.failure ?? null).toBeNull();
    const republished = parsePublishedStateText(w.folder.devices.get(w.id)?.state?.lines[0]?.text ?? '');
    expect(republished?.reset).toBeNull();
    expect(republished?.closed ?? []).toEqual([]);
  });
});
