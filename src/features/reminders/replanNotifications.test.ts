import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { parseNotificationStatus, type NotificationStatusV1 } from '../../domain/notificationStatus';
import { NotificationSchedulerError, type NotificationRequest } from '../../platform/notifications';
import { createFakeSyncService } from '../sync/testKit';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { getNotificationRunner } from './notificationRunner';
import { notificationStatusStore, statusController } from './notificationStatus';
import { requestPermissionOnGesture } from './requestPermission';
import { replanNotifications, type ReplanOutcome } from './replanNotifications';
import { startNotificationIntegration } from './startNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

const banner = () => useAppStatusStore.getState().sources.remindersTrouble;
const stored = async (container: AppContainer): Promise<NotificationStatusV1> => {
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

describe('replanNotifications : données, textes et limite (N-01 critères 7 et 9, N-04 critères 10 à 12)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders();
  });
  afterEach(() => h.db.close());

  it('critère 7 : tâche Perso demain 09:00, « À l’heure » et « 30 min » : deux requêtes de titre = titre de la tâche, corps en français', async () => {
    await seedReminderTask(h.container, { title: 'Appeler le médecin', date: '2026-10-09', time: '09:00', offsets: [0, 30] });
    planned(await replanNotifications(h.container, 'open'));
    const tasks = lastRequests(h).filter((request) => request.kind === 'task');
    expect(tasks).toEqual([
      expect.objectContaining({ fireAt: '2026-10-09T08:30', title: 'Appeler le médecin', body: 'Dans 30 min' }),
      expect.objectContaining({ fireAt: '2026-10-09T09:00', title: 'Appeler le médecin', body: 'À l’heure' }),
    ]);
  });

  it('critère 7 : limit = 64 moins les notifications réservées en attente (1 avec une session Focus planifiée)', async () => {
    expect(planned(await replanNotifications(h.container, 'open')).total).toBeGreaterThan(64);
    expect(lastRequests(h)).toHaveLength(64);
    h.fake.setOutsidePlan(1);
    const outcome = planned(await replanNotifications(h.container, 'resume'));
    expect(lastRequests(h)).toHaveLength(63);
    expect(outcome.coverage.state).toBe('until');
  });

  it('un titre vide est remplacé : replace n’est jamais refusé pour un titre blanc', async () => {
    const task = await seedReminderTask(h.container, { title: 'Titre', date: '2026-10-09', time: '09:00' });
    await h.container.data.repos.tasks.update(task.id, { title: '   ' });
    planned(await replanNotifications(h.container, 'edit'));
    expect(lastRequests(h).find((request) => request.kind === 'task')?.title).toBe('Sans titre');
  });

  it('critère 9 : récapitulatif du jour = buildRecap (titre et 5 premières lignes puis « et {n} autres »), autres jours = texte générique', async () => {
    for (let index = 0; index < 7; index += 1) await seedReminderTask(h.container, { title: `Tâche ${String(index)}`, date: '2026-10-08', time: null, offsets: [] });
    planned(await replanNotifications(h.container, 'open'));
    const requests = lastRequests(h);
    const evening = requests.find((request) => request.id === 'recap:evening:2026-10-08');
    expect(evening).toMatchObject({ kind: 'recap', fireAt: '2026-10-08T21:00', title: '7 éléments non faits' });
    expect(evening?.body.split('\n')).toHaveLength(6);
    expect(evening?.body.split('\n').at(-1)).toBe('et 2 autres');
    // Matin d'aujourd'hui (07:30) : passé, absent ; matin de demain : texte générique (N-07).
    expect(requests.some((request) => request.id === 'recap:morning:2026-10-08')).toBe(false);
    expect(requests.find((request) => request.id === 'recap:morning:2026-10-09')).toMatchObject({
      title: 'Récapitulatif du matin',
      body: 'Ouvrez CircleTasks pour voir votre journée',
    });
    expect(requests.find((request) => request.id === 'recap:evening:2026-10-09')).toMatchObject({ title: 'Récapitulatif du soir', body: 'Ouvrez CircleTasks pour voir votre journée' });
  });

  it('N-04 critère 12 : les plages silencieuses de l’espace Pro (20:00–08:00) ne décalent pas un récapitulatif du soir à 21:00', async () => {
    const spaces = await h.container.data.repos.spaces.listAll();
    expect(spaces.find((space) => space.id === SPACE_PRO_ID)?.quietHours.length).toBeGreaterThan(0);
    planned(await replanNotifications(h.container, 'open'));
    expect(lastRequests(h).find((request) => request.id === 'recap:evening:2026-10-08')?.fireAt).toBe('2026-10-08T21:00');
    // Un rappel Pro à 20:30 est décalé, lui, à la fin de la plage.
    await seedReminderTask(h.container, { title: 'Pro tard', spaceId: SPACE_PRO_ID, date: '2026-10-08', time: '20:30' });
    planned(await replanNotifications(h.container, 'edit'));
    expect(lastRequests(h).find((request) => request.kind === 'task')?.fireAt).toBe('2026-10-09T08:00');
  });

  it('N-04 critère 10 : un récapitulatif désactivé n’est jamais envoyé', async () => {
    await h.container.data.repos.settings.set('reminders.morningRecap', { enabled: false, time: '07:30' as never });
    planned(await replanNotifications(h.container, 'open'));
    expect(lastRequests(h).some((request) => request.id.startsWith('recap:morning'))).toBe(false);
    expect(lastRequests(h).some((request) => request.id.startsWith('recap:evening'))).toBe(true);
  });

  it('N-04 critère 13 : une tâche ajoutée l’après-midi change le texte du récapitulatif du soir (même identifiant)', async () => {
    planned(await replanNotifications(h.container, 'open'));
    const before = lastRequests(h).find((request) => request.id === 'recap:evening:2026-10-08');
    h.db.clock.advance(4 * 3_600_000); // 14:00
    await seedReminderTask(h.container, { title: 'Ajoutée', date: '2026-10-08', time: null, offsets: [] });
    const outcome = planned(await replanNotifications(h.container, 'edit'));
    const after = lastRequests(h).find((request) => request.id === 'recap:evening:2026-10-08');
    expect(after?.id).toBe(before?.id);
    expect(after?.title).not.toBe(before?.title);
    expect(outcome.report.kept).toBeGreaterThan(0);
  });

  it('deux passages sans changement : { 0, 0, n }', async () => {
    await seedReminderTask(h.container, { date: '2026-10-09', time: '09:00' });
    const first = planned(await replanNotifications(h.container, 'open'));
    expect(first.report.scheduled).toBe(64);
    expect(planned(await replanNotifications(h.container, 'resume')).report).toEqual({ scheduled: 0, cancelled: 0, kept: 64 });
  });

  it('aucun titre ni texte de rappel dans le journal technique (codes et nombres seulement)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedReminderTask(h.container, { title: 'Secret médical', date: '2026-10-09', time: '09:00' });
    h.fake.failNextReplace(new NotificationSchedulerError('schedule-failed', ['task:secret'], { scheduled: 1, cancelled: 0, kept: 0 }));
    await replanNotifications(h.container, 'open');
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/Secret|médical|task:secret/);
    warn.mockRestore();
  });
});

describe('PC : « Les rappels sont envoyés par l’iPhone » (N-01 critère 13)', () => {
  it('aucune lecture de données, aucun appel de planification, aucun bandeau, rien d’écrit', async () => {
    const h = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' } });
    const reads = vi.spyOn(h.db.data.repos.reminders, 'listLive');
    const outcome = await replanNotifications(h.container, 'open');
    expect(outcome).toEqual({ status: 'pc' });
    expect(reads).not.toHaveBeenCalled();
    expect(banner()).toBeUndefined();
    expect(await h.db.data.repos.settings.get('notifications.status')).toBeNull();
    expect(notificationStatusStore.get(h.container).getState().availability).toBe('unavailable');
    await h.db.close();
  });

  it('un faux planificateur indisponible sur un PC : aucun appel de planification, aucun échec', async () => {
    const h = await setupReminders({ platform: { runtime: 'tauri', os: 'windows' } });
    h.fake.setAvailability('unavailable');
    expect(await replanNotifications(h.container, 'edit')).toEqual({ status: 'pc' });
    expect(h.fake.calls).toEqual([]);
    expect(banner()).toBeUndefined();
    await h.db.close();
  });

  it('navigateur de développement (web) : même chose, jamais d’échec', async () => {
    const h = await setupReminders({ mode: 'none', platform: { runtime: 'web', os: 'ios' } });
    expect(await replanNotifications(h.container, 'open')).toEqual({ status: 'pc' });
    expect(banner()).toBeUndefined();
    await h.db.close();
  });
});

describe('autorisation : aucun échec silencieux (N-01 critère 11, N-05 critère 5)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders();
  });
  afterEach(() => h.db.close());

  it('refusée : rien n’est envoyé, bandeau persistant, survit à un redémarrage, disparaît dès que granted est relu à la reprise', async () => {
    h.fake.setPermission('denied');
    expect(await replanNotifications(h.container, 'open')).toEqual({ status: 'blocked', permission: 'denied' });
    expect(h.fake.calls.filter((call) => call.type === 'replace')).toEqual([]);
    expect(banner()).toMatchObject({ message: 'Les notifications sont refusées : les rappels ne sonneront pas' });
    expect((await stored(h.container)).permission).toBe('denied');

    // Redémarrage : la page est rouverte, le bandeau est posé dès la lecture de l'état enregistré, avant tout passage.
    useAppStatusStore.setState({ sources: {} });
    const reopened = reopenReminders(h);
    await statusController(reopened).load();
    expect(banner()).toMatchObject({ message: 'Les notifications sont refusées : les rappels ne sonneront pas' });
    // Toujours refusée à l'ouverture suivante : toujours visible.
    expect(await replanNotifications(reopened, 'open')).toEqual({ status: 'blocked', permission: 'denied' });
    expect(banner()).toBeDefined();

    // Rétablie dans Réglages iOS, reprise de l'app : le bandeau disparaît, les rappels se planifient.
    h.fake.setPermission('granted');
    planned(await replanNotifications(reopened, 'resume'));
    expect(banner()).toBeUndefined();
    expect((await stored(reopened)).permission).toBe('granted');
  });

  it('non décidée : invitation « Autoriser » ; la demande se fait sur geste, jamais au démarrage ; elle relance un passage', async () => {
    h.fake.setPermission('undetermined');
    await replanNotifications(h.container, 'open');
    expect(h.fake.calls.some((call) => call.type === 'requestPermission')).toBe(false);
    expect(banner()).toMatchObject({ detail: 'undetermined', message: 'Autorisez les notifications pour recevoir vos rappels' });
    await requestPermissionOnGesture(h.container);
    expect(h.fake.calls.filter((call) => call.type === 'requestPermission')).toHaveLength(1);
    expect(h.fake.calls.some((call) => call.type === 'replace')).toBe(true);
    expect(banner()).toBeUndefined();
  });

  it('le bouton du bandeau « Autoriser » appelle requestPermission() et refusé donne le bandeau « refusées »', async () => {
    h.fake.setPermission('undetermined');
    h.fake.setPermissionAnswer('denied');
    await replanNotifications(h.container, 'open');
    banner()?.onAction?.();
    await vi.waitFor(() => expect(banner()?.message).toBe('Les notifications sont refusées : les rappels ne sonneront pas'));
    expect(h.fake.calls.filter((call) => call.type === 'requestPermission')).toHaveLength(1);
  });
});

describe('échec de planification persistant (N-01 critère 12, N-05 critère 6)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders();
  });
  afterEach(() => h.db.close());

  it.each(['schedule-failed', 'verify-failed', 'over-limit', 'invalid-request', 'unavailable', 'duplicate-id', 'permission-denied', 'ledger-failed'] as const)(
    '%s : écrit (code, heure, nombres de partial), bandeau, survit à un redémarrage, effacé par le premier replace réussi',
    async (reason) => {
      h.fake.failNextReplace(new NotificationSchedulerError(reason, ['a', 'b'], { scheduled: 3, cancelled: 1, kept: 4 }));
      expect(await replanNotifications(h.container, 'hide')).toEqual({ status: 'failed', reason });
      expect((await stored(h.container)).planFailure).toEqual({ at: '2026-10-08T08:00:00.000Z', reason, count: 2, partial: { scheduled: 3, cancelled: 1, kept: 4 } });
      expect(banner()).toMatchObject({ message: 'Les rappels n’ont pas pu être planifiés', onAction: expect.any(Function) });

      // Redémarrage entre l'échec et la résolution.
      useAppStatusStore.setState({ sources: {} });
      const reopened = reopenReminders(h);
      await statusController(reopened).load();
      expect(banner()?.message).toBe('Les rappels n’ont pas pu être planifiés');

      // Le déclencheur suivant relance automatiquement ; le premier replace réussi efface le réglage et le bandeau.
      planned(await replanNotifications(reopened, 'open'));
      expect(banner()).toBeUndefined();
      expect((await stored(reopened)).planFailure).toBeNull();
    },
  );

  it('un plan vide réussi (« Aucun rappel à planifier ») efface aussi l’échec', async () => {
    await h.container.data.repos.settings.set('reminders.morningRecap', { enabled: false, time: '07:30' as never });
    await h.container.data.repos.settings.set('reminders.eveningRecap', { enabled: false, time: '21:00' as never });
    h.fake.failNextReplace(new NotificationSchedulerError('schedule-failed'));
    await replanNotifications(h.container, 'hide');
    expect(banner()).toBeDefined();
    expect(planned(await replanNotifications(h.container, 'open')).coverage).toEqual({ state: 'empty' });
    expect(banner()).toBeUndefined();
  });

  it('une exception inattendue est rattrapée et enregistrée schedule-failed (jamais d’avalement)', async () => {
    vi.spyOn(h.fake, 'replace').mockRejectedValueOnce(new TypeError('boom'));
    expect(await replanNotifications(h.container, 'open')).toEqual({ status: 'failed', reason: 'schedule-failed' });
    expect((await stored(h.container)).planFailure).toMatchObject({ reason: 'schedule-failed', count: 0, partial: null });
    expect(banner()?.message).toBe('Les rappels n’ont pas pu être planifiés');
    vi.spyOn(h.container.data.repos.reminders, 'listLive').mockRejectedValueOnce(new Error('lecture impossible'));
    expect(await replanNotifications(h.container, 'edit')).toEqual({ status: 'failed', reason: 'schedule-failed' });
  });

  it('indisponible sur l’iPhone installé : échec visible (indisponible), pas l’état normal du PC', async () => {
    h.fake.setAvailability('unavailable');
    expect(await replanNotifications(h.container, 'open')).toEqual({ status: 'failed', reason: 'unavailable' });
    expect(banner()?.message).toBe('Les notifications ne sont pas disponibles sur cet iPhone');
  });

  it('valeur d’état illisible : affichée comme un échec de planification jusqu’au passage réussi, qui la réécrit', async () => {
    await h.db.data.repos.settings.set('notifications.status', { v: 99 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reopened = reopenReminders(h);
    await statusController(reopened).load();
    expect(banner()?.message).toBe('Les rappels n’ont pas pu être planifiés');
    expect(warn.mock.calls.flat().join(' ')).toContain('status-unreadable');
    planned(await replanNotifications(reopened, 'open'));
    expect(banner()).toBeUndefined();
    expect((await stored(reopened)).v).toBe(1);
    warn.mockRestore();
  });

  it('écriture de l’état impossible : l’état reste visible pour la session et l’écriture est retentée', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = vi.spyOn(h.db.data.repos.settings, 'set').mockRejectedValue(new Error('disque plein'));
    h.fake.failNextReplace(new NotificationSchedulerError('schedule-failed'));
    await replanNotifications(h.container, 'hide');
    expect(banner()).toBeDefined();
    expect(notificationStatusStore.get(h.container).getState().persistFailed).toBe(true);
    expect(await h.db.data.repos.settings.get('notifications.status')).toBeNull();
    failing.mockRestore();
    h.fake.failNextReplace(new NotificationSchedulerError('verify-failed'));
    await replanNotifications(h.container, 'hide');
    expect((await stored(h.container)).planFailure?.reason).toBe('verify-failed');
    expect(notificationStatusStore.get(h.container).getState().persistFailed).toBe(false);
    warn.mockRestore();
  });
});

describe('déclencheurs et coalescence (N-01 critère 8, N-05 critère 3)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders();
  });
  afterEach(() => h.db.close());

  const replaces = () => h.fake.calls.filter((call) => call.type === 'replace').length;
  const settle = (): Promise<unknown> => getNotificationRunner(h.container).request('action');

  function env() {
    const handlers = new Map<string, () => void>();
    const doc = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (type: string, handler: () => void) => void handlers.set(type, handler),
      removeEventListener: (type: string) => void handlers.delete(type),
    };
    return { doc, handlers };
  }

  it('open : un passage au démarrage ; edit : création d’une tâche et d’un rappel ; la suppression de la tâche annule', async () => {
    const { doc } = env();
    const integration = startNotificationIntegration(h.container, { document: doc as never });
    await integration.opened();
    expect(replaces()).toBe(1);
    const task = await seedReminderTask(h.container, { title: 'Rappel', date: '2026-10-09', time: '09:00' });
    await settle();
    expect(lastRequests(h).some((request) => request.kind === 'task' && request.title === 'Rappel')).toBe(true);
    // Changer l'heure : même identifiant, remplacé.
    const id = lastRequests(h).find((request) => request.kind === 'task')?.id;
    await h.container.data.repos.tasks.update(task.id, { time: '10:00' as never });
    await h.container.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
      { id: (await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id }))[0]?.id as never, targetType: 'task', targetId: task.id, offsetMin: 0, fireAt: '2026-10-09T10:00' as never },
    ]);
    await settle();
    expect(lastRequests(h).find((request) => request.kind === 'task')).toMatchObject({ id, fireAt: '2026-10-09T10:00' });
    // La terminer : annulée.
    await h.container.data.repos.tasks.complete(task.id, '2026-10-08T08:30:00.000Z' as never);
    await settle();
    expect(lastRequests(h).some((request) => request.kind === 'task')).toBe(false);
    integration.dispose();
  });

  it('edit : une plage silencieuse modifiée ou un récapitulatif réglé déclenche un passage', async () => {
    const integration = startNotificationIntegration(h.container, { document: env().doc as never });
    await integration.opened();
    const base = replaces();
    await h.container.data.repos.settings.set('reminders.eveningRecap', { enabled: true, time: '22:00' as never });
    await settle();
    expect(replaces()).toBeGreaterThan(base);
    expect(lastRequests(h).find((request) => request.id === 'recap:evening:2026-10-08')?.fireAt).toBe('2026-10-08T22:00');
    const before = replaces();
    await h.container.data.repos.spaces.update(SPACE_PRO_ID, { quietHours: [] });
    await settle();
    expect(replaces()).toBeGreaterThan(before);
    // Un réglage sans rapport avec les rappels (ou l'état des rappels lui-même) ne déclenche rien.
    const unrelated = replaces();
    await h.container.data.repos.settings.set('ui.theme', 'dark');
    await settle();
    expect(replaces()).toBe(unrelated + 1); // le seul passage de `settle` lui-même
    integration.dispose();
  });

  it('resume et hide : visibilitychange lance un passage dans chaque sens', async () => {
    const { doc, handlers } = env();
    const integration = startNotificationIntegration(h.container, { document: doc as never });
    await integration.opened();
    const base = replaces();
    handlers.get('visibilitychange')?.();
    await settle();
    expect(replaces()).toBe(base + 2);
    doc.visibilityState = 'hidden';
    handlers.get('visibilitychange')?.();
    await settle();
    expect(replaces()).toBe(base + 4);
    integration.dispose();
    expect(handlers.size).toBe(0);
  });

  it('sync : onRemoteChanges sur tâche, routine, pause, validation, événement, rappel, espace, réglage ; pas sur une autre table', async () => {
    const sync = createFakeSyncService();
    const container = reopenReminders(h, { parts: { sync } });
    const { doc } = env();
    const integration = startNotificationIntegration(container, { document: doc as never });
    await integration.opened();
    for (const table of ['task', 'routine', 'routine_pause', 'routine_log', 'event', 'reminder', 'space', 'settings']) {
      const before = replaces();
      sync.emitChanges({ tables: new Set([table]), ids: new Map() });
      await getNotificationRunner(container).request('action');
      expect(replaces(), table).toBe(before + 2);
    }
    const before = replaces();
    sync.emitChanges({ tables: new Set(['checklist']), ids: new Map() });
    await getNotificationRunner(container).request('action');
    expect(replaces()).toBe(before + 1);
    integration.dispose();
  });

  it('N-05 critère 3 / N-07 critère 1 : un rappel créé ailleurs (lu par la synchro) est planifié après le passage `sync`', async () => {
    const sync = createFakeSyncService();
    const container = reopenReminders(h, { parts: { sync } });
    const integration = startNotificationIntegration(container, { document: env().doc as never });
    await integration.opened();
    // Écriture hors du conteneur (application d'un lot reçu : la synchro écrit sur la base brute, sans déclencher `edit`).
    const remote = await createRemoteTask(h);
    sync.emitChanges({ tables: new Set(['task', 'reminder']), ids: new Map() });
    await getNotificationRunner(container).request('action');
    expect(lastRequests(h).find((request) => request.id === `task:${remote}`)).toMatchObject({ kind: 'task', fireAt: '2026-10-08T11:30' });
    integration.dispose();
  });

  it('N-07 critère 2 : un rappel dont l’échéance est déjà passée à la réception n’est ni planifié ni rattrapé, et ce n’est pas une panne', async () => {
    const sync = createFakeSyncService();
    const container = reopenReminders(h, { parts: { sync } });
    const integration = startNotificationIntegration(container, { document: env().doc as never });
    await integration.opened();
    await createRemoteTask(h, '2026-10-08', '09:00');
    sync.emitChanges({ tables: new Set(['reminder']), ids: new Map() });
    await getNotificationRunner(container).request('action');
    expect(lastRequests(h).some((request) => request.kind === 'task')).toBe(false);
    expect(banner()).toBeUndefined();
    integration.dispose();
  });

  it('dispose : plus aucun déclencheur, bandeau retiré', async () => {
    const { doc, handlers } = env();
    h.fake.setPermission('denied');
    const integration = startNotificationIntegration(h.container, { document: doc as never });
    await integration.opened();
    expect(banner()).toBeDefined();
    integration.dispose();
    expect(banner()).toBeUndefined();
    const request = vi.spyOn(getNotificationRunner(h.container), 'request');
    await seedReminderTask(h.container, { date: '2026-10-09', time: '09:00' });
    expect(request).not.toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });
});

/** Tâche et rappel écrits par « un autre appareil » : directement sur la base brute (aucune observation). */
async function createRemoteTask(h: ReminderHarness, date = '2026-10-08', time = '11:30'): Promise<string> {
  const id = `10000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e11)).padStart(12, '0')}`;
  const reminderId = `${id.slice(0, -1)}9`;
  await h.db.driver.execute(
    `INSERT INTO task (id, space_id, title, date, time, status, sort_order, created_at, updated_at, device_id, hlc)
     VALUES (?, ?, 'Venu du PC', ?, ?, 'todo', 1, '2026-10-08T07:00:00.000Z', '2026-10-08T07:00:00.000Z', 'pc', '0000000000001-0000-pc')`,
    [id, SPACE_PERSO_ID, date, time],
  );
  await h.db.driver.execute(
    `INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, delivered, created_at, updated_at, device_id, hlc)
     VALUES (?, 'task', ?, 0, ?, 0, '2026-10-08T07:00:00.000Z', '2026-10-08T07:00:00.000Z', 'pc', '0000000000002-0000-pc')`,
    [reminderId, id, `${date}T${time}`],
  );
  return reminderId;
}
