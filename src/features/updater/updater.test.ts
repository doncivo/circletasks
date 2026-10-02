import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { UpdateInstallError } from '../../platform';
import { createFakeDesktop, fakePendingUpdate, type FakeDesktop } from '../../platform/desktop/testing';
import { createAppContainer, type AppContainer } from '../app/container';
import { CHECK_INTERVAL_MS, LAUNCH_CHECK_DELAY_MS, startUpdateChecks, type UpdateTimers } from './updateChecks';
import { updaterStore } from './updaterStore';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d3');
const HOUR = 60 * 60 * 1000;

describe('mise à jour PC (D-03)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let warn: MockInstance;
  let container: AppContainer;
  const store = () => updaterStore.get(container);

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: db.data,
      desktop,
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  describe('vérification', () => {
    it('version supérieure : proposée avec ses notes ; lastCheckAt est mis à jour (critères 1 et 2)', async () => {
      desktop.nextCheck = fakePendingUpdate('1.2.0', { notes: 'Nouveautés' });
      await expect(store().getState().check()).resolves.toBe('ok');
      expect(store().getState()).toMatchObject({ status: 'available', version: '1.2.0', notes: 'Nouveautés', bannerVisible: true });
      await expect(db.data.repos.settings.get('desktop.updater')).resolves.toEqual({ lastCheckAt: '2026-10-01T08:00:00.000Z' });
    });

    it('version égale ou inférieure : rien à afficher (critère 3)', async () => {
      desktop.nextCheck = null;
      await store().getState().check();
      expect(store().getState()).toMatchObject({ status: 'upToDate', bannerVisible: false, version: null });
    });

    it('réseau absent ou latest.json inaccessible : non bloquant, journalisé, état « échec » (critère 6)', async () => {
      desktop.nextCheck = new Error('réseau absent');
      await expect(store().getState().check()).resolves.toBe('failed');
      expect(store().getState()).toMatchObject({ status: 'checkFailed', bannerVisible: false });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('réseau absent'));
      await expect(db.data.repos.settings.get('desktop.updater')).resolves.toEqual({ lastCheckAt: null });
    });

    it('« Plus tard » ferme le bandeau ; la même version est reproposée à la vérification suivante (QB-16)', async () => {
      desktop.nextCheck = fakePendingUpdate('1.2.0');
      await store().getState().check();
      store().getState().later();
      expect(store().getState().bannerVisible).toBe(false);
      desktop.nextCheck = fakePendingUpdate('1.2.0');
      await store().getState().check();
      expect(store().getState()).toMatchObject({ status: 'available', version: '1.2.0', bannerVisible: true });
    });

    it('la ressource de la mise à jour précédente est libérée', async () => {
      const first = fakePendingUpdate('1.2.0');
      desktop.nextCheck = first;
      await store().getState().check();
      desktop.nextCheck = null;
      await store().getState().check();
      expect(first.disposed.count).toBe(1);
    });

    it('« Voir les notes » bascule l’affichage des notes', async () => {
      desktop.nextCheck = fakePendingUpdate('1.2.0');
      await store().getState().check();
      store().getState().toggleNotes();
      expect(store().getState().notesOpen).toBe(true);
      store().getState().toggleNotes();
      expect(store().getState().notesOpen).toBe(false);
    });

    it('sans intégration PC : aucune vérification', async () => {
      const web = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      await expect(updaterStore.get(web).getState().check()).resolves.toBe('ok');
      expect(updaterStore.get(web).getState().status).toBe('idle');
    });
  });

  describe('installation', () => {
    it('télécharge avec progression puis installe (critère 4)', async () => {
      let release: () => void = () => undefined;
      const pending = fakePendingUpdate('1.2.0', {
        install: (onProgress) =>
          new Promise<void>((resolve) => {
            onProgress({ downloadedBytes: 50, totalBytes: 100 });
            release = resolve;
          }),
      });
      desktop.nextCheck = pending;
      await store().getState().check();
      const installing = store().getState().install();
      expect(store().getState()).toMatchObject({ status: 'downloading', progress: { downloadedBytes: 50, totalBytes: 100 } });
      release();
      await installing;
      expect(pending.installMock.calls).toBe(1);
    });

    it('un second clic pendant le téléchargement est ignoré, et la vérification aussi', async () => {
      let release: () => void = () => undefined;
      const pending = fakePendingUpdate('1.2.0', { install: () => new Promise<void>((resolve) => (release = resolve)) });
      desktop.nextCheck = pending;
      await store().getState().check();
      const first = store().getState().install();
      await store().getState().install();
      await store().getState().check();
      expect(pending.installMock.calls).toBe(1);
      expect(desktop.checks).toBe(1);
      release();
      await first;
    });

    it('signature refusée : message dédié, l’app continue, le bandeau reste (critère 5)', async () => {
      desktop.nextCheck = fakePendingUpdate('1.2.0', { install: () => Promise.reject(new UpdateInstallError('signature', 'x')) });
      await store().getState().check();
      await store().getState().install();
      expect(store().getState()).toMatchObject({ status: 'installFailed', failure: 'signature', bannerVisible: true, progress: null });
    });

    it('autre échec : état « échec » générique', async () => {
      desktop.nextCheck = fakePendingUpdate('1.2.0', { install: () => Promise.reject(new Error('disque plein')) });
      await store().getState().check();
      await store().getState().install();
      expect(store().getState()).toMatchObject({ status: 'installFailed', failure: 'other' });
    });

    it('rien à installer sans mise à jour trouvée', async () => {
      await store().getState().install();
      expect(store().getState().status).toBe('idle');
    });
  });

  describe('planification (critère 1)', () => {
    interface FakeTimers extends UpdateTimers {
      readonly timeouts: Map<number, { handler: () => void; ms: number }>;
      readonly intervals: Map<number, { handler: () => void; ms: number }>;
    }
    const makeTimers = (): FakeTimers => {
      let next = 1;
      const timeouts = new Map<number, { handler: () => void; ms: number }>();
      const intervals = new Map<number, { handler: () => void; ms: number }>();
      return {
        timeouts,
        intervals,
        setTimeout: (handler, ms) => (timeouts.set(next, { handler, ms }), next++),
        clearTimeout: (id) => void timeouts.delete(id),
        setInterval: (handler, ms) => (intervals.set(next, { handler, ms }), next++),
        clearInterval: (id) => void intervals.delete(id),
      };
    };

    it('une vérification au lancement dans les 10 s', () => {
      const timers = makeTimers();
      startUpdateChecks(container, timers);
      const [launch] = [...timers.timeouts.values()];
      expect(launch?.ms).toBeLessThanOrEqual(10_000);
      expect(LAUNCH_CHECK_DELAY_MS).toBeLessThanOrEqual(10_000);
    });

    it('à 23 h 59 : pas de vérification ; à 24 h : vérification (horloge injectée)', async () => {
      const checks = startUpdateChecks(container, makeTimers());
      db.clock.advance(LAUNCH_CHECK_DELAY_MS);
      await checks.tick();
      expect(desktop.checks).toBe(1);

      db.clock.advance(23 * HOUR + 59 * 60 * 1000);
      await checks.tick();
      expect(desktop.checks).toBe(1);

      db.clock.advance(60 * 1000);
      await checks.tick();
      expect(desktop.checks).toBe(2);
      expect(CHECK_INTERVAL_MS).toBe(24 * HOUR);
    });

    it('pas de vérification avant l’échéance du lancement', async () => {
      const checks = startUpdateChecks(container, makeTimers());
      await checks.tick();
      expect(desktop.checks).toBe(0);
    });

    it('après un échec : nouvelle tentative dans l’heure, pas dans 24 h', async () => {
      desktop.nextCheck = new Error('hors ligne');
      const checks = startUpdateChecks(container, makeTimers());
      db.clock.advance(LAUNCH_CHECK_DELAY_MS);
      await checks.tick();
      db.clock.advance(30 * 60 * 1000);
      await checks.tick();
      expect(desktop.checks).toBe(1);
      db.clock.advance(30 * 60 * 1000);
      await checks.tick();
      expect(desktop.checks).toBe(2);
    });

    it('dispose arrête les minuteries et les vérifications ; idempotent', async () => {
      const timers = makeTimers();
      const checks = startUpdateChecks(container, timers);
      checks.dispose();
      checks.dispose();
      expect(timers.timeouts.size + timers.intervals.size).toBe(0);
      db.clock.advance(CHECK_INTERVAL_MS * 2);
      await checks.tick();
      expect(desktop.checks).toBe(0);
    });

    it('sans intégration PC : rien n’est planifié', () => {
      const timers = makeTimers();
      const web = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      startUpdateChecks(web, timers).dispose();
      expect(timers.timeouts.size + timers.intervals.size).toBe(0);
    });
  });
});
