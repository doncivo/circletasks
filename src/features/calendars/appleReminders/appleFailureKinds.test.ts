import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/** Revue 5 : un passage `push` ne lit pas les listes ; sa réussite n'efface que les échecs d'ÉCRITURE, jamais un échec de lecture ou de passage. */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('28');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

const failure = () => appleRemindersStore.get(h.container).getState().status.failure;

describe('effacement des échecs par un passage push (revue 5)', () => {
  it('un échec de lecture survit à un push réussi, puis disparaît au premier passage complet réussi', async () => {
    await appleRemindersState(h.container).fail('store-unavailable');
    expect(await h.pass('push')).toMatchObject({ status: 'done' });
    expect(failure()).toMatchObject({ code: 'store-unavailable' });
    expect(failure()?.write).toBeUndefined();
    expect(await h.pass('full')).toMatchObject({ status: 'done' });
    expect(failure()).toBeNull();
  });

  it('un échec d’écriture est effacé par un push qui envoie tout', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    await h.pass('full');
    const task = await h.taskByTitle('Pain');
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Pain complet' });
    h.reminders.failNext('upsert', 'store-unavailable');
    await h.pass('push');
    expect(failure()).toMatchObject({ code: 'store-unavailable', write: true });
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(failure()).toBeNull();
  });
});
