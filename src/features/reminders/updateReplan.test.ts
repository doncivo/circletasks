import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStatusStore } from '../app/appStatus';
import { getNotificationRunner } from './notificationRunner';
import { replanNotifications, type ReplanOutcome } from './replanNotifications';
import { SIGNING_TRIGGERS } from './signingNotice';
import { startNotificationIntegration } from './startNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * I-06 critère 11 (ADR 0012 renvoi I-06, ADR 0007 avenant I-06 point 6) : premier lancement d'une nouvelle version : le premier passage
 * est demandé avec le déclencheur `update` (même passage complet que `open`) ; le plan est recalculé et réaffirmé par le nouveau processus,
 * sans doublon ni annulation inutile, plafond de 64 respecté ; un échec de planification reste visible (bandeau N-01).
 */

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
const planned = (outcome: ReplanOutcome) => {
  if (outcome.status !== 'planned') throw new Error(`passage non planifié : ${outcome.status}`);
  return outcome;
};

describe('replanification au premier lancement d’une nouvelle version (critère 11)', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    h = await setupReminders({ mode: 'real' });
    await seedReminderTask(h.container, { title: 'Un', date: '2026-10-09', time: '09:00' });
    await seedReminderTask(h.container, { title: 'Deux', date: '2026-10-09', time: '10:00', offsets: [0, 30] });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.db.close();
  });

  it('lancement « updated » : déclencheur update, plan identique réaffirmé, rien d’annulé, aucun doublon, plafond 64', async () => {
    planned(await replanNotifications(h.container, 'open'));
    const before = [...h.bridge.pendingMap.keys()].sort((a, b) => a - b);
    const cancels = h.bridge.cancels.length;
    const shown = h.bridge.shown.length;

    const updated = reopenReminders(h, { mode: 'real', parts: { launch: 'updated' } });
    const runner = getNotificationRunner(updated);
    const request = vi.spyOn(runner, 'request');
    const integration = startNotificationIntegration(updated, { document: fakeDocument });
    const outcome = planned((await integration.opened()) as ReplanOutcome);
    integration.dispose();

    expect(request.mock.calls[0]).toEqual(['update']);
    expect(outcome.report).toEqual({ scheduled: 0, cancelled: 0, kept: before.length });
    expect(h.bridge.cancels).toHaveLength(cancels);
    // Le nouveau processus réaffirme chaque élément conservé (même identifiant : iOS remplace, pas de doublon).
    expect(h.bridge.shown.length - shown).toBe(before.length);
    expect([...h.bridge.pendingMap.keys()].sort((a, b) => a - b)).toEqual(before);
    expect(h.bridge.pendingMap.size).toBeLessThanOrEqual(64);
  });

  it('lancement ordinaire : déclencheur open inchangé', async () => {
    const same = reopenReminders(h, { mode: 'real', parts: { launch: 'same' } });
    const request = vi.spyOn(getNotificationRunner(same), 'request');
    const integration = startNotificationIntegration(same, { document: fakeDocument });
    await integration.opened();
    integration.dispose();
    expect(request.mock.calls[0]).toEqual(['open']);
  });

  it('update relit l’expiration de la signature (identifiant réservé 2) comme open', () => {
    expect(SIGNING_TRIGGERS).toContain('update');
  });

  it('échec de planification au passage update : échec enregistré et bandeau des rappels, jamais de silence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useAppStatusStore.setState({ sources: {} });
    h.bridge.failShow = () => true;
    const updated = reopenReminders(h, { mode: 'real', parts: { launch: 'updated' } });
    const integration = startNotificationIntegration(updated, { document: fakeDocument });
    const outcome = (await integration.opened()) as ReplanOutcome;
    expect(outcome).toEqual({ status: 'failed', reason: 'schedule-failed' });
    expect(useAppStatusStore.getState().sources.remindersTrouble).toBeDefined();
    integration.dispose();
  });
});
