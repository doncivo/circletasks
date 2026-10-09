import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IsoDateTime, LocalDate, LocalTime } from '../../../domain/types';
import { useAppStatusStore } from '../../app/appStatus';
import { useNoticeStore } from '../../app/notice';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { appleRemindersStore } from './appleRemindersState';
import { PERSO, PRO, setupRemindersHarness, type RemindersHarness } from './testKit';

const D = (value: string): LocalDate => value as LocalDate;
const T = (value: string): LocalTime => value as LocalTime;

let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('20');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
  await h.showList({ id: 'L-travail', name: 'Travail', spaceId: PRO });
  useNoticeStore.getState().clear();
});
afterEach(() => h.close());

const uc = () => createTaskUseCases(h.container);
const status = () => appleRemindersStore.get(h.container).getState().status;
const pendingSetting = () => h.container.data.repos.settings.get('appleReminders.pending');

async function linked(title: string, extra: { due?: { date: LocalDate; time: LocalTime | null }; recurring?: boolean } = {}) {
  const reminder = h.reminders.add({ listId: 'L-courses', title, ...(extra.due ? { due: extra.due } : {}), ...(extra.recurring ? { recurring: true } : {}) });
  await h.pass();
  return { reminder, task: await h.taskByTitle(title) };
}

describe('terminer ici ou dans Rappels (K-06 critères 1 et 2)', () => {
  it('terminer une tâche liée termine le rappel avec la date d’achèvement au passage suivant ; la rouvrir le rouvre ; un second passage ne renvoie rien', async () => {
    const { reminder, task } = await linked('Pain');
    h.db.clock.advance(60_000);
    const done = await uc().complete(task.id);
    expect(h.reminders.writes).toEqual([]);
    expect(await h.pass('push')).toMatchObject({ status: 'done', sent: 1, pending: 0 });
    expect(h.reminders.get(reminder.id)).toMatchObject({ completed: true, completedAt: done.doneAt });
    expect(h.reminders.writes.map((write) => write.kind)).toEqual(['complete']);
    expect(await pendingSetting()).toBeNull();
    // Anti-boucle : un passage complet n'a rien à renvoyer ni à recevoir.
    expect(await h.pass('full')).toMatchObject({ sent: 0, updated: 0, created: 0, deleted: 0, pending: 0 });
    expect(await h.pass('push')).toMatchObject({ sent: 0, pending: 0 });
    expect(h.reminders.writes).toHaveLength(1);
    // Rouvrir.
    h.db.clock.advance(60_000);
    await uc().reopen(task.id);
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)).toMatchObject({ completed: false, completedAt: null });
  });

  it('« Annuler » avant le passage ne produit aucune écriture ; après le passage, annuler rouvre aussi le rappel', async () => {
    const { reminder, task } = await linked('Café');
    h.db.clock.advance(60_000);
    await uc().complete(task.id);
    expect((await h.container.undo.undoLast()).status).toBeDefined();
    expect(await h.pass('push')).toMatchObject({ sent: 0 });
    expect(h.reminders.writes).toEqual([]);
    expect(h.reminders.get(reminder.id)?.completed).toBe(false);
    // Terminée puis envoyée ; l'annulation (rouvrir) repart au passage suivant.
    h.db.clock.advance(60_000);
    await uc().complete(task.id);
    await h.pass('push');
    expect(h.reminders.get(reminder.id)?.completed).toBe(true);
    h.db.clock.advance(60_000);
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    await h.pass('push');
    expect(h.reminders.get(reminder.id)?.completed).toBe(false);
  });

  it('terminé dans Rappels : la tâche est terminée au passage suivant, sans écriture en retour', async () => {
    const { reminder, task } = await linked('Colis');
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { completed: true });
    expect(await h.pass('full')).toMatchObject({ updated: 1, sent: 0, pending: 0 });
    expect(await h.task(task.id)).toMatchObject({ status: 'done' });
    expect(h.reminders.writes).toEqual([]);
    expect(await h.pass('full')).toMatchObject({ updated: 0, sent: 0, pending: 0 });
  });
});

describe('titre, date et heure (K-06 critère 3)', () => {
  it('le rappel suit le titre, la date et l’heure ; une date retirée efface l’échéance ; les notes et les rappels CircleTasks ne partent jamais', async () => {
    const { reminder, task } = await linked('Dentiste', { due: { date: D('2026-10-09'), time: T('10:00') } });
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Dentiste (contrôle)', date: D('2026-10-14'), time: T('16:30'), note: 'Apporter la radio' });
    await uc().setReminders(task.id, [0, 15] as never);
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)).toMatchObject({ title: 'Dentiste (contrôle)', due: { date: '2026-10-14', time: '16:30' } });
    expect(JSON.stringify(h.reminders.all())).not.toContain('radio');
    h.db.clock.advance(60_000);
    await uc().moveToSomeday([task.id]);
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)?.due).toBeNull();
    // Retour d'une échéance depuis Rappels.
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { due: { date: D('2026-10-20'), time: null } });
    await h.pass('full');
    expect(await h.task(task.id)).toMatchObject({ date: '2026-10-20', time: null, someday: false });
  });

  it('une modification de la note seule n’écrit rien dans Rappels', async () => {
    const { task } = await linked('Note');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { note: 'seulement ici' });
    expect(await h.pass('push')).toMatchObject({ sent: 0, pending: 0 });
    expect(h.reminders.writes).toEqual([]);
  });

  it('conflit : titre modifié des deux côtés, le plus récent gagne et l’autre valeur va au journal ; champs différents : les deux sont gardés', async () => {
    const { reminder, task } = await linked('Bilan', { due: { date: D('2026-10-09'), time: null } });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Bilan Rappels' });
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Bilan local', date: D('2026-10-30') });
    expect(await h.pass('full')).toMatchObject({ sent: 1 });
    // Le local est plus récent : il gagne pour le titre et la date, Rappels est mis à jour, la valeur perdue est au journal.
    expect(h.reminders.get(reminder.id)).toMatchObject({ title: 'Bilan local', due: { date: '2026-10-30', time: null } });
    expect(await h.conflicts()).toEqual([{ field: 'title', kept_value: '"Bilan local"', discarded_value: '"Bilan Rappels"', kept_device: h.db.deviceId, discarded_device: 'apple-reminders' }]);
    expect(await h.pass('full')).toMatchObject({ sent: 0, updated: 0, pending: 0 });
  });
});

describe('création dans Rappels (K-06 critères 5 et 6, ADR 0008 §10.7)', () => {
  async function enable(spaceId: typeof PERSO, listId: string): Promise<void> {
    const { appleRemindersState } = await import('./appleRemindersState');
    await appleRemindersState(h.container).setCreate({ bySpace: [{ spaceId, enabled: true, listId }] });
  }

  it('désactivé par défaut : aucun appel d’écriture, la tâche est ordinaire ; les tâches existantes à l’activation ne sont jamais envoyées', async () => {
    const before = await uc().create({ title: 'Existante', spaceId: PERSO, date: D('2026-10-09') });
    expect(before.ok && before.value).toMatchObject({ source: 'local', appleListId: null });
    await h.pass('full');
    expect(h.reminders.writes).toEqual([]);
    await enable(PERSO, 'L-courses');
    await h.pass('full');
    expect(h.reminders.writes).toEqual([]);
    expect(h.reminders.calls.filter((call) => call.name === 'upsert')).toEqual([]);
  });

  it('activé pour Perso avec « Courses » : une tâche Perso crée un rappel (titre, date, heure) et reçoit son identifiant ; une tâche Pro ne crée rien', async () => {
    await enable(PERSO, 'L-courses');
    const created = await uc().create({ title: 'Acheter du riz', spaceId: PERSO, date: D('2026-10-10'), time: T('18:00') });
    const pro = await uc().create({ title: 'Réunion', spaceId: PRO, date: D('2026-10-10') });
    if (!created.ok || !pro.ok) throw new Error('création refusée');
    expect(created.value).toMatchObject({ source: 'apple_reminders', externalId: null, appleListId: 'L-courses' });
    expect(pro.value).toMatchObject({ source: 'local', appleListId: null });
    expect(await h.pass('push')).toMatchObject({ sent: 1, pending: 0 });
    const reminder = h.reminders.all().find((entry) => entry.title === 'Acheter du riz');
    expect(reminder).toMatchObject({ listId: 'L-courses', due: { date: '2026-10-10', time: '18:00' }, completed: false });
    expect(await h.task(created.value.id)).toMatchObject({ source: 'apple_reminders', externalId: reminder?.id, appleListId: 'L-courses' });
    expect(h.reminders.all().some((entry) => entry.title === 'Réunion')).toBe(false);
    // L'identifiant est publié (visible sur le PC) ; le lien reste local ; un second passage ne recrée rien.
    expect((await h.outbox()).some((row) => row.row_id === created.value.id && row.field === 'external_id')).toBe(true);
    expect(await h.pass('full')).toMatchObject({ sent: 0, created: 0, updated: 0, pending: 0 });
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toHaveLength(1);
  });

  it('une tâche terminée avant l’envoi est créée terminée ; une tâche supprimée avant l’envoi ne crée rien', async () => {
    await enable(PERSO, 'L-courses');
    const done = await uc().create({ title: 'Déjà fait', spaceId: PERSO });
    const gone = await uc().create({ title: 'Annulée', spaceId: PERSO });
    if (!done.ok || !gone.ok) throw new Error('création refusée');
    await uc().complete(done.value.id);
    await uc().remove([gone.value.id]);
    await h.pass('push');
    expect(h.reminders.all().map((entry) => [entry.title, entry.completed])).toEqual([['Déjà fait', true]]);
  });

  it('réglage désactivé avant l’envoi ou espace changé : la tâche redevient ordinaire, rien n’est créé', async () => {
    await enable(PERSO, 'L-courses');
    const task = await uc().create({ title: 'Changera', spaceId: PERSO });
    if (!task.ok) throw new Error('création refusée');
    const { appleRemindersState } = await import('./appleRemindersState');
    await appleRemindersState(h.container).setCreate({ bySpace: [{ spaceId: PERSO, enabled: false, listId: 'L-courses' }] });
    await h.pass('push');
    expect(h.reminders.writes).toEqual([]);
    expect(await h.task(task.value.id)).toMatchObject({ source: 'local', appleListId: null, externalId: null });
  });

  it('liste de destination décochée : réglage désactivé avec message, tâches à créer remises à l’état ordinaire', async () => {
    await enable(PERSO, 'L-courses');
    const task = await uc().create({ title: 'Orpheline', spaceId: PERSO });
    if (!task.ok) throw new Error('création refusée');
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: false });
    await h.pass('full');
    expect(h.reminders.writes).toEqual([]);
    expect(await h.task(task.value.id)).toMatchObject({ source: 'local', appleListId: null });
    expect(await h.container.data.repos.settings.get('appleReminders.create')).toMatchObject({ bySpace: [{ spaceId: PERSO, enabled: false, listId: 'L-courses' }] });
    expect(status().notices.map((notice) => notice.kind)).toContain('creation-off');
  });

  it('création en série CircleTasks : jamais envoyée vers Rappels', async () => {
    await enable(PERSO, 'L-courses');
    const series = await uc().create({ title: 'Chaque jour', spaceId: PERSO, date: D('2026-10-09'), recurrence: { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null } });
    expect(series.ok && series.value).toMatchObject({ source: 'local', appleListId: null });
  });

  it('reprise après un arrêt : le rappel déjà créé est adopté, jamais dupliqué ; plusieurs candidats : le plus ancien est adopté et les autres signalés', async () => {
    await enable(PERSO, 'L-courses');
    const task = await uc().create({ title: 'Interrompue', spaceId: PERSO, date: D('2026-10-11') });
    if (!task.ok) throw new Error('création refusée');
    // Le lien « création en cours » est écrit, le rappel est créé, puis l'app s'arrête avant de noter l'identifiant.
    await h.container.data.repos.appleLinks.upsert({ taskId: task.value.id, reminderId: null, externalRef: null, listId: 'L-courses', state: 'creating', synced: null, appleModified: null, startedAt: new Date(h.db.clock.nowMs()).toISOString() as IsoDateTime });
    h.db.clock.advance(1_000);
    const first = h.reminders.add({ id: 'ORPH-1', listId: 'L-courses', title: 'Interrompue', due: { date: D('2026-10-11'), time: null } });
    h.db.clock.advance(1_000);
    h.reminders.add({ id: 'ORPH-2', listId: 'L-courses', title: 'Interrompue', due: { date: D('2026-10-11'), time: null } });
    h.reminders.add({ id: 'AUTRE', listId: 'L-courses', title: 'Autre rappel' });
    await h.pass('push');
    expect(h.reminders.writes.filter((write) => write.kind === 'create')).toEqual([]);
    expect(await h.task(task.value.id)).toMatchObject({ externalId: first.id, source: 'apple_reminders' });
    expect(h.reminders.get('ORPH-2')).toBeDefined();
    expect(status().notices).toContainEqual(expect.objectContaining({ kind: 'duplicate-created', count: 1 }));
    // Aucun lien ne reste « en cours ».
    expect((await h.container.data.repos.appleLinks.get(task.value.id))?.state).toBe('linked');
  });
});

describe('suppression (K-06 critère 7)', () => {
  it('supprimer la tâche liée supprime le rappel au passage suivant et détache la tâche (restaurable) ; annulée dans les 5 s : rien n’est envoyé', async () => {
    const { reminder, task } = await linked('À jeter');
    await uc().remove([task.id]);
    expect((await h.container.undo.undoLast()).status).toBe('undone');
    expect(await h.pass('push')).toMatchObject({ sent: 0 });
    expect(h.reminders.get(reminder.id)).toBeDefined();
    h.db.clock.advance(60_000);
    await uc().remove([task.id]);
    expect(await h.pass('push')).toMatchObject({ sent: 1, pending: 0 });
    expect(h.reminders.get(reminder.id)).toBeUndefined();
    expect(h.reminders.writes.map((write) => write.kind)).toEqual(['delete']);
    const after = await h.task(task.id);
    expect(after).toMatchObject({ source: 'local', externalId: null, appleListId: 'L-courses' });
    expect(after?.deletedAt).not.toBeNull();
    expect(await h.container.data.repos.appleLinks.get(task.id)).toBeNull();
    // Rien ne réapparaît, ni n'est renvoyé.
    expect(await h.pass('full')).toMatchObject({ created: 0, sent: 0, deleted: 0 });
    // Restaurée depuis la corbeille : une tâche ordinaire, sans lien, sans boucle de suppression.
    await h.container.data.repos.tasks.restore([task.id]);
    expect(await h.pass('full')).toMatchObject({ created: 0, sent: 0, deleted: 0, pending: 0 });
    expect((await h.task(task.id))?.deletedAt).toBeNull();
  });

  it('tâche purgée avant l’envoi : le lien « suppression en cours » suffit à finir', async () => {
    const { reminder, task } = await linked('Purgée');
    const link = await h.container.data.repos.appleLinks.get(task.id);
    if (!link) throw new Error('lien absent');
    await h.container.data.repos.appleLinks.upsert({ ...link, state: 'deleting', startedAt: new Date(h.db.clock.nowMs()).toISOString() as IsoDateTime });
    await h.db.driver.execute('DELETE FROM task WHERE id = ?', [task.id]);
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)).toBeUndefined();
    expect(await h.container.data.repos.appleLinks.get(task.id)).toBeNull();
  });

  it('suppression venue de la synchro (supprimée sur le PC) : le rappel est supprimé au passage de l’iPhone', async () => {
    const { reminder, task } = await linked('Supprimée sur le PC');
    // Sur le PC, la tâche est supprimée (la ligne de lien n'existe que sur l'iPhone) : ici la tâche passe en corbeille sans toucher au lien.
    await h.container.data.repos.tasks.softDelete([task.id]);
    expect(await h.pass('push')).toMatchObject({ sent: 1 });
    expect(h.reminders.get(reminder.id)).toBeUndefined();
  });
});

describe('aucun échec silencieux (K-06 critère 8)', () => {
  it('accès révoqué pendant une modification : état persistant, nombre en attente, bandeau « n modification(s) n’ont pas pu être envoyées », réessai au passage suivant, effacé quand tout est parti', async () => {
    const { reminder, task } = await linked('Fragile');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Fragile v2' });
    h.reminders.failNext('upsert', 'store-unavailable');
    expect(await h.pass('push')).toMatchObject({ status: 'done', sent: 0, pending: 1 });
    expect(status().failure).toMatchObject({ code: 'store-unavailable' });
    expect(await pendingSetting()).toMatchObject({ count: 1 });
    expect(useAppStatusStore.getState().sources.appleRemindersTrouble?.message).toBe('1 modification(s) n’ont pas pu être envoyées vers Rappels');
    expect(h.reminders.get(reminder.id)?.title).toBe('Fragile');
    // Réessai.
    h.db.clock.advance(60_000);
    expect(await h.pass('push')).toMatchObject({ sent: 1, pending: 0 });
    expect(h.reminders.get(reminder.id)?.title).toBe('Fragile v2');
    expect(status().failure).toBeNull();
    expect(await pendingSetting()).toBeNull();
    expect(useAppStatusStore.getState().sources.appleRemindersTrouble).toBeUndefined();
  });

  it('plusieurs écritures dues restent dues et sont comptées ; une panne du magasin ne les tente pas toutes', async () => {
    const a = await linked('Une');
    const b = await linked('Deux');
    h.db.clock.advance(60_000);
    await uc().update(a.task.id, { title: 'Une bis' });
    await uc().update(b.task.id, { title: 'Deux bis' });
    h.reminders.failNext('upsert', 'store-unavailable', 10);
    const report = await h.pass('push');
    expect(report.pending).toBe(2);
    expect(report.sent).toBe(0);
    expect(h.reminders.calls.filter((call) => call.name === 'upsert')).toHaveLength(1);
    expect(await pendingSetting()).toMatchObject({ count: 2 });
  });

  it('rappel disparu entre la lecture et l’écriture : la tâche est détachée avec message (jamais supprimée)', async () => {
    const { reminder, task } = await linked('Disparu');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Disparu bis' });
    h.reminders.failNext('upsert', 'not-found');
    expect(await h.pass('push')).toMatchObject({ pending: 0 });
    expect(await h.task(task.id)).toMatchObject({ source: 'local', externalId: null, deletedAt: null });
    expect(status().notices.map((notice) => notice.kind)).toContain('detached');
    expect(h.reminders.get(reminder.id)).toBeDefined();
  });

  it('liste en lecture seule : refus visible, écriture comptée comme due', async () => {
    const { task } = await linked('Lecture seule');
    h.reminders.setWritable('L-courses', false);
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Lecture seule v2' });
    expect(await h.pass('push')).toMatchObject({ sent: 0, pending: 1 });
    expect(status().failure).toMatchObject({ code: 'read-only-list' });
    expect(status().notices.map((notice) => notice.kind)).toContain('read-only-list');
  });

  it('création en échec : le lien « en cours » reste, la tâche reste à créer et le nouvel essai ne crée qu’un rappel', async () => {
    const { appleRemindersState } = await import('./appleRemindersState');
    await appleRemindersState(h.container).setCreate({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L-courses' }] });
    const task = await uc().create({ title: 'Création difficile', spaceId: PERSO });
    if (!task.ok) throw new Error('création refusée');
    h.reminders.failNext('upsert', 'write-failed');
    expect(await h.pass('push')).toMatchObject({ pending: 1, sent: 0 });
    expect(await h.task(task.value.id)).toMatchObject({ source: 'apple_reminders', externalId: null });
    h.db.clock.advance(60_000);
    expect(await h.pass('push')).toMatchObject({ pending: 0, sent: 1 });
    expect(h.reminders.all().filter((entry) => entry.title === 'Création difficile')).toHaveLength(1);
  });

  it('le journal des échecs ne contient jamais de titre', async () => {
    const { task } = await linked('Titre confidentiel');
    h.db.clock.advance(60_000);
    await uc().update(task.id, { title: 'Titre confidentiel v2' });
    h.reminders.failNext('upsert', 'write-failed');
    await h.pass('push');
    expect(JSON.stringify(await h.container.data.repos.settings.get('appleReminders.status'))).not.toContain('confidentiel');
    expect(JSON.stringify(await pendingSetting())).not.toContain('confidentiel');
  });
});

describe('rappel récurrent : aucune écriture vers Rappels, refus dans CircleTasks (ADR 0008 §10.6)', () => {
  it('terminer, rouvrir, titre, date, heure, « Un jour », report et suppression sont refusés avec le message ; note, icône et espace restent modifiables', async () => {
    const { reminder, task } = await linked('Poubelles', { due: { date: D('2026-10-09'), time: null }, recurring: true });
    expect(task.appleRecurring).toBe(true);
    const refused = (): boolean => useNoticeStore.getState().notice?.text === 'Modifiez ce rappel récurrent dans Rappels.';
    for (const act of [
      () => uc().complete(task.id),
      () => uc().reopen(task.id),
      () => uc().update(task.id, { title: 'Autre titre' }),
      () => uc().update(task.id, { date: D('2026-10-20') }),
      () => uc().update(task.id, { time: T('09:00') }),
      () => uc().postpone([task.id], 'tomorrow'),
      () => uc().moveToDay(task.id, D('2026-10-22')),
      () => uc().moveToSomeday([task.id]),
      () => uc().remove([task.id]),
    ]) {
      useNoticeStore.getState().clear();
      await act();
      expect(refused()).toBe(true);
      expect(await h.task(task.id)).toMatchObject({ title: 'Poubelles', status: 'todo', date: '2026-10-09', time: null, someday: false });
      expect((await h.task(task.id))?.deletedAt).toBeNull();
    }
    useNoticeStore.getState().clear();
    await uc().update(task.id, { note: 'garage', title: 'Interdit' });
    expect(refused()).toBe(true);
    expect(await h.task(task.id)).toMatchObject({ title: 'Poubelles', note: 'garage' });
    expect(await h.pass('push')).toMatchObject({ sent: 0, pending: 0 });
    expect(h.reminders.writes).toEqual([]);
    expect(h.reminders.get(reminder.id)).toBeDefined();
  });

  it('un rappel non récurrent n’est jamais refusé ; une tâche liée ne reçoit pas de répétition CircleTasks', async () => {
    const { task } = await linked('Normal', { due: { date: D('2026-10-09'), time: null } });
    useNoticeStore.getState().clear();
    await uc().update(task.id, { title: 'Normal bis' });
    expect(useNoticeStore.getState().notice).toBeNull();
    const repeat = await uc().setRecurrence(task.id, { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null });
    expect(repeat).toEqual({ ok: false, error: 'apple-linked' });
    expect((await h.task(task.id))?.recurrenceId).toBeNull();
  });
});
