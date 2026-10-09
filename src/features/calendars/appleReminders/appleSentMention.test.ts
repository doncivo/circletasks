import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { awaitsIphonePass, parseLastPassAt } from '../../../domain/appleReminders';
import type { TaskId } from '../../../domain/types';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * Revue 2 : la mention « Sera envoyée vers Rappels au prochain passage de l'iPhone » ne doit jamais s'allumer pour une valeur que Rappels
 * lui-même vient d'apporter : `lastPassAt` est écrit APRÈS les écritures du passage (jamais avant), et sans attendre les 15 min quand
 * le passage a modifié des tâches.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('24');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

async function mention(taskId: TaskId): Promise<boolean> {
  const clocks = (await h.container.data.repos.appleLinks.fieldClocks([taskId])).get(taskId);
  if (!clocks) throw new Error('horloges absentes');
  const ms = [clocks.title, clocks.date, clocks.time, clocks.status].map((hlc) => Number(hlc.slice(0, 15)));
  return awaitsIphonePass(ms, parseLastPassAt(await h.container.data.repos.settings.get('appleReminders.lastPassAt')));
}

describe('mention « Sera envoyée » sur le PC (revue 2)', () => {
  it('import puis modification venue de Rappels dans les 15 min : aucune mention (valeur apportée par Rappels, pas par le PC)', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    await h.pass();
    const task = await h.taskByTitle('Pain');
    expect(await mention(task.id)).toBe(false);
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Pain complet' });
    expect(await h.pass()).toMatchObject({ updated: 1, sent: 0 });
    expect(await mention(task.id)).toBe(false);
  });

  it('une modification faite ici et envoyée n’allume pas la mention ; une modification faite ici et pas encore envoyée l’allume', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Café' });
    await h.pass();
    const task = await h.taskByTitle('Café');
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Café noir' });
    expect(await mention(task.id)).toBe(true);
    expect(await h.pass()).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Café noir');
    expect(await mention(task.id)).toBe(false);
  });
});
