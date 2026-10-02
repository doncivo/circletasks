import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { TodayScreen } from './TodayScreen';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('valeur attendue');
  return value;
}

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000009');

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('TodayScreen : répétition (T-09)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
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

  function renderToday() {
    return render(
      <AppContainerProvider container={container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );
  }

  it('iPhone : la feuille crée une tâche mensuelle, la ligne affiche « mensuelle », la fiche « Mensuelle, le N », terminer crée la suivante', async () => {
    mockViewport(440);
    renderToday();
    const day = Number(todayLocal(container.clock).slice(8));

    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(within(dialog).getByRole('radio', { name: 'Une fois' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Envoyer la facture' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Mensuel' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));

    const row = (await screen.findByText('Envoyer la facture')).closest('.ct-list-row') as HTMLElement;
    await waitFor(() => expect(row).toHaveTextContent('mensuelle'));

    fireEvent.click(screen.getByRole('button', { name: 'Envoyer la facture' }));
    const detail = await screen.findByRole('dialog', { name: 'Détail de la tâche' });
    expect(await within(detail).findByText(`Mensuelle, le ${day === 1 ? '1ᵉʳ' : day}`)).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Rendre la tâche récurrente' })).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Fermer' }));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : Envoyer la facture' }));
    await waitFor(async () => {
      const [first] = await container.data.repos.tasks.listForDay(todayLocal(container.clock), 'all');
      expect(first?.status).toBe('done');
      const series = await container.data.repos.tasks.listByRecurrence(must(must(first).recurrenceId));
      expect(series.map((task) => task.seriesIndex)).toEqual([0, 1]);
      expect(series[1]?.date?.slice(0, 7)).toBe('2026-11');
    });
  }, 20_000);

  it('PC : « Répéter… » dans la fiche pose une règle sur une tâche existante, puis le résumé remplace le bouton', async () => {
    mockViewport(1440);
    renderToday();

    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Tâche du jour' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Tâche du jour' }));

    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Rendre la tâche récurrente' }));
    expect(within(panel).getByRole('button', { name: 'Valider' })).toBeDisabled();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Hebdo' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Valider' }));

    expect(await within(panel).findByText(/^Toutes les semaines : /)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Rendre la tâche récurrente' })).not.toBeInTheDocument();
    // L'indicateur discret de la ligne suit la règle posée.
    await waitFor(() => expect(document.querySelector('.ct-list-row')).toHaveTextContent('hebdo'));
  });
});
