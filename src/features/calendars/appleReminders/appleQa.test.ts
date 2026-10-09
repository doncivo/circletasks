import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IsoDateTime, LocalDate } from '../../../domain/types';
import { useAppStatusStore } from '../../app/appStatus';
import { useNoticeStore } from '../../app/notice';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';
import { resolveHeldList } from './remindersPass';
import { PERSO, PRO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * Passe QA des lots K-05 à K-07 (ordre 5) : cas limites du passage de Rappels Apple que les tests de module ne fixent pas encore.
 * Un test par risque, nommé avec l'ID de la story ; magasin EventKit factice, aucune base réelle hors mémoire.
 */
const D = (value: string): LocalDate => value as LocalDate;

let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('60');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
  await h.showList({ id: 'L-travail', name: 'Travail', spaceId: PRO });
  useNoticeStore.getState().clear();
});
afterEach(() => h.close());

const uc = () => createTaskUseCases(h.container);
const status = () => appleRemindersStore.get(h.container).getState().status;

async function linked(title: string, listId = 'L-courses') {
  const reminder = h.reminders.add({ listId, title, due: { date: D('2026-10-09'), time: null } });
  await h.pass();
  return { reminder, task: await h.taskByTitle(title) };
}

function addMany(count: number, prefix: string, listId = 'L-courses'): void {
  for (let i = 0; i < count; i += 1) h.reminders.add({ id: `${prefix}-${String(i)}`, listId, title: `${prefix} ${String(i)}` });
}

function removeMany(count: number, prefix: string): void {
  for (let i = 0; i < count; i += 1) h.reminders.remove(`${prefix}-${String(i)}`);
}

describe('K-05 garde de suppression massive max(10, 25 %) au niveau du passage', () => {
  it('K-05 liste de 100 tâches liées : 25 absentes sont supprimées, 26 sont retenues', async () => {
    addMany(100, 'G');
    await h.pass();
    removeMany(25, 'G');
    expect(await h.pass()).toMatchObject({ deleted: 25 });
    expect(status().held).toEqual([]);
    // 75 restent liées ; 26 sur 75 dépasse 25 % : retenues. On repart d'une liste fraîche pour la borne exacte.
    await h.close();
    h = await setupRemindersHarness('61');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    addMany(100, 'H');
    await h.pass();
    removeMany(26, 'H');
    expect(await h.pass()).toMatchObject({ deleted: 0 });
    expect(await h.tasks()).toHaveLength(100);
    expect(status().held).toEqual([{ listId: 'L-courses', count: 26, at: expect.any(String) }]);
  });

  it('K-05 petite liste : tout supprimer de 3 tâches liées passe sous le plancher de 10', async () => {
    addMany(3, 'P');
    await h.pass();
    removeMany(3, 'P');
    expect(await h.pass()).toMatchObject({ deleted: 3 });
    expect(status().held).toEqual([]);
  });

  it('K-05 la garde est par liste : une liste retenue n’empêche pas la suppression normale dans l’autre', async () => {
    addMany(20, 'C');
    addMany(20, 'T', 'L-travail');
    await h.pass();
    removeMany(15, 'C');
    removeMany(2, 'T');
    expect(await h.pass()).toMatchObject({ deleted: 2 });
    expect(status().held).toEqual([{ listId: 'L-courses', count: 15, at: expect.any(String) }]);
    expect((await h.tasks()).filter((task) => task.deletedAt === null)).toHaveLength(38);
  });

  it('K-05 « Supprimer » : met à la corbeille ET détache les tâches absentes, efface la retenue, message', async () => {
    addMany(20, 'D');
    await h.pass();
    removeMany(15, 'D');
    await h.pass();
    expect(status().held).toHaveLength(1);
    expect(await resolveHeldList(h.container, 'L-courses', 'delete')).toMatchObject({ deleted: 15 });
    expect(status().held).toEqual([]);
    expect(status().notices).toContainEqual(expect.objectContaining({ kind: 'deleted', count: 15 }));
    const task = await h.taskByTitle('D 0');
    expect(task.deletedAt).not.toBeNull();
    expect(task).toMatchObject({ source: 'local', externalId: null });
    expect(await h.container.data.repos.appleLinks.get(task.id)).toBeNull();
    expect((await h.taskByTitle('D 19')).deletedAt).toBeNull();
    // Rien ne revient ni ne se supprime de nouveau.
    expect(await h.pass()).toMatchObject({ created: 0, deleted: 0 });
  });

  it('K-05 « Garder et détacher » : aucune suppression, tâches ordinaires, la retenue disparaît et ne revient pas', async () => {
    addMany(20, 'K');
    await h.pass();
    removeMany(15, 'K');
    await h.pass();
    expect(await resolveHeldList(h.container, 'L-courses', 'keep')).toMatchObject({ deleted: 0, detached: 15 });
    expect(status().held).toEqual([]);
    const kept = await h.taskByTitle('K 0');
    expect(kept).toMatchObject({ source: 'local', externalId: null, deletedAt: null });
    expect(await h.pass()).toMatchObject({ deleted: 0, created: 0 });
    expect(status().held).toEqual([]);
    expect(h.reminders.writes).toEqual([]);
  });

  it('K-05 « Supprimer » ne supprime rien sur un doute : accès retiré, rappel revenu entre-temps, liste disparue', async () => {
    addMany(20, 'Q');
    await h.pass();
    removeMany(15, 'Q');
    await h.pass();
    h.reminders.setAccess('denied');
    expect(await resolveHeldList(h.container, 'L-courses', 'delete')).toMatchObject({ status: 'failed', code: 'access-denied' });
    expect(status().held).toHaveLength(1);
    expect((await h.taskByTitle('Q 0')).deletedAt).toBeNull();
    h.reminders.setAccess('full');
    // Un rappel revenu dans Rappels n'est pas supprimé.
    h.reminders.add({ id: 'Q-0', listId: 'L-courses', title: 'Q 0' });
    expect(await resolveHeldList(h.container, 'L-courses', 'delete')).toMatchObject({ deleted: 14 });
    const back = await h.taskByTitle('Q 0');
    expect(back).toMatchObject({ deletedAt: null, source: 'apple_reminders' });
  });

  it('K-05 « Supprimer » avec la liste disparue de Rappels : rien n’est supprimé et la retenue est gardée', async () => {
    addMany(20, 'X');
    await h.pass();
    removeMany(15, 'X');
    await h.pass();
    h.reminders.removeList('L-courses');
    expect(await resolveHeldList(h.container, 'L-courses', 'delete')).toMatchObject({ deleted: 0 });
    expect(status().held).toHaveLength(1);
    expect((await h.taskByTitle('X 0')).deletedAt).toBeNull();
  });
});

describe('K-05 plafond de 500 rappels', () => {
  it('K-05 exactement 500 : aucun message de plafond ; 501 : « 500 sur 501 »', async () => {
    addMany(500, 'E');
    expect(await h.pass()).toMatchObject({ created: 500 });
    expect(status().caps).toEqual([]);
    h.reminders.add({ id: 'E-extra', listId: 'L-courses', title: 'Le 501e' });
    expect(await h.pass()).toMatchObject({ created: 0 });
    expect(status().caps).toEqual([{ listId: 'L-courses', total: 501, imported: 500 }]);
    expect(await h.tasks()).toHaveLength(500);
  });

  it('K-05 le plafond est par liste visible ; un rappel suivi terminé au-delà du plafond est mis à jour', async () => {
    addMany(520, 'A');
    addMany(10, 'B', 'L-travail');
    expect(await h.pass()).toMatchObject({ created: 510 });
    expect(status().caps).toEqual([{ listId: 'L-courses', total: 520, imported: 500 }]);
    const followed = await h.taskByTitle('A 499');
    h.db.clock.advance(60_000);
    h.reminders.edit(followed.externalId as string, { completed: true });
    expect(await h.pass()).toMatchObject({ updated: 1 });
    expect((await h.task(followed.id))?.status).toBe('done');
    // Les 20 non importés ne sont jamais supprimés ni créés par erreur.
    expect(await h.pass()).toMatchObject({ created: 0, deleted: 0 });
  });
});

describe('K-06 modification pendant un passage et suppression croisée', () => {
  it('K-06 une tâche modifiée pendant l’envoi n’est pas écrasée par l’élément relu : la dernière valeur repart au passage suivant', async () => {
    const { reminder, task } = await linked('Plan');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Plan B' });
    const original = h.reminders.upsert.bind(h.reminders);
    let hijacked = false;
    h.reminders.upsert = async (input) => {
      const out = await original(input);
      if (!hijacked) {
        hijacked = true;
        h.db.clock.advance(1_000);
        await uc().update(task.id, { title: 'Plan C' });
      }
      return out;
    };
    await h.pass('push');
    h.reminders.upsert = original;
    expect((await h.task(task.id))?.title).toBe('Plan C');
    h.db.clock.advance(60_000);
    expect(await h.pass('full')).toMatchObject({ sent: 1, pending: 0 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Plan C');
    expect((await h.task(task.id))?.title).toBe('Plan C');
    expect(await h.conflicts()).toEqual([]);
    expect(await h.pass('full')).toMatchObject({ sent: 0, updated: 0, pending: 0 });
  });

  it('K-05 supprimé dans Rappels puis modifié dans CircleTasks avant le passage (passage complet) : jamais de perte sans trace', async () => {
    const { reminder, task } = await linked('Fragile');
    h.reminders.add({ listId: 'L-courses', title: 'Autre' });
    h.reminders.remove(reminder.id);
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Fragile modifiée' });
    await h.pass('full');
    const after = await h.task(task.id);
    // La suppression gagne mais la tâche reste restaurable et la perte est au journal.
    expect(after?.deletedAt).not.toBeNull();
    expect(after).toMatchObject({ source: 'local', externalId: null, title: 'Fragile modifiée' });
    expect((await h.conflicts()).map((row) => row.field)).toEqual(['deleted_at']);
    expect(h.reminders.writes).toEqual([]);
  });

  it('K-05 supprimé dans Rappels puis modifié dans CircleTasks (passage push) : rien n’est recréé ni supprimé en silence', async () => {
    const { reminder, task } = await linked('Orpheline');
    h.reminders.remove(reminder.id);
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Orpheline modifiée' });
    // Le passage push ne lit pas les listes : il ne recrée rien et ne supprime rien ; la tâche reste intacte jusqu'au passage complet.
    expect(await h.pass('push')).toMatchObject({ status: 'done', created: 0, deleted: 0, sent: 0 });
    expect(await h.task(task.id)).toMatchObject({ title: 'Orpheline modifiée', deletedAt: null, source: 'apple_reminders' });
    expect(h.reminders.writes).toEqual([]);
    // Le passage complet (déclenché par `changed`) tranche : la suppression gagne, la perte est au journal, la tâche est restaurable.
    expect(await h.pass('full')).toMatchObject({ deleted: 1, created: 0 });
    expect((await h.conflicts()).map((row) => row.field)).toEqual(['deleted_at']);
    expect(status().notices).toContainEqual(expect.objectContaining({ kind: 'deleted' }));
    expect(h.reminders.all().filter((entry) => entry.title.startsWith('Orpheline'))).toEqual([]);
  });

  it('K-05 liste supprimée dans Rappels avec une modification locale due : la tâche reste liée et intacte, la modification reste due et visible', async () => {
    const { task } = await linked('Dans la liste');
    h.reminders.removeList('L-courses');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Dans la liste v2' });
    const report = await h.pass('full');
    expect(report.deleted).toBe(0);
    expect(await h.task(task.id)).toMatchObject({ deletedAt: null, source: 'apple_reminders', title: 'Dans la liste v2' });
    expect(status().missingLists).toEqual(['L-courses']);
    // La liste revient : la modification due part, sans doublon.
    h.reminders.addList({ id: 'L-courses', name: 'Courses', writable: true });
    h.db.clock.advance(60_000);
    await h.pass('full');
    expect(h.reminders.all().filter((entry) => entry.title.startsWith('Dans la liste'))).toHaveLength(0);
  });

  it('K-06 accès « restricted » entre deux passages avec une écriture due : aucune suppression, état persistant, rien perdu au rétablissement', async () => {
    const { reminder, task } = await linked('Restreinte');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Restreinte v2' });
    h.reminders.setAccess('restricted');
    expect(await h.pass('full')).toMatchObject({ status: 'failed', deleted: 0 });
    expect((await h.task(task.id))?.deletedAt).toBeNull();
    expect(useAppStatusStore.getState().sources.appleRemindersTrouble).toBeDefined();
    h.reminders.setAccess('full');
    h.db.clock.advance(60_000);
    expect(await h.pass('full')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Restreinte v2');
    expect(useAppStatusStore.getState().sources.appleRemindersTrouble).toBeUndefined();
  });
});

describe('K-06 création en deux temps interrompue', () => {
  async function enable(): Promise<void> {
    await appleRemindersState(h.container).setCreate({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L-courses' }] });
  }

  it('K-06 arrêt après le lien « en cours » et avant l’appel : aucun candidat, une seule création au passage suivant', async () => {
    await enable();
    const created = await uc().create({ title: 'Jamais partie', spaceId: PERSO, date: D('2026-10-11') });
    if (!created.ok) throw new Error('création refusée');
    await h.container.data.repos.appleLinks.upsert({
      taskId: created.value.id,
      reminderId: null,
      externalRef: null,
      listId: 'L-courses',
      state: 'creating',
      synced: null,
      appleModified: null,
      startedAt: new Date(h.db.clock.nowMs()).toISOString() as IsoDateTime,
    });
    h.db.clock.advance(1_000);
    await h.pass('push');
    await h.pass('push');
    await h.pass('full');
    expect(h.reminders.all().filter((entry) => entry.title === 'Jamais partie')).toHaveLength(1);
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toHaveLength(1);
    expect(await h.task(created.value.id)).toMatchObject({ source: 'apple_reminders' });
    expect((await h.task(created.value.id))?.externalId).not.toBeNull();
    expect((await h.tasks()).filter((task) => task.title === 'Jamais partie')).toHaveLength(1);
  });

  it('K-06 un rappel de même titre créé AVANT le début de la création n’est jamais adopté', async () => {
    await enable();
    h.reminders.add({ id: 'ANCIEN', listId: 'L-courses', title: 'Même titre', due: { date: D('2026-10-11'), time: null } });
    h.db.clock.advance(5_000);
    const created = await uc().create({ title: 'Même titre', spaceId: PERSO, date: D('2026-10-11') });
    if (!created.ok) throw new Error('création refusée');
    await h.container.data.repos.appleLinks.upsert({
      taskId: created.value.id,
      reminderId: null,
      externalRef: null,
      listId: 'L-courses',
      state: 'creating',
      synced: null,
      appleModified: null,
      startedAt: new Date(h.db.clock.nowMs()).toISOString() as IsoDateTime,
    });
    h.db.clock.advance(1_000);
    await h.pass('push');
    const task = await h.task(created.value.id);
    expect(task?.externalId).not.toBeNull();
    expect(task?.externalId).not.toBe('ANCIEN');
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toHaveLength(1);
  });
});
