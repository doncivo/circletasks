import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, asLocalDate, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { TodayScreen } from '../today/TodayScreen';
import { createTaskUseCases } from './createTaskUseCases';
import { DoneTasksScreen } from './DoneTasksScreen';
import { ReportScreen } from './ReportScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b7');
const at = (local: string) => new Date(local).getTime();

describe('écrans Rapport minimal et Tâches terminées (T-07)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 1024px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    db = await openTestDb(DEVICE, at('2026-09-23T12:00:00'));
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ day: null, spaces: [], spaceFilter: 'all' });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function doneAt(title: string, day: string, time: string, spaceId = SPACE_PRO_ID): Promise<void> {
    const useCases = createTaskUseCases(container);
    const created = await useCases.create({ title, spaceId, date: asLocalDate(day) });
    if (!created.ok) throw new Error('création impossible');
    db.clock.set(at(`${day}T${time}:00`));
    await useCases.complete(created.value.id);
    db.clock.set(at('2026-09-23T12:00:00'));
  }

  const wrap = (node: React.ReactNode) => <AppContainerProvider container={container}>{node}</AppContainerProvider>;

  it('Aujourd’hui : l’icône graphique ouvre le Rapport, qui porte le lien « Tâches terminées » (critère 1)', async () => {
    const { unmount } = render(wrap(<TodayScreen />));
    // Aucun lien « Tâches terminées » dans la liste d'Aujourd'hui.
    expect(screen.queryByText('Tâches terminées')).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Rapport mensuel' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'report' });
    unmount();

    render(wrap(<ReportScreen />));
    expect(screen.getByRole('heading', { name: 'Rapport mensuel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tâches terminées' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'done' });
    fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'today' });
  });

  it('période « Jour » par défaut : en-tête, groupe, heure de fin, espace (critères 1, 3, 4)', async () => {
    await doneAt('Appeler Paul', '2026-09-23', '18:04');
    await doneAt('Hier', '2026-09-22', '09:30');
    render(wrap(<DoneTasksScreen />));

    expect(await screen.findByRole('button', { name: 'Appeler Paul' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hier' })).not.toBeInTheDocument();
    expect(screen.getByText('23 sept.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jour' })).toHaveAttribute('aria-pressed', 'true');
    const row = screen.getByRole('button', { name: 'Appeler Paul' }).closest('.ct-list-row') as HTMLElement;
    expect(row.textContent).toContain('terminée à 18:04');
    expect(within(row).getByText('Pro')).toBeInTheDocument();
  });

  it('Semaine, Mois, précédent / suivant, groupes du plus récent au plus ancien', async () => {
    await doneAt('Lundi', '2026-09-21', '08:00');
    await doneAt('Mercredi', '2026-09-23', '08:00');
    await doneAt('Début de mois', '2026-09-02', '08:00');
    render(wrap(<DoneTasksScreen />));
    await screen.findByRole('button', { name: 'Mercredi' });

    fireEvent.click(screen.getByRole('button', { name: 'Semaine' }));
    expect(await screen.findByText('21 – 27 sept.')).toBeInTheDocument();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain('23');
    expect(titles[1]).toContain('21');

    fireEvent.click(screen.getByRole('button', { name: 'Mois' }));
    expect(await screen.findByText('septembre 2026')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Début de mois' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Période suivante' }));
    expect(await screen.findByText('octobre 2026')).toBeInTheDocument();
    expect(await screen.findByText('Aucune tâche terminée sur cette période')).toBeInTheDocument();
  });

  it('filtre d’espace (critère 5) et état vide (critère 8)', async () => {
    await doneAt('Dossier', '2026-09-23', '10:00', SPACE_PRO_ID);
    await doneAt('Yoga', '2026-09-23', '11:00', SPACE_PERSO_ID);
    render(wrap(<DoneTasksScreen />));
    await screen.findByRole('button', { name: 'Yoga' });

    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Yoga' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Dossier' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Période précédente' }));
    expect(await screen.findByText('Aucune tâche terminée sur cette période')).toBeInTheDocument();
  });

  it('décocher rouvre la tâche, elle quitte la liste, « Annuler » la remet (critère 6)', async () => {
    await doneAt('Facture', '2026-09-23', '10:00');
    render(wrap(<DoneTasksScreen />));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Rouvrir : Facture' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Facture' })).not.toBeInTheDocument());
    expect(screen.getByText('« Facture » rouverte')).toBeInTheDocument();
    expect(await screen.findByText('Aucune tâche terminée sur cette période')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByRole('button', { name: 'Facture' })).toBeInTheDocument();
  });

  it('toucher une ligne ouvre la fiche détail (critère 7)', async () => {
    await doneAt('Facture', '2026-09-23', '10:00');
    render(wrap(<DoneTasksScreen />));
    fireEvent.click(await screen.findByRole('button', { name: 'Facture' }));
    expect(useNavigationStore.getState().detail).toMatchObject({ type: 'task' });
    expect(await screen.findByLabelText('Détail de la tâche')).toBeInTheDocument();
  });

  it('erreur de lecture : message, pas de rejet non géré', async () => {
    const failing = vi.spyOn(db.data.repos.tasks, 'listDone').mockRejectedValue(new Error('boom'));
    render(wrap(<DoneTasksScreen />));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les tâches terminées.');
    failing.mockRestore();
  });
});
