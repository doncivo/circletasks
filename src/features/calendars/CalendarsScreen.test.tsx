import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_ACCOUNT } from '../../../tests/sim';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { useNavigationStore } from '../app/navigation';
import { mockViewport } from '../today/testKit';
import { CalendarsScreen } from './CalendarsScreen';
import { CalendarsSummaryRow } from './CalendarsSummaryRow';
import { calendarsStore } from './calendarsStore';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

let h: CalendarHarness;

function renderScreen() {
  return render(
    <AppContainerProvider container={h.container}>
      <AppStatusBanner />
      <CalendarsSummaryRow />
      <CalendarsScreen />
    </AppContainerProvider>,
  );
}

async function addGoogle(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Google' }));
  return screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
}

beforeEach(async () => {
  mockViewport(440);
  h = await setupCalendarHarness('11');
});
afterEach(() => h.close());

describe('écran Agendas (K-01 à K-03)', () => {
  it('sans compte : « Aucun compte », « Ajouter un compte » propose Google et iCloud (critère 1)', async () => {
    renderScreen();
    expect(await screen.findByText('Aucun compte connecté.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agendas · Rappels Apple : Aucun compte' })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Ajouter un compte' });
    expect(within(group).getByRole('button', { name: 'Google' })).toBeEnabled();
    expect(within(group).getByRole('button', { name: 'iCloud' })).toBeEnabled();
  });

  it('connexion Google : le compte, ses agendas (affichés, espace Pro) et l’état « Connecté » apparaissent ; la ligne de Réglages compte les agendas', async () => {
    renderScreen();
    const card = await addGoogle();
    expect(within(card).getByText('Connecté')).toBeInTheDocument();
    expect(within(card).getByRole('checkbox', { name: 'Afficher Travail' })).toHaveAttribute('aria-checked', 'true');
    expect(within(card).getByRole('combobox', { name: 'Espace de Travail' })).toHaveValue(SPACE_PRO_ID);
    await waitFor(() => expect(within(card).getByText(/^Mis à jour/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Agendas · Rappels Apple : 2 agendas' })).toBeInTheDocument();
  });

  it('un refus affiche « Connexion annulée » sans compte (critère 2)', async () => {
    renderScreen();
    h.google.denyNextConsent();
    fireEvent.click(screen.getByRole('button', { name: 'Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion annulée');
    expect(screen.getByText('Aucun compte connecté.')).toBeInTheDocument();
  });

  it('changer l’espace d’un agenda l’enregistre aussitôt (ES-06 critère 6)', async () => {
    renderScreen();
    const card = await addGoogle();
    fireEvent.change(within(card).getByRole('combobox', { name: 'Espace de Famille' }), { target: { value: SPACE_PERSO_ID } });
    await waitFor(() => expect(calendarsStore.get(h.container).getState().accounts[0]?.calendars.find((calendar) => calendar.name === 'Famille')?.spaceId).toBe(SPACE_PERSO_ID));
    expect((await h.container.data.repos.calendarAccounts.listAll())[0]?.calendars.find((calendar) => calendar.name === 'Famille')?.spaceId).toBe(SPACE_PERSO_ID);
  });

  it('décocher « Afficher » retire les événements de l’agenda', async () => {
    renderScreen();
    const card = await addGoogle();
    await waitFor(async () => expect(await h.container.data.repos.externalEvents.listBetween({ from: '2026-01-01T00:00:00Z' as never, to: '2027-12-31T00:00:00Z' as never })).toHaveLength(4));
    fireEvent.click(within(card).getByRole('checkbox', { name: 'Afficher Famille' }));
    await waitFor(async () => expect(await h.container.data.repos.externalEvents.listBetween({ from: '2026-01-01T00:00:00Z' as never, to: '2027-12-31T00:00:00Z' as never })).toHaveLength(2));
    expect(within(card).getByRole('checkbox', { name: 'Afficher Famille' })).toHaveAttribute('aria-checked', 'false');
  });

  it('« Actualiser » relit le compte ; le bouton est inactif pendant la lecture', async () => {
    renderScreen();
    const card = await addGoogle();
    await waitFor(() => expect(within(card).getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` })).toBeEnabled());
    const before = h.google.log.length;
    h.db.clock.advance(60_000);
    fireEvent.click(within(card).getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }));
    await waitFor(() => expect(h.google.log.length).toBeGreaterThan(before));
    await waitFor(() => expect(within(card).getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` })).toBeEnabled());
  });

  it('jeton révoqué : état « Déconnecté », bandeau « Agenda … déconnecté » et « Reconnecter » qui relance la connexion (critère 7, A-09)', async () => {
    renderScreen();
    const card = await addGoogle();
    const store = calendarsStore.get(h.container);
    await waitFor(() => expect(store.getState().refreshing).toEqual([]));
    h.google.revokeAll();
    h.db.clock.advance(60_000);
    fireEvent.click(within(card).getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }));
    expect(await within(card).findByText('Déconnecté')).toBeInTheDocument();
    expect(screen.getByText(`Agenda ${GOOGLE_ACCOUNT} déconnecté`)).toBeInTheDocument();
    // Le bouton du bandeau passe par la demande de reconnexion de l'écran.
    fireEvent.click(screen.getAllByRole('button', { name: 'Reconnecter' })[0] as HTMLElement);
    expect(await within(card).findByText('Connecté')).toBeInTheDocument();
    expect(screen.queryByText(`Agenda ${GOOGLE_ACCOUNT} déconnecté`)).not.toBeInTheDocument();
  });

  it('supprimer un compte demande confirmation, puis efface le jeton, le compte et ses événements (critère 8)', async () => {
    renderScreen();
    const card = await addGoogle();
    const tokenRef = calendarsStore.get(h.container).getState().accounts[0]?.tokenRef ?? '';
    await waitFor(() => expect(within(card).getByRole('button', { name: `Supprimer le compte ${GOOGLE_ACCOUNT}` })).toBeEnabled());
    fireEvent.click(within(card).getByRole('button', { name: `Supprimer le compte ${GOOGLE_ACCOUNT}` }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(await h.container.calendars.vault.has(tokenRef)).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: `Supprimer le compte ${GOOGLE_ACCOUNT}` }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.getByText('Aucun compte connecté.')).toBeInTheDocument());
    expect(await h.container.calendars.vault.has(tokenRef)).toBe(false);
  });

  it('le bouton retour revient aux réglages', async () => {
    renderScreen();
    await screen.findByText('Aucun compte connecté.');
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'calendars' });
    fireEvent.click(screen.getByRole('button', { name: 'Retour aux réglages' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'home' });
  });
});
