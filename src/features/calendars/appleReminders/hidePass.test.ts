import { afterEach, describe, expect, it } from 'vitest';
import { createUnavailableReminders } from '../../../platform/reminders';
import { remindersHidePass } from './hidePass';
import { getRemindersRunner } from './remindersRunner';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

let h: RemindersHarness;
afterEach(() => h.close());

describe('passage de masquage attendu par la synchro (revue 3)', () => {
  it('lit les rappels (importe la tâche) avant de rendre la main ; une demande `hide` simultanée partage le même passage', async () => {
    h = await setupRemindersHarness('25');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    const listener = getRemindersRunner(h.container).request('hide');
    await remindersHidePass(h.container);
    await listener;
    expect((await h.tasks()).map((task) => task.title)).toEqual(['Pain']);
    // Un seul passage : une seule lecture des listes.
    expect(h.reminders.calls.filter((call) => call.name === 'fetch')).toHaveLength(1);
  });

  it('sans Rappels (PC) : rien à attendre, aucun appel de plugin', async () => {
    h = await setupRemindersHarness('26', { runtime: 'tauri', os: 'windows', reminders: createUnavailableReminders() });
    expect(h.container.reminders.available).toBe(false);
    await remindersHidePass(h.container);
    expect(h.reminders.calls).toEqual([]);
  });
});
