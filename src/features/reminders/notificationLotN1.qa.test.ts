import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationRequest, NotificationScheduler, ReplaceReport } from '../../platform/notifications';
import { createFakeSyncService } from '../sync/testKit';
import { getNotificationRunner } from './notificationRunner';
import { replanNotifications } from './replanNotifications';
import { startNotificationIntegration } from './startNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/** QA du lot N1 : cas non couverts ailleurs (rafale de synchro de bout en bout, annulations par l'adaptateur réel, changements d'heure). */
describe('QA N1 : rafale de 100 écritures de synchro (N-01 critère 8, N-05 critère 3)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders();
  });
  afterEach(() => h.db.close());

  it('N-01 critère 8 : 100 onRemoteChanges pendant un passage = un passage en cours + un seul en attente, jamais deux replace simultanés', async () => {
    let active = 0;
    let maxActive = 0;
    const entered: Array<() => void> = [];
    const enteredPromises = [0, 1, 2].map((index) => new Promise<void>((resolve) => void (entered[index] = resolve)));
    const gates: Array<() => void> = [];
    let started = 0;
    const gated: NotificationScheduler = {
      ...h.fake,
      availability: () => h.fake.availability(),
      permission: () => h.fake.permission(),
      requestPermission: () => h.fake.requestPermission(),
      pending: () => h.fake.pending(),
      reservedCount: () => h.fake.reservedCount(),
      cancelAll: () => h.fake.cancelAll(),
      replace: async (requests: readonly NotificationRequest[]): Promise<ReplaceReport> => {
        const index = started;
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        entered[index]?.();
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return h.fake.replace(requests);
      },
    };
    const sync = createFakeSyncService();
    const container = reopenReminders(h, { parts: { sync, notifications: gated } });
    const doc = { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: () => undefined, removeEventListener: () => undefined };
    const integration = startNotificationIntegration(container, { document: doc as never });
    await enteredPromises[0]; // le passage `open` est dans replace, bloqué
    for (let i = 0; i < 100; i += 1) sync.emitChanges({ tables: new Set(['task']), ids: new Map() });
    const lastOfBurst = getNotificationRunner(container).request('sync');
    expect(started).toBe(1);
    gates[0]?.();
    await integration.opened();
    await enteredPromises[1]; // UN seul passage en attente démarre pour les 101 déclencheurs
    expect(active).toBe(1);
    gates[1]?.();
    await lastOfBurst;
    expect(started).toBe(2);
    expect(maxActive).toBe(1);
    integration.dispose();
  });
});

describe('QA N1 : annulations et changements d’heure par l’adaptateur réel (N-01 critère 4, N-05, N-06)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders({ mode: 'real' });
  });
  afterEach(() => h.db.close());

  // Les récapitulatifs occupent aussi des places : on ne regarde que les titres des tâches.
  const TASK_TITLES = new Set(['À supprimer', 'À terminer', 'Deux rappels']);
  const pendingTitles = (): string[] => [...h.bridge.pendingMap.values()].filter((item) => TASK_TITLES.has(item.title)).map((item) => item.title);

  it('N-01 : tâche supprimée après planification : sa notification est annulée chez iOS', async () => {
    const task = await seedReminderTask(h.container, { title: 'À supprimer', date: '2026-10-09', time: '09:00' });
    await replanNotifications(h.container, 'open');
    expect(pendingTitles()).toEqual(['À supprimer']);
    await h.container.data.repos.tasks.softDelete([task.id]);
    const outcome = await replanNotifications(h.container, 'edit');
    expect(outcome.status).toBe('planned');
    expect(pendingTitles()).toEqual([]);
  });

  it('N-01 : tâche terminée après planification : sa notification est annulée chez iOS', async () => {
    const task = await seedReminderTask(h.container, { title: 'À terminer', date: '2026-10-09', time: '09:00' });
    await replanNotifications(h.container, 'open');
    expect(pendingTitles()).toEqual(['À terminer']);
    await h.container.data.repos.tasks.complete(task.id, '2026-10-08T08:30:00.000Z' as never);
    await replanNotifications(h.container, 'edit');
    expect(pendingTitles()).toEqual([]);
  });

  it('N-05 : un rappel supprimé (ligne supprimée logiquement) ne sonne plus ; les deux autres restent', async () => {
    const task = await seedReminderTask(h.container, { title: 'Deux rappels', date: '2026-10-09', time: '09:00', offsets: [0, 30] });
    await replanNotifications(h.container, 'open');
    expect(pendingTitles()).toHaveLength(2);
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id });
    const kept = reminders.find((r) => r.offsetMin === 0);
    expect(kept).toBeDefined();
    await h.container.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [kept as never]);
    await replanNotifications(h.container, 'sync');
    expect(pendingTitles()).toHaveLength(1);
  });

});

describe('QA N1 : changements d’heure dans la fenêtre de 64 (N-06 critère 3)', () => {
  it('N-06 : heure inexistante (Paris 2027-03-28 02:30) envoyée à 03:30 murale', async () => {
    const h = await setupReminders({ mode: 'real', startAt: '2027-03-27T08:00:00.000Z' });
    await seedReminderTask(h.container, { title: 'Saut', date: '2027-03-28', time: '02:30' });
    expect((await replanNotifications(h.container, 'open')).status).toBe('planned');
    const sent = h.bridge.shown.find((p) => p.title === 'Saut');
    expect(sent?.schedule.at.date).toBe('2027-03-28T03:30:00.000Z');
    expect(sent?.extra['at']).toBe(String(Date.UTC(2027, 2, 28, 1, 30)));
    await h.db.close();
  });

  it('N-06 : heure doublée (Paris 2026-10-25 02:30) planifiée une seule fois, à la première occurrence', async () => {
    const h = await setupReminders({ mode: 'real', startAt: '2026-10-24T08:00:00.000Z' });
    await seedReminderTask(h.container, { title: 'Doublée', date: '2026-10-25', time: '02:30' });
    expect((await replanNotifications(h.container, 'open')).status).toBe('planned');
    const sent = h.bridge.shown.filter((p) => p.title === 'Doublée');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.extra['at']).toBe(String(Date.UTC(2026, 9, 25, 0, 30)));
    await h.db.close();
  });
});
