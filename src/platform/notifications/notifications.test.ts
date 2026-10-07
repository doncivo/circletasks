import { describe, expect, it } from 'vitest';
import { planNotifications } from '../../domain/notificationPlan';
import { asLocalDateTime, asLocalTime } from '../../domain/types';
import type { LocalDateTime } from '../../domain/types';
import { createFakeNotificationScheduler } from './fake';
import { openNotificationScheduler } from './index';
import {
  NOTIFICATION_LIMIT,
  NotificationSchedulerError,
  type NotificationFailure,
  type NotificationKind,
  type NotificationRequest,
  type NotificationScheduler,
} from './types';
import { createUnavailableNotificationScheduler } from './unavailable';

const req = (id: string, fireAt = '2026-10-08T09:00', over: Partial<NotificationRequest> = {}): NotificationRequest => ({
  id,
  fireAt: asLocalDateTime(fireAt),
  title: `Titre ${id}`,
  body: '',
  kind: 'task',
  ...over,
});

async function failureOf(call: () => Promise<unknown>): Promise<NotificationSchedulerError> {
  try {
    await call();
  } catch (error) {
    if (error instanceof NotificationSchedulerError) return error;
    throw error;
  }
  throw new Error('aucun refus');
}

const many = (count: number): NotificationRequest[] =>
  Array.from({ length: count }, (_, i) => req(`task:${String(i).padStart(3, '0')}`, `2026-10-08T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`));

describe('contrat NotificationScheduler (critère 1)', () => {
  it('une requête porte id, fireAt, title, body, kind ; le plafond est 64', async () => {
    expect(NOTIFICATION_LIMIT).toBe(64);
    const fake = createFakeNotificationScheduler();
    await fake.replace([req('recap:evening:2026-10-08', '2026-10-08T21:00', { kind: 'recap', body: 'Tout est fait' })]);
    expect(await fake.pending()).toEqual([{ id: 'recap:evening:2026-10-08', fireAt: '2026-10-08T21:00', title: 'Titre recap:evening:2026-10-08', body: 'Tout est fait', kind: 'recap' }]);
    expect(await fake.availability()).toBe('available');
    expect(await fake.permission()).toBe('granted');
  });

  it('l’erreur typée porte la raison, les identifiants et le travail partiel', () => {
    const error = new NotificationSchedulerError('schedule-failed', ['task:a'], { scheduled: 2, cancelled: 1, kept: 0 });
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('schedule-failed');
    expect(error.ids).toEqual(['task:a']);
    expect(error.partial).toEqual({ scheduled: 2, cancelled: 1, kept: 0 });
    expect(new NotificationSchedulerError('over-limit').partial).toBeNull();
  });
});

describe('faux : replace (critères 2 à 4)', () => {
  it('2 : la même liste deux fois : le second rapport est { 0, 0, n } (idempotent)', async () => {
    const fake = createFakeNotificationScheduler();
    const list = many(5);
    expect(await fake.replace(list)).toEqual({ scheduled: 5, cancelled: 0, kept: 0 });
    expect(await fake.replace(list)).toEqual({ scheduled: 0, cancelled: 0, kept: 5 });
    expect(await fake.replace([...list].reverse())).toEqual({ scheduled: 0, cancelled: 0, kept: 5 });
  });

  it('3 : échéance ou texte changé : replanifié ; identifiant absent : annulé ; pending() = la dernière liste, triée', async () => {
    const fake = createFakeNotificationScheduler();
    await fake.replace([req('task:a', '2026-10-08T09:00'), req('task:b', '2026-10-08T10:00'), req('task:c', '2026-10-08T11:00'), req('task:d', '2026-10-08T12:00')]);
    const report = await fake.replace([
      req('task:d', '2026-10-08T12:00'), // identique
      req('task:a', '2026-10-08T09:30'), // échéance changée
      req('task:b', '2026-10-08T10:00', { body: 'autre texte' }), // texte changé
      req('task:e', '2026-10-08T08:00'), // nouveau ; task:c absent
    ]);
    expect(report).toEqual({ scheduled: 3, cancelled: 1, kept: 1 });
    expect((await fake.pending()).map((r) => [r.id, r.fireAt])).toEqual([
      ['task:e', '2026-10-08T08:00'],
      ['task:a', '2026-10-08T09:30'],
      ['task:b', '2026-10-08T10:00'],
      ['task:d', '2026-10-08T12:00'],
    ]);
    expect((await fake.pending()).find((r) => r.id === 'task:b')?.body).toBe('autre texte');
  });

  it('3 : le titre ou le genre changé replanifie aussi', async () => {
    const fake = createFakeNotificationScheduler();
    await fake.replace([req('task:a'), req('task:b')]);
    expect(await fake.replace([req('task:a', undefined, { title: 'Nouveau' }), req('task:b', undefined, { kind: 'event' })])).toEqual({ scheduled: 2, cancelled: 0, kept: 0 });
  });

  it('3 : cancelAll vide le plan ; une liste vide aussi', async () => {
    const fake = createFakeNotificationScheduler();
    await fake.replace(many(3));
    expect(await fake.replace([])).toEqual({ scheduled: 0, cancelled: 3, kept: 0 });
    await fake.replace(many(2));
    await fake.cancelAll();
    expect(await fake.pending()).toEqual([]);
  });

  it('4 : identifiant en double refusé, sans rien modifier', async () => {
    const fake = createFakeNotificationScheduler();
    await fake.replace([req('task:keep')]);
    const error = await failureOf(() => fake.replace([req('task:b'), req('task:a'), req('task:b')]));
    expect(error.reason).toBe('duplicate-id');
    expect(error.ids).toEqual(['task:b']);
    expect((await fake.pending()).map((r) => r.id)).toEqual(['task:keep']);
  });

  it('4 : plus de 64 requêtes refusé (over-limit), 64 accepté, les identifiants en trop sont rendus', async () => {
    const fake = createFakeNotificationScheduler();
    expect(await fake.replace(many(64))).toEqual({ scheduled: 64, cancelled: 0, kept: 0 });
    const error = await failureOf(() => fake.replace(many(66)));
    expect(error.reason).toBe('over-limit');
    expect(error.ids).toEqual(['task:064', 'task:065']);
    expect(await fake.pending()).toHaveLength(64);
  });

  it('4 : les notifications en attente hors plan comptent dans les 64', async () => {
    const fake = createFakeNotificationScheduler();
    fake.setOutsidePlan(1);
    expect((await failureOf(() => fake.replace(many(64)))).reason).toBe('over-limit');
    expect(await fake.replace(many(63))).toEqual({ scheduled: 63, cancelled: 0, kept: 0 });
  });

  it.each<[string, Partial<NotificationRequest>]>([
    ['échéance mal formée', { fireAt: '2026-10-08 09:00' as LocalDateTime }],
    ['échéance impossible', { fireAt: '2026-02-30T09:00' as LocalDateTime }],
    ['titre vide', { title: '   ' }],
    ['nature inconnue', { kind: 'alarme' as NotificationKind }],
    ['identifiant vide', { id: '' }],
  ])('4 : requête invalide (%s) refusée, sans rien modifier', async (_label, over) => {
    const fake = createFakeNotificationScheduler();
    await fake.replace([req('task:keep')]);
    const error = await failureOf(() => fake.replace([req('task:ok'), req('task:bad', undefined, over)]));
    expect(error.reason).toBe('invalid-request');
    expect(error.ids).toEqual([over.id ?? 'task:bad']);
    expect((await fake.pending()).map((r) => r.id)).toEqual(['task:keep']);
  });

  it('les appels sont enregistrés ; la permission et les échecs sont injectables', async () => {
    const fake = createFakeNotificationScheduler();
    fake.setPermission('undetermined');
    fake.setPermissionAnswer('denied');
    expect(await fake.permission()).toBe('undetermined');
    expect(await fake.requestPermission()).toBe('denied');
    fake.setAvailability('unavailable');
    expect(await fake.availability()).toBe('unavailable');
    fake.failNextReplace(new NotificationSchedulerError('verify-failed', ['task:a'], { scheduled: 1, cancelled: 0, kept: 0 }));
    const error = await failureOf(() => fake.replace([req('task:a')]));
    expect(error).toMatchObject({ reason: 'verify-failed', ids: ['task:a'] });
    // L'échec est consommé : l'appel suivant réussit, et l'échec n'a rien modifié.
    expect(await fake.replace([req('task:a')])).toEqual({ scheduled: 1, cancelled: 0, kept: 0 });
    await fake.cancelAll();
    expect(fake.calls.map((call) => call.type)).toEqual(['requestPermission', 'replace', 'replace', 'cancelAll']);
  });
});

describe('implémentation vide (critères 4 et 5)', () => {
  it('indisponible, autorisation refusée, aucun effet', async () => {
    const empty = createUnavailableNotificationScheduler();
    expect(await empty.availability()).toBe('unavailable');
    expect(await empty.permission()).toBe('denied');
    expect(await empty.requestPermission()).toBe('denied');
    expect(await empty.replace(many(10))).toEqual({ scheduled: 0, cancelled: 0, kept: 0 });
    expect(await empty.pending()).toEqual([]);
    await expect(empty.cancelAll()).resolves.toBeUndefined();
  });

  it('applique les mêmes refus typés que le faux', async () => {
    const lists: [NotificationFailure, NotificationRequest[]][] = [
      ['duplicate-id', [req('task:a'), req('task:a')]],
      ['over-limit', many(65)],
      ['invalid-request', [req('task:a', undefined, { title: '' })]],
    ];
    for (const [reason, list] of lists) {
      const fromEmpty = await failureOf(() => createUnavailableNotificationScheduler().replace(list));
      const fromFake = await failureOf(() => createFakeNotificationScheduler().replace(list));
      expect(fromEmpty.reason).toBe(reason);
      expect(fromEmpty.reason).toBe(fromFake.reason);
      expect(fromEmpty.ids).toEqual(fromFake.ids);
    }
  });

  it('le résolveur rend l’implémentation vide pour tout environnement', async () => {
    const combos: [Parameters<typeof openNotificationScheduler>[0], Parameters<typeof openNotificationScheduler>[1]][] = [
      ['tauri', 'windows'],
      ['tauri', 'ios'],
      ['tauri', 'other'],
      ['web', 'windows'],
      ['web', 'ios'],
      ['web', 'other'],
    ];
    for (const [runtime, os] of combos) {
      const scheduler: NotificationScheduler = openNotificationScheduler(runtime, os);
      expect(await scheduler.availability(), `${runtime}/${os}`).toBe('unavailable');
      expect(await scheduler.replace([req('task:a')])).toEqual({ scheduled: 0, cancelled: 0, kept: 0 });
      expect(await scheduler.pending()).toEqual([]);
    }
  });
});

describe('planificateur et contrat ensemble (critère 6)', () => {
  const base = {
    tasks: [],
    routines: [],
    routinePauses: [],
    routineLogs: [],
    events: [],
    reminders: [],
    spaces: [],
    recaps: { morning: { enabled: true, time: asLocalTime('07:30') }, evening: { enabled: true, time: asLocalTime('21:00') } },
  } as const;

  it('avec une session Focus planifiée (limit 63), le plan complet est accepté par le faux ; à 64 il serait refusé', async () => {
    const fake = createFakeNotificationScheduler();
    fake.setOutsidePlan(1);
    const toRequests = (limit: number) =>
      planNotifications({ ...base, now: asLocalDateTime('2026-10-07T10:00'), limit }).items.map((item) => req(item.id, item.fireAt, { kind: item.kind }));
    expect(await fake.replace(toRequests(63))).toMatchObject({ scheduled: 63 });
    expect((await failureOf(() => fake.replace(toRequests(64)))).reason).toBe('over-limit');
  });
});
