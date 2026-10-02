import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { fr } from '../../i18n/fr';
import { createAppContainer, type AppContainer } from './container';
import { startDesktopIntegration, trayLabels } from './desktop';
import { INITIAL_NAVIGATION, useNavigationStore } from './navigation';
import { useQuickAddStore } from './quickAdd';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d1');

describe('intégration PC de la coquille (D-01)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let warn: MockInstance;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = createAppContainer({
      clock: createManualClock('2026-10-02T08:00:00.000Z'),
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: db.data,
      desktop,
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    useQuickAddStore.setState({ pending: false });
    await db.close();
  });

  it('le menu reçoit les textes français de src/i18n, « Synchroniser » grisé tant que M15 n’existe pas (critères 3 et 6)', async () => {
    const integration = startDesktopIntegration(container);
    await vi.waitFor(() => expect(desktop.trayLabels).not.toBeNull());
    expect(desktop.trayLabels).toEqual({
      open: 'Ouvrir CircleTasks',
      quickAdd: 'Ajout rapide',
      sync: 'Synchroniser',
      quit: 'Quitter',
      syncEnabled: false,
    });
    expect(trayLabels().open).toBe(fr.desktop.tray.open);
    integration.dispose();
  });

  it('« Ajout rapide » : va sur Aujourd’hui et lève la demande de focus (critère 5)', async () => {
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'home' });
    const integration = startDesktopIntegration(container);
    await vi.waitFor(() => expect(desktop.quickAddListeners).toBe(1));
    desktop.emitQuickAdd();
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'today' });
    expect(useQuickAddStore.getState().pending).toBe(true);
    expect(useQuickAddStore.getState().consume()).toBe(true);
    expect(useQuickAddStore.getState().consume()).toBe(false);
    integration.dispose();
  });

  it('dispose retire l’écouteur, même avant la fin de l’abonnement ; idempotent', async () => {
    const integration = startDesktopIntegration(container);
    integration.dispose();
    integration.dispose();
    await vi.waitFor(() => expect(desktop.quickAddListeners).toBe(0));
    desktop.emitQuickAdd();
    expect(useQuickAddStore.getState().pending).toBe(false);
  });

  it('un échec du branchement est journalisé sans interrompre l’app', async () => {
    desktop.setTrayLabels = () => Promise.reject(new Error('icône absente'));
    const integration = startDesktopIntegration(container);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('icône absente')));
    integration.dispose();
  });

  it('« Quitter » : les écritures en file se terminent avant la confirmation de sortie (critère 7)', async () => {
    const integration = startDesktopIntegration(container);
    await vi.waitFor(() => expect(desktop.quittingHandler).not.toBeNull());
    await db.data.repos.settings.set('tasks.carryOverUndone', false);
    await desktop.emitQuitting();
    expect(desktop.quitConfirmed).toBe(true);
    await expect(db.data.repos.settings.get('tasks.carryOverUndone')).resolves.toBe(false);
    integration.dispose();
    expect(desktop.quittingHandler).toBeNull();
  });

  it('hors PC : aucun effet', () => {
    const web = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    expect(() => startDesktopIntegration(web).dispose()).not.toThrow();
  });
});
