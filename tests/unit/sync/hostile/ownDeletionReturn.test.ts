import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import { createSimDevice, setupFirst, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { A_ID, B_ID, ORPHAN_SNAPSHOT, orphanSession } from '../../../sim/syncOrphanSession';

const DAY = 86_400_000;
let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-IOS-02-FIX-01 : défauts 2 et 3 connus du banc', () => {
  it('un substitut laissé par la suppression reste visible comme échec après redémarrage', async () => {
    const { b } = await orphanSession(devices);
    b.folder.armFaults({ name: 'substitut-persistant', options: { removeLeavesPlaceholder: true }, faults: [{ id: 'placeholder', op: 'list', file: `devices/${B_ID}/${ORPHAN_SNAPSHOT}`, nth: 1, effect: 'placeholder' }] });
    await b.cycle();
    expect(b.folder.fileNames(b.id)).toContain(ORPHAN_SNAPSHOT);
    expect(statusLine(b.service.status(), b.clock.nowMs())).not.toContain('À jour');
    await b.restart();
    await b.cycle();
    expect(statusLine(b.service.status(), b.clock.nowMs())).not.toContain('À jour');
    b.folder.disarmFaults();
    await b.cycle();
    expect(b.folder.fileNames(b.id)).not.toContain(ORPHAN_SNAPSHOT);
    expect(statusLine(b.service.status(), b.clock.nowMs())).toContain('À jour');
  });

  it('un ancien instantané revenu est signalé et retenté sans attendre un nouvel instantané', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    devices.push(a);
    await setupFirst(a);
    await a.cycle();
    a.folder.armFaults({ name: 'suppression-non-propagee', faults: [{ id: 'revient', op: 'remove', file: `devices/${A_ID}/*/s-00000001.cts`, nth: 1, times: 'all', effect: 'accept-not-propagated', resurrectAfterCycles: 2 }] });
    for (let i = 0; i < 2; i += 1) {
      a.clock.advance(8 * DAY);
      await a.createTask(`Semaine ${String(i)}`);
      await a.cycle();
    }
    // Suppression acceptée, absence temporaire, puis retour contrôlé par le banc : aucune attente réelle.
    expect(a.folder.fileNames(a.id).some((f) => f.endsWith('/s-00000001.cts'))).toBe(false);
    await a.restart();
    await a.cycle();
    const before = a.folder.faultLog().filter((f) => f.id === 'revient').length;
    await a.cycle();
    expect(a.folder.faultLog().filter((f) => f.id === 'revient').length).toBeGreaterThan(before);
    expect(statusLine(a.service.status(), a.clock.nowMs())).not.toContain('À jour');
    a.folder.disarmFaults();
    await a.cycle();
    await a.cycle();
    expect(a.folder.fileNames(a.id).some((f) => f.endsWith('/s-00000001.cts'))).toBe(false);
    expect(statusLine(a.service.status(), a.clock.nowMs())).toContain('À jour');
  });
});
