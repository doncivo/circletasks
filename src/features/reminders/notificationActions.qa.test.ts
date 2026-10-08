import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationNumericId } from '../../domain/notificationId';
import { parseActionQueue, type NotificationActionQueueV1, type RawNotificationAction } from '../../domain/notificationActions';
import { parseNotificationStatus, type NotificationStatusV1 } from '../../domain/notificationStatus';
import type { EventId, LocalDate, RoutineId } from '../../domain/types';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { createFakeNotificationActionSource, type FakeNotificationActionSource, type NotificationRequest } from '../../platform/notifications';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { createEventUseCases } from '../events/eventUseCases';
import { createRoutineUseCases } from '../routines/routineUseCases';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { dismissActionTrouble } from './actionQueue';
import { replanNotifications } from './replanNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * N-03, passe QA : idempotence, cibles disparues, « +15 min » répété, plafond de 64, file et fichier illisibles, redémarrage entre `drain`
 * et `ack`, événements, routines, interaction avec la replanification, « Ignorer » devant un blocage encore présent.
 * Horloge : jeu. 8 oct. 2026, 10:00 à Paris.
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
const snoozesOf = (h: ReminderHarness) => lastRequests(h).filter((request) => request.kind === 'snooze');
const outbox = async (h: ReminderHarness): Promise<number> => (await h.db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_outbox', []))[0]?.n ?? 0;

function line(h: ReminderHarness, sid: string, actionId: RawNotificationAction['actionId'], over: Partial<RawNotificationAction> = {}): RawNotificationAction {
  return { numericId: notificationNumericId(sid), actionId, receivedAtMs: h.db.clock.nowMs(), sid, deliveredAt: h.db.clock.nowMs() - 30_000, ...over };
}
async function reminderOf(container: AppContainer, targetId: string): Promise<string> {
  const found = (await container.data.repos.reminders.listLive()).find((row) => row.targetId === (targetId as unknown as typeof row.targetId));
  if (found === undefined) throw new Error('rappel introuvable');
  return found.id;
}

describe('N-03 QA : cas limites des actions de notification', () => {
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
  const pass = (container: AppContainer = h.container, trigger: Parameters<typeof replanNotifications>[1] = 'open') => replanNotifications(container, trigger);
  const seedEvent = async (title = 'Dentiste') => {
    const created = await createEventUseCases(h.container).create({
      fields: { spaceId: SPACE_PERSO_ID, title, startDate: '2026-10-08' as LocalDate, startTime: '14:00' as never, endDate: '2026-10-08' as LocalDate, endTime: '15:00' as never, allDay: false, kind: 'event', repeat: 'once', important: false, icon: null, birthYear: null },
      reminderOffsets: [0 as never],
    });
    if (!created.ok) throw new Error(created.error);
    return created.value;
  };
  const seedRoutine = async () => {
    const created = await createRoutineUseCases(h.container).create({
      fields: { spaceId: SPACE_PERSO_ID, title: 'Étirements', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: '2026-09-01' as LocalDate, time: '18:00' as never, paused: false, archived: false },
      reminderOffsets: [0],
    });
    if (!created.ok) throw new Error(created.error);
    return created.value.id as RoutineId;
  };
  const RANGE = { from: '2026-10-01' as LocalDate, to: '2026-10-31' as LocalDate };

  it('N-03 idempotence : « Fait » reçu trois fois dans le même fichier = une seule terminaison, une seule annulation', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    const complete = vi.spyOn(h.container.data.repos.tasks, 'complete');
    for (let i = 0; i < 3; i += 1) source.push(line(h, `task:${rid}`, 'done', { deliveredAt: 7_000, receivedAtMs: h.db.clock.nowMs() + i }), { wake: false });
    await pass();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(h.container.undo.getSnapshot().size).toBe(1);
    expect(source.file).toEqual([]);
  });

  it('N-03 idempotence : « +15 min » puis « Fait » de la même notification sont deux actions distinctes ; la répétition créée avant est annulée', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15', { deliveredAt: 9_000 }), { wake: false });
    source.push(line(h, `task:${rid}`, 'done', { deliveredAt: 9_000 }), { wake: false });
    await pass();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(snoozesOf(h)).toHaveLength(0);
    expect((await storedQueue(h.container)).snoozes).toEqual([]);
  });

  it('N-03 cible disparue : « +15 min » sur une tâche supprimée ou déjà terminée ne laisse aucune répétition ni bandeau', async () => {
    const done = await seedTask('Terminée');
    const gone = await seedTask('Supprimée');
    const doneRid = await reminderOf(h.container, done.id);
    const goneRid = await reminderOf(h.container, gone.id);
    await createTaskUseCases(h.container).complete(done.id);
    await createTaskUseCases(h.container).remove([gone.id]);
    h.container.undo.clear();
    source.push(line(h, `task:${doneRid}`, 'snooze15'), { wake: false });
    source.push(line(h, `task:${goneRid}`, 'snooze15'), { wake: false });
    await pass();
    expect(snoozesOf(h)).toHaveLength(0);
    const queue = await storedQueue(h.container);
    expect(queue.entries).toEqual([]);
    expect(queue.snoozes).toEqual([]);
    expect(banner()).toBeUndefined();
  });

  it('N-03 cible disparue : « Fait » sur un rappel dont la ligne n’existe plus reste en échec visible, la tâche n’est pas touchée', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await h.db.driver.execute('DELETE FROM reminder WHERE id = ?', [rid]);
    source.push(line(h, `task:${rid}`, 'done'));
    await pass();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
    expect((await storedQueue(h.container)).entries[0]?.lastError).toBe('target-not-found');
    expect(banner()).toBeDefined();
  });

  it('N-03 « +15 min » répété : trois appuis successifs sur la répétition la décalent chaque fois, une seule répétition, données inchangées', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await pass();
    const outboxBefore = await outbox(h);
    const before = await h.db.data.repos.tasks.getById(task.id);
    source.push(line(h, `task:${rid}`, 'snooze15', { deliveredAt: 1_000 }));
    await pass(h.container, 'action');
    expect(snoozesOf(h).map((request) => request.fireAt)).toEqual(['2026-10-08T10:15']);
    const sid = `snooze:task:${rid}`;
    for (const expected of ['2026-10-08T10:30', '2026-10-08T10:45', '2026-10-08T11:00']) {
      h.db.clock.advance(15 * 60_000);
      source.push(line(h, sid, 'snooze15', { numericId: notificationNumericId(sid), deliveredAt: h.db.clock.nowMs() - 1_000 }));
      await pass(h.container, 'action');
      expect(snoozesOf(h).map((request) => [request.id, request.fireAt])).toEqual([[sid, expected]]);
      expect((await storedQueue(h.container)).snoozes).toHaveLength(1);
    }
    expect(await h.db.data.repos.tasks.getById(task.id)).toEqual(before);
    expect(await outbox(h)).toBe(outboxBefore);
    expect(banner()).toBeUndefined();
  });

  it('N-03 plafond : « +15 min » quand le plan est déjà à 64 reste à 64, la répétition (plus proche) prend la place du dernier élément', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await pass();
    expect(lastRequests(h)).toHaveLength(64);
    const lastBefore = lastRequests(h)[63];
    source.push(line(h, `task:${rid}`, 'snooze15'));
    await pass(h.container, 'action');
    expect(lastRequests(h)).toHaveLength(64);
    expect(snoozesOf(h)).toHaveLength(1);
    expect(lastRequests(h).some((request) => request.id === lastBefore?.id)).toBe(false);
    await pass(h.container, 'resume');
    expect(lastRequests(h)).toHaveLength(64);
  });

  it('N-03 file pleine (100) : les plus anciennes sont écartées (visible), les actions valides les plus récentes sont appliquées', async () => {
    const tasks = [];
    for (let i = 0; i < 3; i += 1) tasks.push(await seedReminderTask(h.container, { title: `T${String(i)}`, date: '2026-10-08', time: '12:00' }));
    const rids = await Promise.all(tasks.map((task) => reminderOf(h.container, task.id)));
    for (let i = 0; i < 100; i += 1) source.push({ numericId: 80_000 + i, actionId: 'done', receivedAtMs: 1_000 + i, sid: null, deliveredAt: null }, { wake: false });
    rids.forEach((rid, i) => source.push(line(h, `task:${rid}`, 'done', { receivedAtMs: h.db.clock.nowMs() + i, deliveredAt: 2_000 + i }), { wake: false }));
    await pass();
    const queue = await storedQueue(h.container);
    expect(queue.entries.length).toBeLessThanOrEqual(100);
    expect(queue.dropped).toBe(3);
    for (const task of tasks) expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(banner()).toBeDefined();
  });

  it('N-03 fichier d’actions illisible : `drain` en échec = rien d’appliqué, état visible, la ligne reste, reprise au passage suivant', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'done'), { wake: false });
    source.failNext('drain');
    await pass();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');
    expect(source.file).toHaveLength(1);
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('source-failed');
    expect(banner()).toBeDefined();
    await pass(h.container, 'resume');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(source.file).toEqual([]);
    expect(banner()).toBeUndefined();
  });

  it('N-03 file locale illisible : une action reçue ensuite est tout de même appliquée, le bandeau reste jusqu’à « Ignorer »', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    await h.container.data.repos.settings.set('notifications.actionQueue', 'pas une file');
    source.push(line(h, `task:${rid}`, 'done'), { wake: false });
    await pass();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(banner()).toBeDefined();
    await pass(h.container, 'resume');
    expect(banner()).toBeDefined();
    await dismissActionTrouble(h.container);
    expect(banner()).toBeUndefined();
    expect((await storedQueue(h.container)).lost).toBe(0);
  });

  it('N-03 redémarrage entre drain et ack : rien de perdu, rien appliqué deux fois, une seule répétition', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    const other = await seedReminderTask(h.container, { title: 'Autre', date: '2026-10-08', time: '13:00' });
    const otherRid = await reminderOf(h.container, other.id);
    source.push(line(h, `task:${rid}`, 'done', { deliveredAt: 3_000 }), { wake: false });
    source.push(line(h, `task:${otherRid}`, 'snooze15', { deliveredAt: 3_100 }), { wake: false });
    source.failNext('ack');
    await pass();
    expect(source.file).toHaveLength(2);
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    // Le processus meurt avant l'acquittement : conteneur neuf, le natif rend encore les deux lignes.
    const relaunched = reopenReminders(h, { parts: { notificationActions: source } });
    const completeAfter = vi.spyOn(relaunched.data.repos.tasks, 'complete');
    await pass(relaunched, 'open');
    expect(completeAfter).not.toHaveBeenCalled();
    expect(source.file).toEqual([]);
    expect(snoozesOf(h)).toHaveLength(1);
    const queue = await storedQueue(relaunched);
    expect(queue.entries).toEqual([]);
    expect(queue.applied).toHaveLength(2);
    expect(queue.snoozes).toHaveLength(1);
  });

  it('N-03 redémarrage après drain, avant toute écriture : la ligne native reste le tampon et est appliquée au redémarrage', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'done'), { wake: false });
    await source.drain();
    expect(await h.container.data.repos.settings.get('notifications.actionQueue')).toBeNull();
    await pass(reopenReminders(h, { parts: { notificationActions: source } }), 'open');
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');
    expect(source.file).toEqual([]);
  });

  it('N-03 événement : « +15 min » répète le rappel (catégorie événement), l’événement est inchangé ; « Fait » est sans effet et sans bandeau', async () => {
    const event = await seedEvent();
    const rid = await reminderOf(h.container, event.id);
    const sid = `event:${rid}:2026-10-08`;
    await pass();
    const before = await h.container.data.repos.events.getById(event.id as EventId);
    const outboxBefore = await outbox(h);
    source.push(line(h, sid, 'snooze15', { deliveredAt: 4_000 }), { wake: false });
    source.push(line(h, sid, 'done', { deliveredAt: 4_000 }), { wake: false });
    await pass(h.container, 'action');
    expect(snoozesOf(h)).toHaveLength(1);
    expect(snoozesOf(h)[0]).toMatchObject({ kind: 'snooze', category: 'event', title: 'Dentiste', fireAt: '2026-10-08T10:15' });
    expect(await h.container.data.repos.events.getById(event.id as EventId)).toEqual(before);
    expect(await outbox(h)).toBe(outboxBefore);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    expect((await storedQueue(h.container)).entries).toEqual([]);
    expect(banner()).toBeUndefined();
  });

  it('N-03 événement supprimé : la répétition en attente est annulée au passage suivant', async () => {
    const event = await seedEvent();
    const rid = await reminderOf(h.container, event.id);
    source.push(line(h, `event:${rid}:2026-10-08`, 'snooze15'));
    await pass();
    expect(snoozesOf(h)).toHaveLength(1);
    await createEventUseCases(h.container).remove(event.id as EventId);
    await pass(h.container, 'sync');
    expect(snoozesOf(h)).toHaveLength(0);
    expect((await storedQueue(h.container)).snoozes).toEqual([]);
  });

  it('N-03 routine : « +15 min » ne valide rien ; « Fait » sur la répétition valide la date d’origine et la répétition disparaît', async () => {
    const routineId = await seedRoutine();
    const rid = await reminderOf(h.container, routineId);
    const sid = `routine:${rid}:2026-10-08`;
    await pass();
    source.push(line(h, sid, 'snooze15', { deliveredAt: 5_000 }));
    await pass(h.container, 'action');
    expect(await h.container.data.repos.routineLogs.listForRoutine(routineId, RANGE)).toEqual([]);
    expect(snoozesOf(h)).toHaveLength(1);
    expect(snoozesOf(h)[0]).toMatchObject({ category: 'routine', title: 'Étirements', fireAt: '2026-10-08T10:15' });
    source.push(line(h, `snooze:${sid}`, 'done', { numericId: notificationNumericId(`snooze:${sid}`) }));
    await pass(h.container, 'action');
    expect((await h.container.data.repos.routineLogs.listForRoutine(routineId, RANGE)).map((log) => log.date)).toEqual(['2026-10-08']);
    expect(snoozesOf(h)).toHaveLength(0);
  });

  it('N-03 routine : « Fait » reçu deux fois, puis relu après redémarrage = une seule ligne de journal, aucun bandeau', async () => {
    const routineId = await seedRoutine();
    const rid = await reminderOf(h.container, routineId);
    const sid = `routine:${rid}:2026-10-07`;
    source.push(line(h, sid, 'done', { deliveredAt: 6_000 }), { wake: false });
    source.push(line(h, sid, 'done', { deliveredAt: 6_000 }), { wake: false });
    await pass();
    source.push(line(h, sid, 'done', { deliveredAt: 6_000 }), { wake: false });
    await pass(reopenReminders(h, { parts: { notificationActions: source } }), 'open');
    const logs = await h.container.data.repos.routineLogs.listForRoutine(routineId, RANGE);
    expect(logs.map((log) => log.date)).toEqual(['2026-10-07']);
    expect(banner()).toBeUndefined();
  });

  it('N-03 routine archivée entre-temps : « Fait » ne crée aucune ligne de journal', async () => {
    const routineId = await seedRoutine();
    const rid = await reminderOf(h.container, routineId);
    await createRoutineUseCases(h.container).setArchived(routineId, true);
    source.push(line(h, `routine:${rid}:2026-10-08`, 'done'));
    await pass();
    expect(await h.container.data.repos.routineLogs.listForRoutine(routineId, RANGE)).toEqual([]);
  });

  it('N-03 replanification : la répétition survit aux passages avant l’heure, puis disparaît (plan et file) après avoir sonné', async () => {
    const task = await seedTask();
    const rid = await reminderOf(h.container, task.id);
    source.push(line(h, `task:${rid}`, 'snooze15'));
    await pass();
    for (const trigger of ['resume', 'sync', 'edit', 'open'] as const) {
      h.db.clock.advance(60_000);
      await pass(trigger === 'open' ? reopenReminders(h, { parts: { notificationActions: source } }) : h.container, trigger);
      expect(snoozesOf(h).map((request) => request.fireAt)).toEqual(['2026-10-08T10:15']);
    }
    h.db.clock.advance(15 * 60_000);
    await pass(h.container, 'resume');
    expect(snoozesOf(h)).toHaveLength(0);
    expect((await storedQueue(h.container)).snoozes).toEqual([]);
    await pass(h.container, 'resume');
    expect(snoozesOf(h)).toHaveLength(0);
  });

  it('N-03 « Ignorer » n’efface pas un blocage encore présent : plugin d’actions en panne, puis permission refusée', async () => {
    source.push({ numericId: 99_998, actionId: 'done', receivedAtMs: h.db.clock.nowMs(), sid: null, deliveredAt: null }, { wake: false });
    source.setDelegate(false);
    await pass();
    expect((await storedQueue(h.container)).entries).toHaveLength(1);
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('delegate-lost');
    await dismissActionTrouble(h.container);
    expect((await storedQueue(h.container)).entries).toEqual([]);
    expect((await storedStatus(h.container)).actionsFailure?.reason).toBe('delegate-lost');
    expect(banner()?.message).toBe('Les boutons « Fait » et « +15 min » sont indisponibles');
    source.setDelegate(true);
    h.fake.setPermission('denied');
    await pass(h.container, 'resume');
    await dismissActionTrouble(h.container);
    expect(banner()).toBeDefined();
  });

  it('N-03 « Ignorer » sur une cible encore introuvable : l’action est écartée une fois, le bandeau part, une nouvelle réception reviendrait en échec', async () => {
    const entry: RawNotificationAction = { numericId: 99_997, actionId: 'done', receivedAtMs: h.db.clock.nowMs(), sid: null, deliveredAt: null };
    source.push(entry, { wake: false });
    await pass();
    expect(banner()).toBeDefined();
    await dismissActionTrouble(h.container);
    expect(banner()).toBeUndefined();
    source.push({ ...entry, receivedAtMs: entry.receivedAtMs + 1 }, { wake: false });
    await pass(h.container, 'resume');
    expect(banner()).toBeDefined();
  });
});
