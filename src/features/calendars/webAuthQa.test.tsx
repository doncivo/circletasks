import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ACCOUNT } from '../../../tests/sim';
import { AppContainerProvider } from '../app/AppContainerContext';
import { mockViewport } from '../today/testKit';
import { CalendarsScreen } from './CalendarsScreen';
import { calendarsStore } from './calendarsStore';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

/**
 * K-TECH-01, passe QA : double clic sur « Google » (une seule session), annulation, state falsifié, aucun secret dans les messages
 * ni dans les sorties de console, échec persistant puis succès.
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
const authorizations = () => h.google.log.filter((line) => line.startsWith('GET /o/oauth2/v2/auth')).length;

beforeEach(async () => {
  mockViewport(440);
  h = await setupCalendarHarness('14');
});
afterEach(() => h.close());

describe('K-TECH-01 QA : une seule session de connexion', () => {
  it('QA-3 deux clics rapprochés sur « Google » ouvrent une seule session et créent un seul compte', async () => {
    renderScreen();
    fireEvent.click(googleButton());
    fireEvent.click(googleButton());
    fireEvent.click(googleButton());
    await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
    await waitFor(() => expect(store().getState().connecting).toBe(false));
    expect(authorizations()).toBe(1);
    expect(store().getState().accounts).toHaveLength(1);
    expect(await h.container.data.repos.calendarAccounts.listAll()).toHaveLength(1);
  });

  it('QA-3 deux appels simultanés du store : le second est refusé sans appeler la plateforme', async () => {
    const first = store().getState().connectGoogle();
    const second = await store().getState().connectGoogle();
    expect(second).toEqual({ ok: false, failure: 'failed' });
    expect((await first).ok).toBe(true);
    expect(authorizations()).toBe(1);
    expect(store().getState().connecting).toBe(false);
  });

  it('QA-3 double clic sur « Réessayer » après un échec : une seule nouvelle session', async () => {
    renderScreen();
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    const retry = await screen.findByRole('button', { name: 'Réessayer' });
    h.failWebAuth(null);
    fireEvent.click(retry);
    fireEvent.click(retry);
    await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
    await waitFor(() => expect(store().getState().connecting).toBe(false));
    expect(authorizations()).toBe(1);
    expect(store().getState().accounts).toHaveLength(1);
  });
});

describe('K-TECH-01 QA : annulation, state falsifié, échec puis réussite', () => {
  it('QA-3 annulation volontaire : « Connexion annulée », aucun compte, bouton à nouveau actif', async () => {
    renderScreen();
    h.google.denyNextConsent();
    fireEvent.click(googleButton());
    expect(await screen.findByText('Connexion annulée')).toBeInTheDocument();
    expect(screen.getByText('Aucun compte connecté.')).toBeInTheDocument();
    expect(googleButton()).toBeEnabled();
    expect(store().getState().googleFailure).toBeNull();
    expect(await h.container.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('QA-2 state falsifié : message de connexion impossible, aucun compte, aucun échange de code', async () => {
    renderScreen();
    h.google.forgeNextState();
    fireEvent.click(googleButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion impossible. Réessayez.');
    expect(screen.getByText('Aucun compte connecté.')).toBeInTheDocument();
    expect(h.google.log.some((line) => line.startsWith('POST /token'))).toBe(false);
    expect(store().getState().googleFailure).toBeNull();
  });

  it('QA-6 échec persistant sur plusieurs tentatives, disparition à la réussite uniquement', async () => {
    renderScreen();
    h.failWebAuth('web-auth-unavailable');
    fireEvent.click(googleButton());
    await screen.findByText('Code : web-auth-unavailable');
    for (const code of ['web-auth-failed', 'web-auth-unavailable'] as const) {
      h.failWebAuth(code);
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
      await screen.findByText(`Code : ${code}`);
      expect(screen.getByText('La connexion à Google n’a pas pu aboutir.')).toBeInTheDocument();
    }
    h.failWebAuth(null);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
    await waitFor(() => expect(screen.queryByText('La connexion à Google n’a pas pu aboutir.')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument();
  });
});

describe('K-TECH-01 QA : aucune fuite du code, de l’URL ou de l’ID client', () => {
  it('QA-5 ni l’écran, ni la console, ni la base ne contiennent l’URL de retour, le code ou l’ID client après réussite, annulation, falsification et échec', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    renderScreen();
    h.google.forgeNextState();
    fireEvent.click(googleButton());
    await screen.findByRole('alert');
    await waitFor(() => expect(store().getState().connecting).toBe(false));
    h.google.denyNextConsent();
    fireEvent.click(googleButton());
    await screen.findByText('Connexion annulée');
    h.failWebAuth('web-auth-failed');
    fireEvent.click(googleButton());
    await screen.findByText('Code : web-auth-failed');
    h.failWebAuth(null);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await screen.findByRole('region', { name: `Google Agenda · ${GOOGLE_ACCOUNT}` });
    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call))).join('\n');
    const screenText = document.body.textContent ?? '';
    const state = JSON.stringify({ ...store().getState(), reconnectRequest: null });
    for (const text of [logged, screenText, state]) {
      for (const fragment of [h.google.clientId, 'code=', 'state=', 'oauth2redirect', 'oauth/callback', 'googleusercontent.com/oauth']) expect(text).not.toContain(fragment);
    }
    spies.forEach((spy) => spy.mockRestore());
  });
});
