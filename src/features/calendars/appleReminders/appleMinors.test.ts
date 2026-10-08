import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IsoDateTime, LocalDate } from '../../../domain/types';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { appleRemindersState } from './appleRemindersState';
import { runRemindersPass } from './remindersPass';
import { createSender } from './remindersWrites';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/** Points mineurs de la revue du lot K : reprise d'une création interrompue, envois bornés par l'échéance du passage, écritures dues comptées. */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('30');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

const uc = () => createTaskUseCases(h.container);
const D = (value: string): LocalDate => value as LocalDate;
const at = (): IsoDateTime => new Date(h.db.clock.nowMs()).toISOString() as IsoDateTime;

async function interrupted(patch: { completed?: boolean } = {}) {
  await appleRemindersState(h.container).setCreate({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L-courses' }] });
  const created = await uc().create({ title: 'Interrompue', spaceId: PERSO, date: D('2026-10-11') });
  if (!created.ok) throw new Error('création refusée');
  if (patch.completed === true) await uc().complete(created.value.id);
  await h.container.data.repos.appleLinks.upsert({ taskId: created.value.id, reminderId: null, externalRef: null, listId: 'L-courses', state: 'creating', synced: null, appleModified: null, startedAt: at() });
  h.db.clock.advance(1_000);
  return created.value;
}

describe('reprise d’une création interrompue (revue, mineur)', () => {
  it('le rappel créé TERMINÉ avant l’arrêt est adopté (la lecture des listes ne rend que les non terminés)', async () => {
    const task = await interrupted({ completed: true });
    h.reminders.add({ id: 'ORPH', listId: 'L-courses', title: 'Interrompue', due: { date: D('2026-10-11'), time: null }, completed: true });
    h.db.clock.advance(6_000);
    await h.pass('push');
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toEqual([]);
    expect(await h.task(task.id)).toMatchObject({ externalId: 'ORPH', source: 'apple_reminders' });
  });

  it('un titre changé entre-temps (dans Rappels ou ici) n’empêche pas l’adoption : un seul candidat de même échéance créé après le début', async () => {
    const task = await interrupted();
    h.reminders.add({ id: 'ORPH', listId: 'L-courses', title: 'Interrompue (modifiée dans Rappels)', due: { date: D('2026-10-11'), time: null } });
    h.reminders.add({ id: 'AUTRE', listId: 'L-courses', title: 'Autre', due: { date: D('2026-10-20'), time: null } });
    h.db.clock.advance(6_000);
    await h.pass('push');
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toEqual([]);
    expect(await h.task(task.id)).toMatchObject({ externalId: 'ORPH' });
  });

  it('plusieurs candidats sans titre identique : aucun n’est deviné, la tâche est créée une fois', async () => {
    await interrupted();
    h.reminders.add({ id: 'A', listId: 'L-courses', title: 'Quelque chose', due: { date: D('2026-10-11'), time: null } });
    h.reminders.add({ id: 'B', listId: 'L-courses', title: 'Autre chose', due: { date: D('2026-10-11'), time: null } });
    h.db.clock.advance(6_000);
    await h.pass('push');
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toHaveLength(1);
  });
});

describe('envois bornés par l’échéance du passage (revue, mineur)', () => {
  it('l’échéance atteinte pendant l’envoi : aucune écriture suivante n’est entamée, elle reste due et comptée ; envoyée au passage suivant', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    h.reminders.add({ listId: 'L-courses', title: 'Lait' });
    await h.pass();
    h.db.clock.advance(60_000);
    for (const title of ['Pain', 'Lait']) await h.container.data.repos.tasks.update((await h.taskByTitle(title)).id, { title: `${title} bio` });
    h.db.clock.advance(6_000);
    const original = h.reminders.upsert.bind(h.reminders);
    h.reminders.upsert = (async (input) => {
      const written = await original(input);
      h.db.clock.advance(10_000);
      return written;
    }) as typeof h.reminders.upsert;
    const report = await runRemindersPass(h.container, 'full', { send: createSender(h.container), deadlineAt: h.db.clock.nowMs() + 5_000 });
    expect(report).toMatchObject({ sent: 1, pending: 1 });
    expect(h.reminders.writes).toHaveLength(1);
    h.reminders.upsert = original;
    expect(await h.pass('push')).toMatchObject({ sent: 1, pending: 0 });
  });
});

describe('écriture due non évaluée comptée (observation QA)', () => {
  it('une tâche modifiée pendant la lecture n’est pas appliquée : son écriture due est comptée, pas perdue de vue', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Café' });
    await h.pass();
    const task = await h.taskByTitle('Café');
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Café noir' });
    h.db.clock.advance(6_000);
    // Modification concurrente pendant le passage (après la lecture du suivi, avant l'écriture de la tâche).
    const original = h.reminders.fetch.bind(h.reminders);
    let raced = false;
    h.reminders.fetch = (async (input) => {
      const result = await original(input);
      if (!raced) {
        raced = true;
        await h.container.data.repos.tasks.update(task.id, { title: 'Café au lait' });
      }
      return result;
    }) as typeof h.reminders.fetch;
    const report = await h.pass('push');
    expect(report.pending).toBeGreaterThanOrEqual(1);
  });
});

describe('échec déterministe : jamais de boucle (revue)', () => {
  it('Rappels refuse la valeur (invalid-input) : la tâche est détachée et gardée avec un message, aucun échec ne revient à chaque passage', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Pain' });
    await h.pass();
    const task = await h.taskByTitle('Pain');
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Pain complet' });
    h.reminders.failNext('upsert', 'invalid-input');
    expect(await h.pass('push')).toMatchObject({ pending: 0 });
    expect(await h.task(task.id)).toMatchObject({ source: 'local', externalId: null });
    expect(await h.container.data.repos.appleLinks.get(task.id)).toBeNull();
    expect(await h.pass('push')).toMatchObject({ sent: 0, pending: 0 });
  });
});
