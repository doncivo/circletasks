import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notificationNumericId } from '../../domain/notificationId';
import type { NotificationRequest } from '../../platform/notifications';
import { replanNotifications } from './replanNotifications';
import { seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * N-04 critères 10 à 15 (complément ordre 5) : récapitulatifs du matin et du soir envoyés sur l'iPhone (mêmes planificateur et adaptateur
 * que les rappels). Les cas de texte générique, de plages silencieuses et de récapitulatif désactivé sont dans replanNotifications.test.ts.
 */
const requestsOf = (h: ReminderHarness): readonly NotificationRequest[] => {
  const call = [...h.fake.calls].reverse().find((entry) => entry.type === 'replace');
  if (call?.type !== 'replace') throw new Error('aucun replace');
  return call.requests;
};
const recap = (h: ReminderHarness, id: string): NotificationRequest | undefined => requestsOf(h).find((request) => request.id === id);

describe('récapitulatifs sur l’iPhone : contenu du jour (N-04 critères 10 et 11)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    // 06:00 à Paris : le matin (07:30) et le soir (21:00) d'aujourd'hui sont encore à venir.
    h = await setupReminders({ startAt: '2026-10-08T04:00:00.000Z' });
  });
  afterEach(() => h.db.close());

  it('critère 11 : le matin « 4 éléments aujourd’hui » (tâche faite comprise), le soir « 3 éléments non faits »', async () => {
    for (const title of ['A', 'B', 'C']) await seedReminderTask(h.container, { title, date: '2026-10-08', time: null, offsets: [] });
    const done = await seedReminderTask(h.container, { title: 'D', date: '2026-10-08', time: null, offsets: [] });
    await h.container.data.repos.tasks.complete(done.id, '2026-10-08T03:00:00.000Z' as never);
    await replanNotifications(h.container, 'open');
    expect(recap(h, 'recap:morning:2026-10-08')).toMatchObject({ kind: 'recap', fireAt: '2026-10-08T07:30', title: '4 éléments aujourd’hui' });
    expect(recap(h, 'recap:morning:2026-10-08')?.body.split('\n')).toHaveLength(4);
    expect(recap(h, 'recap:evening:2026-10-08')).toMatchObject({ fireAt: '2026-10-08T21:00', title: '3 éléments non faits' });
    expect(recap(h, 'recap:evening:2026-10-08')?.body).not.toContain('D');
  });

  it('critère 11 : le soir sans élément non fait : « Tout est fait »', async () => {
    const only = await seedReminderTask(h.container, { title: 'Seule', date: '2026-10-08', time: null, offsets: [] });
    await h.container.data.repos.tasks.complete(only.id, '2026-10-08T03:00:00.000Z' as never);
    await replanNotifications(h.container, 'open');
    expect(recap(h, 'recap:evening:2026-10-08')).toMatchObject({ title: 'Tout est fait', body: '' });
  });

  it('critère 10 : à 10:00 (réglages par défaut) : le soir d’aujourd’hui puis matin et soir des jours suivants, comptés dans les 64 ; pas le matin passé', async () => {
    h.db.clock.set('2026-10-08T08:00:00.000Z');
    await replanNotifications(h.container, 'open');
    const ids = requestsOf(h)
      .filter((request) => request.kind === 'recap')
      .map((request) => request.id);
    expect(ids.slice(0, 5)).toEqual(['recap:evening:2026-10-08', 'recap:morning:2026-10-09', 'recap:evening:2026-10-09', 'recap:morning:2026-10-10', 'recap:evening:2026-10-10']);
    expect(ids).not.toContain('recap:morning:2026-10-08');
    expect(requestsOf(h)).toHaveLength(64);
  });

  it('le corps des jours suivants est le texte générique, jamais le contenu du jour', async () => {
    await seedReminderTask(h.container, { title: 'Confidentiel', date: '2026-10-09', time: null, offsets: [] });
    await replanNotifications(h.container, 'open');
    expect(recap(h, 'recap:morning:2026-10-09')?.body).toBe('Ouvrez CircleTasks pour voir votre journée');
    expect(JSON.stringify(recap(h, 'recap:evening:2026-10-09'))).not.toContain('Confidentiel');
  });
});

describe('récapitulatifs sur l’iPhone : mise à jour sans doublon (N-04 critère 13, adaptateur réel)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders({ mode: 'real', startAt: '2026-10-08T08:00:00.000Z' });
  });
  afterEach(() => h.db.close());

  const eveningId = notificationNumericId('recap:evening:2026-10-08');

  it('une tâche ajoutée l’après-midi : le récapitulatif du soir est remplacé (même identifiant, texte différent), aucun doublon', async () => {
    await replanNotifications(h.container, 'open');
    const before = h.bridge.pendingMap.get(eveningId);
    expect(before?.title).toBe('Tout est fait');
    h.db.clock.advance(4 * 3_600_000); // 14:00
    await seedReminderTask(h.container, { title: 'Ajoutée à 14 h', date: '2026-10-08', time: null, offsets: [] });
    const outcome = await replanNotifications(h.container, 'edit');
    expect(outcome).toMatchObject({ status: 'planned', report: { scheduled: 1, cancelled: 0 } });
    expect(h.bridge.pendingMap.get(eveningId)).toMatchObject({ title: '1 élément non fait', body: 'Ajoutée à 14 h' });
    expect(h.bridge.pendingMap.size).toBe(64);
  });

  it('changer l’heure du soir dans Réglages replanifie sans doublon : l’ancienne notification ne sonne plus', async () => {
    await replanNotifications(h.container, 'open');
    const dates = (): string[] => [...h.bridge.pendingMap.values()].filter((item) => item.title === 'Tout est fait' || item.title === 'Récapitulatif du soir').map((item) => item.date);
    expect(dates()[0]).toContain('T21:00:00.000Z');
    await h.container.data.repos.settings.set('reminders.eveningRecap', { enabled: true, time: '22:30' as never });
    const outcome = await replanNotifications(h.container, 'edit');
    expect(outcome.status).toBe('planned');
    expect(h.bridge.pendingMap.get(eveningId)?.date).toBe('2026-10-08T22:30:00.000Z');
    expect([...h.bridge.pendingMap.values()].filter((item) => item.date.endsWith('T21:00:00.000Z') && item.title.includes('soir'))).toEqual([]);
    expect(h.bridge.pendingMap.size).toBeLessThanOrEqual(64);
  });
});

describe('récapitulatifs : PC et échecs (N-04 critères 14 et 15)', () => {
  it('critère 14 : le PC n’émet aucun récapitulatif (aucun appel de planification)', async () => {
    const h = await setupReminders({ platform: { runtime: 'tauri', os: 'windows' } });
    h.fake.setAvailability('unavailable');
    await replanNotifications(h.container, 'open');
    expect(h.fake.calls).toEqual([]);
    await h.db.close();
  });

  it('critère 15 : un échec d’envoi d’un récapitulatif passe par l’état persistant, jamais par un simple journal', async () => {
    const h = await setupReminders({ mode: 'real', startAt: '2026-10-08T08:00:00.000Z' });
    h.bridge.failShow = (payload) => payload.title.includes('Récapitulatif') || payload.extra['sid']?.startsWith('recap:') === true;
    const outcome = await replanNotifications(h.container, 'open');
    expect(outcome).toEqual({ status: 'failed', reason: 'schedule-failed' });
    const stored = (await h.container.data.repos.settings.get('notifications.status')) as { planFailure: { reason: string; count: number } | null };
    expect(stored.planFailure?.reason).toBe('schedule-failed');
    expect(stored.planFailure?.count).toBeGreaterThan(0);
    await h.db.close();
  });
});
