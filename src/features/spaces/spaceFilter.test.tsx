import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { isSharedSetting } from '../../domain/model';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createShortcutRegistry, toKeyInput, type KeyInput } from '../app/shortcuts';
import { RoutinesScreen } from '../routines/RoutinesScreen';
import { registerRoutinesSource, unregisterRoutinesSource } from '../routines/routinesSource';
import { seedRoutine } from '../routines/testKit';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { WeekScreen } from '../week/WeekScreen';
import { persistSpaceFilter, registerSpaceShortcuts, restoreSpaceFilter } from './spaceFilter';

const key = (code: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key: code.replace('Digit', ''), code, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false, ...extra });
const pill = (name: string) => within(screen.getByRole('group', { name: 'Filtre d’espace' })).getByRole('button', { name });

describe('Filtre Pro / Perso / Tout (ES-03)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('e5004');
    registerRoutinesSource();
  });
  afterEach(async () => {
    unregisterRoutinesSource();
    await teardownToday(h);
  });

  it('Aujourd’hui : « Pro » ne garde que les éléments Pro et porte aria-pressed (critères 1, 8)', async () => {
    mockViewport(440);
    await seedTask(h, { title: 'Facture client', spaceId: SPACE_PRO_ID });
    await seedTask(h, { title: 'Appeler maman', spaceId: SPACE_PERSO_ID });
    await seedRoutine(h, { title: 'Revue des e-mails', spaceId: SPACE_PRO_ID });
    await seedRoutine(h, { title: 'Faire mon lit', spaceId: SPACE_PERSO_ID });
    renderToday(h.container);
    expect(await screen.findByText('Facture client')).toBeInTheDocument();
    expect(screen.getByText('Appeler maman')).toBeInTheDocument();
    expect(pill('Tout')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pill('Pro'));
    await waitFor(() => expect(screen.queryByText('Appeler maman')).toBeNull());
    expect(pill('Pro')).toHaveAttribute('aria-pressed', 'true');
    expect(pill('Tout')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Facture client')).toBeInTheDocument();
    expect(screen.getByText('Revue des e-mails')).toBeInTheDocument();
    expect(screen.queryByText('Faire mon lit')).toBeNull();
  });

  it('en « Tout », l’espace est écrit en couleur (tâche et routine) ; en Pro ou Perso, il n’est pas répété (critère 5)', async () => {
    mockViewport(440);
    await seedTask(h, { title: 'Appeler maman', spaceId: SPACE_PERSO_ID, time: '09:00' });
    await seedRoutine(h, { title: 'Faire mon lit', spaceId: SPACE_PERSO_ID, time: '07:30' as never });
    renderToday(h.container);
    const taskRow = (await screen.findByText('Appeler maman')).closest('.ct-list-row') as HTMLElement;
    expect(taskRow).toHaveTextContent('09:00 · Perso');
    const routineRow = (await screen.findByText('Faire mon lit')).closest('.ct-list-row') as HTMLElement;
    expect(routineRow).toHaveTextContent('07:30 · Routine · Perso');
    expect(within(routineRow).getByText('Perso')).toHaveStyle({ color: 'color-mix(in srgb, #b5483b, #ffffff var(--ct-space-white, 0%))' });

    fireEvent.click(pill('Perso'));
    await waitFor(() => expect(screen.getByText('Appeler maman').closest('.ct-list-row')).not.toHaveTextContent('Perso'));
    expect(screen.getByText('Faire mon lit').closest('.ct-list-row')).toHaveTextContent('07:30 · Routine');
    expect(screen.getByText('Faire mon lit').closest('.ct-list-row')).not.toHaveTextContent('Perso');
  });

  it('un filtre sans élément l’indique : « Aucune tâche Pro aujourd’hui » (critère 6)', async () => {
    mockViewport(440);
    await seedTask(h, { title: 'Appeler maman', spaceId: SPACE_PERSO_ID });
    renderToday(h.container);
    await screen.findByText('Appeler maman');
    fireEvent.click(pill('Pro'));
    expect(await screen.findByText('Aucune tâche Pro aujourd’hui')).toBeInTheDocument();
    fireEvent.click(pill('Tout'));
    await screen.findByText('Appeler maman');
    expect(screen.queryByText(/Aucune tâche/)).toBeNull();
  });

  it('le filtre est unique : choisi dans Aujourd’hui, il s’applique à la Semaine et aux Routines (critère 2)', async () => {
    mockViewport(440);
    await seedRoutine(h, { title: 'Revue des e-mails', spaceId: SPACE_PRO_ID });
    await seedRoutine(h, { title: 'Faire mon lit', spaceId: SPACE_PERSO_ID });
    await seedTask(h, { title: 'Facture client', spaceId: SPACE_PRO_ID });
    await seedTask(h, { title: 'Appeler maman', spaceId: SPACE_PERSO_ID });
    const view = renderToday(h.container);
    await screen.findByText('Facture client');
    fireEvent.click(pill('Perso'));
    await waitFor(() => expect(screen.queryByText('Facture client')).toBeNull());
    view.unmount();

    const week = render(
      <AppContainerProvider container={h.container}>
        <WeekScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Appeler maman')).toBeInTheDocument();
    expect(screen.queryByText('Facture client')).toBeNull();
    expect(pill('Perso')).toHaveAttribute('aria-pressed', 'true');
    week.unmount();

    render(
      <AppContainerProvider container={h.container}>
        <RoutinesScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Faire mon lit' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Revue des e-mails' })).toBeNull();
    expect(pill('Perso')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pill('Pro'));
    expect(await screen.findByRole('heading', { name: 'Revue des e-mails' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Faire mon lit' })).toBeNull();
  });

  it('Routines : un filtre sans routine nomme l’espace (critère 6)', async () => {
    mockViewport(440);
    await seedRoutine(h, { title: 'Faire mon lit', spaceId: SPACE_PERSO_ID });
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    render(
      <AppContainerProvider container={h.container}>
        <RoutinesScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Aucune routine Pro pour l’instant.')).toBeInTheDocument();
  });
});

describe('mémorisation et raccourcis du filtre (ES-03)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('e5005');
  });
  afterEach(() => teardownToday(h));

  it('Perso choisi puis redémarrage : Perso est restauré ; le réglage est local, non synchronisé (critère 3)', async () => {
    const stop = persistSpaceFilter(h.container);
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    await waitFor(async () => expect(await h.container.data.repos.settings.get('spaces.filter')).toBe(SPACE_PERSO_ID));
    stop();
    // « Redémarrage » : l'état en mémoire est perdu, la base reste.
    useAppStore.setState({ spaceFilter: 'all' });
    expect(await restoreSpaceFilter(h.container)).toBe(SPACE_PERSO_ID);
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PERSO_ID);
    expect(isSharedSetting('spaces.filter')).toBe(false);
  });

  it('un filtre mémorisé inconnu ou illisible retombe sur « Tout »', async () => {
    await h.container.data.repos.settings.set('spaces.filter', '00000000-0000-4000-8000-0000000000ff' as never);
    expect(await restoreSpaceFilter(h.container)).toBe('all');
    useAppStore.setState({ spaceFilter: SPACE_PERSO_ID });
    const broken = { data: { repos: { settings: { get: () => Promise.reject(new Error('boom')) } } } } as never;
    expect(await restoreSpaceFilter(broken)).toBe('all');
  });

  it('Ctrl+1 / Ctrl+2 / Ctrl+3 : Pro / Perso / Tout, y compris dans une liste focalisée ou un champ (critère 4)', () => {
    const registry = createShortcutRegistry();
    const stop = registerSpaceShortcuts(registry);
    expect(registry.handle(key('Digit1'))).toBe('app.space.pro');
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PRO_ID);
    expect(registry.handle(key('Digit2'))).toBe('app.space.perso');
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PERSO_ID);
    expect(registry.handle(key('Digit3', { editable: true }))).toBe('app.space.all');
    expect(useAppStore.getState().spaceFilter).toBe('all');
    // Clavier AZERTY : « & » en `key`, la touche est reconnue par son code.
    expect(registry.handle({ ...key('Digit1'), key: '&' })).toBe('app.space.pro');
    // Sans Ctrl : aucun effet.
    expect(registry.handle(key('Digit2', { ctrlKey: false }))).toBeNull();
    stop();
    useAppStore.setState({ spaceFilter: 'all' });
    expect(registry.handle(key('Digit1'))).toBeNull();
    expect(useAppStore.getState().spaceFilter).toBe('all');
  });

  it('Ctrl+2 depuis le clavier réel de la fenêtre change le filtre affiché', async () => {
    mockViewport(1440);
    const stop = registerSpaceShortcuts(h.container.shortcuts);
    const onKeyDown = (event: KeyboardEvent): void => void h.container.shortcuts.handle(toKeyInput(event));
    window.addEventListener('keydown', onKeyDown);
    try {
      renderToday(h.container);
      fireEvent.keyDown(document.body, { key: 'é', code: 'Digit2', ctrlKey: true });
      await waitFor(() => expect(pill('Perso')).toHaveAttribute('aria-pressed', 'true'));
    } finally {
      window.removeEventListener('keydown', onKeyDown);
      stop();
    }
  });
});
