import { afterEach, describe, expect, it } from 'vitest';
import { RESET_META } from '../../../../src/sync/reset';
import { syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, backupOf, closeAll, meta, reassociate, restoreBackup, setupRoom, settle, titles, type Room } from './resetKit';

/**
 * Y-11, passe QA : DÉFAUTS constatés (tests volontairement rouges, renvoyés à l'agent sync-icloud avec le diagnostic ; voir le rapport).
 * Restauration P-04 d'une sauvegarde antérieure à la réinitialisation, croisée avec la transition ou avec la nouvelle clé.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));

describe('QA-1 : « Appliquer partout » pendant la transition échoue sans rien dire', () => {
  it('Rust refuse l’état sans annonce (state-mismatch) : l’échec doit être visible (phase d’erreur ou échec gardé), pas avalé par chooseRestoreOption', async () => {
    const [a] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
    await restoreBackup(a, copy);
    expect((await a.cycle()).phase).toBe('restore-choice');
    await a.service.chooseRestoreOption('apply-everywhere');
    const marker = await a.platform.restoreMarker.get();
    const status = a.service.status();
    const applied = a.logger.entries.some((e) => e.event === 'restore-applied-everywhere');
    const visible = status.phase === 'error' || (status.reset?.failure ?? null) !== null;
    // Soit appliquée, soit refusée de façon visible ; jamais « marqueur gardé, aucune trace, aucune explication ».
    expect(applied || visible, JSON.stringify({ phase: status.phase, marker: marker !== null, reset: status.reset })).toBe(true);
  });
});

describe('QA-2 : sauvegarde antérieure à l’époque que cet appareil a lui-même ouverte, « Garder les données synchronisées »', () => {
  const stuck = async (a: SimDevice, b: SimDevice): Promise<void> => {
    await settle(room.devices, 4);
    const status = a.service.status();
    expect(status.phase, `bloqué : ${JSON.stringify(status.pendingFiles)}`).not.toBe('waiting-icloud');
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  };

  it('pendant la transition (resetState perdu avec la base restaurée) : l’appareil rejoint son époque, retrouve ses écritures, converge avec B', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
    await a.createTask('Pendant la transition');
    await a.cycle();
    await restoreBackup(a, copy);
    expect(await meta(a, RESET_META)).toBeNull();
    await a.service.chooseRestoreOption('keep-synced');
    expect(a.service.status().reset).toMatchObject({ role: 'initiator' });
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await stuck(a, b);
    expect(await titles(a)).toContain('Pendant la transition');
  });

  it('après la réinitialisation (nouvelle clé en usage) : même résultat attendu', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const copy = await backupOf(a);
    expect((await a.service.resetSync()).kind).toBe('started');
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 3);
    await a.createTask('Après la réinitialisation');
    await settle(room.devices, 2);
    await restoreBackup(a, copy);
    await a.service.chooseRestoreOption('keep-synced');
    await stuck(a, b);
    expect(await titles(a)).toContain('Après la réinitialisation');
  });
});
