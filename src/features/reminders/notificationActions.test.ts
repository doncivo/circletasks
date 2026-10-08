import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationNumericId } from '../../domain/notificationId';
import { parseActionQueue, type NotificationActionQueueV1, type RawNotificationAction } from '../../domain/notificationActions';
import { parseNotificationStatus, type NotificationStatusV1 } from '../../domain/notificationStatus';
import type { LocalDate, RoutineId } from '../../domain/types';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { createFakeNotificationActionSource, type FakeNotificationActionSource, type NotificationRequest } from '../../platform/notifications';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { createRoutineUseCases } from '../routines/routineUseCases';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { actionQueueController, dismissActionTrouble } from './actionQueue';
import { actionTypeSpecs } from './notificationActions';
import { getNotificationRunner } from './notificationRunner';
import { replanNotifications, type ReplanOutcome } from './replanNotifications';
import { startNotificationIntegration } from './startNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * N-03 : actions « Fait » et « +15 min » des notifications, du fichier natif (faux de la source) à leur application par les cas d'usage.
 * Horloge : jeu. 8 oct. 2026, 10:00 à Paris. « App tuée » = lignes déjà dans le fichier avant l'ouverture ; « redémarrage » = conteneur,
 * magasins et coordinateur neufs sur la même base.
 */
const banner = () => useAppStatusStore.getState().sources.remindersTrouble;
const storedQueue = async (container: AppContainer): Promise<NotificationActionQueueV1> => {
  const read = parseActionQueue(await container.data.repos.settings.get('notifications.actionQueue'));
  if (read.state !== 'valid') throw new Error('file illisible');
  return read.queue;
};
const storedStatus = async (container: AppContainer): Promise<NotificationStatusV1> => {
  const read = parseNotificationStatus(await container.data.repos.settings.get('notifications.status'));
  if (read.state !== 'valid') throw new Error('état illisible');
  return read.status;
};
const lastRequests = (h: ReminderHarness): readonly NotificationRequest[] => {
  const call = [...h.fake.calls].reverse().find((entry) => entry.type === 'replace');
  if (call?.type !== 'replace') throw new Error('aucun replace');
  return call.requests;
};
const planned = (outcome: ReplanOutcome) => {
  if (outcome.status !== 'planned') throw new Error(`passage non planifié : ${outcome.status}`);
  return outcome;
};
const outbox = async (h: ReminderHarness): Promise<number> => (await h.db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox', []))[0]?.n ?? 0;

/** Ligne du fichier natif pour une notification de rappel de tâche (identifiant stable `task:{reminderId}`). */
function line(h: ReminderHarness, sid: string, actionId: RawNotificationAction['actionId'], over: Partial<RawNotificationAction> = {}): RawNotificationAction {
  return { numericId: notificationNumericId(sid), actionId, receivedAtMs: h.db.clock.nowMs(), sid, deliveredAt: h.db.clock.nowMs() - 30_000, ...over };
}

async function reminderOf(container: AppContainer, taskId: string): Promise<string> {
  const found = (await container.data.repos.reminders.listLive()).find((row) => row.targetId === (taskId as unknown as typeof row.targetId));
  if (found === undefined) throw new Error('rappel introuvable');
  return found.id;
}

describe('N-03 : « Fait » et « +15 min » depuis la notification', () => {
  let source: FakeNotificationActionSource;
  let h: ReminderHarness;
  beforeEach(async () => {
    source = createFakeNotificationActionSource();
    h = await setupReminders({ parts: { notificationActions: source } });
  });
  afterEach(async () => {
    await h.db.close();
    useAppStatusStore.setState({ sources: {} });
  });

  const seedTask = (title = 'Appeler le médecin') => seedReminderTask(h.container, { title, date: '2026-10-08', time: '12:00', offsets: [0] });
  const pass = async (container: AppContainer = h.container, trigger: Parameters<typeof replanNotifications>[1] = 'open') => replanNotifications(container, trigger);

  it('critère 1 : catégories enregistrées avant le premier envoi ; événement = « +15 min » seul ; titres français ; au premier plan', async () => {
    await pass();
    expect(source.calls[0]).toBe('registerActionTypes');
    expect(source.registered).toEqual(actionTypeSpecs());
    expect(source.registered.map((type) => [type.id, type.actions.map((action) => action.id)])).toEqual([
      ['ct.task', ['done', 'snooze15']],
      ['ct.routine', ['done', 'snooze15']],
      ['ct.event', ['snooze15']],
    ]);
    expect(source.registered[0]?.actions.map((action) => action.title)).toEqual(['Fait', '+15 min']);
    expect(source.registered.flatMap((type) => type.actions).every((action) => action.foreground)).toBe(true);
    // Une seule fois par processus.
    await pass(h.container, 'resume');
    expect(source.calls.filter((call) => call === 'registerActionTypes')).toHaveLength(1);
  });

  it('critère 1 : chaque rappel porte la catégorie de sa nature, le récapitulatif aucune', async () => {
    await seedTask();
    await pass();
    const requests = lastRequests(h);
    expect(requests.find((request) => request.kind === 'task')?.category).toBe('task');
    expect(requests.filter((request) => request.kind === 'recap').every((request) => request.category === undefined)).toBe(true);
  });

  it('critères 2 et 3 : « Fait » est d’abord écrit dans la file durable, puis la tâche est terminée par le cas d’usage (annulation 5 s)', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await pass();
    const writes = vi.spyOn(h.container.data.repos.settings, 'set');
    const completes = vi.spyOn(h.container.data.repos.tasks, 'complete');
    source.push(line(h, `task:${rid}`, 'done'));
    planned(await pass(h.container, 'action'));
    // La file est écrite (réglage notifications.actionQueue) AVANT la moindre écriture de la tâche.
    const queueWrite = writes.mock.calls.findIndex((call) => call[0] === 'notifications.actionQueue');
    expect(queueWrite).toBeGreaterThanOrEqual(0);
    expect(completes).toHaveBeenCalledTimes(1);
    expect(writes.mock.invocationCallOrder[queueWrite]).toBeLessThan(completes.mock.invocationCallOrder[0] ?? 0);
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(h.container.undo.getSnapshot()).toMatchObject({ top: { kind: 'complete', labelParams: { title: 'Appeler le médecin' } } });
    // Le fichier natif est acquitté, la file est vide, la clé est gardée, aucun rappel d'une tâche terminée.
    expect(source.file).toEqual([]);
    const queue = await storedQueue(h.container);
    expect(queue.entries).toEqual([]);
    expect(queue.applied).toHaveLength(1);
    expect(lastRequests(h).some((request) => request.kind === 'task')).toBe(false);
    expect(banner()).toBeUndefined();
    writes.mockRestore();
  });

  it('critère 4 : « Fait » sur une routine valide la date de la notification, pas celle du jour d’application', async () => {
    const created = await createRoutineUseCases(h.container).create({
      fields: { spaceId: SPACE_PERSO_ID, title: 'Étirements', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: '2026-09-01' as LocalDate, time: '09:00' as never, paused: false, archived: false },
      reminderOffsets: [0],
    });
    if (!created.ok) throw new Error(created.error);
    const routineId = created.value.id as RoutineId;
    const rid = await reminderOf(h.container, routineId);
    // La notification d'hier est reçue, l'action est appliquée aujourd'hui.
    source.push(line(h, `routine:${rid}:2026-10-07`, 'done'));
    planned(await pass());
    const logs = await h.container.data.repos.routineLogs.listForRoutine(routineId, { from: '2026-10-01' as LocalDate, to: '2026-10-31' as LocalDate });
    expect(logs.map((log) => log.date)).toEqual(['2026-10-07']);
    expect((await storedQueue(h.container)).entries).toEqual([]);
    // L'occurrence du jour (09:00) est passée : l'occurrence suivante prend la place au passage suivant.
    expect(lastRequests(h).find((request) => request.kind === 'routine')?.id).toBe(`routine:${rid}:2026-10-09`);
  });

  it('critère 5 : la même action reçue deux fois (double appui, redémarrage entre deux) n’est appliquée qu’une fois', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    const complete = vi.spyOn(h.container.data.repos.tasks, 'complete');
    source.push(line(h, `task:${rid}`, 'done', { deliveredAt: 1_000 }));
    source.push(line(h, `task:${rid}`, 'done', { deliveredAt: 1_000 }));
    await pass();
    // Après redémarrage, le natif rend encore la ligne (acquittement perdu) : écartée par clé.
    source.push(line(h, `task:${rid}`, 'done', { deliveredAt: 1_000 }));
    await pass(reopenReminders(h, { parts: { notificationActions: source } }), 'open');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(h.container.undo.getSnapshot().size).toBe(1);
    expect((await storedQueue(h.container)).applied).toHaveLength(1);
  });

  it('critère 5 : tâche déjà terminée ou supprimée = succès sans effet, l’entrée est retirée, aucun bandeau', async () => {
    const done = await seedTask('Terminée');
    const gone = await seedTask('Supprimée');
    const doneRid = await reminderOf(h.container, done.id);
    const goneRid = await reminderOf(h.container, gone.id);
    await createTaskUseCases(h.container).complete(done.id);
    await createTaskUseCases(h.container).remove([gone.id]);
    h.container.undo.clear();
    source.push(line(h, `task:${doneRid}`, 'done'));
    source.push(line(h, `task:${goneRid}`, 'done'));
    await pass();
    expect((await storedQueue(h.container)).entries).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    expect(banner()).toBeUndefined();
  });

  it('un rappel supprimé après la notification laisse la tâche agissable', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await h.container.data.repos.reminders.softDeleteForTarget({ type: 'task', id: task.id as never });
    source.push(line(h, `task:${rid}`, 'done'));
    await pass();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
  });

  it('critère 6 : « +15 min » planifie une répétition 15 min après la réponse, même texte, tâche et données inchangées, rien dans sync_outbox', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await pass();
    const outboxBefore = await outbox(h);
    const before = await h.db.data.repos.tasks.getById(task.id);
    const remindersBefore = await h.db.data.repos.reminders.listLive();
    source.push(line(h, `task:${rid}`, 'snooze15'));
    planned(await pass(h.container, 'action'));
    const snooze = lastRequests(h).find((request) => request.kind === 'snooze');
    expect(snooze).toEqual({ id: `snooze:task:${rid}`, fireAt: '2026-10-08T10:15', kind: 'snooze', category: 'task', title: 'Appeler le médecin', body: 'À l’heure' });
    expect(await h.db.data.repos.tasks.getById(task.id)).toEqual(before);
    expect(await h.db.data.repos.reminders.listLive()).toEqual(remindersBefore);
    expect(await outbox(h)).toBe(outboxBefore);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    expect((await storedQueue(h.container)).snoozes).toEqual([{ id: `snooze:task:${rid}`, originId: `task:${rid}`, fireAt: '2026-10-08T10:15' }]);
  });

  it('critère 6 : « +15 min » appliqué deux fois ne crée qu’une répétition, et un appui sur la répétition la décale depuis l’origine', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15', { deliveredAt: 5_000 }));
    source.push(line(h, `task:${rid}`, 'snooze15', { deliveredAt: 5_000 }));
    await pass();
    expect(lastRequests(h).filter((request) => request.kind === 'snooze')).toHaveLength(1);
    // Quinze minutes plus tard, la répétition sonne : « +15 min » encore, sur la notification de la répétition.
    h.db.clock.advance(15 * 60_000);
    source.push(line(h, `snooze:task:${rid}`, 'snooze15', { numericId: notificationNumericId(`snooze:task:${rid}`) }));
    await pass(h.container, 'resume');
    const snoozes = lastRequests(h).filter((request) => request.kind === 'snooze');
    expect(snoozes.map((request) => [request.id, request.fireAt])).toEqual([[`snooze:task:${rid}`, '2026-10-08T10:30']]);
  });

  it('critère 6 : « Fait » sur la répétition termine la tâche d’origine et la répétition disparaît', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15'));
    await pass();
    source.push(line(h, `snooze:task:${rid}`, 'done', { numericId: notificationNumericId(`snooze:task:${rid}`) }));
    await pass(h.container, 'action');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(lastRequests(h).some((request) => request.kind === 'snooze')).toBe(false);
    expect((await storedQueue(h.container)).snoozes).toEqual([]);
  });

  it('critère 7 : tâche terminée sur le PC puis reçue par la synchro : le passage `sync` annule la répétition', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15'));
    await pass();
    expect(lastRequests(h).some((request) => request.kind === 'snooze')).toBe(true);
    await h.db.data.repos.tasks.complete(task.id, '2026-10-08T08:01:00.000Z' as never);
    await pass(h.container, 'sync');
    expect(lastRequests(h).some((request) => request.kind === 'snooze')).toBe(false);
    expect((await storedQueue(h.container)).snoozes).toEqual([]);
  });

  it('critère 6 : une répétition dont l’échéance est passée au passage suivant est purgée de la file', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15'));
    await pass();
    h.db.clock.advance(20 * 60_000);
    await pass(h.container, 'resume');
    expect((await storedQueue(h.container)).snoozes).toEqual([]);
    expect(lastRequests(h).some((request) => request.kind === 'snooze')).toBe(false);
  });

  it('critère 8 : cible introuvable (notification sans identifiant stable, registre perdu) : l’entrée reste, bandeau et Réglages, nouvel essai à chaque passage', async () => {
    source.push({ numericId: 99_999, actionId: 'done', receivedAtMs: h.db.clock.nowMs(), sid: null, deliveredAt: null });
    await pass();
    const queue = await storedQueue(h.container);
    expect(queue.entries).toEqual([expect.objectContaining({ numericId: 99_999, tries: 1, lastError: 'target-not-found' })]);
    expect(banner()?.message).toBe('Une action de notification n’a pas pu être appliquée');
    await pass(reopenReminders(h, { parts: { notificationActions: source } }), 'open');
    expect((await storedQueue(h.container)).entries[0]?.tries).toBe(2);
    // Le bandeau survit au redémarrage (la file est relue avant tout).
    expect(banner()?.message).toBe('Une action de notification n’a pas pu être appliquée');
  });

  it('critère 8 : « Ignorer » écarte l’entrée en échec et le bandeau disparaît', async () => {
    source.push({ numericId: 99_999, actionId: 'done', receivedAtMs: h.db.clock.nowMs(), sid: null, deliveredAt: null });
    await pass();
    expect(banner()).toBeDefined();
    await dismissActionTrouble(h.container);
    expect((await storedQueue(h.container)).entries).toEqual([]);
    expect(banner()).toBeUndefined();
  });

  it('critère 8 : le registre retrouve l’identifiant stable quand le fichier n’en porte pas (adaptateur réel)', async () => {
    await h.db.close();
    source = createFakeNotificationActionSource();
    h = await setupReminders({ mode: 'real', parts: { notificationActions: source } });
    const task = await seedReminderTask(h.container, { title: 'Appeler le médecin', date: '2026-10-08', time: '12:00' });
    const rid = await reminderOf(h.container, task.id);
    planned(await pass());
    source.push({ numericId: notificationNumericId(`task:${rid}`), actionId: 'done', receivedAtMs: h.db.clock.nowMs(), sid: null, deliveredAt: null });
    await pass(h.container, 'action');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(banner()).toBeUndefined();
  });

  it('critère 8 : un échec de la base laisse l’entrée avec `apply-failed`, puis elle est appliquée au passage suivant', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    const complete = vi.spyOn(h.container.data.repos.tasks, 'complete').mockRejectedValueOnce(new Error('base verrouillée'));
    source.push(line(h, `task:${rid}`, 'done'));
    await pass();
    expect((await storedQueue(h.container)).entries[0]).toMatchObject({ lastError: 'apply-failed', tries: 1 });
    expect(banner()).toBeDefined();
    await pass(h.container, 'resume');
    complete.mockRestore();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect((await storedQueue(h.container)).entries).toEqual([]);
    expect(banner()).toBeUndefined();
  });

  it('critère 9 : autorisation retirée, les actions déjà reçues sont tout de même appliquées', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    h.fake.setPermission('denied');
    source.push(line(h, `task:${rid}`, 'done'));
    const outcome = await pass();
    expect(outcome.status).toBe('blocked');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
  });

  it('app tuée : les lignes déjà dans le fichier au lancement sont appliquées au passage `open`', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'done'), { wake: false });
    const relaunched = reopenReminders(h, { parts: { notificationActions: source } });
    planned(await pass(relaunched, 'open'));
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(source.file).toEqual([]);
  });

  it('coupure entre l’écriture de la file et l’acquittement : rien n’est perdu, rien n’est appliqué deux fois', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15'));
    source.failNext('ack');
    await pass();
    // La ligne est restée dans le fichier ; la file l'a déjà ; l'échec est visible.
    expect(source.file).toHaveLength(1);
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('source-failed');
    expect(banner()?.message).toBe('Les boutons « Fait » et « +15 min » sont indisponibles');
    await pass(h.container, 'resume');
    expect(source.file).toEqual([]);
    expect((await storedQueue(h.container)).snoozes).toHaveLength(1);
    expect((await storedStatus(h.container)).actionsFailure).toBeNull();
    expect(banner()).toBeUndefined();
  });

  it('écriture de la file impossible : aucun acquittement (le fichier natif reste le tampon), échec visible, repris ensuite', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'done'));
    const original = h.container.data.repos.settings.set;
    const write = vi.spyOn(h.container.data.repos.settings, 'set').mockImplementation(async (key, value) => {
      if (key === 'notifications.actionQueue') throw new Error('disque plein');
      await original(key, value);
    });
    await pass();
    expect(source.file).toHaveLength(1);
    expect(source.calls.some((call) => call.startsWith('ack'))).toBe(false);
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('queue-write-failed');
    expect(banner()).toBeDefined();
    write.mockRestore();
    await pass(h.container, 'resume');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(source.file).toEqual([]);
    expect(banner()).toBeUndefined();
  });

  it('file pleine : la plus ancienne est écartée, visible jusqu’à « Ignorer »', async () => {
    for (let index = 0; index < 103; index += 1) source.push({ numericId: 90_000 + index, actionId: 'done', receivedAtMs: 1_000 + index, sid: null, deliveredAt: null }, { wake: false });
    await pass();
    const queue = await storedQueue(h.container);
    expect(queue.entries).toHaveLength(100);
    expect(queue.dropped).toBe(3);
    expect(banner()).toBeDefined();
    await dismissActionTrouble(h.container);
    expect(banner()).toBeUndefined();
    expect((await storedQueue(h.container)).dropped).toBe(0);
  });

  it('lignes illisibles ou écritures impossibles côté natif : comptées, visibles, acquittées', async () => {
    source.addUnreadable(2);
    source.addWriteFailures(1);
    await pass();
    expect((await storedQueue(h.container)).lost).toBe(3);
    expect(banner()).toBeDefined();
    expect(await source.drain()).toMatchObject({ lines: 0, unreadable: 0, writeFailures: 0 });
  });

  it('revue : acquittement en échec, passages successifs : le compteur des lignes perdues reste stable (compté après un ack réussi)', async () => {
    source.addUnreadable(2);
    source.failNext('ack');
    await pass();
    await pass(h.container, 'resume');
    // Le deuxième passage a acquitté : les 2 lignes sont comptées une fois.
    expect((await storedQueue(h.container)).lost).toBe(2);
    await pass(h.container, 'resume');
    await pass(h.container, 'resume');
    expect((await storedQueue(h.container)).lost).toBe(2);
  });

  it('revue : acquittement en échec : rien n’est compté tant que le fichier n’est pas acquitté', async () => {
    source.addUnreadable(3);
    source.failNext('ack');
    await pass();
    expect(actionQueueController(h.container).get().lost).toBe(0);
  });

  it('file illisible : jamais perdue en silence (lost = 1, visible)', async () => {
    await h.container.data.repos.settings.set('notifications.actionQueue', { v: 9 });
    await pass();
    expect(actionQueueController(h.container).get().lost).toBe(1);
    expect(banner()).toBeDefined();
    // « Ignorer » réécrit une file valide.
    await dismissActionTrouble(h.container);
    expect(await storedQueue(h.container)).toMatchObject({ lost: 0, entries: [] });
    expect(banner()).toBeUndefined();
  });

  it('délégué repris par un autre : état visible, effacé quand il est retrouvé', async () => {
    source.setDelegate(false);
    await pass();
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('delegate-lost');
    expect(banner()?.message).toBe('Les boutons « Fait » et « +15 min » sont indisponibles');
    source.setDelegate(true);
    await pass(h.container, 'resume');
    expect((await storedStatus(h.container)).actionsFailure).toBeNull();
    expect(banner()).toBeUndefined();
  });

  it('revue : délégué posé après le lancement (delegateAtLaunch faux) : état visible, effacé quand il est de nouveau à l’heure', async () => {
    source.setDelegateAtLaunch(false);
    await pass();
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('delegate-late');
    expect(banner()).toBeDefined();
    source.setDelegateAtLaunch(true);
    await pass(h.container, 'resume');
    expect((await storedStatus(h.container)).actionsFailure).toBeNull();
  });

  it('revue : status en échec n’empêche pas l’écoute du réveil (deux essais séparés)', async () => {
    source.failNext('status');
    const listeners = { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' as const };
    const integration = startNotificationIntegration(h.container, { document: listeners });
    await integration.opened();
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('source-failed');
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'done'));
    await getNotificationRunner(h.container).request('resume');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    integration.dispose();
  });

  it('catégories non enregistrées : visible, nouvel essai au passage suivant', async () => {
    source.failNext('registerActionTypes');
    await pass();
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('register-failed');
    await pass(h.container, 'resume');
    expect(source.calls.filter((call) => call === 'registerActionTypes')).toHaveLength(2);
    expect((await storedStatus(h.container)).actionsFailure).toBeNull();
  });

  it('réveil du plugin : une action écrite app ouverte déclenche un passage `action`', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    const listeners = { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' as const };
    const integration = startNotificationIntegration(h.container, { document: listeners });
    await integration.opened();
    source.push(line(h, `task:${rid}`, 'done'));
    // Le réveil demande un passage ; celui-ci se termine avant le suivant demandé ici.
    await getNotificationRunner(h.container).request('resume');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    integration.dispose();
  });

  it('PC (aucune source) : rien n’est appelé, rien n’est lu', async () => {
    await h.db.close();
    h = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' } });
    const outcome = await pass();
    expect(outcome.status).toBe('pc');
    expect(h.container.notificationActions).toBeNull();
    expect(await h.container.data.repos.settings.get('notifications.actionQueue')).toBeNull();
    expect(actionQueueController(h.container).get().entries).toEqual([]);
  });
});
