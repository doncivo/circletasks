import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildNextOccurrence } from '../../../domain/recurrenceNext';
import type { LocalDate, TaskId } from '../../../domain/types';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { runRemindersPass } from './remindersPass';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * K-05 critère 3 (ADR 0008 §10.2, « Copies ») : la duplication (T-12), les occurrences d'une série (T-09), la tâche depuis un événement
 * (K-04), l'import et la saisie rapide ne copient JAMAIS `source`, `external_id`, `apple_list_id` ni `apple_recurring` : la copie est
 * ordinaire. Un rappel Apple pour une seule tâche.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('12');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

const D = (value: string): LocalDate => value as LocalDate;
const ORDINARY = { source: 'local', externalId: null, appleListId: null, appleRecurring: false };

async function linkedTask() {
  h.reminders.add({ listId: 'L-courses', title: 'Série de courses', due: { date: D('2026-10-09'), time: null }, recurring: true });
  await runRemindersPass(h.container, 'full');
  const task = await h.taskByTitle('Série de courses');
  expect(task).toMatchObject({ source: 'apple_reminders', appleListId: 'L-courses', appleRecurring: true });
  expect(task.externalId).not.toBeNull();
  return task;
}

describe('les copies d’une tâche liée sont ordinaires (K-05 critère 3)', () => {
  it('duplication (T-12)', async () => {
    const task = await linkedTask();
    const copy = await createTaskUseCases(h.container).duplicate(task.id, D('2026-10-10'));
    expect(copy).toMatchObject(ORDINARY);
    expect(copy.id).not.toBe(task.id);
    expect(await h.container.data.repos.tasks.getById(copy.id)).toMatchObject(ORDINARY);
    // L'original garde son lien, un seul rappel pour une seule tâche.
    expect(await h.task(task.id)).toMatchObject({ source: 'apple_reminders', appleListId: 'L-courses' });
    expect((await h.tasks()).map((entry) => entry.id)).toEqual([task.id]);
  });

  it('occurrence suivante d’une série (T-09)', async () => {
    const task = await linkedTask();
    const next = buildNextOccurrence(task, { taskId: '91000000-0000-4000-8000-000000000001' as TaskId, date: D('2026-10-16'), seriesIndex: 1, newReminderId: () => '92000000-0000-4000-8000-000000000001' as never });
    expect(next.task).toMatchObject(ORDINARY);
  });

  it('tâche créée depuis un événement d’agenda (K-04) et saisie rapide', async () => {
    const fromEvent = await createTaskUseCases(h.container).create({ title: 'Depuis un événement', spaceId: PERSO, date: D('2026-10-09'), externalEventId: '93000000-0000-4000-8000-000000000001' as never });
    expect(fromEvent.ok && fromEvent.value).toMatchObject(ORDINARY);
    const quick = await createTaskUseCases(h.container).create({ title: 'Saisie rapide', spaceId: PERSO });
    expect(quick.ok && quick.value).toMatchObject(ORDINARY);
    expect(await h.tasks()).toHaveLength(0);
  });
});
