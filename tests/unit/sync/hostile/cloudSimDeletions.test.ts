import { describe, expect, it } from 'vitest';
import { createSimFolder, hydrate, mirrorDeviceFolder, propagate } from '../../../sim/syncCloudSim';

/**
 * Y-TECH-03 (B13), critère 10 : le simulateur à deux dossiers transmet une suppression selon le plan de pannes : aussitôt par défaut,
 * différée par `deferDeletions`, refusée tant qu'une suppression « acceptée mais non propagée » de l'émetteur attend son retour. Les options
 * existantes sont rejouées telles quelles par la suite de tests/unit/sync (attentes inchangées) ; quelques-unes sont recontrôlées ici avec le
 * plan armé. Aucun délai : des appels et des cycles comptés.
 */

const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const E = `e0001-${DEV}`;
const S1 = `${E}/s-00000001.cts`;
const J1 = `${E}/j-00000001.ctj`;

function folders(): { pc: ReturnType<typeof createSimFolder>; phone: ReturnType<typeof createSimFolder> } {
  const pc = createSimFolder();
  const phone = createSimFolder();
  pc.putLines(DEV, J1, ['l1', 'l2']);
  pc.putLines(DEV, S1, ['instantane']);
  pc.putLines(DEV, 'state.ctx', ['etat']);
  propagate(pc, phone, DEV);
  return { pc, phone };
}

describe('Y-TECH-03 : propagation des suppressions selon le plan (critère 10)', () => {
  it('par défaut : suppression transmise au prochain propagate', () => {
    const { pc, phone } = folders();
    expect(pc.removeWithFaults(DEV, S1)).toBe(true);
    propagate(pc, phone, DEV);
    expect(phone.fileNames(DEV)).toEqual([J1, 'state.ctx']);
  });

  it('différée : gardée chez le destinataire tant que deferDeletions la cite, transmise ensuite', () => {
    const { pc, phone } = folders();
    pc.removeWithFaults(DEV, S1);
    propagate(pc, phone, DEV, { deferDeletions: [S1] });
    expect(phone.fileNames(DEV)).toContain(S1);
    expect(phone.records(DEV, S1)).toEqual(['instantane']);
    propagate(pc, phone, DEV);
    expect(phone.fileNames(DEV)).not.toContain(S1);
  });

  it('acceptée mais non propagée (N = 2) : jamais transmise ; le fichier revient chez l’émetteur après 2 cycles, puis partout', () => {
    const { pc, phone } = folders();
    pc.armFaults({ name: 'non-propagee', faults: [{ id: 'back', op: 'remove', file: `devices/${DEV}/${S1}`, nth: 1, effect: 'accept-not-propagated', resurrectAfterCycles: 2 }] });
    expect(pc.removeWithFaults(DEV, S1)).toBe(true);
    expect(pc.fileNames(DEV)).not.toContain(S1);
    propagate(pc, phone, DEV);
    expect(phone.fileNames(DEV)).toContain(S1);
    pc.advanceCycle();
    propagate(pc, phone, DEV);
    expect(phone.fileNames(DEV)).toContain(S1);
    expect(pc.advanceCycle()).toBe(1);
    expect(pc.fileNames(DEV)).toContain(S1);
    propagate(pc, phone, DEV);
    expect(phone.records(DEV, S1)).toEqual(['instantane']);
    expect(pc.pendingResurrections(DEV)).toEqual([]);
  });

  it('N = 0 : suppression ordinaire, transmise aussitôt', () => {
    const { pc, phone } = folders();
    pc.armFaults({ name: 'n0', faults: [{ id: 'gone', op: 'remove', file: `devices/${DEV}/${S1}`, nth: 1, effect: 'accept-not-propagated', resurrectAfterCycles: 0 }] });
    pc.removeWithFaults(DEV, S1);
    propagate(pc, phone, DEV);
    expect(phone.fileNames(DEV)).not.toContain(S1);
  });

  it('options existantes inchangées avec un plan armé : placeholder, drop, hydrate, mirrorDeviceFolder', () => {
    const { pc, phone } = folders();
    pc.armFaults({ name: 'lecture', faults: [{ id: 'read-io', op: 'read', file: `devices/${DEV}/${J1}`, nth: 1, effect: 'error', code: 'io' }] });
    propagate(pc, phone, DEV, { placeholder: true, drop: [S1] });
    expect(phone.fileNames(DEV)).toEqual([J1, 'state.ctx']);
    expect(phone.availabilityOf(DEV, J1)).toBe('cloud');
    expect(phone.isPlaceholder(DEV, J1)).toBe(false);
    hydrate(phone, DEV);
    expect(phone.availabilityOf(DEV, J1)).toBe('local');
    pc.devices.delete(DEV);
    mirrorDeviceFolder(pc, phone, DEV);
    expect(phone.devices.has(DEV)).toBe(false);
  });
});
