import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_ACCOUNT } from '../../../tests/sim';
import { AppContainerProvider } from '../app/AppContainerContext';
import { mockViewport } from '../today/testKit';
import { CalendarsScreen } from './CalendarsScreen';
import { calendarsStore } from './calendarsStore';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

/**
 * K-TECH-01 critères 4 et 6 : sur iPhone, la feuille de connexion Google peut échouer (`web-auth-failed`, `web-auth-unavailable`). L'écran
 * Agendas garde un message persistant avec le code et « Réessayer » jusqu'à la réussite ou l'annulation volontaire.
 */
let h: CalendarHarness;
const store = () => calendarsStore.get(h.container);

function renderScreen() {
  return render(
    <AppContainerProvider container={h.container}>
      <CalendarsScreen />
    </AppContainerProvider>,
  );
}

const googleButton = () => screen.getByRole('button', { name: 'Google' });
const FAILURE_TEXT = 'La connexion à Google n’a pas pu aboutir.';
const failureBlock = () => screen.getByText(FAILURE_TEXT).closest('div') as HTMLElement;

beforeEach(async () => {
  mockViewport(440);
  h = await setupCalendarHarness('12');
});
afterEach(() => h.close());

describe('connexion Google sur iPhone : échec de la feuille d’authentification (K-TECH-01)', () => {
  it('le bouton Google est actif et un échec affiche le message, le code et « Réessayer » sans compte créé', async () => {
    renderScreen();
    expect(googleButton()).toBeEnabled();
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    expect(await screen.findByText(FAILURE_TEXT)).toBeInTheDocument();
    expect(within(failureBlock()).getByText('Code : web-auth-failed')).toBeInTheDocument();
    expect(within(failureBlock()).getByRole('button', { name: 'Réessayer' })).toBeEnabled();
    expect(screen.getByText('Aucun compte connecté.')).toBeInTheDocument();
    expect(googleButton()).toBeEnabled();
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('web-auth-unavailable a son propre code, et le message reste tant que rien n’a réussi', async () => {
    renderScreen();
    h.failWebAuth('web-auth-unavailable');
    fireEvent.click(googleButton());
    expect(await screen.findByText('Code : web-auth-unavailable')).toBeInTheDocument();
    // Un autre geste de l’écran n’efface pas l’état : il disparaît à la réussite ou à l’annulation seulement.
    fireEvent.click(screen.getByRole('button', { name: 'iCloud' }));
    expect(screen.getByText(FAILURE_TEXT)).toBeInTheDocument();
    expect(store().getState().googleFailure).toEqual({ code: 'web-auth-unavailable', accountId: null });
  });

  it('« Réessayer » relance la connexion : réussie, le message disparaît et le compte apparaît', async () => {
    renderScreen();
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(store().getState().connecting).toBe(false));
    expect(await screen.findByText('Code : web-auth-failed')).toBeInTheDocument();
    h.failWebAuth(null);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(FAILURE_TEXT)).not.toBeInTheDocument());
    expect(store().getState().googleFailure).toBeNull();
  });

  it('l’annulation volontaire efface l’état d’échec et affiche « Connexion annulée »', async () => {
    renderScreen();
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    await screen.findByText('Code : web-auth-failed');
    h.failWebAuth(null);
    h.google.denyNextConsent();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Connexion annulée')).toBeInTheDocument();
    expect(screen.queryByText(FAILURE_TEXT)).not.toBeInTheDocument();
    expect(store().getState().googleFailure).toBeNull();
  });

  it('une configuration absente garde le texte « Google n’est pas configuré » (pas de message de feuille)', async () => {
    await h.close();
    h = await setupCalendarHarness('13', { noGoogleClient: true });
    renderScreen();
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Google n’est pas configuré dans cette version de l’application.');
    expect(screen.queryByText(FAILURE_TEXT)).not.toBeInTheDocument();
  });

  it('compte à reconnecter : l’échec garde le compte et « Réessayer » relance sa reconnexion', async () => {
    renderScreen();
    fireEvent.click(googleButton());
    const card = await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
    await waitFor(() => expect(within(card).getByText(/^Mis à jour/)).toBeInTheDocument());
    const accountId = store().getState().accounts[0]?.id;
    expect(accountId).toBeDefined();
    h.failWebAuth('web-auth-failed');
    await store().getState().reconnectGoogle(accountId as never);
    expect(store().getState().googleFailure).toEqual({ code: 'web-auth-failed', accountId });
    expect(store().getState().accounts).toHaveLength(1);
    h.failWebAuth(null);
    fireEvent.click(await screen.findByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(store().getState().googleFailure).toBeNull());
  });

  it('l’état de l’interface ne contient ni URL, ni code d’autorisation, ni ID client', async () => {
    renderScreen();
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    await screen.findByText('Code : web-auth-failed');
    const state = JSON.stringify({ ...store().getState(), reconnectRequest: null });
    for (const fragment of [h.google.clientId, 'http://', 'https://', 'code=', 'state=', 'oauth2redirect']) expect(state).not.toContain(fragment);
    expect(document.body.textContent).not.toContain(h.google.clientId);
  });
});
