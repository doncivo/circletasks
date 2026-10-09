import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStatusStore } from '../app/appStatus';
import { createFakeSigningAlert, createFakeSigningSource, type FakeSigningAlert, type FakeSigningSource } from '../../platform/signing';
import { createTauriSigningAlert } from '../../platform/signing/tauriSigningAlert';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { replanNotifications, type ReplanOutcome } from './replanNotifications';
import { startNotificationIntegration } from './startNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/**
 * I-06 critère 11, QA : le premier lancement d'une nouvelle version rejoue le passage complet dans les cas où le nouveau processus ne
 * retrouve pas l'état d'avant (notifications perdues côté iOS, registre en retard sur les tâches, alerte d'expiration à reposer, plafond),
 * et un échec n'est jamais muet. Maintenant : 2026-10-08 08:00 UTC.
 */

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
const IN_6_DAYS = '2026-10-14T08:00:00Z';
const planned = (outcome: ReplanOutcome) => {
  if (outcome.status !== 'planned') throw new Error(`passage non planifié : ${outcome.status}`);
  return outcome;
};
const ids = (h: ReminderHarness): number[] => [...h.bridge.pendingMap.keys()].sort((a, b) => a - b);

/** Un nouveau processus au premier lancement d'une nouvelle version ; `inspect` s'exécute avant `dispose()` (qui retire les bandeaux). */
async function updateLaunch(h: ReminderHarness, parts: Parameters<typeof reopenReminders>[1] = {}, inspect: () => void = () => undefined): Promise<ReplanOutcome> {
  const container = reopenReminders(h, { mode: 'real', ...parts, parts: { launch: 'updated', ...parts.parts } });
  const integration = startNotificationIntegration(container, { document: fakeDocument });
  const outcome = (await integration.opened()) as ReplanOutcome;
  inspect();
  integration.dispose();
  return outcome;
}

describe('critère 11 (QA) : replanification complète au premier lancement d’une nouvelle version', () => {
  let h: ReminderHarness;
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h = await setupReminders({ mode: 'real' });
    await seedReminderTask(h.container, { title: 'Un', date: '2026-10-09', time: '09:00' });
    await seedReminderTask(h.container, { title: 'Deux', date: '2026-10-09', time: '10:00', offsets: [0, 30] });
    planned(await replanNotifications(h.container, 'open'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.db.close();
  });

  it('notifications effacées par la mise à jour (liste d’iOS vide, registre gardé) : le plan est reposé en entier, mêmes identifiants, sans doublon', async () => {
    const before = ids(h);
    expect(before.length).toBeGreaterThanOrEqual(3);
    h.bridge.pendingMap.clear();
    const outcome = planned(await updateLaunch(h));
    expect(outcome.report.scheduled).toBe(before.length);
    expect(ids(h)).toEqual(before);
    expect(new Set(ids(h)).size).toBe(before.length);
  });

  it('tâche supprimée sans que le registre le sache (processus tué pendant la mise à jour) : sa notification est annulée au premier lancement', async () => {
    const before = ids(h);
    const gone = await seedReminderTask(h.container, { title: 'À supprimer', date: '2026-10-09', time: '09:15' });
    planned(await replanNotifications(h.container, 'edit'));
    const titled = (): number[] => [...h.bridge.pendingMap.values()].filter((p) => p.title === 'À supprimer').map((p) => p.id);
    expect(titled()).toHaveLength(1);
    await createTaskUseCases(h.container).remove([gone.id]);
    planned(await updateLaunch(h));
    expect(titled()).toEqual([]);
    expect(ids(h)).toEqual(before);
  });

  it('plafond de 64 : beaucoup de rappels, le nouveau processus ne dépasse jamais 64 en attente et ne duplique rien', async () => {
    for (let i = 0; i < 70; i += 1) await seedReminderTask(h.container, { title: `Tâche ${String(i)}`, date: '2026-10-10', time: `${String(8 + (i % 12)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}` });
    planned(await replanNotifications(h.container, 'edit'));
    expect(h.bridge.pendingMap.size).toBeLessThanOrEqual(64);
    h.bridge.pendingMap.clear();
    planned(await updateLaunch(h));
    expect(h.bridge.pendingMap.size).toBe(64);
  });

  it('alerte d’expiration (identifiant 2) reposée par le nouveau processus, et Focus (identifiant 1) non touché', async () => {
    const source: FakeSigningSource = createFakeSigningSource();
    const alert: FakeSigningAlert = createFakeSigningAlert();
    source.expireAt(IN_6_DAYS);
    const first = reopenReminders(h, { mode: 'real', parts: { signing: { source, alert } } });
    planned(await replanNotifications(first, 'open'));
    expect(alert.scheduled).toHaveLength(1);
    // Focus : notification de fin d'identifiant 1 posée avant la mise à jour.
    h.bridge.pendingMap.set(1, { id: 1, title: 'Focus terminé', body: '', date: '2026-10-08T08:25:00.000Z' });
    await updateLaunch(h, { parts: { signing: { source, alert } } });
    expect(alert.scheduled).toHaveLength(2);
    expect(h.bridge.pendingMap.has(1)).toBe(true);
  });

  it('alerte d’expiration, adaptateur réel : identifiant 2 présent après la mise à jour même si iOS a tout effacé', async () => {
    const source = createFakeSigningSource();
    source.expireAt(IN_6_DAYS);
    const alert = createTauriSigningAlert(h.bridge);
    h.bridge.pendingMap.clear();
    await updateLaunch(h, { parts: { signing: { source, alert } } });
    expect(h.bridge.pendingMap.has(2)).toBe(true);
    expect([...h.bridge.pendingMap.keys()].filter((id) => id < 65_536)).toEqual([2]);
  });

  it('échec de planification au premier lancement : bandeau N-01 posé et conservé au lancement suivant tant que ça échoue, retiré quand ça réussit', async () => {
    useAppStatusStore.setState({ sources: {} });
    h.bridge.pendingMap.clear();
    h.bridge.failShow = () => true;
    expect(await updateLaunch(h, {}, () => expect(useAppStatusStore.getState().sources.remindersTrouble).toBeDefined())).toEqual({ status: 'failed', reason: 'schedule-failed' });
    // Le lancement suivant n'est plus une « mise à jour » (version mémorisée) : le passage `open` retente et garde le bandeau.
    const next = reopenReminders(h, { mode: 'real', parts: { launch: 'same' } });
    const integration = startNotificationIntegration(next, { document: fakeDocument });
    expect(((await integration.opened()) as ReplanOutcome).status).toBe('failed');
    expect(useAppStatusStore.getState().sources.remindersTrouble).toBeDefined();
    integration.dispose();
    // Le problème disparaît : le plan est posé et le bandeau part.
    h.bridge.failShow = () => false;
    const fixed = reopenReminders(h, { mode: 'real', parts: { launch: 'same' } });
    const again = startNotificationIntegration(fixed, { document: fakeDocument });
    planned((await again.opened()) as ReplanOutcome);
    expect(useAppStatusStore.getState().sources.remindersTrouble).toBeUndefined();
    again.dispose();
    expect(ids(h).length).toBeGreaterThanOrEqual(3);
  });
});
