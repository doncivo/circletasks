// Y-TECH-05, critère 26 : le compte rendu du scénario 23 (restauration « Appliquer partout », troisième auteur) vu par l'interface.
// Le vrai service de synchro de B (banc à trois appareils) alimente l'intégration (bandeau) et l'écran de détails : le bandeau est levé,
// l'écran montre « À jeter » dans « Rétablis alors que vous les aviez supprimés », « J'ai vu » retire le bandeau, et il ne revient pas
// après un redémarrage simulé de B.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scenario, type Scenario } from '../../../tests/unit/sync/epochCarryScenario';
import { syncFolders, warmSimDevices, type SimDevice } from '../../../tests/sim/syncDevice';
import { AppContainerProvider } from '../app/AppContainerContext';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { startSyncIntegration, type SyncIntegration } from './startSync';

const NO_TIMERS = { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined } as const;
const SLOTS = { pairing: null, conflicts: null, version: null, forget: null, reset: null } as const;
const BANNER = /Changement d.époque : éléments rétablis : 2\. Voir le compte rendu/;
const RESTORED_TITLE = 'Rétablis alors que vous les aviez supprimés';

let devices: SimDevice[] = [];
let integration: SyncIntegration | null = null;
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  cleanup();
  integration?.dispose();
  integration = null;
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Conteneur de l'app de B : sa base et son service de synchro (celui du banc, moteur réel). */
const containerOf = (s: Scenario): AppContainer => createAppContainer({ clock: s.b.clock, hlc: s.b.hlc, data: s.b.data, sync: s.b.service });

const warningsOf = (s: Scenario): readonly string[] => (s.b.service.status().warnings as readonly string[] | undefined) ?? [];

function view(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <AppStatusBanner />
      <SyncDetailsScreen slots={SLOTS} />
    </AppContainerProvider>,
  );
}

describe('Y-TECH-05 critère 26 : bandeau, écran et « J’ai vu » du compte rendu du scénario 23', () => {
  it('bandeau levé, « À jeter » dans les rétablis, « J’ai vu » retire le bandeau, aucun retour après redémarrage', async () => {
    const s = await scenario((created) => {
      devices = created;
    });
    await s.b.cycle();
    await s.b.cycle();
    // Le moteur lève l'avertissement du compte rendu non acquitté.
    expect(warningsOf(s)).toContain('carry-report');

    const container = containerOf(s);
    integration = startSyncIntegration(container, NO_TIMERS);
    await integration.refreshed();
    view(container);

    // Bandeau durable avec le nombre d'éléments (« À jeter » rétablie, « Test Pc » recréée) et accès au détail.
    const banner = await screen.findByText(BANNER);
    expect(banner).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Voir' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'sync' });

    // Le détail s'ouvre sur le compte rendu non acquitté ; « À jeter » est dans la liste des rétablis.
    const dialog = await screen.findByRole('dialog');
    const restored = within(dialog).getByRole('list', { name: new RegExp(`^${RESTORED_TITLE}`) });
    expect(within(restored).getByText('À jeter')).toBeTruthy();
    expect(within(dialog).getByRole('list', { name: /^Recréés/ })).toBeTruthy();
    expect(within(dialog).queryByText('Annulée par la restauration')).toBeNull();

    // « J'ai vu » : acquitte ce seul compte rendu, le bandeau disparaît tout de suite.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'J’ai vu' }));
    });
    await waitFor(() => expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined());
    expect(screen.queryByText(BANNER)).toBeNull();
    const [report] = await (await s.b.data.repos.carryReports()).list(20);
    expect(report?.acknowledgedAt).not.toBeNull();

    // Redémarrage simulé : nouvelle instance de l'app sur la même base ; un cycle ; aucun bandeau, le compte rendu reste lisible.
    integration.dispose();
    cleanup();
    useAppStatusStore.setState({ sources: {} });
    await s.b.restart();
    syncFolders(devices);
    await s.b.cycle();
    expect(warningsOf(s)).not.toContain('carry-report');
    const restarted = containerOf(s);
    integration = startSyncIntegration(restarted, NO_TIMERS);
    await integration.refreshed();
    view(restarted);
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(await screen.findByRole('button', { name: /^Époque du/ })).toBeTruthy();
  });
});
