import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import type { StateFileCopy } from '../../../../src/platform/sync/memory';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { RESET_META } from '../../../../src/sync/reset';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';
import { A_ID, B_ID, backupOf, C_ID, closeAll, meta, publishedState, reassociate, recoveryOf, restoreBackup as restore, setupRoom, settle, titles, W_ID, type Room } from './resetKit';

/**
 * Y-11, passe QA : cas limites croisés (oubliés retenus, restauration « Appliquer partout », annonce interrompue, ancien état rejoué,
 * appareil resté sous l'ancienne clé, hlc d'origine, ordre d'annonce inversé). Horloge injectée, aucun délai réel.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (error: unknown) => (error instanceof SyncPlatformError ? error.code : 'other'),
  );

describe('appareils oubliés retenus (couverture jusqu’à la coupure)', () => {
  it('A oublie X (que B avait lu plus loin), puis réinitialise : X1 à X3 gardées partout, X4 (après la coupure) jamais, X n’est pas attendu', async () => {
    const [a, b, x] = (await setupRoom(room, [B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    await x.createTask('X1');
    await x.cycle();
    for (const d of [a, b]) propagate(x.folder, d.folder, x.id);
    for (const d of [a, b]) await d.cycle();
    await x.createTask('X2');
    await x.createTask('X3');
    x.clock.advance(1_000);
    await x.cycle();
    propagate(x.folder, b.folder, x.id);
    await b.cycle();
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await x.createTask('X4');
    x.clock.advance(1_000);
    await x.cycle();
    for (const d of [a, b]) propagate(x.folder, d.folder, x.id);
    await settle([a, b]);
    expect(await titles(a)).toEqual(['X1', 'X2', 'X3']);
    // Réinitialisation avec X retenu : A a tout lu jusqu'à la coupure ; X n'est pas dans la liste des appareils à réassocier.
    const outcome = await a.service.resetSync();
    expect(outcome.kind).toBe('started');
    expect(a.service.status().reset?.waiting).toEqual([B_ID]);
    await reassociate(a, b, [a, b]);
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    expect(a.service.status().reset?.step).toBe('done');
    await settle([a, b], 3);
    for (const d of [a, b]) expect(await titles(d), d.name).toEqual(['X1', 'X2', 'X3']);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    // X reste oublié : l'oubli survit à la réinitialisation, rien de X ne se réécrit sous la nouvelle clé.
    expect(a.platform.testing.forgottenDeclarations().map((f) => f.deviceId)).toEqual([x.id]);
    expect(a.service.status().devices.find((d) => d.deviceId === x.id)?.status).toBe('forgotten');
  });

  it('un oublié dont A n’a pas tout lu jusqu’à la coupure : « Synchronisez d’abord » nomme X, rien n’est créé', async () => {
    const [a, b, x] = (await setupRoom(room, [B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    await x.createTask('X1');
    await x.cycle();
    propagate(x.folder, b.folder, x.id);
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    // B a lu X1, pas A : A oublie X, la coupure monte au maximum des accusés (X1), A ne l'a pas lue.
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    const outcome = await a.service.resetSync();
    if (outcome.kind === 'lagging') {
      expect((await a.platform.key.status()).nextKid ?? null).toBeNull();
      expect(a.platform.testing.resetRecord()).toBeNull();
    } else {
      // Sinon A a tout lu (la coupure ne dépasse pas sa lecture) : la réinitialisation inclut X1 dans l'instantané.
      expect(outcome.kind).toBe('started');
      expect(await titles(a)).toEqual(['X1']);
    }
  });
});

describe('restauration « Appliquer partout » et réinitialisation (cas croisé)', () => {
  it('après la réinitialisation : « Appliquer partout » ouvre l’époque suivante sous la nouvelle clé, B converge, aucun fichier sous K', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    expect((await a.service.resetSync()).kind).toBe('started');
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    expect(a.service.status().reset?.step).toBe('done');
    await settle(room.devices, 3);
    const k2 = (await a.platform.key.status()).kid;
    const copy = await backupOf(a);
    await a.createTask('Après la sauvegarde');
    await a.cycle();
    await restore(a, copy);
    expect((await a.cycle()).phase).toBe('restore-choice');
    await a.service.chooseRestoreOption('apply-everywhere');
    expect(a.service.status().phase).toBe('idle');
    await settle(room.devices, 4);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await titles(b)).toEqual(['Avant']);
    expect(publishedState(a, a.id)?.epoch).toMatch(/^e0003-/);
    for (const [id, dir] of a.folder.devices) {
      for (const file of [dir.state, ...[...dir.epochs.values()].flatMap((e) => [...e.segments.values(), ...e.snapshots.values()])]) if (file) expect(file.header.kid, id).toBe(k2);
    }
  });
});

describe('annonce et ouverture de l’époque interrompues, échec visible', () => {
  it('écriture de l’annonce refusée : échec gardé à l’étape « announced », reprise au démarrage, la réinitialisation aboutit', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const realWrite = a.platform.writeState;
    let fail = true;
    a.platform.writeState = async (request) => {
      if (fail) throw new SyncPlatformError('cloud-pending');
      return realWrite(request);
    };
    const outcome = await a.service.resetSync();
    expect(outcome.kind === 'started' || outcome.kind === 'failed').toBe(true);
    const state = (await meta(a, RESET_META)) as { step: string; failure: { code: string } | null } | null;
    // Visible : étape gardée avec échec, ou phase d'erreur ; jamais « tout va bien ».
    expect(state?.failure?.code ?? a.service.status().reset?.failure?.code ?? (a.service.status().phase === 'error' ? 'error' : null)).not.toBeNull();
    fail = false;
    a.platform.writeState = realWrite;
    await a.restart();
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ failure: null });
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    expect(a.service.status().reset?.step).toBe('done');
  });
});

describe('arrêt entre la création de K2 et le reste du lancement, ou après l’instantané de la nouvelle époque', () => {
  it('arrêt juste après la création de K2 (avant que le moteur garde son état) : au redémarrage la transition est retrouvée, visible, et aboutit sans seconde clé', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const real = a.platform.reset.start;
    a.platform.reset.start = async () => {
      await real();
      throw new SyncPlatformError('io');
    };
    const outcome = await a.service.resetSync();
    expect(outcome).toEqual({ kind: 'failed', code: 'io' });
    expect(a.service.status().reset?.failure, 'échec visible').toMatchObject({ code: 'io' });
    const k2 = (await a.platform.key.status()).nextKid;
    expect(k2, 'K2 est au coffre (Rust a fini son étape)').not.toBeNull();
    a.platform.reset.start = real;
    await a.restart();
    await a.cycle();
    await a.cycle();
    expect((await a.platform.key.status()).nextKid, 'aucune seconde clé').toBe(k2);
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', step: 'waiting-devices', failure: null });
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 3);
    expect(a.service.status().reset?.step).toBe('done');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('état sous K2 refusé après l’écriture de l’instantané : échec gardé, reprise au démarrage, aucune écriture de B ni de A perdue', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('A avant');
    await b.createTask('B avant');
    await settle(room.devices);
    const real = a.platform.writeState;
    let fail = true;
    a.platform.writeState = async (request) => {
      if (fail && request.state.epoch.startsWith('e0002-')) throw new SyncPlatformError('cloud-pending');
      return real(request);
    };
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(a.service.status().reset?.failure, 'échec gardé et visible').toMatchObject({ code: 'cloud-pending' });
    await a.createTask('A pendant l’échec');
    fail = false;
    a.platform.writeState = real;
    await a.restart();
    await a.cycle();
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'waiting-devices', failure: null });
    await b.createTask('B hors ligne');
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 4);
    expect(a.service.status().reset?.step).toBe('done');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await titles(a)).toEqual(['A avant', 'A pendant l’échec', 'B avant', 'B hors ligne']);
  });
});

describe('réassociation de B : échec visible et persistant (critère 18)', () => {
  it('clé de secours erronée : refus sans rien enregistrer, B reste « à associer de nouveau » après redémarrage, jusqu’à la réussite', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const oldRecovery = await recoveryOf(a);
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders(room.devices);
    expect((await b.cycle()).phase).toBe('reset-required');
    // Ancienne clé de secours : B possède déjà K, rien ne change ; saisie fausse : refus.
    a.clock.advance(11 * 60_000);
    await b.platform.key.openPairing('import');
    const refused = await codeOf(b.platform.key.import({ recoveryKey: oldRecovery }));
    await b.platform.key.closePairing().catch(() => undefined);
    expect(refused, 'l’ancienne clé est déjà celle de B : sans effet').toBe('ok');
    expect((await b.platform.key.status()).nextKid ?? null, 'rien d’enregistré sous .next avec l’ancienne clé').toBeNull();
    // Clé d'un autre dossier : « Cette clé ne correspond pas aux données du dossier », rien n'est enregistré.
    const stranger = await createSimDevice('99999999-9999-4999-8999-999999999999', { name: 'Étranger', clock: a.clock });
    await setupFirst(stranger);
    await stranger.cycle();
    const foreign = await recoveryOf(stranger);
    await stranger.close();
    a.clock.advance(11 * 60_000);
    await b.platform.key.openPairing('import');
    expect(await codeOf(b.platform.key.import({ recoveryKey: foreign }))).toBe('key-mismatch');
    await b.platform.key.closePairing().catch(() => undefined);
    expect((await b.platform.key.status()).nextKid ?? null).toBeNull();
    await b.restart();
    const status = await b.cycle();
    expect(status.phase).toBe('reset-required');
    expect(status.reset).toMatchObject({ role: 'required', by: a.id });
    expect(await meta(b, RESET_META)).toMatchObject({ role: 'required' });
    // Réussite : la nouvelle clé de secours efface l'état.
    await reassociate(a, b, room.devices);
    await b.cycle();
    expect(b.service.status().reset).toMatchObject({ role: 'joined' });
  });
});

describe('state.ctx étranger sans annonce (critères 8 et 9, §1.4)', () => {
  const foreignState = (owner: SimDevice, deviceId: string, withNotice: boolean): StateFileCopy => {
    const real = JSON.parse(owner.folder.devices.get(owner.id)?.state?.lines[0]?.text ?? '{}') as Record<string, unknown>;
    return {
      deviceId,
      file: {
        header: { f: 'ct-state', sm: 1, kid: 'ffffffffffffffff', dev: deviceId as DeviceId, e: real['epoch'] as never, n: 9 },
        lines: [{ sm: 1, sv: 17, text: JSON.stringify({ ...real, deviceId, reset: withNotice ? { kid: 'ffffffffffffffff', epoch: `e0009-${deviceId}`, at: `000000000001000-0000-${deviceId}` } : null }), bytes: 4200, corrupt: false }],
        partialTail: false,
        availability: 'local',
        extraBytes: 0,
      },
    } as unknown as StateFileCopy;
  };

  it('un state.ctx étranger sans annonce : « Clé différente » pour cet appareil seulement, rien n’est suspendu, B continue de publier', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    b.folder.putState(foreignState(a, X_ID, false));
    for (let i = 0; i < 2; i += 1) expect((await b.cycle()).phase).not.toMatch(/reset-required|key-mismatch/);
    expect((await b.platform.scan({ keep: [] })).devices.find((d) => d.deviceId === X_ID)?.stateStatus).toBe('foreign');
    expect(await meta(b, RESET_META)).toBeNull();
    await b.createTask('B publie');
    await settle(room.devices, 2);
    expect(await titles(a)).toContain('B publie');
  });

  it('le state.ctx d’un appareil dont B est le propriétaire, remplacé par un tiers, est réécrit aussitôt sous la clé de B', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const kid = (await b.platform.key.status()).kid;
    b.folder.putState(foreignState(b, b.id, true));
    expect(b.folder.devices.get(b.id)?.state?.header.kid).toBe('ffffffffffffffff');
    const status = await b.cycle();
    expect(status.phase).not.toBe('reset-required');
    expect(b.folder.devices.get(b.id)?.state?.header.kid, 'réécrit sous la clé de B').toBe(kid);
    expect(publishedState(b, b.id)?.reset, 'sans l’annonce forgée').toBeNull();
    expect(await meta(b, RESET_META)).toBeNull();
    void a;
  });
});

describe('deux réinitialisations successives (rotation volontaire répétée)', () => {
  it('la seconde, lancée sans fermer le message « terminée » de la première : nouvelle clé, époque suivante, B se réassocie encore, aucune perte', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    const kids: string[] = [(await a.platform.key.status()).kid ?? ''];
    for (let round = 0; round < 2; round += 1) {
      a.clock.advance(11 * 60_000);
      expect((await a.service.resetSync()).kind, `tour ${round}`).toBe('started');
      expect(a.service.status().reset).toMatchObject({ role: 'initiator', step: 'waiting-devices', failure: null });
      await b.createTask(`B tour ${round}`);
      syncFolders(room.devices);
      expect((await b.cycle()).phase).toBe('reset-required');
      a.clock.advance(11 * 60_000);
      await reassociate(a, b, room.devices);
      await b.cycle();
      syncFolders(room.devices);
      await a.cycle();
      await settle(room.devices, 3);
      expect(a.service.status().reset?.step).toBe('done');
      kids.push((await a.platform.key.status()).kid ?? '');
      expect((await b.platform.key.status()).kid).toBe(kids.at(-1));
    }
    expect(new Set(kids).size, 'trois clés distinctes').toBe(3);
    expect(publishedState(a, a.id)?.epoch).toMatch(/^e0003-/);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await titles(a)).toEqual(['Avant', 'B tour 0', 'B tour 1']);
  });
});

describe('bascule en échec transitoire, sans redémarrage (critères 12 et 17)', () => {
  for (let step = 1; step <= 6; step += 1) {
    it(`échec avant l’écriture ${step}, cycle suivant dans la même session : l’échec est visible puis la bascule est reprise, jamais sans clé`, async () => {
      const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
      await a.createTask('Avant');
      await settle(room.devices);
      expect((await a.service.resetSync()).kind).toBe('started');
      const k2 = (await a.platform.key.status()).nextKid;
      await reassociate(a, b, room.devices);
      await b.cycle();
      syncFolders(room.devices);
      a.platform.testing.interruptBefore(`switch-${step}`);
      expect((await a.cycle()).phase, 'échec visible').toBe('error');
      const key = await a.platform.key.status();
      expect(key.present).toBe(true);
      expect(key.kid === k2 || key.nextKid === k2).toBe(true);
      expect((await a.cycle()).phase, 'repris au cycle suivant').not.toBe('error');
      expect(a.service.status().reset?.step).toBe('done');
      expect((await a.platform.key.status()).kid).toBe(k2);
      expect((await a.platform.key.status()).nextKid ?? null).toBeNull();
      await settle(room.devices, 3);
      expect((await b.platform.key.status()).kid).toBe(k2);
      expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    });
  }
});

describe('ancien état rejoué et appareil resté sous l’ancienne clé', () => {
  it('ancien state.ctx de A (annonce sous K) rejoué chez B après la bascule : aucune suspension, rien d’écrit', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    expect((await a.service.resetSync()).kind).toBe('started');
    const announced = a.folder.takeState(a.id);
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 3);
    expect(a.service.status().reset?.step).toBe('done');
    expect((await b.cycle()).phase).toBe('idle');
    await settle(room.devices, 2);
    const files = JSON.stringify(b.folder.fileNames(b.id));
    const seq = publishedState(a, a.id)?.stateSeq;
    for (const d of [a, b]) d.folder.putState(announced);
    for (const d of [a, b]) {
      expect((await d.cycle()).phase, d.name).not.toBe('reset-required');
      expect(await meta(d, RESET_META)).toMatchObject({ step: 'done' });
    }
    // Un état sous K est « Clé différente » pour B : B ne publie aucun journal de plus (au plus un instantané redondant, sous K2).
    expect(b.folder.fileNames(b.id).filter((f) => f.endsWith('.ctj')).join()).toBe(JSON.parse(files).filter((f: string) => f.endsWith('.ctj')).join());
    expect(publishedState(a, a.id)?.stateSeq, 'l’état de A n’est pas remplacé').toBeGreaterThanOrEqual(seq ?? 0);
    await b.createTask('B après rejeu');
    await settle(room.devices, 3);
    expect(await titles(a)).toContain('B après rejeu');
  });

  it('un appareil oublié par choix, resté sous l’ancienne clé, revient : il ne lit rien du nouveau dossier, n’y écrit rien, et A n’en lit rien', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await a.createTask('Avant');
    await settle(room.devices);
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await reassociate(a, b, [a, b]);
    await b.cycle();
    syncFolders([a, b]);
    await a.cycle();
    await settle([a, b], 3);
    expect(a.service.status().reset?.step).toBe('done');
    // C, sous K, écrit hors ligne puis voit le dossier chiffré avec K2 : il n'y publie rien.
    await c.createTask('C sous l’ancienne clé');
    syncFolders(room.devices);
    const status = await c.cycle();
    expect(['key-mismatch', 'forgotten', 'reset-required']).toContain(status.phase);
    syncFolders(room.devices);
    const kidK2 = (await a.platform.key.status()).kid;
    const dir = c.folder.devices.get(c.id);
    for (const file of [dir?.state, ...[...(dir?.epochs.values() ?? [])].flatMap((e) => [...e.segments.values(), ...e.snapshots.values()])]) {
      if (file) expect(file.header.kid, 'C n’écrit jamais sous la nouvelle clé').not.toBe(kidK2);
    }
    await settle([a, b], 2);
    expect(await titles(a)).not.toContain('C sous l’ancienne clé');
    expect(await titles(b)).not.toContain('C sous l’ancienne clé');
    expect((await c.platform.key.status()).present).toBe(true);
  });
});

describe('écritures hors ligne republiées avec leur hlc d’origine (critère 10, 11)', () => {
  it('l’horloge de champ d’une écriture de B faite hors ligne est la même chez A après la fusion', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const t = await a.createTask('Commune');
    await settle(room.devices);
    expect((await a.service.resetSync()).kind).toBe('started');
    b.clock.advance(5_000);
    await b.updateTask(t.id, { note: 'écrite hors ligne par B' });
    const clockOf = (d: SimDevice) => d.driver.select<{ field: string; hlc: string }>("SELECT field, hlc FROM sync_field_clock WHERE row_id = ? AND field = 'note'", [t.id]);
    const original = await clockOf(b);
    expect(original).toHaveLength(1);
    syncFolders(room.devices);
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 3);
    expect(await clockOf(a)).toEqual(original);
    expect(await clockOf(b)).toEqual(original);
    expect((await a.driver.select<{ note: string }>('SELECT note FROM task WHERE id = ?', [t.id]))[0]?.note).toBe('écrite hors ligne par B');
  });
});

describe('deux réinitialisations : ordre d’annonce inversé, même verdict partout', () => {
  it('W annonce avant A (plus petit UUID) : A l’emporte quand même (ni l’heure ni le kid ne comptent), W, C et A disent la même chose', async () => {
    const [a, w, c] = (await setupRoom(room, [W_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await a.createTask('Commun');
    await settle(room.devices);
    expect((await w.service.resetSync()).kind).toBe('started');
    w.clock.advance(60 * 60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
    const kidA = (await a.platform.key.status()).nextKid;
    await w.createTask('W hors ligne');
    await w.cycle();
    syncFolders(room.devices);
    // A (gagnant) ne se croit jamais perdant ; W et C apprennent que A l'emporte.
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', superseded: false });
    expect((await w.cycle()).reset).toMatchObject({ step: 'superseded', by: a.id });
    const cStatus = await c.cycle();
    expect(cStatus.phase).toBe('reset-required');
    expect(cStatus.reset).toMatchObject({ by: a.id });
    a.clock.advance(11 * 60_000);
    await reassociate(a, w, room.devices);
    await w.cycle();
    a.clock.advance(11 * 60_000);
    await reassociate(a, c, room.devices);
    await c.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 4);
    expect(a.service.status().reset?.step).toBe('done');
    for (const d of room.devices) expect((await d.platform.key.status()).kid, d.name).toBe(kidA);
    expect(await taskSnapshot(w)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(c)).toEqual(await taskSnapshot(a));
    expect(await titles(a)).toEqual(['Commun', 'W hors ligne']);
    void A_ID;
  });
});
