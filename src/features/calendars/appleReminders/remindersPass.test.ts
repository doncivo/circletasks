import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate, LocalTime } from '../../../domain/types';
import { useAppStatusStore } from '../../app/appStatus';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';
import { runRemindersPass } from './remindersPass';
import { PERSO, PRO, setupRemindersHarness, type RemindersHarness } from './testKit';

const D = (value: string): LocalDate => value as LocalDate;
const T = (value: string): LocalTime => value as LocalTime;

let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('1');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
  await h.showList({ id: 'L-travail', name: 'Travail', spaceId: PRO });
});
afterEach(() => h.close());

const pass = (kind: 'full' | 'push' = 'full') => runRemindersPass(h.container, kind);
const status = () => appleRemindersStore.get(h.container).getState().status;
const banner = () => useAppStatusStore.getState().sources.appleRemindersTrouble;

describe('import des rappels (K-05 critères 8 et 9)', () => {
  it('les rappels non terminés deviennent des tâches : espace de la liste, échéance, « Un jour » sans échéance ; un second passage ne crée rien', async () => {
    h.reminders.add({ listId: 'L-travail', title: 'Appeler le notaire', due: { date: D('2026-10-09'), time: T('10:00') } });
    h.reminders.add({ listId: 'L-courses', title: 'Acheter du pain', due: { date: D('2026-10-12'), time: null } });
    h.reminders.add({ listId: 'L-courses', title: 'Idée de cadeau' });
    h.reminders.add({ listId: 'L-courses', title: 'Déjà fait', completed: true });
    const first = await pass();
    expect(first).toMatchObject({ status: 'done', created: 3, updated: 0, deleted: 0, sent: 0 });
    const notary = await h.taskByTitle('Appeler le notaire');
    expect(notary).toMatchObject({ spaceId: PRO, date: '2026-10-09', time: '10:00', someday: false, source: 'apple_reminders', appleListId: 'L-travail', appleRecurring: false, status: 'todo' });
    expect(notary.externalId).toMatch(/^R-/);
    expect(await h.taskByTitle('Acheter du pain')).toMatchObject({ spaceId: PERSO, date: '2026-10-12', time: null, someday: false });
    expect(await h.taskByTitle('Idée de cadeau')).toMatchObject({ spaceId: PERSO, date: null, time: null, someday: true });
    expect((await h.tasks()).map((task) => task.title)).not.toContain('Déjà fait');
    // Aucun appel d'écriture vers Rappels (lecture seule), aucun doublon au second passage.
    expect(h.reminders.writes).toEqual([]);
    const second = await pass();
    expect(second).toMatchObject({ status: 'done', created: 0, updated: 0, deleted: 0, sent: 0, pending: 0 });
    expect(await h.tasks()).toHaveLength(3);
    expect(h.reminders.writes).toEqual([]);
  });

  it('les tâches importées sont publiées par la synchro (tâche complète dans la file d’envoi), les liens restent locaux', async () => {
    h.reminders.add({ listId: 'L-travail', title: 'Appeler le notaire' });
    await pass();
    const task = await h.taskByTitle('Appeler le notaire');
    const outbox = await h.outbox();
    expect(outbox).toContainEqual({ table_name: 'task', row_id: task.id, field: '*' });
    expect(outbox.filter((row) => row.table_name === 'apple_reminder_link')).toEqual([]);
    expect((await h.container.data.repos.appleLinks.listAll()).map((link) => link.taskId)).toEqual([task.id]);
  });

  it('un rappel d’échéance passée garde sa date (le report T-06 ne s’écrit jamais vers Rappels)', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'En retard', due: { date: D('2026-09-01'), time: null } });
    await pass();
    expect(await h.taskByTitle('En retard')).toMatchObject({ date: '2026-09-01', someday: false });
  });

  it('plafond de 500 par liste : message « 500 rappels sur 740 importés », les rappels déjà liés restent suivis', async () => {
    for (let i = 0; i < 740; i += 1) h.reminders.add({ listId: 'L-courses', title: `Rappel ${String(i).padStart(3, '0')}`, due: { date: D('2026-11-01'), time: null } });
    expect(await pass()).toMatchObject({ status: 'done', created: 500 });
    expect(status().caps).toEqual([{ listId: 'L-courses', total: 740, imported: 500 }]);
    expect(await h.tasks()).toHaveLength(500);
    // Un rappel suivi, modifié dans Rappels, est relu par identifiant même au-delà du plafond.
    const followed = await h.taskByTitle('Rappel 000');
    h.db.clock.advance(60_000);
    h.reminders.edit(followed.externalId as string, { title: 'Rappel 000 modifié' });
    expect(await pass()).toMatchObject({ created: 0, updated: 1 });
    expect((await h.task(followed.id))?.title).toBe('Rappel 000 modifié');
  });
});

describe('mises à jour depuis Rappels (K-05 critère 10)', () => {
  it('titre, date, heure et achèvement modifiés dans Rappels mettent la tâche à jour au passage suivant', async () => {
    const reminder = h.reminders.add({ listId: 'L-travail', title: 'Rapport', due: { date: D('2026-10-09'), time: T('10:00') } });
    await pass();
    h.db.clock.advance(120_000);
    h.reminders.edit(reminder.id, { title: 'Rapport final', due: { date: D('2026-10-10'), time: T('15:30') } });
    expect(await pass()).toMatchObject({ updated: 1, created: 0 });
    const task = await h.taskByTitle('Rapport final');
    expect(task).toMatchObject({ date: '2026-10-10', time: '15:30', status: 'todo' });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { completed: true });
    await pass();
    expect(await h.task(task.id)).toMatchObject({ status: 'done' });
    expect((await h.task(task.id))?.doneAt).not.toBeNull();
    // Aucun renvoi : le second passage est vide (anti-boucle).
    expect(await pass()).toMatchObject({ updated: 0, sent: 0, pending: 0 });
    expect(h.reminders.writes).toEqual([]);
    // Rouvert dans Rappels : la tâche redevient à faire.
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { completed: false });
    await pass();
    expect(await h.task(task.id)).toMatchObject({ status: 'todo', doneAt: null });
  });

  it('l’échéance retirée dans Rappels envoie la tâche dans « Un jour »', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Vélo', due: { date: D('2026-10-09'), time: T('08:00') } });
    await pass();
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { due: null });
    await pass();
    expect(await h.taskByTitle('Vélo')).toMatchObject({ date: null, time: null, someday: true });
  });

  it('une date reportée par T-06 reste locale tant que Rappels ne change pas l’échéance ; si Rappels la change, le badge « reportée » tombe', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Reporté', due: { date: D('2026-10-07'), time: null } });
    await pass();
    const task = await h.taskByTitle('Reporté');
    await h.container.data.repos.tasks.carryOver([task.id], D('2026-10-08'));
    h.db.clock.advance(60_000);
    expect(await pass()).toMatchObject({ updated: 0, pending: 0 });
    expect(await h.task(task.id)).toMatchObject({ date: '2026-10-08', carriedOver: true });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { due: { date: D('2026-10-15'), time: null } });
    await pass();
    expect(await h.task(task.id)).toMatchObject({ date: '2026-10-15', carriedOver: false });
  });

  it('un rappel récurrent est importé avec son badge ; une valeur locale arrivée malgré tout est remplacée et inscrite au journal des conflits, rien n’est écrit vers Rappels', async () => {
    const series = h.reminders.add({ listId: 'L-courses', title: 'Poubelles', due: { date: D('2026-10-09'), time: null }, recurring: true });
    await pass();
    const task = await h.taskByTitle('Poubelles');
    expect(task.appleRecurring).toBe(true);
    // Version plus ancienne ou conflit restauré : le titre local a changé.
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Poubelles (local)' });
    expect(await pass()).toMatchObject({ sent: 0, pending: 0 });
    expect((await h.task(task.id))?.title).toBe('Poubelles');
    expect(await h.conflicts()).toEqual([{ field: 'title', kept_value: '"Poubelles"', discarded_value: '"Poubelles (local)"', kept_device: 'apple-reminders', discarded_device: h.db.deviceId }]);
    expect(h.reminders.writes).toEqual([]);
    expect(status().notices.map((notice) => notice.kind)).toContain('recurring-refused');
    // Rappels passe à l'échéance suivante : la tâche suit.
    h.db.clock.advance(60_000);
    h.reminders.edit(series.id, { due: { date: D('2026-10-16'), time: null } });
    await pass();
    expect((await h.task(task.id))?.date).toBe('2026-10-16');
  });

  it('rappel déplacé dans une autre liste affichée : la tâche reste liée et suit sa liste ; dans une liste non affichée : règle de la liste décochée', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Déménagé' });
    await pass();
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { listId: 'L-travail' });
    await pass();
    expect(await h.taskByTitle('Déménagé')).toMatchObject({ appleListId: 'L-travail', source: 'apple_reminders' });
    h.reminders.addList({ id: 'L-autre', name: 'Autre', writable: true });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { listId: 'L-autre' });
    expect(await pass()).toMatchObject({ deleted: 1 });
    expect(await h.taskByTitle('Déménagé')).toMatchObject({ source: 'local', externalId: null, appleListId: 'L-travail' });
    expect((await h.taskByTitle('Déménagé')).deletedAt).not.toBeNull();
  });

  it('conflit sur le même champ : le plus récent gagne, la valeur perdue va au journal ; champs différents : les deux sont gardés', async () => {
    const reminder = h.reminders.add({ listId: 'L-travail', title: 'Budget', due: { date: D('2026-10-09'), time: null } });
    await pass();
    const task = await h.taskByTitle('Budget');
    // Titre modifié des deux côtés ; date modifiée dans Rappels seulement.
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Budget local' });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Budget Rappels', due: { date: D('2026-10-20'), time: null } });
    expect(await pass()).toMatchObject({ updated: 1 });
    expect(await h.task(task.id)).toMatchObject({ title: 'Budget Rappels', date: '2026-10-20' });
    expect(await h.conflicts()).toEqual([{ field: 'title', kept_value: '"Budget Rappels"', discarded_value: '"Budget local"', kept_device: 'apple-reminders', discarded_device: h.db.deviceId }]);
  });

  it('une tâche modifiée pendant la lecture n’est pas écrasée : elle est reprise au passage suivant', async () => {
    const reminder = h.reminders.add({ listId: 'L-travail', title: 'Course' });
    await pass();
    const task = await h.taskByTitle('Course');
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Course Rappels' });
    // La tâche change entre la lecture du passage et son écriture.
    const originalFetch = h.reminders.fetch.bind(h.reminders);
    let hijacked = false;
    h.reminders.fetch = async (input) => {
      const out = await originalFetch(input);
      if (!hijacked) {
        hijacked = true;
        h.db.clock.advance(1_000);
        await h.container.data.repos.tasks.update(task.id, { note: 'note ajoutée pendant le passage' });
      }
      return out;
    };
    expect(await pass()).toMatchObject({ status: 'done', updated: 0 });
    expect((await h.task(task.id))?.title).toBe('Course');
    h.reminders.fetch = originalFetch;
    expect(await pass()).toMatchObject({ updated: 1 });
    expect((await h.task(task.id))?.title).toBe('Course Rappels');
  });
});

describe('suppressions (K-05 critère 10, ADR 0008 §10.6)', () => {
  it('un rappel supprimé dans Rappels met la tâche à la corbeille ET la détache, avec un message', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'À supprimer' });
    h.reminders.add({ listId: 'L-courses', title: 'Reste' });
    await pass();
    const task = await h.taskByTitle('À supprimer');
    h.reminders.remove(reminder.id);
    expect(await pass()).toMatchObject({ deleted: 1 });
    const after = await h.task(task.id);
    expect(after?.deletedAt).not.toBeNull();
    expect(after).toMatchObject({ source: 'local', externalId: null, appleListId: 'L-courses' });
    expect(await h.container.data.repos.appleLinks.get(task.id)).toBeNull();
    expect(status().notices).toEqual([expect.objectContaining({ kind: 'deleted', count: 1 })]);
    // Tombstone : la suppression est publiée (suppression douce, champ deleted_at dans la file).
    expect(await h.outbox()).toContainEqual({ table_name: 'task', row_id: task.id, field: 'deleted_at' });
    // Rien ne réapparaît au passage suivant.
    expect(await pass()).toMatchObject({ created: 0, deleted: 0 });
  });

  it('suppression avec changements locaux non envoyés : la suppression gagne, conflit sur deleted_at, la tâche reste restaurable', async () => {
    const reminder = h.reminders.add({ listId: 'L-courses', title: 'Modifiée ici' });
    h.reminders.add({ listId: 'L-courses', title: 'Autre' });
    await pass();
    const task = await h.taskByTitle('Modifiée ici');
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Modifiée ici encore' });
    h.reminders.remove(reminder.id);
    await pass();
    expect((await h.task(task.id))?.deletedAt).not.toBeNull();
    expect((await h.conflicts()).map((row) => row.field)).toEqual(['deleted_at']);
    await h.container.data.repos.tasks.restore([task.id]);
    expect((await h.task(task.id))?.deletedAt).toBeNull();
    expect(await pass()).toMatchObject({ deleted: 0, created: 0 });
  });

  it('garde de suppression massive : trop de rappels absents, rien n’est supprimé et le message demande un geste', async () => {
    for (let i = 0; i < 20; i += 1) h.reminders.add({ id: `M-${String(i)}`, listId: 'L-courses', title: `Tâche ${String(i)}` });
    await pass();
    for (let i = 0; i < 11; i += 1) h.reminders.remove(`M-${String(i)}`);
    expect(await pass()).toMatchObject({ deleted: 0 });
    expect(await h.tasks()).toHaveLength(20);
    expect(status().held).toEqual([{ listId: 'L-courses', count: 11, at: expect.any(String) }]);
    // Les rappels reviennent : le message demandant un geste disparaît au passage suivant.
    for (let i = 0; i < 11; i += 1) h.reminders.add({ id: `M-${String(i)}`, listId: 'L-courses', title: `Tâche ${String(i)}` });
    await pass();
    expect(status().held).toEqual([]);
  });

  it('au seuil (10 absents sur 20) les suppressions ont lieu', async () => {
    for (let i = 0; i < 20; i += 1) h.reminders.add({ id: `S-${String(i)}`, listId: 'L-courses', title: `Seuil ${String(i)}` });
    await pass();
    for (let i = 0; i < 10; i += 1) h.reminders.remove(`S-${String(i)}`);
    expect(await pass()).toMatchObject({ deleted: 10 });
    expect(status().held).toEqual([]);
    expect(await h.tasks()).toHaveLength(10);
  });

  it('jamais de suppression sur un échec de lecture, un accès retiré, une liste absente ou un lien inconnu sur cet appareil', async () => {
    h.reminders.add({ id: 'K-1', listId: 'L-courses', title: 'Intacte' });
    await pass();
    const task = await h.taskByTitle('Intacte');
    h.reminders.remove('K-1');
    // Échec de lecture.
    h.reminders.failNext('fetch', 'read-failed');
    expect(await pass()).toMatchObject({ status: 'failed', code: 'read-failed' });
    expect((await h.task(task.id))?.deletedAt).toBeNull();
    expect(status().failure).toMatchObject({ code: 'read-failed' });
    // Accès retiré.
    h.reminders.setAccess('denied');
    expect(await pass()).toMatchObject({ status: 'failed', code: 'access-denied' });
    expect((await h.task(task.id))?.deletedAt).toBeNull();
    h.reminders.setAccess('full');
    // Liste absente de Rappels : tâches intactes, état « Liste introuvable ».
    h.reminders.removeList('L-courses');
    expect(await pass()).toMatchObject({ status: 'done', deleted: 0 });
    expect((await h.task(task.id))).toMatchObject({ deletedAt: null, source: 'apple_reminders' });
    expect(status().missingLists).toEqual(['L-courses']);
    h.reminders.addList({ id: 'L-courses', name: 'Courses', writable: true });
    // Tâche liée sans lien sur cet appareil (reçue de la synchro) et rappel introuvable : comptée, jamais supprimée.
    await h.container.data.repos.appleLinks.remove(task.id);
    expect(await pass()).toMatchObject({ deleted: 0 });
    expect((await h.task(task.id))?.deletedAt).toBeNull();
    expect(status().unknown).toBe(1);
  });

  it('liste décochée : tâches non modifiées localement à la corbeille et détachées, les autres détachées et gardées, message visible', async () => {
    h.reminders.add({ id: 'U-1', listId: 'L-courses', title: 'Non modifiée' });
    h.reminders.add({ id: 'U-2', listId: 'L-courses', title: 'Modifiée ici' });
    await pass();
    const modified = await h.taskByTitle('Modifiée ici');
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(modified.id, { title: 'Modifiée ici (local)' });
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: false });
    const report = await pass();
    expect(report).toMatchObject({ deleted: 1, detached: 1 });
    expect(await h.taskByTitle('Non modifiée')).toMatchObject({ source: 'local', externalId: null });
    expect((await h.taskByTitle('Non modifiée')).deletedAt).not.toBeNull();
    expect(await h.task(modified.id)).toMatchObject({ source: 'local', externalId: null, appleListId: 'L-courses', deletedAt: null });
    expect(status().notices.map((notice) => notice.kind).sort()).toEqual(['detached', 'unlinked-list']);
    // Cocher de nouveau : les rappels sont réimportés comme nouvelles tâches (les tâches détachées restent ordinaires).
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: true });
    expect(await pass()).toMatchObject({ created: 2 });
  });
});

describe('liens reconstruits (tâche reçue de la synchro)', () => {
  it('une tâche liée reçue d’un autre appareil retrouve son lien sans doublon ; les conflits sont traités faute d’empreinte', async () => {
    const reminder = h.reminders.add({ listId: 'L-travail', title: 'Venue du PC' });
    await pass();
    const task = await h.taskByTitle('Venue du PC');
    // Simule une base reçue : la tâche existe, le lien local non.
    await h.container.data.repos.appleLinks.remove(task.id);
    expect(await pass()).toMatchObject({ created: 0, updated: 0 });
    expect(await h.tasks()).toHaveLength(1);
    expect((await h.container.data.repos.appleLinks.get(task.id))?.reminderId).toBe(reminder.id);
  });

  it('la tâche liée reçue avec le titre modifié sur le PC : empreinte inconnue, le champ différent est un conflit résolu par la date', async () => {
    const reminder = h.reminders.add({ listId: 'L-travail', title: 'Original' });
    await pass();
    const task = await h.taskByTitle('Original');
    await h.container.data.repos.appleLinks.remove(task.id);
    h.db.clock.advance(60_000);
    await h.container.data.repos.tasks.update(task.id, { title: 'Modifié sur le PC' });
    h.db.clock.advance(60_000);
    h.reminders.edit(reminder.id, { title: 'Modifié dans Rappels' });
    await pass();
    expect((await h.task(task.id))?.title).toBe('Modifié dans Rappels');
    expect((await h.conflicts()).map((row) => row.field)).toEqual(['title']);
  });
});

describe('accès, échecs visibles, heure de dernière lecture (K-05 critères 7, 12 et 14)', () => {
  it('accès non décidé : aucune lecture, aucune demande, aucun bandeau ; refusé : état persistant, bandeau, aucune liste lue ; rétabli : disparaît', async () => {
    h.reminders.setAccess('not-determined');
    expect(await pass()).toMatchObject({ status: 'skipped', reason: 'not-determined' });
    expect(h.reminders.calls.map((call) => call.name)).toEqual(['status']);
    expect(banner()).toBeUndefined();
    h.reminders.setAccess('denied');
    expect(await pass()).toMatchObject({ status: 'failed', code: 'access-denied' });
    expect(h.reminders.calls.filter((call) => call.name === 'lists' || call.name === 'fetch')).toEqual([]);
    expect(banner()).toMatchObject({ detail: 'access-denied', message: 'L’accès aux Rappels est refusé' });
    expect(status().failure).toMatchObject({ code: 'access-denied' });
    // L'état survit au redémarrage : relu depuis le réglage local.
    expect(await h.container.data.repos.settings.get('appleReminders.status')).toMatchObject({ failure: { code: 'access-denied' } });
    h.reminders.setAccess('full');
    h.reminders.add({ listId: 'L-courses', title: 'Après rétablissement' });
    expect(await pass()).toMatchObject({ status: 'done', created: 1 });
    expect(status().failure).toBeNull();
    expect(banner()).toBeUndefined();
  });

  it('un rejet du plugin est écrit (code, heure, aucun titre), affiché par le bandeau, et effacé au premier passage réussi ; une exception inattendue est rattrapée de même', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Secret professionnel' });
    h.reminders.failNext('lists', 'store-unavailable');
    expect(await pass()).toMatchObject({ status: 'failed', code: 'store-unavailable' });
    expect(banner()?.message).toBe('Les Rappels Apple n’ont pas pu être lus');
    expect(JSON.stringify(await h.container.data.repos.settings.get('appleReminders.status'))).not.toContain('Secret');
    expect(await pass()).toMatchObject({ status: 'done' });
    expect(banner()).toBeUndefined();
    h.reminders.fetch = () => Promise.reject(new Error('Secret professionnel illisible'));
    expect(await pass()).toMatchObject({ status: 'failed', code: 'pass-failed' });
    expect(status().failure?.code).toBe('pass-failed');
    expect(JSON.stringify(status())).not.toContain('Secret');
  });

  it('sur PC (plugin indisponible) : aucun passage, aucun appel', async () => {
    const pc = await setupRemindersHarness('2', { runtime: 'tauri', os: 'windows' });
    // Le faux est branché ici ; la plateforme réelle d'un PC est « indisponible » (aucun appel).
    const { createUnavailableReminders } = await import('../../../platform/reminders');
    const container = { ...pc.container, reminders: createUnavailableReminders() };
    expect(await runRemindersPass(container, 'full')).toMatchObject({ status: 'skipped', reason: 'unavailable' });
    expect(pc.reminders.calls).toEqual([]);
    await pc.close();
  });

  it('la dernière lecture réussie est enregistrée, au plus une écriture par 15 minutes ; l’affichage de la session la suit', async () => {
    const writes = async () => h.db.driver.select<{ hlc: string }>("SELECT hlc FROM settings WHERE key = 'appleReminders.lastPassAt'");
    await pass();
    const first = await writes();
    expect(first).toHaveLength(1);
    expect(await h.container.data.repos.settings.get('appleReminders.lastPassAt')).toBe('2026-10-08T09:00:00.000Z');
    h.db.clock.advance(5 * 60_000);
    await pass();
    expect(await writes()).toEqual(first);
    expect(appleRemindersStore.get(h.container).getState().lastPassAt).toBe('2026-10-08T09:05:00.000Z');
    h.db.clock.advance(11 * 60_000);
    await pass();
    expect(await h.container.data.repos.settings.get('appleReminders.lastPassAt')).toBe('2026-10-08T09:16:00.000Z');
  });

  it('un passage vide n’écrit aucun réglage (ni statut, ni nombre d’écritures dues)', async () => {
    h.reminders.add({ listId: 'L-courses', title: 'Une' });
    await pass();
    h.db.clock.advance(60_000);
    const before = await h.db.driver.select("SELECT key, hlc FROM settings WHERE key LIKE 'appleReminders.%' ORDER BY key");
    await pass();
    expect(await h.db.driver.select("SELECT key, hlc FROM settings WHERE key LIKE 'appleReminders.%' ORDER BY key")).toEqual(before);
  });

  it('noms de liste : un nom changé dans Rappels est repris dans le réglage partagé (le PC affiche le nom)', async () => {
    await pass();
    h.reminders.renameList('L-courses', 'Courses du week-end');
    await pass();
    expect(appleRemindersStore.get(h.container).getState().lists.lists.find((list) => list.id === 'L-courses')?.name).toBe('Courses du week-end');
    expect(JSON.stringify(await h.container.data.repos.settings.get('appleReminders.lists'))).toContain('Courses du week-end');
  });

  it('les réglages venus de la synchro sont relus par leur analyseur : une valeur invalide ne casse pas le passage', async () => {
    await h.container.data.repos.settings.set('appleReminders.lists', { lists: [{ id: 'L-courses', name: 'Courses', spaceId: 'pas-un-uuid', shown: true }, 42] } as never);
    await appleRemindersState(h.container).reload();
    h.reminders.add({ listId: 'L-courses', title: 'Rien ne s’importe sans espace' });
    expect(await pass()).toMatchObject({ status: 'done', created: 0 });
  });
});
