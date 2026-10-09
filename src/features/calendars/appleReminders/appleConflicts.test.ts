import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPLE_REMINDERS_DEVICE } from '../../../domain/appleReminders';
import { conflictDeviceName } from '../../sync/conflictText';
import { createSyncConflictUseCases } from '../../sync/syncConflictUseCases';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * K-06 critère 4 (ADR 0008 §10.5) : un conflit avec Rappels est écrit dans le journal des conflits (Y-04) avec l'élément, le champ et les deux
 * valeurs ; le côté Rappels porte l'appareil fictif `apple-reminders` (affiché « Rappels Apple ») et un hlc synthétique tiré de `modifiedAt` ;
 * « Restaurer » reste une écriture locale ordinaire, renvoyée vers Rappels au passage suivant.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('21');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

describe('journal des conflits avec Rappels', () => {
  it('la valeur perdue côté local est montrée avec « Rappels Apple » ; la restaurer l’envoie vers Rappels au passage suivant', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Bilan' });
    await h.pass();
    const task = await h.taskByTitle('Bilan');
    h.db.clock.advance(60_000);
    await createTaskUseCases(h.container).update(task.id, { title: 'Bilan local' });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Bilan Rappels' });
    await h.pass();
    expect((await h.task(task.id))?.title).toBe('Bilan Rappels');

    const uc = createSyncConflictUseCases(h.container);
    const page = await uc.list(1);
    expect(page.items).toHaveLength(1);
    const view = page.items[0];
    expect(view).toMatchObject({ rowId: task.id, title: 'Bilan Rappels', kept: { value: 'Bilan Rappels', device: APPLE_REMINDERS_DEVICE }, discarded: { value: 'Bilan local', device: h.db.deviceId } });
    expect(view?.table.name).toBe('task');
    expect(view?.column.name).toBe('title');
    expect(conflictDeviceName(APPLE_REMINDERS_DEVICE, [])).toBe('Rappels Apple');
    // Le hlc synthétique de Rappels donne l'instant de modification de l'élément.
    expect(view?.kept.at).toBe(reminder.modifiedAt === null ? undefined : h.reminders.get(reminder.id)?.modifiedAt);

    h.db.clock.advance(60_000);
    expect(await uc.restore(view?.id ?? 0)).toEqual({ status: 'restored' });
    expect((await h.task(task.id))?.title).toBe('Bilan local');
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Bilan local');
    expect(await h.pass('full')).toMatchObject({ sent: 0, updated: 0, pending: 0 });
  });

  it('quand le local gagne, c’est la valeur de Rappels qui est écartée, avec son hlc synthétique et son appareil fictif', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Courses' });
    await h.pass();
    const task = await h.taskByTitle('Courses');
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Courses Rappels' });
    h.db.clock.advance(60_000);
    await createTaskUseCases(h.container).update(task.id, { title: 'Courses local' });
    await h.pass();
    const rows = await h.db.driver.select<{ kept_device: string; discarded_device: string; discarded_hlc: string; kept_hlc: string }>('SELECT kept_device, discarded_device, kept_hlc, discarded_hlc FROM conflict_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kept_device: h.db.deviceId, discarded_device: APPLE_REMINDERS_DEVICE });
    expect(rows[0]?.discarded_hlc).toMatch(/^\d{15}-0000-00000000-0000-4000-8000-0000000000ae$/);
    expect(h.reminders.get(reminder.id)?.title).toBe('Courses local');
  });
});
