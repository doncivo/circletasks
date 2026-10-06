import { afterEach, describe, expect, it } from 'vitest';
import { syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';
import { A_ID, C_ID, closeAll, publishedState, reassociate, setupRoom, settle, titles, W_ID, type Room } from './resetKit';

/**
 * Y-11 critère 15 (ADR 0011 §14.3, §18 point 2, D4) : A et W réinitialisent en même temps ; l'annonce valide de plus grande époque (A,
 * UUID plus grand) l'emporte ; W et C écrivent hors ligne ; C importe la clé de W puis apprend la perte ; arrêts avant chaque étape du
 * perdant ; bases identiques à la fin. Horloge commune, aucun délai réel.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));

for (const stop of [null, 'supersede-2', 'supersede-3', 'supersede-4'] as const) {
  describe(`deux réinitialisations simultanées${stop ? ` (arrêt avant ${stop})` : ''}`, () => {
    it('le perdant constate la perte au scan, republie sans annonce, se réassocie par fusion ; aucune perte', async () => {
      const [a, w, c] = (await setupRoom(room, [W_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
      expect(A_ID > W_ID).toBe(true);
      await a.createTask('Commun');
      await settle(room.devices);
      // A puis W réinitialisent, chacun sans avoir vu l'annonce de l'autre.
      expect((await a.service.resetSync()).kind).toBe('started');
      expect((await w.service.resetSync()).kind).toBe('started');
      const kidA = (await a.platform.key.status()).nextKid;
      const kidW = (await w.platform.key.status()).nextKid;
      expect(kidA).not.toBe(kidW);
      // W et C écrivent hors ligne ; C importe la clé de W (seule annonce qu'il voit), rejoint son époque.
      await w.createTask('W hors ligne');
      await w.cycle();
      await c.createTask('C hors ligne');
      syncFolders([w, c]);
      expect((await c.cycle()).phase).toBe('reset-required');
      await reassociate(w, c, [w, c]);
      await c.cycle();
      expect((await c.platform.key.status()).nextKid).toBe(kidW);

      // Tout le monde voit tout : W constate la perte (Rust, au scan), ses quatre étapes ; arrêt simulé avant l'une d'elles.
      syncFolders(room.devices);
      if (stop) {
        w.platform.testing.interruptBefore(stop);
        expect((await w.cycle()).phase, 'échec visible').toBe('error');
        expect((await w.platform.key.status()).present, 'jamais sans clé valide').toBe(true);
        await w.restart();
      }
      const wStatus = await w.cycle();
      expect(wStatus.phase).toBe('reset-required');
      expect(wStatus.reset).toMatchObject({ step: 'superseded', superseded: true, by: a.id });
      expect(w.platform.testing.resetRecord()?.superseded).toMatchObject({ by: a.id, done: true });
      expect((await w.platform.key.status()).nextKid ?? null, '.next effacée').toBeNull();
      expect(w.folder.devices.get(w.id)?.nextState ?? null, 'state.next.ctx supprimé').toBeNull();
      // Republication unique sous K, sans annonce ; la file est gardée, rien d'autre n'est publié.
      expect(publishedState(w, w.id)?.reset).toBeNull();
      const seq = publishedState(w, w.id)?.stateSeq;
      expect((await w.cycle()).phase).toBe('reset-required');
      expect(publishedState(w, w.id)?.stateSeq, 'une seule fois').toBe(seq);
      // C, réassocié à la perdante, apprend aussi la perte ; il garde K.
      syncFolders(room.devices);
      expect((await c.cycle()).reset).toMatchObject({ step: 'superseded', by: a.id });
      expect((await c.platform.key.status()).nextKid ?? null).toBeNull();
      // A, le gagnant, attend C et W, puis chacun se réassocie avec K2a par fusion.
      await a.cycle();
      expect(a.service.status().reset?.waiting).toEqual([W_ID, C_ID].sort());
      // Trois affichages de la clé par 10 minutes au plus (Y-08) : l'heure avance entre les associations.
      a.clock.advance(11 * 60_000);
      await reassociate(a, w, room.devices);
      await w.cycle();
      a.clock.advance(11 * 60_000);
      await reassociate(a, c, room.devices);
      await c.cycle();
      syncFolders(room.devices);
      await a.cycle();
      expect(a.service.status().reset).toMatchObject({ step: 'done' });
      await settle(room.devices, 4);
      for (const d of room.devices) expect((await d.platform.key.status()).kid, d.name).toBe(kidA);
      const expected = await taskSnapshot(a);
      expect(await taskSnapshot(w)).toEqual(expected);
      expect(await taskSnapshot(c)).toEqual(expected);
      expect(await titles(a)).toEqual(['C hors ligne', 'Commun', 'W hors ligne']);
      // L'époque perdante de W a disparu ; plus rien sous K2w.
      expect([...(a.folder.devices.get(w.id)?.epochs.keys() ?? [])].some((e) => e.endsWith(W_ID))).toBe(false);
    });
  });
}
