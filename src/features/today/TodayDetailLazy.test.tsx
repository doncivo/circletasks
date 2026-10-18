import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { TaskDetail } from '../app/lazyScreens';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SCREEN_LOADED_PREFIX } from '../app/screenNames';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TodayScreen } from './TodayScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000001');

/**
 * BUNDLE-01, palier 1 (critère 9) : la fiche de tâche est un bloc à la demande (`lazyScreens.tsx`), préchargé au repos. Son hôte est monté en
 * permanence dans Aujourd'hui (il ne rend rien tant qu'aucune tâche n'est ouverte) : aucun repli ne doit occuper la mise en page, ni avant
 * le préchargement ni à l'ouverture. Les deux cas sont dans l'ordre du fichier : le module n'est pas encore arrivé au premier test.
 */
describe('BUNDLE-01 : fiche de tâche à la demande dans Aujourd’hui', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('min-width: 1024px'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.getState().setSpaces([]);
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function openCreatedTask(): Promise<HTMLElement> {
    const created = await createTaskUseCases(container).create({ title: 'Courses', spaceId: SPACE_PERSO_ID });
    if (!created.ok) throw new Error('fixture');
    const { container: root } = render(
      <AppContainerProvider container={container}>
        <TodayScreen />
      </AppContainerProvider>,
    );
    act(() => useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id }));
    return root;
  }

  it('avant le préchargement : aucun repli dans la mise en page, la fiche apparaît quand son bloc arrive, sans erreur', async () => {
    expect(document.documentElement).not.toHaveAttribute(SCREEN_LOADED_PREFIX + 'taskdetail');
    const root = await openCreatedTask();
    expect(root.querySelector('.ct-app__placeholder')).toBeNull();
    expect(await screen.findByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    expect(root.querySelector('.ct-app__placeholder')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.documentElement).toHaveAttribute(SCREEN_LOADED_PREFIX + 'taskdetail', 'true');
  });

  it('préchargement fait : la fiche s’ouvre aussitôt, sans repli à aucun instant', async () => {
    await TaskDetail.preload();
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    await openCreatedTask();
    // Rendu synchrone : aucun await entre l'ouverture et la vérification.
    expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    const added = observer.takeRecords().flatMap((record) => [...record.addedNodes]);
    observer.disconnect();
    expect(added.some((node) => node instanceof HTMLElement && (node.matches('.ct-app__placeholder') || node.querySelector('.ct-app__placeholder') !== null))).toBe(false);
    expect(screen.getByRole('button', { name: 'Courses' })).toBeInTheDocument();
  });
});
