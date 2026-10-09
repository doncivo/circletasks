import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../../../domain/types';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { appleRemindersState } from './appleRemindersState';
import { PERSO, PRO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * Fenêtre d'annulation de 5 s (T-13) : aucune écriture vers Rappels, quelle que soit la sorte de passage (`full` ou `push`), ne part
 * pour une tâche dont la dernière écriture locale (modification, création, suppression) a moins de 5 s. Une suppression dans Rappels
 * est irréversible : « Annuler » doit rester possible.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('21');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
  await h.showList({ id: 'L-travail', name: 'Travail', spaceId: PRO });
});
afterEach(() => h.close());

const uc = () => createTaskUseCases(h.container);

async function linked(title: string) {
  const reminder = h.reminders.add({ listId: 'L-courses', title });
  await h.pass();
  h.db.clock.advance(60_000);
  return { reminder, task: await h.taskByTitle(title) };
}

describe('fenêtre d’annulation de 5 s (revue 1)', () => {
  it('passage full pendant la fenêtre : un statut terminé n’est pas envoyé, reste dû et réclame un nouveau passage ; envoyé une fois la fenêtre écoulée', async () => {
    const { reminder, task } = await linked('Pain');
    await uc().complete(task.id);
    h.db.clock.advance(2_000);
    const held = await h.pass('full', { settle: false });
    expect(held).toMatchObject({ sent: 0, pending: 1 });
    expect(held.holdMs).toBeGreaterThan(0);
    expect(held.holdMs).toBeLessThanOrEqual(3_000);
    expect(h.reminders.writes).toEqual([]);
    expect(h.reminders.get(reminder.id)?.completed).toBe(false);
    h.db.clock.advance(held.holdMs ?? 0);
    expect(await h.pass('push', { settle: false })).toMatchObject({ sent: 1, pending: 0 });
    expect(h.reminders.get(reminder.id)?.completed).toBe(true);
  });

  it('bornes : 4 999 ms retenu, 5 000 ms envoyé', async () => {
    const { reminder, task } = await linked('Café');
    await uc().update(task.id, { title: 'Café noir' });
    h.db.clock.advance(4_999);
    expect(await h.pass('push', { settle: false })).toMatchObject({ sent: 0, pending: 1 });
    h.db.clock.advance(1);
    expect(await h.pass('push', { settle: false })).toMatchObject({ sent: 1, pending: 0 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Café noir');
  });

  it('suppression pendant la fenêtre : le rappel n’est pas supprimé ; « Annuler » le garde ; sans annulation il est supprimé une fois la fenêtre écoulée', async () => {
    const { reminder, task } = await linked('À jeter');
    await uc().remove([task.id]);
    h.db.clock.advance(1_000);
    const held = await h.pass('full', { settle: false });
    expect(held).toMatchObject({ sent: 0 });
    expect(held.holdMs).toBeGreaterThan(0);
    expect(h.reminders.get(reminder.id)).toBeDefined();
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    h.db.clock.advance(60_000);
    expect(await h.pass('full', { settle: false })).toMatchObject({ sent: 0, deleted: 0 });
    expect(h.reminders.get(reminder.id)).toBeDefined();
    expect((await h.task(task.id))?.deletedAt).toBeNull();
    // Sans annulation.
    await uc().remove([task.id]);
    h.db.clock.advance(5_000);
    expect(await h.pass('full', { settle: false })).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)).toBeUndefined();
  });

  it('création pendant la fenêtre : aucun rappel n’est créé ; une tâche supprimée dans la fenêtre ne crée jamais rien', async () => {
    await appleRemindersState(h.container).setCreate({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L-courses' }] });
    const created = await uc().create({ title: 'Acheter du riz', spaceId: PERSO, date: '2026-10-10' as LocalDate });
    if (!created.ok) throw new Error('création refusée');
    h.db.clock.advance(1_000);
    const held = await h.pass('full', { settle: false });
    expect(held).toMatchObject({ sent: 0 });
    expect(held.holdMs).toBeGreaterThan(0);
    expect(h.reminders.writes).toEqual([]);
    h.db.clock.advance(4_000);
    expect(await h.pass('push', { settle: false })).toMatchObject({ sent: 1 });
    expect(h.reminders.writes.map((write) => write.kind)).toEqual(['create']);
  });

  it('rafale : trois modifications rapprochées, une seule écriture finale avec la dernière valeur, rien avant la fin de la fenêtre de la DERNIÈRE', async () => {
    const { reminder, task } = await linked('Rafale');
    await uc().update(task.id, { title: 'Rafale 1' });
    h.db.clock.advance(3_000);
    await uc().update(task.id, { title: 'Rafale 2' });
    h.db.clock.advance(3_000);
    await uc().update(task.id, { title: 'Rafale 3' });
    h.db.clock.advance(3_000);
    expect(await h.pass('push', { settle: false })).toMatchObject({ sent: 0, pending: 1 });
    expect(h.reminders.writes).toEqual([]);
    h.db.clock.advance(2_000);
    expect(await h.pass('push', { settle: false })).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Rafale 3');
    expect(h.reminders.writes).toHaveLength(1);
  });
});
