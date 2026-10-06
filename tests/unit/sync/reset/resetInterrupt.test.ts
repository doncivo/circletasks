import { afterEach, describe, expect, it } from 'vitest';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { RESET_META } from '../../../../src/sync/reset';
import { hydrate, propagate } from '../../../sim/syncCloudSim';
import { syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, closeAll, meta, reassociate, setupRoom, settle, type Room } from './resetKit';

/**
 * Y-11 critères 12 et 17 (ADR 0011 §14.3 étape 5) : arrêt brutal avant **chacune** des écritures de la bascule (même méthode que
 * `joinInterrupt.test.ts` : échec simulé, puis redémarrage) : état final identique à une exécution sans arrêt, à aucun instant sans clé
 * valide, et l'écran dit que la réinitialisation a été reprise ; arrêts pendant l'annonce et l'ouverture de l'époque ; échecs persistants
 * jusqu'à la résolution.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));

/** Ce qui doit être identique avec ou sans arrêt : clé, entrée `.next`, registre, fichiers de l'appareil, tâches, état affiché. */
async function shape(a: SimDevice): Promise<unknown> {
  const key = await a.platform.key.status();
  return {
    hasNext: key.nextKid ?? null,
    record: a.platform.testing.resetRecord(),
    files: a.folder.fileNames(a.id).map((f) => f.replace(/e0002-[0-9a-f-]+/, 'e0002')),
    tasks: await taskSnapshot(a),
    step: a.service.status().reset?.step ?? null,
  };
}

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
  await a.createTask('A1');
  await b.createTask('B1');
  await settle(room.devices);
  expect((await a.service.resetSync()).kind).toBe('started');
  await reassociate(a, b, room.devices);
  await b.cycle();
  syncFolders(room.devices);
  return [a, b];
}

describe('bascule interrompue avant chacune de ses écritures (critère 12)', () => {
  it('référence sans arrêt', async () => {
    const [a] = await twoDevices();
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'done', resumed: false });
  });

  for (let step = 1; step <= 6; step += 1) {
    it(`arrêt avant l'écriture ${step} de la bascule, puis redémarrage : même état final, reprise dite à l'écran`, async () => {
      const [a] = await twoDevices();
      const k2 = (await a.platform.key.status()).nextKid;
      a.platform.testing.interruptBefore(`switch-${step}`);
      const failed = await a.cycle();
      expect(failed.phase, 'échec visible').toBe('error');
      const key = await a.platform.key.status();
      expect(key.present, 'jamais sans clé valide').toBe(true);
      expect(key.kid === k2 || key.nextKid === k2, 'K2 toujours au coffre').toBe(true);
      await a.restart();
      await a.cycle();
      expect(a.service.status().reset).toMatchObject({ step: 'done', resumed: step > 1 });
      expect((await a.platform.key.status()).kid).toBe(k2);
      // Même état final que sans arrêt (fichiers, registre, tâches) ; le second appareil bascule ensuite.
      expect(await shape(a)).toMatchObject({ hasNext: null, record: null, step: 'done' });
      expect((await shape(a) as { files: string[] }).files.every((f) => f === 'state.ctx' || f.startsWith('e0002'))).toBe(true);
      await settle(room.devices, 3);
      const b = room.devices[1] as SimDevice;
      expect((await b.platform.key.status()).kid).toBe(k2);
      expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    });
  }
});

describe('arrêts pendant l’annonce et l’ouverture de l’époque (critère 17)', () => {
  it('instantané d’ouverture en échec : échec gardé (étape, code, heure), bandeau et ligne ; reprise au démarrage, dite à l’écran', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const realWrite = a.platform.writeSnapshot;
    let fail = true;
    a.platform.writeSnapshot = async (r) => {
      if (fail && r.epoch.startsWith('e0002-')) throw new SyncPlatformError('cloud-pending');
      return realWrite(r);
    };
    const outcome = await a.service.resetSync();
    expect(outcome.kind).toBe('started');
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', step: 'snapshot', failure: { code: 'cloud-pending', step: 'snapshot' } });
    expect(await meta(a, RESET_META)).toMatchObject({ failure: { code: 'cloud-pending' } });
    // Redémarrage : l'échec reste affiché jusqu'à la réussite ; l'étape est reprise et l'écran le dit.
    fail = false;
    await a.restart();
    a.platform.writeSnapshot = realWrite;
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'waiting-devices', failure: null, resumed: true });
    await reassociate(a, b, room.devices);
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    expect(a.service.status().reset).toMatchObject({ step: 'done', resumed: true });
  });

  it('précondition non remplie : « Synchronisez d’abord » nommant l’appareil, rien n’est créé (ni clé .next, ni registre), échec gardé jusqu’au nouvel essai', async () => {
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    await b.createTask('B tardive');
    await b.cycle();
    // La copie de B chez A est restée dans le nuage : A ne peut pas lire B jusqu'à sa tête.
    propagate(b.folder, a.folder, b.id, { placeholder: true });
    const prompts = a.platform.testing.consentPrompts();
    expect(await a.service.resetSync()).toEqual({ kind: 'lagging', device: b.id });
    expect(a.platform.testing.consentPrompts(), 'aucune boîte').toBe(prompts);
    expect((await a.platform.key.status()).nextKid ?? null).toBeNull();
    expect(a.platform.testing.resetRecord()).toBeNull();
    expect(a.service.status().reset).toMatchObject({ step: 'start', failure: { code: 'state-mismatch', step: 'start' } });
    // « Rust » refuse aussi de lui-même, avant toute boîte, si l'interface l'appelle directement.
    const direct = await a.platform.reset.start().then(
      () => 'ok',
      (error: unknown) => (error as SyncPlatformError).code,
    );
    expect(direct).toBe('state-mismatch');
    expect(a.platform.testing.consentPrompts()).toBe(prompts);
    // B arrive (fichiers téléchargés) : A le lit jusqu'à sa tête, la réinitialisation passe et l'échec disparaît.
    hydrate(a.folder, b.id);
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', failure: null });
  });
});
