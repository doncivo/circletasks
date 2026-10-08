import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSigningAlert, createFakeSigningSource, type FakeSigningAlert, type FakeSigningSource } from '../../platform/signing';
import { createTauriSigningAlert } from '../../platform/signing/tauriSigningAlert';
import { useAppStatusStore } from '../app/appStatus';
import { replanNotifications } from './replanNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from './testKit';

/** I-02 QA : bornes de l'échéance, fuseau changé, plan à 64 (critères 1, 4, 5, 6). Maintenant : 2026-10-08 08:00 UTC. */
const NOW = Date.parse('2026-10-08T08:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const banner = () => useAppStatusStore.getState().sources.signingExpiry;

describe('I-02 QA : bornes de l’échéance et fuseau', () => {
  let h: ReminderHarness;
  let source: FakeSigningSource;
  let alert: FakeSigningAlert;
  beforeEach(async () => {
    source = createFakeSigningSource();
    alert = createFakeSigningAlert();
    h = await setupReminders({ parts: { signing: { source, alert } } });
  });
  afterEach(() => h.db.close());

  it('I-02 critère 4 : expiration dans 7 jours (profil neuf) : alerte à J+6 exactement, pas de bandeau', async () => {
    source.expireAt(iso(NOW + 7 * 24 * H), iso(NOW));
    await replanNotifications(h.container, 'open');
    expect(alert.scheduled).toHaveLength(1);
    expect(alert.scheduled[0]?.instant).toBe(NOW + 6 * 24 * H);
    expect(banner()).toBeUndefined();
  });

  it('I-02 critère 6 : exactement 24 h restantes : bandeau, aucune alerte', async () => {
    source.expireAt(iso(NOW + 24 * H));
    await replanNotifications(h.container, 'open');
    expect(alert.scheduled).toHaveLength(0);
    expect(banner()?.detail).toBe('soon');
  });

  it('I-02 critère 6 : 23 h 59 restantes : bandeau, aucune alerte', async () => {
    source.expireAt(iso(NOW + 24 * H - 60_000));
    await replanNotifications(h.container, 'open');
    expect(alert.scheduled).toHaveLength(0);
    expect(banner()?.detail).toBe('soon');
    expect(banner()?.message).toBe('CircleTasks expire dans 23 h : actualisez-la dans SideStore');
  });

  it('I-02 critère 4 : 24 h 1 min restantes : alerte dans une minute, pas de bandeau', async () => {
    source.expireAt(iso(NOW + 24 * H + 60_000));
    await replanNotifications(h.container, 'open');
    expect(alert.scheduled).toHaveLength(1);
    expect(alert.scheduled[0]?.instant).toBe(NOW + 60_000);
    expect(banner()).toBeUndefined();
  });

  it('I-02 critère 4 : échéance renvoyée identique à chaque ouverture et reprise : une seule alerte, aucun renvoi', async () => {
    source.expireAt(iso(NOW + 5 * 24 * H));
    for (const trigger of ['open', 'resume', 'resume', 'permission', 'resume'] as const) await replanNotifications(h.container, trigger);
    expect(alert.scheduled).toHaveLength(1);
    expect(alert.cancels).toBe(0);
  });

  it('I-02 critère 4 : échéance changée puis revenue à l’ancienne : remplacement à chaque changement, jamais deux alertes en attente', async () => {
    source.expireAt(iso(NOW + 5 * 24 * H));
    await replanNotifications(h.container, 'open');
    source.expireAt(iso(NOW + 7 * 24 * H));
    await replanNotifications(h.container, 'resume');
    source.expireAt(iso(NOW + 5 * 24 * H));
    await replanNotifications(h.container, 'resume');
    expect(alert.scheduled.map((request) => request.instant)).toEqual([NOW + 4 * 24 * H, NOW + 6 * 24 * H, NOW + 4 * 24 * H]);
    expect(alert.pending?.instant).toBe(NOW + 4 * 24 * H);
  });

  it('I-02 critère 1 : fuseau changé (Paris vers New York) : même instant, heure murale du texte recalculée au passage suivant', async () => {
    source.expireAt('2026-10-14T08:00:00Z');
    await replanNotifications(h.container, 'open');
    expect(alert.scheduled[0]?.zone).toBe('Europe/Paris');
    expect(alert.scheduled[0]?.body).toContain('à 10:00');
    h.zone.name = 'America/New_York';
    await replanNotifications(h.container, 'zone'); // la relecture n'a pas lieu pour ce déclencheur
    expect(alert.scheduled).toHaveLength(1);
    await replanNotifications(h.container, 'resume');
    expect(alert.scheduled).toHaveLength(2);
    expect(alert.scheduled[1]?.instant).toBe(alert.scheduled[0]?.instant);
    expect(alert.scheduled[1]?.zone).toBe('America/New_York');
    expect(alert.scheduled[1]?.body).toContain('à 04:00');
    expect(alert.pending?.zone).toBe('America/New_York');
  });

  it('I-02 critère 1 : fuseau inconnu (null) : l’alerte reste planifiée à l’instant absolu', async () => {
    h.zone.name = null;
    source.expireAt('2026-10-14T08:00:00Z');
    await replanNotifications(h.container, 'open');
    expect(alert.scheduled).toHaveLength(1);
    expect(alert.scheduled[0]?.instant).toBe(Date.parse('2026-10-13T08:00:00Z'));
  });

  it('I-02 critère 6 : échéance exactement atteinte : expirée', async () => {
    source.expireAt(iso(NOW));
    await replanNotifications(h.container, 'open');
    expect(banner()?.detail).toBe('expired');
    expect(alert.scheduled).toHaveLength(0);
  });
});

describe('I-02 QA : plan déjà à 64 (critère 5)', () => {
  it('I-02 critère 5 : 70 rappels au plan : le plan est réduit à 63, l’alerte 2 survit à chaque replace (changement de tâche) et à cancelAll', async () => {
    const source = createFakeSigningSource();
    const h = await setupReminders({ mode: 'real', parts: { signing: { source, alert: createFakeSigningAlert() } } });
    try {
      const alert = createTauriSigningAlert(h.bridge);
      const container = reopenReminders(h, { mode: 'real', parts: { signing: { source, alert } } });
      for (let i = 0; i < 70; i += 1) await seedReminderTask(container, { title: `Tâche ${String(i)}`, date: '2026-10-09', time: `${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` });
      source.expireAt('2026-10-14T08:00:00Z');
      await replanNotifications(container, 'open');
      const reserved = () => [...h.bridge.pendingMap.keys()].filter((id) => id < 65_536);
      expect(reserved()).toEqual([2]);
      expect(h.bridge.pendingMap.size).toBe(64);
      // Plusieurs replace successifs (déclencheur edit : l'alerte n'est pas relue) ne l'effacent jamais.
      for (const trigger of ['edit', 'sync', 'hide', 'resume'] as const) {
        await replanNotifications(container, trigger);
        expect(reserved()).toEqual([2]);
        expect(h.bridge.pendingMap.size).toBe(64);
      }
      await container.notifications.cancelAll();
      expect([...h.bridge.pendingMap.keys()]).toEqual([2]);
    } finally {
      h.db.close();
    }
  });
});
