import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../../../domain/types';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * Report T-06 (« reportée ») : la date d'une tâche reportée automatiquement n'est pas une modification locale (comme dans `mergeLinked`) : elle ne
 * compte ni pour le suivi des écritures, ni pour « non modifiée localement » d'une liste décochée, ni pour le conflit d'une suppression venue de Rappels.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('29');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

async function carried(title: string) {
  const reminder = h.reminders.add({ listId: 'L-courses', title, due: { date: '2026-10-07' as LocalDate, time: null } });
  await h.pass();
  const task = await h.taskByTitle(title);
  await h.container.data.repos.tasks.carryOver([task.id], '2026-10-08' as LocalDate);
  h.db.clock.advance(60_000);
  return { reminder, task };
}

describe('report T-06 exclu de la comparaison locale (revue, mineur)', () => {
  it('liste décochée : la tâche reportée est « non modifiée » et va à la corbeille', async () => {
    const { task } = await carried('Reporté');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: false });
    expect(await h.pass()).toMatchObject({ deleted: 1, detached: 0 });
    expect((await h.task(task.id))?.deletedAt).not.toBeNull();
  });

  it('rappel supprimé dans Rappels : aucun conflit « changements locaux » pour une simple date reportée', async () => {
    const { reminder, task } = await carried('Reporté 2');
    h.reminders.remove(reminder.id);
    expect(await h.pass()).toMatchObject({ deleted: 1 });
    expect((await h.task(task.id))?.deletedAt).not.toBeNull();
    expect(await h.conflicts()).toEqual([]);
  });

  it('push : une tâche reportée seule n’est pas relue ni envoyée', async () => {
    await carried('Reporté 3');
    h.reminders.calls.length = 0;
    expect(await h.pass('push')).toMatchObject({ sent: 0, pending: 0 });
    expect(h.reminders.calls.filter((call) => call.name === 'fetch').every((call) => (call.args as { ids: unknown[] }).ids.length === 0)).toBe(true);
  });
});
