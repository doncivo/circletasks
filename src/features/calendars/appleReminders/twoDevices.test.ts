import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appleLinkState } from '../../../domain/appleReminders';
import { taskLineSegments } from '../../../domain/taskLine';
import type { LocalDate, LocalTime } from '../../../domain/types';
import { createFakeReminders, createUnavailableReminders, type FakeReminders } from '../../../platform/reminders';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../../tests/sim/syncDevice';
import { createAppContainer, type AppContainer } from '../../app/container';
import { createTaskUseCases } from '../../tasks/createTaskUseCases';
import { appleRemindersState } from './appleRemindersState';
import { runRemindersPass } from './remindersPass';
import { createSender } from './remindersWrites';

/**
 * K-07 (critères 1 à 4) : deux appareils associés (PC et iPhone simulés, synchro en mémoire, faux EventKit côté iPhone). Les Rappels
 * arrivent sur le PC par la synchro seule ; les modifications du PC repartent vers Rappels au prochain passage de l'iPhone ; le PC n'appelle
 * jamais le plugin.
 */
const PC_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const IPHONE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO = '00000000-0000-4000-8000-000000000001' as never;
const PERSO = '00000000-0000-4000-8000-000000000002' as never;
const D = (value: string): LocalDate => value as LocalDate;
const T = (value: string): LocalTime => value as LocalTime;

let devices: SimDevice[] = [];
let pc: SimDevice;
let iphone: SimDevice;
let pcContainer: AppContainer;
let phoneContainer: AppContainer;
let reminders: FakeReminders;

const pass = (kind: 'full' | 'push' = 'full') => runRemindersPass(phoneContainer, kind, { send: createSender(phoneContainer) });

/** Un tour de synchro complet dans les deux sens (l'iPhone publie, le PC lit, le PC publie, l'iPhone lit). */
async function sync(): Promise<void> {
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
  syncFolders(devices);
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
}

beforeEach(async () => {
  pc = await createSimDevice(PC_ID, { name: 'PC', start: '2026-10-08T08:00:00.000Z' });
  iphone = await createSimDevice(IPHONE_ID, { name: 'iPhone', clock: pc.clock });
  devices = [pc, iphone];
  await setupFirst(pc);
  await pc.cycle();
  await pair(pc, iphone);
  reminders = createFakeReminders({ now: () => pc.clock.nowMs() });
  reminders.addList({ id: 'L-travail', name: 'Travail', writable: true });
  reminders.addList({ id: 'L-courses', name: 'Courses', writable: true });
  phoneContainer = createAppContainer({ clock: iphone.clock, hlc: iphone.hlc, data: iphone.data, reminders, sync: iphone.service, platform: { runtime: 'tauri', os: 'ios' } });
  pcContainer = createAppContainer({ clock: pc.clock, hlc: pc.hlc, data: pc.data, reminders: createUnavailableReminders(), sync: pc.service, platform: { runtime: 'tauri', os: 'windows' } });
  const state = appleRemindersState(phoneContainer);
  await state.load();
  await state.setLists({ lists: [{ id: 'L-travail', name: 'Travail', spaceId: PRO, shown: true }, { id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: true }] });
});
afterEach(async () => {
  await Promise.all(devices.map((device) => device.close()));
  devices = [];
});

const pcTask = async (title: string) => {
  const rows = await pc.driver.select<{ id: string }>('SELECT id FROM task WHERE title = ? ORDER BY created_at DESC LIMIT 1', [title]);
  const id = rows[0]?.id;
  return id === undefined ? null : await pc.data.repos.tasks.getById(id as never, { includeDeleted: true });
};

describe('arrivée sur le PC par la synchro (K-07 critère 1)', () => {
  it('un rappel importé sur l’iPhone arrive sur le PC : tâche Pro demain 10:00 avec le badge Rappels ; sans échéance dans « Un jour » ; filtre d’espace respecté', async () => {
    reminders.add({ listId: 'L-travail', title: 'Appeler le notaire', due: { date: D('2026-10-09'), time: T('10:00') } });
    reminders.add({ listId: 'L-travail', title: 'Idée sans date' });
    reminders.add({ listId: 'L-courses', title: 'Pain', due: { date: D('2026-10-09'), time: null } });
    expect(await pass()).toMatchObject({ created: 3 });
    await sync();
    const notary = await pcTask('Appeler le notaire');
    expect(notary).toMatchObject({ spaceId: PRO, date: '2026-10-09', time: '10:00', someday: false, source: 'apple_reminders', appleListId: 'L-travail', appleRecurring: false });
    expect(appleLinkState(notary as never)).toBe('linked');
    expect(taskLineSegments(notary as never, { showSpace: false, hasRule: false }).map((segment) => segment.kind)).toEqual(['time', 'apple']);
    expect(await pcTask('Idée sans date')).toMatchObject({ date: null, someday: true, spaceId: PRO });
    // Le filtre Pro / Perso / Tout est respecté.
    expect((await pc.data.repos.tasks.listForDay(D('2026-10-09'), PRO)).map((task) => task.title)).toEqual(['Appeler le notaire']);
    expect((await pc.data.repos.tasks.listForDay(D('2026-10-09'), PERSO)).map((task) => task.title)).toEqual(['Pain']);
    expect((await pc.data.repos.tasks.listForDay(D('2026-10-09'), 'all')).map((task) => task.title).sort()).toEqual(['Appeler le notaire', 'Pain']);
    expect((await pc.data.repos.tasks.listSomeday(PRO)).map((task) => task.title)).toEqual(['Idée sans date']);
    // Les listes suivies et l'heure de la dernière lecture arrivent aussi (réglages partagés).
    const pcState = appleRemindersState(pcContainer);
    await pcState.reload();
    const { appleRemindersStore } = await import('./appleRemindersState');
    expect(appleRemindersStore.get(pcContainer).getState().lists.lists.map((list) => list.name).sort()).toEqual(['Courses', 'Travail']);
    expect(appleRemindersStore.get(pcContainer).getState().lastPassAt).not.toBeNull();
    // Aucune ligne de lien ni statut local ne voyage.
    expect(await pc.driver.select('SELECT * FROM apple_reminder_link')).toEqual([]);
    expect(await pc.data.repos.settings.get('appleReminders.status')).toBeNull();
    // Le PC n'a appelé aucun plugin.
    expect(pcContainer.reminders.available).toBe(false);
  });
});

describe('modifications du PC vers Rappels (K-07 critère 2)', () => {
  it('cocher la tâche sur le PC : synchronisé, rien n’est appelé côté PC ; au passage de l’iPhone le faux magasin reçoit l’achèvement ; aucun doublon, aucune boucle', async () => {
    const reminder = reminders.add({ listId: 'L-travail', title: 'Rapport', due: { date: D('2026-10-09'), time: null } });
    await pass();
    await sync();
    const task = await pcTask('Rapport');
    pc.clock.advance(60_000);
    await createTaskUseCases(pcContainer).complete(task?.id as never);
    await createTaskUseCases(pcContainer).update(task?.id as never, { title: 'Rapport final' });
    await sync();
    expect(reminders.writes).toEqual([]);
    expect(await iphone.task(task?.id as never)).toMatchObject({ status: 'done', title: 'Rapport final' });
    // Au prochain passage de l'iPhone : titre et achèvement partent.
    expect(await pass('full')).toMatchObject({ sent: 1, pending: 0 });
    expect(reminders.get(reminder.id)).toMatchObject({ completed: true, title: 'Rapport final' });
    // Le PC voit que la lecture de l'iPhone est postérieure à sa modification (la mention « sera envoyée » disparaît).
    await sync();
    const { appleRemindersStore } = await import('./appleRemindersState');
    await appleRemindersState(pcContainer).reload();
    const lastPassAt = appleRemindersStore.get(pcContainer).getState().lastPassAt;
    expect(Date.parse(lastPassAt ?? '')).toBeGreaterThanOrEqual(pc.clock.nowMs() - 1_000);
    // Plus rien à envoyer, rien ne revient.
    await sync();
    expect(await pass('full')).toMatchObject({ sent: 0, updated: 0, created: 0, pending: 0 });
    expect(reminders.writes).toHaveLength(1);
    expect((await pc.data.repos.tasks.listAppleSourced()).filter((entry) => entry.title === 'Rapport final')).toHaveLength(1);
  });

  it('une tâche créée sur le PC dans un espace dont la création est activée est créée dans Rappels au passage de l’iPhone', async () => {
    const phoneState = appleRemindersState(phoneContainer);
    await phoneState.setCreate({ bySpace: [{ spaceId: PERSO, enabled: true, listId: 'L-courses' }] });
    await sync();
    const created = await createTaskUseCases(pcContainer).create({ title: 'Acheter du riz (depuis le PC)', spaceId: PERSO, date: D('2026-10-10') });
    expect(created.ok && created.value).toMatchObject({ source: 'apple_reminders', externalId: null, appleListId: 'L-courses' });
    await sync();
    expect(reminders.all()).toEqual([]);
    expect(await pass('full')).toMatchObject({ sent: 1 });
    expect(reminders.all().map((item) => item.title)).toEqual(['Acheter du riz (depuis le PC)']);
    await sync();
    const id = created.ok ? created.value.id : null;
    expect(await pc.data.repos.tasks.getById(id as never)).toMatchObject({ source: 'apple_reminders', externalId: reminders.all()[0]?.id, appleListId: 'L-courses' });
  });
});

describe('rappel terminé ou supprimé dans Rappels (K-07 critère 3)', () => {
  it('terminé : terminé sur le PC après la synchro ; supprimé : supprimé (suppression douce) sur le PC et jamais réapparu', async () => {
    const done = reminders.add({ listId: 'L-travail', title: 'À terminer' });
    const gone = reminders.add({ listId: 'L-travail', title: 'À supprimer' });
    reminders.add({ listId: 'L-travail', title: 'Reste 1' });
    reminders.add({ listId: 'L-travail', title: 'Reste 2' });
    reminders.add({ listId: 'L-travail', title: 'Reste 3' });
    reminders.add({ listId: 'L-travail', title: 'Reste 4' });
    reminders.add({ listId: 'L-travail', title: 'Reste 5' });
    reminders.add({ listId: 'L-travail', title: 'Reste 6' });
    reminders.add({ listId: 'L-travail', title: 'Reste 7' });
    reminders.add({ listId: 'L-travail', title: 'Reste 8' });
    reminders.add({ listId: 'L-travail', title: 'Reste 9' });
    reminders.add({ listId: 'L-travail', title: 'Reste 10' });
    await pass();
    await sync();
    pc.clock.advance(60_000);
    reminders.edit(done.id, { completed: true });
    reminders.remove(gone.id);
    await pass();
    await sync();
    expect(await pcTask('À terminer')).toMatchObject({ status: 'done' });
    const removed = await pcTask('À supprimer');
    expect(removed?.deletedAt).not.toBeNull();
    expect(removed).toMatchObject({ source: 'local', externalId: null });
    // Plusieurs tours de synchro : la suppression ne revient pas (tombstone), aucune boucle.
    await sync();
    await sync();
    expect((await pcTask('À supprimer'))?.deletedAt).not.toBeNull();
    expect((await pc.data.repos.tasks.listAppleSourced()).map((task) => task.title)).not.toContain('À supprimer');
    expect(await pass()).toMatchObject({ created: 0, deleted: 0, sent: 0, updated: 0 });
  });
});

describe('conflit entre le PC et Rappels (K-07 critère 4)', () => {
  it('terminée sur le PC et modifiée dans Rappels avant le passage : les deux changements sont gardés, aucun conflit sur des champs différents', async () => {
    const reminder = reminders.add({ listId: 'L-travail', title: 'Budget' });
    await pass();
    await sync();
    const task = await pcTask('Budget');
    pc.clock.advance(60_000);
    await createTaskUseCases(pcContainer).complete(task?.id as never);
    pc.clock.advance(60_000);
    reminders.edit(reminder.id, { title: 'Budget 2027' });
    await sync();
    expect(await pass('full')).toMatchObject({ sent: 1, updated: 1 });
    await sync();
    expect(reminders.get(reminder.id)).toMatchObject({ completed: true, title: 'Budget 2027' });
    expect(await pcTask('Budget 2027')).toMatchObject({ status: 'done' });
    expect(await iphone.driver.select('SELECT * FROM conflict_log')).toEqual([]);
  });

  it('même titre modifié des deux côtés : le plus récent gagne ; le journal des conflits est sur l’iPhone qui a détecté le conflit, le PC voit le résultat', async () => {
    const reminder = reminders.add({ listId: 'L-travail', title: 'Plan' });
    await pass();
    await sync();
    const task = await pcTask('Plan');
    pc.clock.advance(60_000);
    await createTaskUseCases(pcContainer).update(task?.id as never, { title: 'Plan PC' });
    pc.clock.advance(60_000);
    reminders.edit(reminder.id, { title: 'Plan Rappels' });
    await sync();
    await pass('full');
    await sync();
    expect(reminders.get(reminder.id)?.title).toBe('Plan Rappels');
    expect(await pcTask('Plan Rappels')).not.toBeNull();
    expect(await iphone.driver.select<{ field: string }>('SELECT field FROM conflict_log')).toEqual([{ field: 'title' }]);
    expect(await pc.driver.select("SELECT * FROM conflict_log WHERE discarded_device = 'apple-reminders' OR kept_device = 'apple-reminders'")).toEqual([]);
  });
});

describe('liste décochée sur l’iPhone (K-07 critère 8)', () => {
  it('la tâche non modifiée localement est supprimée et détachée sur le PC ; la tâche modifiée reste, détachée', async () => {
    reminders.add({ id: 'N-1', listId: 'L-courses', title: 'Pas touchée' });
    reminders.add({ id: 'N-2', listId: 'L-courses', title: 'Touchée sur le PC' });
    await pass();
    await sync();
    const touched = await pcTask('Touchée sur le PC');
    pc.clock.advance(60_000);
    await createTaskUseCases(pcContainer).update(touched?.id as never, { title: 'Touchée sur le PC (titre)' });
    await sync();
    const state = appleRemindersState(phoneContainer);
    await state.setLists({ lists: [{ id: 'L-travail', name: 'Travail', spaceId: PRO, shown: true }, { id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: false }] });
    await pass('full');
    await sync();
    const untouched = await pcTask('Pas touchée');
    expect(untouched?.deletedAt).not.toBeNull();
    expect(untouched).toMatchObject({ source: 'local', externalId: null, appleListId: 'L-courses' });
    const kept = await pcTask('Touchée sur le PC (titre)');
    expect(kept).toMatchObject({ source: 'local', externalId: null, appleListId: 'L-courses', deletedAt: null });
    expect(appleLinkState(kept as never)).toBe('detached');
  });
});

describe('aucune notification de rappel côté PC (K-07 critère 9)', () => {
  it('une tâche liée ne produit aucune planification sur le PC : le planificateur du PC est vide', async () => {
    reminders.add({ listId: 'L-travail', title: 'Sans cloche', due: { date: D('2026-10-09'), time: T('10:00') } });
    await pass();
    await sync();
    const container = createAppContainer({ clock: pc.clock, hlc: pc.hlc, data: pc.data, platform: { runtime: 'tauri', os: 'windows' } });
    expect(await container.notifications.availability()).toBe('unavailable');
    expect((await pcTask('Sans cloche'))?.source).toBe('apple_reminders');
  });
});

describe('QA : rappel récurrent refusé sur PC comme sur iPhone, synchro reçue pendant un passage', () => {
  it('K-07 un rappel récurrent importé arrive sur le PC ; case, titre, date et suppression y sont refusés, comme sur l’iPhone ; rien ne voyage ni n’est écrit dans Rappels', async () => {
    const reminder = reminders.add({ listId: 'L-travail', title: 'Poubelles', due: { date: D('2026-10-09'), time: null }, recurring: true });
    await pass();
    await sync();
    const onPc = await pcTask('Poubelles');
    expect(onPc).toMatchObject({ appleRecurring: true, status: 'todo', date: '2026-10-09' });
    const { useNoticeStore } = await import('../../app/notice');
    const refused = (): boolean => useNoticeStore.getState().notice?.text === 'Modifiez ce rappel récurrent dans Rappels.';
    for (const [name, container, id] of [['PC', pcContainer, onPc?.id], ['iPhone', phoneContainer, onPc?.id]] as const) {
      const uc = createTaskUseCases(container);
      for (const act of [
        () => uc.complete(id as never),
        () => uc.update(id as never, { title: `Autre ${name}` }),
        () => uc.update(id as never, { date: D('2026-10-25') }),
        () => uc.remove([id as never]),
      ]) {
        useNoticeStore.getState().clear();
        await act();
        expect(refused(), name).toBe(true);
      }
    }
    pc.clock.advance(60_000);
    await sync();
    expect(await pcTask('Poubelles')).toMatchObject({ title: 'Poubelles', status: 'todo', date: '2026-10-09', deletedAt: null });
    expect(await iphone.task(onPc?.id as never)).toMatchObject({ title: 'Poubelles', status: 'todo', deletedAt: null });
    await pass('full');
    expect(reminders.writes).toEqual([]);
    expect(reminders.get(reminder.id)).toMatchObject({ title: 'Poubelles', completed: false });
    // Quand Rappels passe à l'échéance suivante, la tâche suit sur les deux appareils.
    pc.clock.advance(60_000);
    reminders.edit(reminder.id, { due: { date: D('2026-10-16'), time: null } });
    await pass('full');
    await sync();
    expect(await pcTask('Poubelles')).toMatchObject({ date: '2026-10-16' });
  });

  it('K-07 une modification du PC reçue par la synchro pendant le passage n’est pas écrasée ; les deux champs différents sont gardés', async () => {
    const reminder = reminders.add({ listId: 'L-travail', title: 'Dossier', due: { date: D('2026-10-09'), time: null } });
    await pass();
    await sync();
    const task = await pcTask('Dossier');
    pc.clock.advance(60_000);
    reminders.edit(reminder.id, { title: 'Dossier Rappels' });
    // Pendant la lecture de Rappels par l'iPhone, la date modifiée sur le PC arrive par la synchro.
    const original = reminders.fetch.bind(reminders);
    let hijacked = false;
    reminders.fetch = async (input) => {
      const out = await original(input);
      if (!hijacked) {
        hijacked = true;
        pc.clock.advance(1_000);
        await createTaskUseCases(pcContainer).update(task?.id as never, { date: D('2026-10-30') });
        await sync();
      }
      return out;
    };
    await pass('full');
    reminders.fetch = original;
    // La date du PC est arrivée et n'a pas été remplacée ; aucune perte, aucun conflit sur des champs différents.
    expect(await iphone.task(task?.id as never)).toMatchObject({ date: '2026-10-30' });
    pc.clock.advance(60_000);
    await pass('full');
    await pass('full');
    await sync();
    expect(await iphone.task(task?.id as never)).toMatchObject({ title: 'Dossier Rappels', date: '2026-10-30' });
    expect(reminders.get(reminder.id)).toMatchObject({ title: 'Dossier Rappels', due: { date: '2026-10-30', time: null } });
    expect(await pcTask('Dossier Rappels')).toMatchObject({ date: '2026-10-30' });
    expect(await iphone.driver.select('SELECT * FROM conflict_log')).toEqual([]);
    expect(await pass('full')).toMatchObject({ sent: 0, updated: 0 });
  });
});
