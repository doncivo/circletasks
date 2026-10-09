import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER, GOOGLE_ACCOUNT } from '../../../tests/sim';
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

  it('iPhone : compte iCloud reçu du PC sans secret ici : « Connecté ailleurs », aucun bandeau « déconnecté », « Connecter ici » ouvre le formulaire', async () => {
    const id = 'a7000000-0000-4000-8000-0000000000e1' as Parameters<typeof h.container.data.repos.calendarAccounts.create>[0]['id'];
    await h.container.data.repos.calendarAccounts.create({ id, provider: 'icloud', label: '', tokenRef: '', calendars: [] });
    renderScreen();
    const card = await screen.findByRole('region', { name: 'iCloud · Compte iCloud' });
    expect(await within(card).findByText('Connecté ailleurs')).toBeInTheDocument();
    expect(within(card).getByText(/^Connecté sur un autre appareil/)).toBeInTheDocument();
    expect(within(card).queryByText('Déconnecté')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Actualiser/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Reconnecter/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/déconnecté$/)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Connecter Compte iCloud sur cet appareil' }));
    expect(calendarsStore.get(h.container).getState().icloudForm).toEqual({ accountId: id, username: '' });
  });

  it('compte Google reçu du PC : « Connecter ici » connecte CET appareil (pas d’impasse), annulation dite puis nouvel essai', async () => {
    const id = 'a7000000-0000-4000-8000-0000000000e2' as Parameters<typeof h.container.data.repos.calendarAccounts.create>[0]['id'];
    await h.container.data.repos.calendarAccounts.create({ id, provider: 'google', label: GOOGLE_ACCOUNT, tokenRef: '', calendars: [] });
    renderScreen();
    const card = await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
    expect(await within(card).findByText('Connecté ailleurs')).toBeInTheDocument();
    h.google.denyNextConsent();
    fireEvent.click(within(card).getByRole('button', { name: `Connecter ${GOOGLE_ACCOUNT} sur cet appareil` }));
    expect(await screen.findByText('Connexion annulée')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: `Connecter ${GOOGLE_ACCOUNT} sur cet appareil` }));
    expect(await within(card).findByText('Connecté')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /sur cet appareil$/ })).not.toBeInTheDocument();
    await waitFor(() => expect(within(card).getByText(/^Mis à jour/)).toBeInTheDocument());
  });

  it('jeton d’une connexion abandonnée resté au coffre : message dédié et « Réessayer l’effacement » qui l’efface', async () => {
    renderScreen();
    await addGoogle();
    await waitFor(() => expect(calendarsStore.get(h.container).getState().refreshing).toEqual([]));
    const revoke = vi.spyOn(h.container.calendars.oauth, 'revokeGoogle').mockRejectedValue(new Error('coffre indisponible'));
    fireEvent.click(screen.getByRole('button', { name: 'Google' }));
    const alert = await screen.findByTestId('calendars-orphan-secret');
    expect(within(alert).getByText(/l’effacement a échoué$/)).toBeInTheDocument();
    revoke.mockRestore();
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer l’effacement' }));
    await waitFor(() => expect(screen.queryByTestId('calendars-orphan-secret')).not.toBeInTheDocument());
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

describe('formulaire iCloud (K-02)', () => {
  const field = (name: string): HTMLInputElement => screen.getByLabelText(name) as HTMLInputElement;

  async function openForm(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'iCloud' }));
    await screen.findByRole('form', { name: 'Compte iCloud' });
  }

  it('demande l’identifiant Apple et le mot de passe d’application, avec la consigne et le chemin pour le créer (critère 1)', async () => {
    renderScreen();
    await openForm();
    expect(screen.getByText('Utilisez un mot de passe d’application, pas votre mot de passe Apple.')).toBeInTheDocument();
    expect(screen.getByText(/appleid\.apple\.com/)).toBeInTheDocument();
    expect(field('Mot de passe d’application')).toHaveAttribute('type', 'password');
    expect(field('Mot de passe d’application')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeDisabled();
  });

  it('succès : le compte apparaît avec ses agendas, le champ est vidé, le formulaire se ferme, aucun mot de passe dans la page (critères 2 et 7)', async () => {
    renderScreen();
    await openForm();
    fireEvent.change(field('Identifiant Apple'), { target: { value: CALDAV_USER } });
    fireEvent.change(field('Mot de passe d’application'), { target: { value: CALDAV_APP_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    const card = await screen.findByRole('region', { name: `iCloud · ${CALDAV_USER}` });
    expect(within(card).getByRole('checkbox', { name: 'Afficher Famille' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('form', { name: 'Compte iCloud' })).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(CALDAV_APP_PASSWORD);
    expect([...document.querySelectorAll('input')].every((input) => !input.value.includes(CALDAV_APP_PASSWORD))).toBe(true);
    await waitFor(() => expect(within(card).getByText(/^Mis à jour/)).toBeInTheDocument());
  });

  it('401 : « Identifiant ou mot de passe d’application incorrect », mot de passe vidé, aucun compte (critère 3)', async () => {
    renderScreen();
    await openForm();
    fireEvent.change(field('Identifiant Apple'), { target: { value: CALDAV_USER } });
    fireEvent.change(field('Mot de passe d’application'), { target: { value: 'mauvais-mot-de-passe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText('Identifiant ou mot de passe d’application incorrect')).toBeInTheDocument();
    expect(field('Mot de passe d’application').value).toBe('');
    expect(field('Identifiant Apple').value).toBe(CALDAV_USER);
    expect(screen.getByText('Aucun compte connecté.')).toBeInTheDocument();
  });

  it('serveur injoignable : « Impossible de joindre iCloud » (critère 3)', async () => {
    renderScreen();
    await openForm();
    await h.caldav.close();
    fireEvent.change(field('Identifiant Apple'), { target: { value: CALDAV_USER } });
    fireEvent.change(field('Mot de passe d’application'), { target: { value: CALDAV_APP_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText('Impossible de joindre iCloud')).toBeInTheDocument();
  });

  it('« Reconnecter » d’un compte iCloud déconnecté rouvre le formulaire avec l’identifiant pré-rempli et verrouillé (critère 6)', async () => {
    renderScreen();
    await openForm();
    fireEvent.change(field('Identifiant Apple'), { target: { value: CALDAV_USER } });
    fireEvent.change(field('Mot de passe d’application'), { target: { value: CALDAV_APP_PASSWORD } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    const card = await screen.findByRole('region', { name: `iCloud · ${CALDAV_USER}` });
    const store = calendarsStore.get(h.container);
    await waitFor(() => expect(store.getState().refreshing).toEqual([]));
    h.caldav.setPassword('autre-mot-de-passe');
    h.db.clock.advance(60_000);
    fireEvent.click(within(card).getByRole('button', { name: `Actualiser ${CALDAV_USER}` }));
    fireEvent.click(await within(card).findByRole('button', { name: `Reconnecter ${CALDAV_USER}` }));
    const form = await screen.findByRole('form', { name: 'Compte iCloud' });
    expect(within(form).getByLabelText('Identifiant Apple')).toHaveValue(CALDAV_USER);
    expect(within(form).getByLabelText('Identifiant Apple')).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Mot de passe d’application'), { target: { value: 'autre-mot-de-passe' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Se connecter' }));
    await waitFor(() => expect(within(card).getByText('Connecté')).toBeInTheDocument());
  });
});
