import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../../db/seed/defaultSpaces';
import { addDays } from '../../../domain/localDate';
import type { Task } from '../../../domain/model';
import { undoMessage } from '../../app/undo';
import { setupToday, teardownToday, type TodayHarness } from '../../today/testKit';
import type { ScanDraft } from './scanDrafts';
import { createScanTasks } from './scanUseCases';

/** Création en lot de la relecture (Q-04 critère 9) : une transaction, un message, un seul Ctrl+Z. */
describe('création des tâches de la relecture (Q-04)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('b104');
  });
  afterEach(() => teardownToday(h));

  const draft = (title: string, extra: Partial<ScanDraft> = {}): ScanDraft => ({ title, spaceId: SPACE_PERSO_ID, projectId: null, date: h.today, time: null, someday: false, ...extra });
  const everything = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
    ...(await h.container.data.repos.tasks.listSomeday('all')),
  ];

  it('quatre tâches créées avec leur espace, leur date et leur heure', async () => {
    const result = await createScanTasks(h.container, [
      draft('Appeler le plombier'),
      draft('Acheter des ampoules', { spaceId: SPACE_PRO_ID }),
      draft('Réserver le restaurant', { date: addDays(h.today, 3) }),
      draft('Dentiste', { date: addDays(h.today, 1), time: '14:00' as never }),
    ]);
    expect(result.ok && result.tasks).toHaveLength(4);
    const tasks = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(tasks.map((t) => [t.title, t.spaceId])).toEqual(
      expect.arrayContaining([
        ['Appeler le plombier', SPACE_PERSO_ID],
        ['Acheter des ampoules', SPACE_PRO_ID],
      ]),
    );
    const tomorrow = await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all');
    expect(tomorrow[0]).toMatchObject({ title: 'Dentiste', time: '14:00' });
    expect((await h.container.data.repos.tasks.listForDay(addDays(h.today, 3), 'all'))[0]?.title).toBe('Réserver le restaurant');
  });

  it('l’ordre des lignes est conservé dans la liste du jour', async () => {
    await createScanTasks(h.container, ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq'].map((title) => draft(title)));
    const tasks = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(tasks.map((t) => t.title)).toEqual(['Un', 'Deux', 'Trois', 'Quatre', 'Cinq']);
  });

  it('« Un jour » : tâche sans date ni heure', async () => {
    await createScanTasks(h.container, [draft('Un jour peut-être', { date: null, someday: true })]);
    const [task] = await h.container.data.repos.tasks.listSomeday('all');
    expect(task).toMatchObject({ title: 'Un jour peut-être', date: null, time: null, someday: true });
  });

  it('une heure fait créer les rappels par défaut', async () => {
    await createScanTasks(h.container, [draft('Réunion', { time: '09:30' as never })]);
    const [task] = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    const defaults = await h.container.data.repos.settings.get('reminders.defaultOffsets');
    expect((await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task?.id as never })).length).toBe(defaults.length);
  });

  it('un seul message « 4 tâches créées » et un seul Ctrl+Z retire toutes les tâches du lot', async () => {
    await createScanTasks(h.container, ['A tâche', 'B tâche', 'C tâche', 'D tâche'].map((title) => draft(title)));
    expect(h.container.undo.getSnapshot().size).toBe(1);
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('4 tâches créées');
    expect((await everything()).length).toBe(4);
    const outcome = await h.container.undo.undoLast();
    expect(outcome.status).toBe('undone');
    expect(await everything()).toEqual([]);
  });

  it('une seule tâche : « « Titre » ajoutée »', async () => {
    await createScanTasks(h.container, [draft('Payer la cantine')]);
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Payer la cantine » ajoutée');
  });

  it('transaction unique : si une tâche est refusée, aucune n’est écrite ni annonçable', async () => {
    const result = await createScanTasks(h.container, [draft('Première'), draft('x'.repeat(400)), draft('Troisième')]);
    expect(result).toEqual({ ok: false, error: 'failed' });
    expect(await everything()).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    expect(h.container.taskEntities.get('inconnu' as never)).toBeUndefined();
  });

  it('aucune ligne : rien à créer', async () => {
    expect(await createScanTasks(h.container, [])).toEqual({ ok: false, error: 'empty' });
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });

  it('annuler après modification d’une tâche du lot : seules les tâches intactes sont retirées', async () => {
    await createScanTasks(h.container, [draft('Intacte'), draft('Modifiée')]);
    const tasks = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    const edited = tasks.find((t) => t.title === 'Modifiée');
    await h.container.data.repos.tasks.update(edited?.id as never, { note: 'ma note' });
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect((await everything()).map((t) => t.title)).toEqual(['Modifiée']);
  });
});
