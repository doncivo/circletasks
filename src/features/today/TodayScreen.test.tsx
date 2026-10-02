import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { TodayScreen } from './TodayScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000001');

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderToday(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <TodayScreen />
    </AppContainerProvider>,
  );
}

describe('TodayScreen (T-01)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    // Comme App.tsx (ADR 0004) : les espaces sont déjà dans useAppStore avant le
    // premier rendu de l'écran, jamais lus depuis db/seed par la feature.
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    // Démonte le composant (et ses abonnements/effets) avant de remettre à zéro
    // l'état global et de fermer la base, pour éviter tout effet en vol sur un état
    // déjà réinitialisé ou une connexion déjà fermée.
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.getState().setSpaceFilter('all');
    useAppStore.getState().setSpaces([]);
    await db.close();
  });

  it('Entrée dans le champ en ligne crée la tâche, vide le champ et garde le focus (critère 1)', async () => {
    mockViewport(1440);
    renderToday(container);

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Appeler le notaire' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    expect(await screen.findByText('Appeler le notaire')).toBeInTheDocument();
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('l’état vide disparaît dès qu’une tâche est créée (critère 3)', async () => {
    mockViewport(1440);
    renderToday(container);

    expect(await screen.findByText('Rien de prévu aujourd’hui.')).toBeInTheDocument();

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Appeler le notaire' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    expect(await screen.findByText('Appeler le notaire')).toBeInTheDocument();
    expect(screen.queryByText('Rien de prévu aujourd’hui.')).not.toBeInTheDocument();
  });

  it('un titre vide ou composé d’espaces ne crée rien (critère 2)', async () => {
    mockViewport(1440);
    renderToday(container);

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByText('Rien de prévu aujourd’hui.')).toBeInTheDocument());
    expect(field).toHaveValue('   ');
  });

  it('le champ Titre a le focus à l’ouverture de la feuille « Nouvelle tâche » (critère 4)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByRole('dialog', { name: 'Nouvelle tâche' })).toBeInTheDocument();
    expect(screen.getByLabelText('Titre')).toHaveFocus();
  });

  it('le sélecteur d’espace de la feuille est présélectionné sur le filtre actif (critère 10)', async () => {
    mockViewport(440);
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(within(dialog).getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('le bouton Enregistrer de la feuille « Nouvelle tâche » est désactivé tant que le titre est vide (critère 6)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const save = screen.getByRole('button', { name: 'Enregistrer' });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Envoyer la facture' } });
    expect(save).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: '   ' } });
    expect(save).toBeDisabled();
  });

  it('Enregistrer dans la feuille crée la tâche et la ferme (critère 7)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Faire les courses' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByText('Faire les courses')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('affiche un message d’erreur si le chargement de la liste échoue, sans rejet non géré', async () => {
    mockViewport(1440);
    vi.spyOn(container.data.repos.tasks, 'listForDay').mockRejectedValueOnce(new Error('boom'));
    renderToday(container);

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les tâches du jour.');
  });

  it('Fermer la feuille ne crée rien (critère 8)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Ne pas enregistrer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Ne pas enregistrer')).not.toBeInTheDocument();
  });

  it('affiche l’heure sous le titre quand une tâche en a une (critère 2, T-02)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Appeler le notaire' } });
    fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '14:00' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);

    const row = await screen.findByText('Appeler le notaire');
    expect(row.closest('.ct-list-row')).toHaveTextContent('14:00');
  });

  it('une tâche datée sur un autre jour que l’affichage n’apparaît pas dans Aujourd’hui (critère 1, T-02)', async () => {
    mockViewport(1440);
    renderToday(container);

    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Jeudi prochain' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-10-08' } });
    fireEvent.submit(screen.getByLabelText('Nouvelle tâche').closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByText('Rien de prévu aujourd’hui.')).toBeInTheDocument());
    expect(screen.queryByText('Jeudi prochain')).not.toBeInTheDocument();
    const thursday = await container.data.repos.tasks.listForDay('2026-10-08' as never, 'all');
    expect(thursday.map((task) => task.title)).toEqual(['Jeudi prochain']);
  });

  it('la feuille « Nouvelle tâche » porte ses propres champs Date et Heure (iPhone, T-02)', async () => {
    mockViewport(440);
    renderToday(container);

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Faire les courses' } });
    fireEvent.change(within(dialog).getByLabelText('Date'), { target: { value: '2026-10-08' } });
    fireEvent.change(within(dialog).getByLabelText('Heure'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const thursday = await container.data.repos.tasks.listForDay('2026-10-08' as never, 'all');
    expect(thursday).toMatchObject([{ title: 'Faire les courses', time: '09:00' }]);
  });
});
