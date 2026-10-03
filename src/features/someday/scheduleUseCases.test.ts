import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { LocalDate, LocalTime } from '../../domain/types';
import { undoMessage } from '../app/undo';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { seedTask } from '../today/testKit';
import { seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

describe('scheduleSomeday : cas d’usage (SD-02)', () => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday('411');
  });
  afterEach(() => teardownSomeday(h));

  const get = async (id: string) => h.container.data.repos.tasks.getById(id as never);
  const somedayTitles = async () => (await h.container.data.repos.tasks.listSomeday('all')).map((task) => task.title);
  // Aujourd'hui dans les tests : ven. 2 oct. 2026.
  const tomorrow = '2026-10-03' as LocalDate;

  it('« Aujourd’hui » : someday levé, date du jour, sans heure ; la tâche quitte la liste (critère 2)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    const [planned] = await createTaskUseCases(h.container).scheduleSomeday([task.id], 'today');
    expect(planned).toMatchObject({ someday: false, date: h.today, time: null });
    expect(await somedayTitles()).toHaveLength(0);
    expect((await h.container.data.repos.tasks.listForDay(h.today, 'all')).map((t) => t.title)).toEqual(['Renouveler le passeport']);
  });

  it('« Demain » : date de demain (critère 3), message « planifiée pour demain » (critère 5)', async () => {
    const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
    await createTaskUseCases(h.container).scheduleSomeday([task.id], 'tomorrow');
    expect(await get(task.id)).toMatchObject({ someday: false, date: tomorrow, time: null });
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Renouveler le passeport » planifiée pour demain');
  });

  it('une date et une heure choisies : message avec la date ; espace, note, icône conservés (critères 4 et 6)', async () => {
    const created = await createTaskUseCases(h.container).create({ title: 'Dîner', spaceId: SPACE_PRO_ID, someday: true, date: null, note: 'Chez Karim' });
    if (!created.ok) throw new Error('création');
    await createTaskUseCases(h.container).scheduleSomeday([created.value.id], { date: '2026-10-09' as LocalDate, time: '19:30' as LocalTime });
    expect(await get(created.value.id)).toMatchObject({ date: '2026-10-09', time: '19:30', note: 'Chez Karim', spaceId: SPACE_PRO_ID, someday: false });
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Dîner » planifiée au ven. 9 oct.');
  });

  it('prend la fin de l’ordre du jour d’arrivée', async () => {
    const existing = await seedTask(h, { title: 'Déjà là' });
    const task = await seedSomeday(h, { title: 'Arrivée' });
    await createTaskUseCases(h.container).scheduleSomeday([task.id], 'today');
    const planned = await get(task.id);
    expect(planned?.sortOrder).toBeGreaterThan(existing.sortOrder);
  });

  it('Annuler remet la tâche dans « Un jour », à sa position (critère 5)', async () => {
    await seedSomeday(h, { title: 'Première' });
    const second = await seedSomeday(h, { title: 'Deuxième' });
    await seedSomeday(h, { title: 'Troisième' });
    const before = await somedayTitles();
    expect(before).toEqual(['Troisième', 'Deuxième', 'Première']);
    await createTaskUseCases(h.container).scheduleSomeday([second.id], 'tomorrow');
    expect(await somedayTitles()).toEqual(['Troisième', 'Première']);
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect(await somedayTitles()).toEqual(before);
    expect(await get(second.id)).toMatchObject({ someday: true, date: null, time: null });
  });

  it('un lot : un seul message « N tâches planifiées », une seule annulation', async () => {
    const a = await seedSomeday(h, { title: 'A' });
    const b = await seedSomeday(h, { title: 'B' });
    await createTaskUseCases(h.container).scheduleSomeday([a.id, b.id], 'today');
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('2 tâches planifiées');
    await h.container.undo.undoLast();
    expect(await somedayTitles()).toHaveLength(2);
  });

  it('annuler est refusé si la tâche a changé depuis (hlc) : « stale », rien n’est écrit', async () => {
    const task = await seedSomeday(h, { title: 'A' });
    const uc = createTaskUseCases(h.container);
    await uc.scheduleSomeday([task.id], 'today');
    await uc.update(task.id, { title: 'A modifiée' });
    expect((await h.container.undo.undoLast()).status).toBe('stale');
    expect(await get(task.id)).toMatchObject({ someday: false, date: h.today });
  });

  it('ignore une tâche qui n’est pas dans « Un jour » ; refuse une date invalide sans rien écrire', async () => {
    const dated = await seedTask(h, { title: 'Datée' });
    const uc = createTaskUseCases(h.container);
    expect(await uc.scheduleSomeday([dated.id], 'tomorrow')).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    const someday = await seedSomeday(h, { title: 'A' });
    await expect(uc.scheduleSomeday([someday.id], { date: '2026-02-31' as LocalDate })).rejects.toThrow(RangeError);
    expect(await get(someday.id)).toMatchObject({ someday: true });
  });

  it('les rappels conservés redeviennent actifs avec fire_at recalculé quand la tâche retrouve date et heure (QB-10)', async () => {
    const uc = createTaskUseCases(h.container);
    const created = await uc.create({ title: 'Appeler le notaire', spaceId: SPACE_PRO_ID, date: h.today, time: '10:00' as LocalTime, reminderOffsets: [0, 30] });
    if (!created.ok) throw new Error('création');
    const target = { type: 'task', id: created.value.id } as const;
    await uc.moveToSomeday([created.value.id]);
    // Conservés en base, inactifs : aucun n'est dû (le domaine ignore les rappels d'une tâche sans heure).
    expect(await h.container.data.repos.reminders.listForTarget(target)).toHaveLength(2);
    await uc.scheduleSomeday([created.value.id], { date: '2026-10-09' as LocalDate, time: '10:00' as LocalTime });
    const reminders = await h.container.data.repos.reminders.listForTarget(target);
    expect(reminders.map((r) => r.fireAt)).toEqual(['2026-10-09T09:30', '2026-10-09T10:00']);
  });

  it('replanifiée sans heure, les rappels restent inactifs : fire_at inchangé', async () => {
    const uc = createTaskUseCases(h.container);
    const created = await uc.create({ title: 'Appeler le notaire', spaceId: SPACE_PRO_ID, date: h.today, time: '10:00' as LocalTime, reminderOffsets: [0] });
    if (!created.ok) throw new Error('création');
    const target = { type: 'task', id: created.value.id } as const;
    const [before] = await h.container.data.repos.reminders.listForTarget(target);
    await uc.moveToSomeday([created.value.id]);
    await uc.scheduleSomeday([created.value.id], 'tomorrow');
    const [after] = await h.container.data.repos.reminders.listForTarget(target);
    expect(after?.fireAt).toBe(before?.fireAt);
  });
});
