import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../domain/types';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { appleRemindersStore } from './appleRemindersState';
import { resolveHeldSend } from './remindersWrites';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * Garde de suppression massive SYMÉTRIQUE (audit M2) : des tâches supprimées ici qui dépasseraient max(10, 25 %) des tâches liées d'une
 * liste n'effacent rien dans Rappels sans confirmation (écran Agendas) ; jamais de suppression dans Rappels sans tâche supprimée connue.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('23');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

const uc = () => createTaskUseCases(h.container);
const status = () => appleRemindersStore.get(h.container).getState().status;

async function importMany(count: number): Promise<TaskId[]> {
  for (let index = 0; index < count; index += 1) h.reminders.add({ listId: 'L-courses', title: `Rappel ${String(index)}` });
  await h.pass();
  const tasks = await h.tasks();
  expect(tasks).toHaveLength(count);
  return tasks.map((task) => task.id);
}

describe('suppressions vers Rappels sous garde (audit M2)', () => {
  it('au-delà de max(10, 25 %) : rien n’est envoyé, la retenue est inscrite avec le nombre, les rappels restent', async () => {
    const ids = await importMany(14);
    await uc().remove(ids.slice(0, 11));
    const report = await h.pass();
    expect(report).toMatchObject({ status: 'done', sent: 0 });
    expect(h.reminders.writes).toEqual([]);
    expect(h.reminders.all()).toHaveLength(14);
    expect(status().held).toEqual([{ listId: 'L-courses', count: 11, at: expect.any(String), send: true }]);
    expect(report.pending).toBe(11);
    // Un passage de plus ne change rien : toujours retenu, une seule entrée.
    await h.pass();
    expect(status().held).toHaveLength(1);
    expect(h.reminders.writes).toEqual([]);
  });

  it('jusqu’au seuil : les suppressions partent normalement', async () => {
    const ids = await importMany(14);
    await uc().remove(ids.slice(0, 10));
    expect(await h.pass()).toMatchObject({ sent: 10 });
    expect(status().held).toEqual([]);
    expect(h.reminders.all()).toHaveLength(4);
  });

  it('confirmation « Supprimer dans Rappels » : les rappels sont supprimés, la retenue disparaît', async () => {
    const ids = await importMany(14);
    await uc().remove(ids.slice(0, 11));
    await h.pass();
    h.db.clock.advance(1_000);
    expect(await resolveHeldSend(h.container, 'L-courses', 'delete')).toMatchObject({ status: 'done', sent: 11 });
    expect(h.reminders.all()).toHaveLength(3);
    expect(status().held).toEqual([]);
    expect(await h.container.data.repos.appleLinks.listAll()).toHaveLength(3);
  });

  it('confirmation « Garder les rappels » : les rappels restent, les tâches supprimées sont détachées ; la liste étant suivie, les rappels conservés sont réimportés, et rien n’est écrit dans Rappels', async () => {
    const ids = await importMany(14);
    await uc().remove(ids.slice(0, 11));
    await h.pass();
    expect(await resolveHeldSend(h.container, 'L-courses', 'keep')).toMatchObject({ status: 'done', sent: 0 });
    expect(h.reminders.all()).toHaveLength(14);
    expect(status().held).toEqual([]);
    expect(await h.pass()).toMatchObject({ sent: 0, created: 11 });
    expect(h.reminders.all()).toHaveLength(14);
    expect(h.reminders.writes).toEqual([]);
  });

  it('tâche absente de la base sans suppression connue : jamais de suppression dans Rappels', async () => {
    const ids = await importMany(2);
    const first = ids[0];
    if (first === undefined) throw new Error('aucune tâche');
    await h.db.driver.execute('DELETE FROM task WHERE id = ?', [first]);
    expect(await h.pass()).toMatchObject({ sent: 0 });
    expect(h.reminders.all()).toHaveLength(2);
    expect(h.reminders.writes).toEqual([]);
  });
});
