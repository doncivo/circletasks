import { afterEach, describe, expect, it } from 'vitest';
import type { SyncTable } from '../../../../src/domain/sync/syncTables';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Seconde revue de Y-04, point 1 (bloquant) : une ligne republiée entière (« + ») se publie en entier ou pas du tout. Si un de ses
 * champs est écrit après la coupure de la publication (hlc plus grand), rien de la ligne ne part dans ce cycle et toutes ses entrées
 * restent ; elle part entière au cycle suivant. Sinon, chez un appareil qui avait purgé la ligne, la partie restaurée serait mise de
 * côté et le champ seul abandonné (divergence silencieuse). Scénario : tâche supprimée, purgée par B, restaurée par A (restauration
 * fondée sur la trace) ; A modifie un champ pendant la mise en forme de sa publication.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;
const REMINDER = '90000000-0000-4000-8000-0000000000b1';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    for (const d of devices) await d.cycle();
    syncFolders(devices);
  }
}

/** Avant la lecture des lignes de `table` par la publication de A (après la coupure), exécute `action` une fois. */
function beforeRowsRead(device: SimDevice, table: string, action: () => Promise<void>): void {
  const sync = device.data.repos.sync as { readRowsWithClocks: (t: SyncTable, ids: readonly string[]) => Promise<unknown> };
  const real = sync.readRowsWithClocks.bind(sync);
  let done = false;
  sync.readRowsWithClocks = async (t, ids) => {
    if (!done && t.name === table) {
      done = true;
      await action();
    }
    return real(t, ids);
  };
}

/** Tâche avec un rappel vivant, supprimée par A, purgée par B ; A la restaure hors ligne (fondée sur la trace). */
async function purgedOnB(): Promise<{ a: SimDevice; b: SimDevice; taskId: string }> {
  const [a, b] = await twoDevices();
  const t = await a.createTask('Rappel vivant');
  await a.data.repos.reminders.createMany([{ id: REMINDER as never, targetType: 'task', targetId: t.id, offsetMin: 15, fireAt: '2026-10-05T09:00' as never }]);
  await settle();
  a.clock.advance(1_000);
  await a.deleteTask(t.id);
  await settle();
  a.clock.advance(29 * DAY);
  await a.data.repos.tasks.restore([t.id]);
  a.clock.advance(2 * DAY);
  await b.cycle();
  expect(await b.task(t.id), 'B a purgé').toBeNull();
  return { a, b, taskId: t.id };
}

describe('ligne « + » : entière ou pas du tout', () => {
  it('titre modifié pendant la publication de la tâche restaurée : la tâche est recréée chez B avec la modification, et son rappel', async () => {
    const { a, b, taskId } = await purgedOnB();
    beforeRowsRead(a, 'task', async () => {
      a.clock.advance(1);
      await a.updateTask(taskId as never, { title: 'Modifiée pendant la publication' });
    });
    await a.cycle();
    syncFolders(devices);
    await settle();
    const onB = await b.task(taskId as never);
    expect(onB?.deletedAt).toBeNull();
    expect(onB?.title).toBe('Modifiée pendant la publication');
    expect(await b.driver.select('SELECT id, deleted_at FROM reminder')).toEqual([{ id: REMINDER, deleted_at: null }]);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await b.driver.select('SELECT reason FROM sync_parked')).toEqual([]);
    expect(b.logger.entries.filter((e) => e.event === 'apply-abandoned')).toEqual([]);
  });

  it('rappel vivant modifié pendant la publication : recréé chez B avec la modification, avec sa tâche', async () => {
    const { a, b, taskId } = await purgedOnB();
    beforeRowsRead(a, 'reminder', async () => {
      a.clock.advance(1);
      await a.driver.execute('UPDATE reminder SET offset_min = 60, fire_at = ?, updated_at = ?, hlc = ? WHERE id = ?', [
        '2026-10-05T08:00',
        new Date(a.clock.nowMs()).toISOString(),
        a.hlc.now(),
        REMINDER,
      ]);
    });
    await a.cycle();
    syncFolders(devices);
    await settle();
    expect((await b.task(taskId as never))?.deletedAt).toBeNull();
    expect(await b.driver.select('SELECT id, offset_min, deleted_at FROM reminder')).toEqual([{ id: REMINDER, offset_min: 60, deleted_at: null }]);
    expect(await b.driver.select('SELECT reason FROM sync_parked')).toEqual([]);
    expect(b.logger.entries.filter((e) => e.event === 'apply-abandoned')).toEqual([]);
  });

  it('ligne « + » réécrite pendant deux cycles de suite : retenue deux fois, publiée entière au troisième au-dessus de la tête, B converge', async () => {
    const { a, b, taskId } = await purgedOnB();
    const sync = a.data.repos.sync as { readRowsWithClocks: (t: SyncTable, ids: readonly string[]) => Promise<unknown> };
    const real = sync.readRowsWithClocks.bind(sync);
    let rewrites = 0;
    let rewriting = true;
    sync.readRowsWithClocks = async (t, ids) => {
      if (rewriting && t.name === 'task' && ids.includes(taskId)) {
        rewrites += 1;
        a.clock.advance(1);
        await a.updateTask(taskId as never, { title: `Réécrite ${String(rewrites)}` });
      }
      return real(t, ids);
    };
    const pendingWhole = () => a.driver.select("SELECT field FROM sync_outbox WHERE table_name = 'task' AND row_id = ? AND field = '+'", [taskId]);
    const head = async (): Promise<string> => String((JSON.parse(String(await a.data.repos.sync.getMeta('head'))) as { hlc: string }).hlc);
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await a.cycle();
      syncFolders(devices);
      await b.cycle();
      // Retenue : son entrée « + » reste, rien d'elle n'est arrivé chez B (ni partie mise de côté, ni champ abandonné).
      expect(await pendingWhole(), `cycle ${String(cycle)}`).toEqual([{ field: '+' }]);
      expect(await b.task(taskId as never), `cycle ${String(cycle)}`).toBeNull();
      // Seul le rappel vivant (parti entier) attend sa tâche, encore une trace chez B : mis de côté, jamais abandonné (ADR 0011 §5.4).
      expect(await b.driver.select('SELECT table_name, reason FROM sync_parked')).toEqual([{ table_name: 'reminder', reason: 'missing-parent' }]);
    }
    expect(rewrites).toBe(2);
    rewriting = false;
    const before = await head();
    await a.cycle();
    expect(await pendingWhole()).toEqual([]);
    // Publiée à un rang au-dessus de la tête déjà publiée (l'ajout est refusé sinon, hlc-order) : aucune famine.
    expect(await head() > before).toBe(true);
    expect(a.logger.entries.filter((e) => e.event === 'publish-failed')).toEqual([]);
    syncFolders(devices);
    await settle();
    const onB = await b.task(taskId as never);
    expect(onB?.deletedAt).toBeNull();
    expect(onB?.title).toBe('Réécrite 2');
    expect(await b.driver.select('SELECT id, deleted_at FROM reminder')).toEqual([{ id: REMINDER, deleted_at: null }]);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await b.driver.select('SELECT reason FROM sync_parked')).toEqual([]);
    expect(b.logger.entries.filter((e) => e.event === 'apply-abandoned')).toEqual([]);
  });
});
