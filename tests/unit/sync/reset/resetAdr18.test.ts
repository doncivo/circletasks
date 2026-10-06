import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../../../../src/domain/types';
import { META } from '../../../../src/sync/meta';
import { RESET_META } from '../../../../src/sync/reset';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';
import { A_ID, B_ID, C_ID, DAY, backupOf, closeAll, meta, reassociate, recoveryOf, restoreBackup, setupRoom, settle, titles, type Room } from './resetKit';

/**
 * Y-11, décision de l'architecte (ADR 0011 §18 points 14 à 18) côté moteur et simulation : oubli pendant la transition (rattrapage,
 * instantané couvrant, attente visible du réassocié, accusés de l'époque `n` gardés), annonces d'appareils inconnus, restauration pendant
 * une réinitialisation (fenêtre de choix, garde d'époque du moteur), échec d'import persisté. Aucun délai réel : horloge du test.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));

const L_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

describe('§18 point 14 : oubli pendant la transition', () => {
  it('C publie dans n après la précondition, B le lit ; A oublie C ; B attend de façon visible ; A rattrape C et écrit un instantané couvrant ; bases identiques', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    // A réinitialise sans voir la suite de C (dossier de A seul).
    expect((await a.service.resetSync()).kind).toBe('started');
    // C écrit dans l'époque n ; B le lit avant de voir l'annonce.
    await c.createTask('C après la précondition');
    await c.cycle();
    syncFolders([b, c]);
    await b.cycle();
    expect(await titles(b)).toContain('C après la précondition');
    // A oublie C sans avoir encore reçu la suite de C ; B voit l'annonce.
    expect(await a.service.forgetDevice(C_ID as DeviceId)).toEqual({ kind: 'done' });
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, [a, b]);
    await b.cycle();
    // L'instantané d'ouverture de A ne couvre pas C jusqu'à la coupure (accusé de B) : attente visible, jamais une perte.
    const waiting = b.service.status().reset;
    expect(waiting?.role).toBe('joined');
    expect(waiting?.failure).toMatchObject({ code: 'state-mismatch', step: 'joined' });
    // A détient K : il rattrape C dans l'époque n jusqu'à la coupure, écrit un instantané couvrant et republie.
    syncFolders(room.devices);
    await a.cycle();
    await settle([a, b], 4);
    expect(a.service.status().reset?.step).toBe('done');
    expect(b.service.status().reset?.step).toBe('done');
    expect(b.service.status().reset?.failure ?? null).toBeNull();
    expect(await titles(a)).toContain('C après la précondition');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('le réassocié publie ses accusés sur un oublié retenu à leur position de l’époque n (jamais au début de n+1)', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await c.createTask('C');
    await settle(room.devices);
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(await a.service.forgetDevice(c.id)).toEqual({ kind: 'done' });
    await reassociate(a, b, [a, b]);
    await b.cycle();
    const next = b.folder.devices.get(b.id)?.nextState?.lines[0]?.text;
    const ack = next ? (JSON.parse(next) as { acks: Record<string, { epoch: string }> }).acks[C_ID] : undefined;
    expect(ack?.epoch).toMatch(/^e0001-/);
    syncFolders([a, b]);
    await settle([a, b], 3);
    expect(a.service.status().reset?.step).toBe('done');
  });
});

describe('§18 point 15 : annonce d’un appareil jamais vu', () => {
  it('L, associé avec K mais jamais lu par B, annonce : B et N (associé ensuite) la suivent ; B oublie L : l’annonce est sans effet', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const l = await createSimDevice(L_ID, { name: 'L', clock: a.clock });
    room.devices.push(l);
    await pair(a, l);
    propagate(b.folder, l.folder, b.id);
    await l.cycle();
    propagate(l.folder, a.folder, l.id);
    await a.cycle();
    propagate(a.folder, l.folder, a.id);
    expect((await l.service.resetSync()).kind).toBe('started');
    // B voit L pour la première fois, porteur d'une annonce authentique.
    syncFolders(room.devices);
    expect((await b.cycle()).phase).toBe('reset-required');
    expect(b.service.status().reset?.by).toBe(L_ID);
    expect(await b.service.forgetDevice(L_ID as DeviceId)).toEqual({ kind: 'done' });
    expect((await b.cycle()).phase).not.toBe('reset-required');
  });
});

describe('§18 point 16 : restauration pendant une réinitialisation', () => {
  it('fenêtre de choix : « Appliquer partout » retiré (appareil qui réinitialise), texte présent ; refus visible et persistant', async () => {
    const [a] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const copy = await backupOf(a);
    expect((await a.service.resetSync()).kind).toBe('started');
    await restoreBackup(a, copy);
    const context = await a.service.restoreContext();
    expect(context?.options).toEqual(['keep-synced']);
    expect(context?.notice).toBe('reset-in-progress');
    await a.service.chooseRestoreOption('apply-everywhere');
    const failure = (await a.service.restoreContext())?.failure;
    expect(failure).toMatchObject({ option: 'apply-everywhere', code: 'state-mismatch' });
    await a.restart();
    expect((await a.service.restoreContext())?.failure, 'gardé après un redémarrage').toMatchObject({ option: 'apply-everywhere' });
  });

  it('fenêtre de choix : retiré aussi pour un appareil réassocié (nextKid) et pour un appareil à associer de nouveau (annonce lue)', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    const copyB = await backupOf(b);
    const copyC = await backupOf(c);
    expect((await a.service.resetSync()).kind).toBe('started');
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    expect((await c.cycle()).phase).toBe('reset-required');
    await restoreBackup(b, copyB);
    await restoreBackup(c, copyC);
    for (const d of [b, c]) {
      const context = await d.service.restoreContext();
      expect(context?.options, d.name).toEqual(['keep-synced']);
      expect(context?.notice, d.name).toBe('reset-in-progress');
    }
  });

  it('règle 4 pendant une réinitialisation : aucune option, marqueur gardé, texte « terminez-la »', async () => {
    const [a] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const copy = await backupOf(a);
    expect((await a.service.resetSync()).kind).toBe('started');
    await restoreBackup(a, copy);
    const late = `${String(a.clock.nowMs() + DAY).padStart(15, '0')}-0000-${B_ID}` as Hlc;
    await a.data.repos.sync.setMeta(META.purgeHorizon, JSON.stringify(late));
    const context = await a.service.restoreContext();
    expect(context?.options).toEqual([]);
    expect(context?.notice).toBe('reset-finish');
    expect((await a.cycle()).phase).toBe('restore-choice');
    expect(await a.platform.restoreMarker.get()).not.toBeNull();
  });

  it('directive initiator : une époque plus grande sous K que Rust ne désigne pas (sans instantané) n’est jamais suivie', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    const opened = await meta(a, META.epoch);
    // B, qui n'a pas lu l'annonce, publie un état dans une époque e3 sans instantané (garde de Rust passée : rien d'annoncé chez B).
    const scan = await b.platform.scan({ keep: [] });
    const own = scan.devices.find((d) => d.deviceId === b.id)?.state;
    if (!own) throw new Error('état');
    const e3 = `e0003-${B_ID}` as typeof own.epoch;
    await b.platform.writeState({ sv: own.sv, state: { ...own, epoch: e3, stateSeq: own.stateSeq + 1, head: { epoch: e3, segment: 0, record: 0, hlc: null, stateSeq: own.stateSeq + 1 }, snapshot: null } });
    syncFolders(room.devices);
    await a.cycle();
    expect(await meta(a, META.epoch)).toBe(opened);
    expect(a.service.status().phase).not.toBe('waiting-icloud');
    expect(a.service.status().reset?.role).toBe('initiator');
  });

  it('restauration appliquée partout avant la lecture de l’annonce, UUID plus grand : la restauration l’emporte, A suit par remplacement', async () => {
    const [a, b] = (await setupRoom(room, [L_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const copy = await backupOf(b);
    await b.createTask('B supprimé ensuite');
    await settle(room.devices);
    // A réinitialise (dossier de A seul) ; B restaure et applique partout sans avoir vu l'annonce.
    expect((await a.service.resetSync()).kind).toBe('started');
    await restoreBackup(b, copy);
    await b.service.chooseRestoreOption('apply-everywhere');
    expect(await b.platform.restoreMarker.get()).toBeNull();
    syncFolders(room.devices);
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'superseded', superseded: true, restore: true, by: L_ID });
    await settle(room.devices, 3);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect((await a.platform.key.status()).nextKid ?? null).toBeNull();
    // Époque restaurée suivie : perte close par Rust ; l'état « interrompue » reste affiché jusqu'à « Fermer » ; A peut relancer.
    expect(a.platform.testing.resetRecord()).toBeNull();
    expect(a.service.status().reset).toMatchObject({ step: 'superseded', restore: true });
    a.clock.advance(11 * 60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
  });
});

describe('§18 point 17 : échec d’import persisté', () => {
  it('import refusé sur B : resetState.failure visible au cycle suivant, après redémarrage aussi ; écarté : non recopié ; import réussi : effacé', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    expect((await b.cycle()).phase).toBe('reset-required');
    const stranger = await createSimDevice('99999999-9999-4999-8999-999999999999', { name: 'X', clock: a.clock });
    room.devices.push(stranger);
    await stranger.platform.folder.choose();
    await stranger.platform.key.create();
    await stranger.platform.bindDevice(stranger.id);
    const foreign = await recoveryOf(stranger);
    a.clock.advance(11 * 60_000);
    await b.platform.key.openPairing('import');
    await b.platform.key.import({ recoveryKey: foreign }).catch(() => undefined);
    await b.platform.key.closePairing().catch(() => undefined);
    await b.cycle();
    expect(b.service.status().reset?.failure).toMatchObject({ code: 'key-mismatch', step: 'required' });
    await b.restart();
    await b.cycle();
    expect(b.service.status().reset?.failure).toMatchObject({ code: 'key-mismatch', step: 'required' });
    await b.service.dismissReset();
    expect(b.service.status().reset?.failure ?? null).toBeNull();
    await b.cycle();
    expect(b.service.status().reset?.failure ?? null, 'même échec : non recopié').toBeNull();
    expect((await meta(b, RESET_META)) as { importFailureAt?: string }).toMatchObject({ importFailureAt: expect.any(String) });
    a.clock.advance(11 * 60_000);
    await reassociate(a, b, room.devices);
    await b.cycle();
    expect(b.service.status().reset?.failure ?? null).toBeNull();
    void A_ID;
  });
});

const D_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('§18 point 18 : simulations complémentaires', () => {
  it('(1) variante : l’oubli précède la lecture de C par B ; la coupure croît après la déclaration ; couverte avant l’arrivée de B', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(await a.service.forgetDevice(C_ID as DeviceId)).toEqual({ kind: 'done' });
    await c.createTask('C après l’oubli');
    await c.cycle();
    syncFolders([b, c]);
    await b.cycle();
    expect(await titles(b)).toContain('C après l’oubli');
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, [a, b]);
    await b.cycle();
    expect(b.service.status().reset?.failure).toMatchObject({ code: 'state-mismatch', step: 'joined' });
    syncFolders(room.devices);
    await settle([a, b], 4);
    expect(a.service.status().reset?.step).toBe('done');
    expect(b.service.status().reset?.step).toBe('done');
    expect(await titles(a)).toContain('C après l’oubli');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('(1) variante : réassocié D dont le curseur sur C reste sous la coupure après la bascule : trou, reprise, bases identiques', async () => {
    const [a, b, c, d] = (await setupRoom(room, [B_ID, C_ID, D_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    a.clock.advance(11 * 60_000);
    await c.createTask('C lu par B seulement');
    await c.cycle();
    syncFolders([b, c]);
    await b.cycle();
    expect(await a.service.forgetDevice(C_ID as DeviceId)).toEqual({ kind: 'done' });
    // A rattrape C ; B et D se réassocient ; D ne reçoit jamais les fichiers de C avant la bascule.
    syncFolders([a, b, c]);
    for (const x of [a, b, d]) if (x !== a) propagate(a.folder, x.folder, a.id);
    await reassociate(a, b, [a, b]);
    propagate(b.folder, d.folder, b.id);
    a.clock.advance(11 * 60_000);
    await reassociate(a, d, [a, b, d]);
    for (const x of [b, d]) await x.cycle();
    const without = (list: readonly SimDevice[]): void => {
      for (const from of list) for (const to of list) if (from !== to) propagate(from.folder, to.folder, from.id);
    };
    for (let r = 0; r < 4; r += 1) {
      without([a, b, d]);
      for (const x of [a, b, d]) await x.cycle();
    }
    expect(a.service.status().reset?.step).toBe('done');
    expect(d.service.status().reset?.step).toBe('done');
    // Les fichiers de C (sous l'ancienne clé, plus détenue) arrivent chez D : trou, reprise depuis l'instantané éligible de A.
    propagate(c.folder, d.folder, c.id);
    await settle([a, b, d], 3);
    expect(await titles(d)).toContain('C lu par B seulement');
    expect(await taskSnapshot(d)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('(2) L (UUID jamais vu) annonce ; B oublie L et republie son état sous K ; A apprend l’oubli, l’annonce est sans effet, A relance', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const l = await createSimDevice(L_ID, { name: 'L', clock: a.clock });
    room.devices.push(l);
    await pair(a, l);
    propagate(b.folder, l.folder, b.id);
    await l.cycle();
    propagate(l.folder, a.folder, l.id);
    await a.cycle();
    propagate(a.folder, l.folder, a.id);
    expect((await l.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    for (const x of [a, b]) {
      expect((await x.cycle()).phase, x.name).toBe('reset-required');
      expect(x.service.status().reset?.by, x.name).toBe(L_ID);
    }
    expect(await b.service.forgetDevice(L_ID as DeviceId)).toEqual({ kind: 'done' });
    expect((await b.cycle()).phase).not.toBe('reset-required');
    // B, suspendu, a republié son état sous K avec la liste maître : A l'apprend sans attendre de réassociation.
    syncFolders([a, b]);
    expect((await a.cycle()).phase).not.toBe('reset-required');
    await settle([a, b], 2);
    a.clock.advance(11 * 60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
  });

  it('(3) D restaure et applique partout avant de lire l’annonce, UUID plus petit : la réinitialisation l’emporte, D arrive par remplacement, rien de purgé ne renaît', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const gone = await a.createTask('Supprimée');
    await b.createTask('B avant');
    await settle(room.devices, 2);
    const copy = await backupOf(b);
    const takenAt = new Date(b.clock.nowMs()).toISOString();
    a.clock.advance(1_000);
    await a.deleteTask(gone.id);
    await settle(room.devices, 1);
    for (const x of room.devices) x.clock.advance(31 * DAY);
    // Purge, puis horizon de purge publié par chacun (règle 4).
    await settle(room.devices, 2);
    for (const x of room.devices) expect((await x.driver.select('SELECT id FROM task WHERE id = ?', [gone.id])).length, x.name).toBe(0);
    // A réinitialise (dossier de A seul) ; B restaure une sauvegarde d'avant la purge et applique partout sans avoir vu l'annonce.
    expect((await a.service.resetSync()).kind).toBe('started');
    await restoreBackup(b, copy);
    const marker = await b.platform.restoreMarker.get();
    if (!marker) throw new Error('marqueur');
    b.platform.testing.setRestoreMarker({ ...marker, backupTakenAt: takenAt as typeof marker.backupTakenAt });
    expect((await b.service.restoreContext())?.options).toEqual(['apply-everywhere']);
    await b.service.chooseRestoreOption('apply-everywhere');
    expect(await b.platform.restoreMarker.get()).toBeNull();
    syncFolders(room.devices);
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', superseded: false });
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, room.devices);
    await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'epoch-switched')).toBe(true);
    syncFolders(room.devices);
    await settle(room.devices, 4);
    expect(a.service.status().reset?.step).toBe('done');
    for (const x of room.devices) expect((await x.driver.select('SELECT id FROM task WHERE id = ?', [gone.id])).length, `${x.name} : purgée, jamais renée`).toBe(0);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await titles(a)).toEqual(['B avant']);
  });
});
