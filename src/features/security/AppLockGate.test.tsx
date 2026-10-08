import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeAuthenticator, guardAuthenticator, type FakeAuthenticator } from '../../platform/biometric';
import { createFakePrivacyShield } from '../../platform/privacyShield';
import { getNotificationRunner } from '../reminders/notificationRunner';
import { startNotificationIntegration } from '../reminders/startNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from '../reminders/testKit';
import { createFakeSyncService } from '../sync/testKit';
import { AppContainerProvider } from '../app/AppContainerContext';
import { SettingsScreen } from '../settings/SettingsScreen';
import { AppLockGate } from './AppLockGate';
import { resetAppLockStore, useAppLockStore } from './appLockStore';
import { configureExcursions } from './excursion';
import { startAppLockFor, type AppLockController } from './startAppLock';

/** I-03 critères 5, 6, 7, 9 et 11 : écran de verrou, coquille, Réglages, intégrations qui continuent pendant le verrou. */

let visibility: DocumentVisibilityState = 'visible';
let h: ReminderHarness;
let fake: FakeAuthenticator;
let lock: AppLockController | null = null;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function Shell() {
  const [text, setText] = useState('');
  return (
    <main>
      <ul>
        <li>{'Courses'}</li>
      </ul>
      <input aria-label={'Saisie'} value={text} onChange={(event) => setText(event.target.value)} />
    </main>
  );
}

async function boot(appLock: unknown, sync = createFakeSyncService()) {
  const container = reopenReminders(h, { parts: { authenticator: guardAuthenticator(fake), privacyShield: createFakePrivacyShield(), sync } });
  await container.data.repos.settings.set('security.appLock', appLock);
  lock = startAppLockFor(container);
  await lock.ready;
  const view = render(
    <AppContainerProvider container={container}>
      <AppLockGate>
        <Shell />
      </AppLockGate>
    </AppContainerProvider>,
  );
  return { container, view, sync };
}

beforeEach(async () => {
  resetAppLockStore();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  h = await setupReminders();
  configureExcursions({ now: () => h.db.clock.nowMs(), isVisible: () => visibility !== 'hidden' });
  fake = createFakeAuthenticator();
});

afterEach(async () => {
  cleanup();
  lock?.dispose();
  lock = null;
  document.body.innerHTML = '';
  delete document.documentElement.dataset['privacy'];
  delete document.documentElement.dataset['appLock'];
  configureExcursions();
  await h.db.close();
});

describe('écran de verrou et coquille (critères 6, 7 et 11)', () => {
  it('lancement verrouillé : coquille non montée, écran de verrou seul, authentification automatique une fois ; réussite : coquille montée', async () => {
    fake.enqueue('user-cancel');
    await boot(true);
    await flush();
    expect(screen.queryByText('Courses')).toBeNull();
    expect(screen.getByRole('heading', { name: 'CircleTasks est verrouillée' })).toBeInTheDocument();
    expect(screen.getByText('CircleTasks', { selector: '.ct-lock__app' })).toBeInTheDocument();
    expect(fake.authenticateCount()).toBe(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Déverrouillage annulé');
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller CircleTasks' }));
    await flush();
    expect(screen.getByText('Courses')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'CircleTasks est verrouillée' })).toBeNull();
  });

  it('retour après 31 s : coquille montée mais hidden, inert, aria-hidden ; saisie retrouvée au déverrouillage', async () => {
    await boot(true);
    await flush();
    const input = screen.getByRole('textbox', { name: 'Saisie' });
    fireEvent.change(input, { target: { value: 'Acheter du pain' } });
    fake.enqueue('authentication-failed');
    setVisibility('hidden');
    h.db.clock.advance(31_000);
    setVisibility('visible');
    await flush();
    const content = screen.getByTestId('app-lock-content');
    expect(content).toHaveAttribute('hidden');
    expect(content).toHaveAttribute('inert');
    expect(content).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Déverrouillage impossible (authentication-failed)');
    // Le seul contenu lisible : l'écran de verrou (le reste est caché aux technologies d'assistance).
    expect(screen.queryByRole('textbox', { name: 'Saisie' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Déverrouiller CircleTasks' }));
    await flush();
    expect(screen.getByRole('textbox', { name: 'Saisie' })).toHaveValue('Acheter du pain');
    expect(screen.getByTestId('app-lock-content')).not.toHaveAttribute('inert');
  });

  it('plugin en échec : message persistant avec le code et « Réessayer », jamais de déverrouillage', async () => {
    fake.setDefault('unavailable');
    await boot(true);
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Le verrouillage ne répond pas (unavailable). Vos données sont intactes.');
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await flush();
    expect(screen.queryByText('Courses')).toBeNull();
    expect(fake.authenticateCount()).toBe(2);
  });

  it('aucun code sur l’iPhone : message, sortie « Désactiver le verrouillage » avec confirmation ; réglage écrit faux', async () => {
    fake.enqueue('passcode-not-set');
    const { container } = await boot(true);
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Déverrouillage impossible : aucun code n’est défini sur l’iPhone');
    fireEvent.click(screen.getByRole('button', { name: 'Désactiver le verrouillage' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Désactiver le verrouillage ?' });
    expect(dialog).toHaveTextContent('Les données de CircleTasks seront de nouveau lisibles sans protection');
    fireEvent.click(screen.getByRole('button', { name: 'Désactiver' }));
    await flush();
    expect(screen.getByText('Courses')).toBeInTheDocument();
    expect(await container.data.repos.settings.get('security.appLock')).toBe(false);
  });

  it('sans code, avant tout retour passcode-not-set : pas de sortie proposée', async () => {
    fake.enqueue('user-cancel');
    await boot(true);
    await flush();
    expect(screen.queryByRole('button', { name: 'Désactiver le verrouillage' })).toBeNull();
  });
});

describe('le verrou couvre l’interface, pas les données (critère 7)', () => {
  it('pendant le verrou, un onRemoteChanges simulé replanifie les rappels', async () => {
    fake.setDefault('user-cancel');
    const { container, sync } = await boot(true);
    expect(useAppLockStore.getState().phase).toBe('locked');
    const integration = startNotificationIntegration(container, { document: { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as never });
    await integration.opened();
    const replaces = () => h.fake.calls.filter((call) => call.type === 'replace').length;
    const before = replaces();
    await seedReminderTask(container, { title: 'Appeler le notaire', date: '2026-10-09', time: '09:00' });
    sync.emitChanges({ tables: new Set(['task']), ids: new Map() });
    await getNotificationRunner(container).request('action');
    expect(replaces()).toBeGreaterThan(before);
    expect(useAppLockStore.getState().phase).toBe('locked');
    integration.dispose();
  });
});

describe('Réglages > DONNÉES ET SÉCURITÉ (critères 5 et 9, D2)', () => {
  async function settings(appLock: unknown) {
    const container = reopenReminders(h, { parts: { authenticator: guardAuthenticator(fake), privacyShield: createFakePrivacyShield() } });
    await container.data.repos.settings.set('security.appLock', appLock);
    lock = startAppLockFor(container);
    await lock.ready;
    render(
      <AppContainerProvider container={container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    await flush();
    return container;
  }

  it('ligne « Verrouillage Face ID » (Reglages.html) ; activer demande une authentification ; refus : réglage inchangé, message', async () => {
    const container = await settings(false);
    const row = screen.getByRole('switch', { name: 'Verrouillage Face ID' });
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Repli sur le code de l’iPhone')).toBeInTheDocument();
    expect(screen.getByText(/Protège l’app, pas le texte des notifications/)).toBeInTheDocument();
    fake.enqueue('user-cancel');
    fireEvent.click(row);
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Le verrouillage n’a pas été activé');
    expect(await container.data.repos.settings.get('security.appLock')).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Verrouillage Face ID' }));
    await flush();
    expect(fake.calls.at(-1)).toMatchObject({ reason: 'Activer le verrouillage de CircleTasks' });
    expect(screen.getByRole('switch', { name: 'Verrouillage Face ID' })).toHaveAttribute('aria-checked', 'true');
    expect(await container.data.repos.settings.get('security.appLock')).toBe(true);
  });

  it('aucun code défini : activation refusée avec la raison, sans fenêtre Face ID', async () => {
    fake.setStatus({ kind: 'face-id', biometryAvailable: false, passcode: 'not-set', code: 'passcode-not-set' });
    await settings(false);
    fireEvent.click(screen.getByRole('switch', { name: 'Verrouillage Face ID' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Le verrouillage n’a pas été activé Aucun code n’est défini sur l’iPhone');
    expect(fake.authenticateCount()).toBe(0);
  });

  it('biométrie indisponible (refusée) mais code défini : libellé « code de l’iPhone »', async () => {
    fake.setStatus({ kind: 'face-id', biometryAvailable: false, passcode: 'unknown', code: 'not-available' });
    await settings(false);
    expect(screen.getByRole('switch', { name: 'Verrouillage par code de l’iPhone' })).toBeInTheDocument();
  });

  it('Touch ID : libellé générique « biométrie »', async () => {
    fake.setStatus({ kind: 'touch-id', biometryAvailable: true, passcode: 'set', code: null });
    await settings(false);
    expect(screen.getByRole('switch', { name: 'Verrouillage par biométrie' })).toBeInTheDocument();
  });

  it('PC et navigateur : ligne absente', async () => {
    const container = reopenReminders(h, { platform: { runtime: 'tauri', os: 'windows' } });
    lock = startAppLockFor(container);
    await lock.ready;
    render(
      <AppContainerProvider container={container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    await flush();
    expect(screen.queryByRole('switch', { name: /Verrouillage/ })).toBeNull();
    expect(useAppLockStore.getState().phase).toBe('unlocked');
  });
});
