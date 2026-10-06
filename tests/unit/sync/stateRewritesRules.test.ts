import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../src/domain/types';
import { mirrorDeviceFolder } from '../../sim/syncCloudSim';
import { syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { A_ID, B_ID, C_ID, closeAll, DAY, reassociate, setupRoom, type Room } from './reset/resetKit';

/**
 * Y-TECH-01, QA : aucune règle de synchro n'est bloquée plus de 30 minutes de cycles (6 tours de 5 minutes) par la nouvelle comparaison de
 * `state.ctx` : purge d'une suppression (Y-09), suppression des fichiers d'un appareil oublié (Y-10), bascule d'une réinitialisation (Y-11).
 * Horloge injectée, aucun délai réel. Les accusés attendus par une règle doivent être publiés au cycle même de la lecture, pas au prochain
 * rafraîchissement : les assertions « avant tout rafraîchissement » le vérifient directement dans le `state.ctx` publié.
 */

const CYCLE_MS = 5 * 60_000;
const MAX_TICKS = (30 * 60_000) / CYCLE_MS;

const room: Room = { devices: [] };
beforeAll(warmSimDevices);
afterEach(() => closeAll(room));

interface PublishedAck {
  readonly hlc: string | null;
  readonly epoch: string;
  readonly segment: number;
  readonly record: number;
}
interface PublishedJson {
  readonly head: PublishedAck;
  readonly acks: Record<string, PublishedAck>;
}
const published = (of: SimDevice): PublishedJson => JSON.parse(of.folder.devices.get(of.id)?.state?.lines[0]?.text ?? '{}') as PublishedJson;

async function tick(list: readonly SimDevice[], after?: (cycled: SimDevice) => void): Promise<void> {
  (list[0] as SimDevice).clock.advance(CYCLE_MS);
  for (const d of list) {
    await d.cycle();
    syncFolders(list);
    after?.(d);
  }
}

describe('Y-TECH-01 QA : purge d\'une suppression (Y-09), 3 appareils actifs', () => {
  it('l\'accusé de lecture de la suppression est publié au tour même (jamais attendu jusqu\'au rafraîchissement), la purge suit en au plus 6 tours', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    const list = [a, b, c];
    const doomed = await a.createTask('À purger');
    await tick(list);
    await tick(list);
    for (const d of list) expect((await d.task(doomed.id))?.title, d.name).toBe('À purger');
    // Sortie de la fenêtre de rafraîchissement posée par la mise en route : une marge de 6 tours d'abord.
    for (let t = 0; t < MAX_TICKS; t += 1) await tick(list);
    await a.deleteTask(doomed.id);
    await tick(list);
    await tick(list);
    // Moins de 15 minutes après la suppression : chaque lecteur a déjà accusé la tête de A, la suppression comprise.
    const head = published(a).head.hlc as string;
    expect(head).not.toBeNull();
    for (const d of [b, c]) expect((published(d).acks[a.id]?.hlc ?? '') >= head, `${d.name} a accusé la suppression`).toBe(true);
    // La suppression a 31 jours : un saut, puis au plus 6 tours (30 minutes) jusqu'à la purge chez tous.
    for (const d of list) d.clock.advance(31 * DAY);
    let ticks = 0;
    const purged = async (d: SimDevice): Promise<boolean> => (await d.driver.select('SELECT id FROM task WHERE id = ?', [doomed.id])).length === 0;
    for (; ticks < MAX_TICKS; ticks += 1) {
      await tick(list);
      if ((await Promise.all(list.map(purged))).every(Boolean)) break;
    }
    for (const d of list) expect(await purged(d), `${d.name} : purgée dans les ${String(MAX_TICKS)} tours`).toBe(true);
    const expected = await taskSnapshot(a);
    for (const d of list) expect(await taskSnapshot(d), d.name).toEqual(expected);
  });
});

describe('Y-TECH-01 QA : suppression des fichiers d\'un oublié (Y-10), 3 appareils actifs, un éteint', () => {
  it('A oublie D ; les fichiers de D sont supprimés chez tous en au plus 6 tours', async () => {
    const [a, b, c, d] = (await setupRoom(room, [B_ID, C_ID, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    const live = [a, b, c];
    await d.createTask('D1');
    await d.cycle();
    syncFolders(room.devices);
    await tick(live);
    await tick(live);
    for (let t = 0; t < MAX_TICKS; t += 1) await tick(live);
    expect(await a.service.forgetDevice(d.id as DeviceId)).toEqual({ kind: 'done' });
    // Une suppression de fichiers faite par un appareil est propagée par iCloud aux autres dossiers.
    const mirrorDeletion = (cycled: SimDevice): void => {
      if (cycled.folder.devices.has(d.id)) return;
      for (const other of live) if (other !== cycled) mirrorDeviceFolder(cycled.folder, other.folder, d.id);
    };
    let ticks = 0;
    for (; ticks < MAX_TICKS; ticks += 1) {
      await tick(live, mirrorDeletion);
      if (live.every((x) => !x.folder.devices.has(d.id))) break;
    }
    for (const x of live) expect(x.folder.devices.has(d.id), `${x.name} : fichiers de D supprimés dans les ${String(MAX_TICKS)} tours`).toBe(false);
    const expected = await taskSnapshot(a);
    for (const x of live) expect(await taskSnapshot(x), x.name).toEqual(expected);
  });
});

describe('Y-TECH-01 QA : réinitialisation en cours puis oubli (Y-10 et Y-11 ensemble), C éteint', () => {
  it('A et B attendent C pendant 2 heures : écritures de state.ctx bornées (rafraîchissement) ; A oublie C : bascule de A et B en au plus 6 tours', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    const live = [a, b];
    for (let t = 0; t < MAX_TICKS; t += 1) await tick(live);
    expect(await a.service.resetSync()).toEqual({ kind: 'started', switched: false });
    const k2 = (await a.platform.key.status()).nextKid;
    syncFolders(live);
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, live);
    const writes = new Map<string, number>(live.map((d) => [d.id, 0]));
    for (const d of live) {
      const original = d.platform.writeState.bind(d.platform);
      d.platform.writeState = async (request) => {
        await original(request);
        writes.set(d.id, (writes.get(d.id) ?? 0) + 1);
      };
    }
    // Deux heures d'attente de C : 24 tours. Au plus un rafraîchissement par 30 minutes (4 mesurés), plus 2 d'alignement.
    for (let t = 0; t < 24; t += 1) await tick(live);
    for (const d of live) expect(writes.get(d.id), `${d.name} : écritures pendant l'attente`).toBeLessThanOrEqual(4 + 2);
    expect((await a.platform.key.status()).kid).not.toBe(k2);
    // Oubli explicite de C : la bascule suit en au plus 6 tours.
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    let ticks = 0;
    for (; ticks < MAX_TICKS; ticks += 1) {
      await tick(live);
      if ((await a.platform.key.status()).kid === k2 && (await b.platform.key.status()).kid === k2) break;
    }
    for (const d of live) expect((await d.platform.key.status()).kid, `${d.name} : bascule dans les ${String(MAX_TICKS)} tours`).toBe(k2);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});

describe('Y-TECH-01 QA : bascule d\'une réinitialisation (Y-11), 3 appareils', () => {
  it('B et C réassociés : A bascule et B, C le suivent en au plus 6 tours ; bases identiques', async () => {
    const [a, b, c] = (await setupRoom(room, [B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    const list = [a, b, c];
    for (let t = 0; t < MAX_TICKS; t += 1) await tick(list);
    await b.createTask('B avant');
    await tick(list);
    expect(await a.service.resetSync()).toEqual({ kind: 'started', switched: false });
    const k2 = (await a.platform.key.status()).nextKid;
    expect(k2).not.toBeNull();
    syncFolders(list);
    expect((await b.cycle()).phase).toBe('reset-required');
    expect((await c.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, list);
    await reassociate(a, c, list);
    let ticks = 0;
    const switched = async (): Promise<boolean> => {
      for (const d of list) if ((await d.platform.key.status()).kid !== k2) return false;
      return true;
    };
    for (; ticks < MAX_TICKS; ticks += 1) {
      await tick(list);
      if (await switched()) break;
    }
    for (const d of list) expect((await d.platform.key.status()).kid, `${d.name} : bascule dans les ${String(MAX_TICKS)} tours`).toBe(k2);
    expect(a.service.status().reset).toMatchObject({ step: 'done' });
    await tick(list);
    await tick(list);
    const expected = await taskSnapshot(a);
    for (const d of list) expect(await taskSnapshot(d), d.name).toEqual(expected);
    void A_ID;
  });
});
