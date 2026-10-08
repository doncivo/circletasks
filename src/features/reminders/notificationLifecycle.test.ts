import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotificationLedger } from '../../domain/notificationLedger';
import { parseNotificationStatus, type NotificationStatusV1 } from '../../domain/notificationStatus';
import { planNotifications } from '../../domain/notificationPlan';
import { notificationNumericId } from '../../domain/notificationId';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { startAppStartup } from '../app/startup';
import { getNotificationRunner } from './notificationRunner';
import { notificationStatusStore, statusController } from './notificationStatus';
import { replanNotifications, type ReplanOutcome } from './replanNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * N-05 (survie au redémarrage) et N-06 (fuseau) : le cas d'usage réel sur l'adaptateur réel (faux pont iOS, registre dans le réglage
 * local de la vraie base). « Redémarrer » = conteneur, magasins, coordinateur et adaptateur neufs ; l'iPhone garde ses notifications.
 */
const banner = () => useAppStatusStore.getState().sources.remindersTrouble;
const status = async (container: AppContainer): Promise<NotificationStatusV1> => {
  const read = parseNotificationStatus(await container.data.repos.settings.get('notifications.status'));
  if (read.state !== 'valid') throw new Error('état illisible');
  return read.status;
};
const ledgerZone = async (container: AppContainer): Promise<string | null | undefined> => {
  const read = parseNotificationLedger(await container.data.repos.settings.get('notifications.ledger'));
  return read.state === 'valid' ? read.ledger.zone : undefined;
};
const planned = (outcome: ReplanOutcome) => {
  if (outcome.status !== 'planned') throw new Error(`passage non planifié : ${outcome.status}`);
  return outcome;
};

describe('N-05 : les rappels survivent au redémarrage', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders({ mode: 'real' });
    await seedReminderTask(h.container, { title: 'Un', date: '2026-10-09', time: '09:00' });
    await seedReminderTask(h.container, { title: 'Deux', date: '2026-10-09', time: '10:00', offsets: [0, 30] });
  });
  afterEach(() => h.db.close());

  it('critère 1 : application tuée puis relancée, le plan en attente est identique (kept = n), aucun doublon', async () => {
    const first = planned(await replanNotifications(h.container, 'open'));
    expect(first.report.scheduled).toBe(64);
    const before = [...h.bridge.pendingMap.keys()].sort();
    const relaunched = reopenReminders(h, { mode: 'real' });
    const again = planned(await replanNotifications(relaunched, 'open'));
    expect(again.report).toEqual({ scheduled: 0, cancelled: 0, kept: 64 });
    expect([...h.bridge.pendingMap.keys()].sort()).toEqual(before);
    expect(h.bridge.pendingMap.size).toBe(64);
  });

  it('critère 2 : 100 candidats limités à 64, trois jours plus tard à la reprise, le plan avance et « Planifiés jusqu’au » avance', async () => {
    for (let index = 0; index < 40; index += 1) {
      await seedReminderTask(h.container, { title: `T${String(index)}`, date: `2026-10-${String(10 + (index % 20)).padStart(2, '0')}`, time: '15:00' });
    }
    const first = planned(await replanNotifications(h.container, 'open'));
    expect(first.total).toBeGreaterThan(64);
    expect(first.coverage.state).toBe('until');
    h.db.clock.advance(3 * 86_400_000);
    const second = planned(await replanNotifications(h.container, 'resume'));
    expect(second.report.scheduled).toBeGreaterThan(0);
    expect(second.report.cancelled).toBeGreaterThan(0);
    if (first.coverage.state === 'until' && second.coverage.state === 'until') expect(second.coverage.until > first.coverage.until).toBe(true);
    const third = planned(await replanNotifications(h.container, 'resume'));
    expect(third.report).toEqual({ scheduled: 0, cancelled: 0, kept: 64 });
    expect(h.bridge.pendingMap.size).toBe(64);
  });

  it('critère 4 : registre perdu (réinstallation) avec un plan encore en attente : tout replanifié une fois, sans doublon', async () => {
    planned(await replanNotifications(h.container, 'open'));
    const ids = [...h.bridge.pendingMap.keys()].sort();
    await h.db.data.repos.settings.set('notifications.ledger', null);
    const relaunched = reopenReminders(h, { mode: 'real' });
    expect(planned(await replanNotifications(relaunched, 'open')).report).toEqual({ scheduled: 64, cancelled: 0, kept: 0 });
    expect([...h.bridge.pendingMap.keys()].sort()).toEqual(ids);
    expect(planned(await replanNotifications(relaunched, 'resume')).report.kept).toBe(64);
  });

  it('critère 4 : registre illisible = reconstruit avec une information visible, effacée au passage suivant', async () => {
    planned(await replanNotifications(h.container, 'open'));
    await h.db.data.repos.settings.set('notifications.ledger', { v: 1, zone: 12, entries: 'x', focusEnd: null });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const relaunched = reopenReminders(h, { mode: 'real' });
    planned(await replanNotifications(relaunched, 'open'));
    expect((await status(relaunched)).ledgerRebuiltAt).toBe('2026-10-08T08:00:00.000Z');
    expect(warn.mock.calls.flat().join(' ')).toContain('ledger-unreadable');
    expect(h.bridge.pendingMap.size).toBe(64);
    planned(await replanNotifications(relaunched, 'resume'));
    expect((await status(relaunched)).ledgerRebuiltAt).toBeNull();
    warn.mockRestore();
  });

  it('critère 4 (inverse) : registre présent mais plan vidé par iOS : ce qui manque est replanifié', async () => {
    planned(await replanNotifications(h.container, 'open'));
    h.bridge.pendingMap.clear();
    const relaunched = reopenReminders(h, { mode: 'real' });
    expect(planned(await replanNotifications(relaunched, 'open')).report).toEqual({ scheduled: 64, cancelled: 0, kept: 0 });
    expect(h.bridge.pendingMap.size).toBe(64);
  });

  it('critère 6 : échec à la fermeture (hide) puis réouverture réussie : l’échec persistant et le bandeau disparaissent', async () => {
    h.bridge.failShow = () => true;
    expect((await replanNotifications(h.container, 'hide')).status).toBe('failed');
    expect(banner()?.message).toBe('Les rappels n’ont pas pu être planifiés');
    h.bridge.failShow = () => false;
    useAppStatusStore.setState({ sources: {} });
    const relaunched = reopenReminders(h, { mode: 'real' });
    await statusController(relaunched).load();
    expect(banner()).toBeDefined();
    planned(await replanNotifications(relaunched, 'open'));
    expect(banner()).toBeUndefined();
    expect((await status(relaunched)).planFailure).toBeNull();
  });

  it('critère 7 : une échéance passée pendant que l’app est fermée a sonné ; à la réouverture elle n’est ni rattrapée ni re-notifiée', async () => {
    planned(await replanNotifications(h.container, 'open'));
    const dueId = notificationNumericId(`task:${(await h.db.data.repos.reminders.listLive()).find((r) => r.fireAt === '2026-10-09T09:00')?.id ?? ''}`);
    expect(h.bridge.pendingMap.has(dueId)).toBe(true);
    // Le lendemain 09:30 : iOS a fait sonner la notification de 09:00 (elle n'est plus en attente) ; l'app était fermée.
    h.bridge.pendingMap.delete(dueId);
    h.db.clock.set('2026-10-09T07:30:00.000Z');
    const shownBefore = h.bridge.shown.length;
    const relaunched = reopenReminders(h, { mode: 'real' });
    planned(await replanNotifications(relaunched, 'open'));
    expect(h.bridge.shown.slice(shownBefore).some((payload) => payload.id === dueId)).toBe(false);
    expect(h.bridge.pendingMap.has(dueId)).toBe(false);
    expect(banner()).toBeUndefined();
  });

  it('le coordinateur ne retire jamais l’identifiant 1 (fin de Focus) et réduit la place de 1', async () => {
    h.bridge.pendingMap.set(1, { id: 1, title: 'Session terminée', body: 'x', date: '2026-10-09T09:00:00.000Z' });
    const outcome = planned(await replanNotifications(h.container, 'open'));
    expect(outcome.report.scheduled).toBe(63);
    expect(h.bridge.pendingMap.has(1)).toBe(true);
    expect(h.bridge.pendingMap.size).toBe(64);
    expect(h.bridge.cancels.flat()).not.toContain(1);
  });
});

describe('N-06 : mes rappels suivent mon changement de fuseau (option 3)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders({ mode: 'real' });
    await seedReminderTask(h.container, { title: 'Réunion', date: '2026-10-12', time: '09:00' });
  });
  afterEach(() => h.db.close());

  const taskDate = () => [...h.bridge.pendingMap.values()].find((item) => item.title === 'Réunion')?.date;

  it('critère 1 : même plan, fuseau Europe/Paris vers America/New_York : tout replanifié à 09:00 locale du nouveau fuseau', async () => {
    planned(await replanNotifications(h.container, 'open'));
    expect(taskDate()).toBe('2026-10-12T09:00:00.000Z');
    const instantParis = Number(h.bridge.shown.find((payload) => payload.title === 'Réunion')?.extra['at']);
    h.zone.name = 'America/New_York';
    const outcome = planned(await replanNotifications(h.container, 'resume'));
    // L'heure locale de référence recule de 6 h : le récapitulatif du matin d'aujourd'hui (07:30 à New York) entre dans le plan, le dernier en sort.
    expect(outcome.report).toEqual({ scheduled: 64, cancelled: 1, kept: 0 });
    const instantNewYork = Number(h.bridge.shown.findLast((payload) => payload.title === 'Réunion')?.extra['at']);
    expect(instantNewYork - instantParis).toBe(6 * 3_600_000);
    expect(taskDate()).toBe('2026-10-12T09:00:00.000Z');
  });

  it('critère 2 : le fuseau enregistré est mis à jour après un replace réussi ; l’information « Fuseau modifié » est posée puis effacée au passage réussi suivant', async () => {
    planned(await replanNotifications(h.container, 'open'));
    expect(await ledgerZone(h.container)).toBe('Europe/Paris');
    expect((await status(h.container)).zoneChange).toBeNull();
    h.zone.name = 'America/New_York';
    planned(await replanNotifications(h.container, 'resume'));
    expect((await status(h.container)).zoneChange).toEqual({ at: '2026-10-08T08:00:00.000Z', from: 'Europe/Paris', to: 'America/New_York' });
    expect(await ledgerZone(h.container)).toBe('America/New_York');
    planned(await replanNotifications(h.container, 'resume'));
    expect((await status(h.container)).zoneChange).toBeNull();
  });

  it('critère 2 : un échec du replace ne met pas à jour le fuseau enregistré (le prochain déclencheur recommence) et l’information reste', async () => {
    planned(await replanNotifications(h.container, 'open'));
    h.zone.name = 'America/New_York';
    h.bridge.failShow = () => true;
    expect((await replanNotifications(h.container, 'zone')).status).toBe('failed');
    expect(await ledgerZone(h.container)).toBe('Europe/Paris');
    expect((await status(h.container)).zoneChange).toMatchObject({ from: 'Europe/Paris', to: 'America/New_York' });
    h.bridge.failShow = () => false;
    planned(await replanNotifications(h.container, 'zone'));
    expect(await ledgerZone(h.container)).toBe('America/New_York');
    expect(banner()).toBeUndefined();
  });

  it('critère 3 (avenant) : fuseau illisible : passage mené à bout avec le décalage courant, puis état zone-unknown visible, effacé au passage suivant lisible', async () => {
    h.zone.name = null;
    planned(await replanNotifications(h.container, 'open'));
    expect(h.bridge.pendingMap.size).toBe(64);
    expect(taskDate()).toBe('2026-10-12T09:00:00.000Z');
    expect((await status(h.container)).planFailure).toMatchObject({ reason: 'zone-unknown' });
    expect(banner()?.message).toBe('Fuseau de l’appareil illisible : rappels calculés avec le décalage actuel');
    expect(await ledgerZone(h.container)).toBeNull();
    // Persiste tant que le fuseau est illisible, y compris après un redémarrage.
    useAppStatusStore.setState({ sources: {} });
    const relaunched = reopenReminders(h, { mode: 'real' });
    await statusController(relaunched).load();
    expect(banner()).toBeDefined();
    h.zone.name = 'Europe/Paris';
    planned(await replanNotifications(relaunched, 'resume'));
    expect(banner()).toBeUndefined();
    expect(notificationStatusStore.get(relaunched).getState().status.planFailure).toBeNull();
  });

  it('critère 5 : le récapitulatif du soir reste à 21:00 locale après un voyage (jamais filtré par espace ni décalé par une plage silencieuse)', async () => {
    h.zone.name = 'America/New_York';
    planned(await replanNotifications(h.container, 'open'));
    const evening = [...h.bridge.pendingMap.values()].find((item) => item.title === 'Récapitulatif du soir');
    expect(evening?.date).toMatch(/T21:00:00\.000Z$/);
  });

  it('critère 6 : planNotifications rend la même sortie sous deux valeurs de TZ (indépendance du fuseau)', async () => {
    const input = {
      now: '2026-10-08T10:00' as never,
      tasks: [],
      routines: [],
      routinePauses: [],
      routineLogs: [],
      events: [],
      reminders: [],
      spaces: [],
      recaps: { morning: { enabled: true, time: '07:30' as never }, evening: { enabled: true, time: '21:00' as never } },
    };
    const original = process.env['TZ'];
    try {
      const outputs = ['Europe/Paris', 'Pacific/Auckland', 'America/Los_Angeles'].map((zone) => {
        process.env['TZ'] = zone;
        return JSON.stringify(planNotifications(input));
      });
      expect(new Set(outputs).size).toBe(1);
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });

  it('le changement de fuseau du système déclenche un passage `zone` (startup.ts)', async () => {
    const runner = getNotificationRunner(h.container);
    const request = vi.spyOn(runner, 'request');
    const handlers = new Map<string, () => void>();
    const document = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (type: string, handler: () => void) => void handlers.set(type, handler),
      removeEventListener: (type: string) => void handlers.delete(type),
    };
    let zone = 'Europe/Paris';
    const startup = startAppStartup(h.container, {
      document,
      window: { addEventListener: document.addEventListener, removeEventListener: document.removeEventListener },
      detectTimeZone: () => zone,
    } as never);
    await startup.ready;
    expect(request).not.toHaveBeenCalledWith('zone');
    zone = 'America/New_York';
    handlers.get('visibilitychange')?.();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('zone'));
    startup.dispose();
  });
});
