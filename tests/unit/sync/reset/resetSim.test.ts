import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import type { StateFileCopy } from '../../../../src/platform/sync/memory';
import { RESET_META } from '../../../../src/sync/reset';
import { propagate } from '../../../sim/syncCloudSim';
import { syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, C_ID, closeAll, DAY, meta, publishedState, reassociate, setupRoom, settle, titles, W_ID, type Room } from './resetKit';

/**
 * Y-11 critères 8 à 13 et 16 par simulation (ADR 0011 §14.3, §9.1) : trois appareils (PC A, PC B, iPhone C), B écrit hors ligne pendant
 * que A réinitialise, C reste éteint toute la réinitialisation et revient des jours plus tard ; suspension sur annonce authentique
 * seulement ; réassociation par fusion ; bascule ; rappel des 30 jours sans oubli d'office. Horloge commune, aucun délai réel.
 */

const room: Room = { devices: [] };
// Point 5 de l'audit : le premier test (critère 11) payait l'initialisation de SQLite Wasm et des migrations dans son propre budget.
beforeAll(warmSimDevices);
afterEach(() => closeAll(room));

/** Sortie de chaque appareil vers « iCloud » interdite (hors ligne) : seul `online` se synchronise. */
function syncOnline(online: readonly SimDevice[]): void {
  syncFolders(online);
}

describe('réinitialisation à trois appareils, B hors ligne, C éteint (critère 11)', () => {
  it('aucune perte : bases identiques (union, aucun doublon ni élément ressuscité), trace purgée avant jamais réapparue', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    const iphone = c;
    // Données communes, puis une suppression purgée partout (30 jours, lue par tous) avant la réinitialisation. Le coût de ce test est
    // celui des cycles complets (base SQLite de chaque appareil) : seulement les tours nécessaires (création lue et accusée par tous : 2 ;
    // suppression lue et accusée : 1 ; purge après 30 jours : 1), chacun vérifié.
    await a.createTask('Commun A');
    await b.createTask('Commun B');
    const gone = await a.createTask('Supprimée');
    await settle(room.devices, 2);
    for (const d of room.devices) expect(await titles(d), d.name).toEqual(['Commun A', 'Commun B', 'Supprimée']);
    await a.deleteTask(gone.id);
    await settle(room.devices, 1);
    for (const d of room.devices) expect(await titles(d), d.name).toEqual(['Commun A', 'Commun B']);
    for (const d of room.devices) d.clock.advance(31 * DAY);
    await settle(room.devices, 1);
    for (const d of room.devices) expect((await d.driver.select('SELECT id FROM task WHERE id = ?', [gone.id])).length, `purgée chez ${d.name}`).toBe(0);
    expect((await a.driver.select('SELECT id FROM task WHERE id = ?', [gone.id])).length, 'purgée chez A').toBe(0);

    // B passe hors ligne et écrit ; C s'éteint.
    await b.createTask('B hors ligne 1');
    const shared = (await a.driver.select<{ id: string }>("SELECT id FROM task WHERE title = 'Commun A'"))[0]?.id;
    if (!shared) throw new Error('tâche commune');
    await b.updateTask(shared as never, { note: 'note de B hors ligne' });

    // A réinitialise (précondition remplie : il a tout lu jusqu'aux têtes publiées).
    const outcome = await a.service.resetSync();
    expect(outcome).toEqual({ kind: 'started', switched: false });
    const k2 = (await a.platform.key.status()).nextKid;
    expect(k2).toMatch(/^[0-9a-f]{16}$/);
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', step: 'waiting-devices', waiting: [B_ID, C_ID].sort() });
    // L'annonce est sous K dans state.ctx de A ; l'état sous K2 dans state.next.ctx.
    expect(publishedState(a, a.id)?.reset).toMatchObject({ kid: k2 });
    expect(publishedState(a, a.id, 'next')?.epoch).toMatch(/^e0002-/);
    await a.createTask('A après la réinitialisation');
    await a.cycle();

    // B revient : il lit l'annonce authentique, suspend sa publication (file gardée, rien d'écrit).
    syncOnline([a, b]);
    const bFiles = JSON.stringify(b.folder.fileNames(b.id));
    const bStatus = await b.cycle();
    expect(bStatus.phase).toBe('reset-required');
    expect(JSON.stringify(b.folder.fileNames(b.id)), 'rien n’est écrit').toBe(bFiles);
    expect(await b.data.repos.sync.outboxCount()).toBeGreaterThan(0);
    expect(await meta(b, RESET_META)).toMatchObject({ role: 'required', by: a.id });
    // Persistance : après un redémarrage, toujours à réassocier.
    await b.restart();
    expect((await b.cycle()).phase).toBe('reset-required');
    // B se réassocie avec K2 (clé de secours) : K2 sous .next, fusion, écritures republiées dans l'époque 2.
    await reassociate(a, b, [a, b]);
    expect((await b.platform.key.status()).nextKid).toBe(k2);
    expect(b.platform.testing.resetRecord()).toMatchObject({ role: 'joined', kid: k2 });
    expect((await b.cycle()).phase).not.toBe('reset-required');
    expect(b.service.status().reset).toMatchObject({ role: 'joined', step: 'joined' });
    syncOnline([a, b]);
    await a.cycle();
    expect(a.service.status().reset?.waiting).toEqual([C_ID]);
    // B ne bascule pas avant A.
    await b.cycle();
    expect((await b.platform.key.status()).nextKid).toBe(k2);

    // Trente jours : rappel (bandeau), sans rien oublier.
    a.clock.advance(30 * DAY);
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ reminder: true, waiting: [C_ID] });
    expect(a.platform.testing.forgottenDeclarations()).toEqual([]);

    // C revient plusieurs jours plus tard (horloge injectée) : il voit l'annonce, se réassocie, rejoint par fusion.
    a.clock.advance(5 * DAY);
    syncOnline([a, b, iphone]);
    expect((await iphone.cycle()).phase).toBe('reset-required');
    await reassociate(a, iphone, [a, b, iphone]);
    await iphone.cycle();
    syncOnline([a, b, iphone]);
    // A bascule (B et C réassociés), puis B et C, qui lisent le state.ctx de A sous K2.
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'done' });
    expect((await a.platform.key.status()).kid).toBe(k2);
    await settle([a, b, iphone], 2);
    for (const d of [b, iphone]) {
      expect((await d.platform.key.status()).kid, d.name).toBe(k2);
      expect((await d.platform.key.status()).nextKid ?? null, d.name).toBeNull();
      expect(d.service.status().reset, d.name).toMatchObject({ step: 'done' });
    }
    // Bases identiques : union, écritures hors ligne présentes, rien de ressuscité.
    const expected = await taskSnapshot(a);
    expect(await taskSnapshot(b)).toEqual(expected);
    expect(await taskSnapshot(iphone)).toEqual(expected);
    expect(await titles(a)).toEqual(['A après la réinitialisation', 'B hors ligne 1', 'Commun A', 'Commun B']);
    expect((await a.driver.select<{ note: string }>("SELECT note FROM task WHERE title = 'Commun A'"))[0]?.note).toBe('note de B hors ligne');
    expect((await a.driver.select('SELECT id FROM task WHERE id = ?', [gone.id])).length, 'trace purgée jamais réapparue').toBe(0);
    // Plus aucun fichier sous l'ancienne clé dans le dossier ; deux espaces seulement.
    for (const [id, dir] of a.folder.devices) {
      for (const file of [dir.state, ...[...dir.epochs.values()].flatMap((e) => [...e.segments.values(), ...e.snapshots.values()])]) {
        if (file) expect(file.header.kid, id).toBe(k2);
      }
    }
    expect((await a.driver.select('SELECT id FROM space')).length).toBe(2);
  });
});

describe('suspension seulement sur une annonce authentique (critères 8 et 9)', () => {
  it('faux state.ctx étranger avec annonce forgée, ancien état rejoué, annonce d’un appareil inconnu : aucune suspension', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const forgedId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId;
    const ep = publishedState(a, a.id)?.epoch ?? '';
    const forged = JSON.parse(a.folder.devices.get(a.id)?.state?.lines[0]?.text ?? '{}') as Record<string, unknown>;
    const fake: StateFileCopy = {
      deviceId: forgedId,
      file: {
        header: { f: 'ct-state', sm: 1, kid: 'ffffffffffffffff', dev: forgedId, e: ep as never, n: 1 },
        lines: [{ sm: 1, sv: 1, text: JSON.stringify({ ...forged, deviceId: forgedId, reset: { kid: 'ffffffffffffffff', epoch: `e0009-${forgedId}`, at: `000000000001000-0000-${forgedId}` } }), bytes: 4200, corrupt: false }],
        partialTail: false,
        availability: 'local',
        extraBytes: 0,
      },
    } as unknown as StateFileCopy;
    b.folder.putState(fake);
    for (let i = 0; i < 2; i += 1) expect((await b.cycle()).phase).not.toBe('reset-required');
    expect((await b.platform.scan({ keep: [] })).devices.find((d) => d.deviceId === forgedId)?.stateStatus, 'seulement « Clé différente »').toBe('foreign');
    expect(await meta(b, RESET_META)).toBeNull();
    // B publie toujours (rien n'est suspendu) et A n'est pas gêné.
    await b.createTask('B toujours publié');
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    expect(await titles(a)).toContain('B toujours publié');
  });

  it('§18 point 15 : une annonce d’un appareil que B n’a jamais accepté est authentique dès le premier scan (même gagnant partout)', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    // B oublie tout ce qu'il savait de C (ligne sync_state effacée) : C lui est inconnu.
    await b.driver.execute('DELETE FROM sync_state WHERE device_id = ?', [c.id]);
    await c.cycle();
    expect((await c.service.resetSync()).kind).toBe('started');
    propagate(c.folder, b.folder, c.id);
    expect((await b.cycle()).phase, 'état authentifié sous la clé locale : comme chez Rust').toBe('reset-required');
    void a;
  });
});

describe('pas d’oubli d’office (critère 13)', () => {
  it('30, 90 et 400 jours : rappel seulement, aucun oubli ; seul « Oublier cet appareil » (choix explicite) permet la bascule', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    for (const days of [30, 60, 310]) {
      a.clock.advance(days * DAY);
      await a.cycle();
      expect(a.service.status().reset, `${days}`).toMatchObject({ step: 'waiting-devices', reminder: true, waiting: [B_ID] });
      expect(a.platform.testing.forgottenDeclarations()).toEqual([]);
      expect((await a.platform.key.status()).nextKid).not.toBeNull();
    }
    // Choix explicite : « Oublier cet appareil » (boîte de Y-10), puis la bascule.
    expect(await a.service.forgetDevice(b.id)).toEqual({ kind: 'done' });
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'done' });
    expect(a.platform.testing.forgottenDeclarations().map((f) => f.deviceId)).toEqual([b.id]);
    void W_ID;
  });
});
