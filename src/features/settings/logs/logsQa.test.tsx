import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../domain/clock';
import { createHlcClock } from '../../../domain/hlc';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { createMemoryFiles, type MemoryFiles } from '../../../platform/files';
import { createLogJournal, createMemoryLogTransport, type LogEntry, type LogTransport } from '../../../platform/logs';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { createAppContainer } from '../../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../../app/navigation';
import { configureExcursions } from '../../security/excursion';
import { LogsScreen } from './LogsScreen';

/**
 * QA du lot F (FILES-IOS-01 critère 9, I-04 critères 7, 8 et 10) : « Enregistrer dans Fichiers » annulé / échoué / trop gros, effacement refusé,
 * journal illisible ; chaque état d'échec offre une action utile et aucun « Réessayer » ne peut échouer d'avance.
 */
const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fb');
const SAMPLE: readonly LogEntry[] = [{ at: '2026-10-08T06:00:00.000Z', scope: 'sync', code: 'sync-now', detail: '' }];

describe('I-04 / FILES-IOS-01 QA : états d’échec de l’écran Logs', () => {
  let files: MemoryFiles;

  beforeEach(() => {
    files = createMemoryFiles();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    configureExcursions();
    useNavigationStore.setState(INITIAL_NAVIGATION);
  });

  function renderScreen(transport: LogTransport) {
    const clock = createManualClock('2026-10-08T08:12:00.000Z');
    const container = createAppContainer({ clock, hlc: createHlcClock({ clock, deviceId: DEVICE }), data: {} as never, files, platform: { runtime: 'tauri', os: 'ios' } });
    const journal = createLogJournal(transport, { document: null, window: null });
    render(
      <AppContainerProvider container={container}>
        <LogsScreen journal={journal} version={() => Promise.resolve('0.2.0')} />
      </AppContainerProvider>,
    );
    return journal;
  }

  const confirmClear = async (): Promise<void> => {
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getAllByRole('button').find((button) => button.textContent === 'Effacer');
    if (!confirm) throw new Error('bouton de confirmation introuvable');
    fireEvent.click(confirm);
  };

  it('FILES-IOS-01 critère 8 : fichier trop gros -> « Fichier trop volumineux » avec le code, SANS « Réessayer » (il échouerait encore), « Exporter » reste actif', async () => {
    renderScreen(createMemoryLogTransport(SAMPLE));
    await screen.findByRole('log');
    files.failNext('too-large', 'too-large');
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Fichier trop volumineux.');
    expect(alert).toHaveTextContent('Code : too-large');
    expect(within(alert).queryByRole('button', { name: 'Réessayer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Exporter' })).toBeEnabled();
    expect(files.saved).toHaveLength(0);
  });

  it('FILES-IOS-01 critère 9 : feuille impossible à présenter (app pas au premier plan) -> message avec code et « Réessayer » qui enregistre ensuite', async () => {
    renderScreen(createMemoryLogTransport(SAMPLE));
    await screen.findByRole('log');
    files.failNext('unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Code : unavailable');
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Logs exportés')).toBeInTheDocument();
    expect(files.saved).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('FILES-IOS-01 critère 2 : annuler après un échec efface le message d’échec, sans nouvelle erreur', async () => {
    renderScreen(createMemoryLogTransport(SAMPLE));
    await screen.findByRole('log');
    files.failNext('write-failed', 'io');
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));
    const alert = await screen.findByRole('alert');
    files.cancelNext();
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(files.saved).toHaveLength(0);
    expect(screen.queryByText('Logs exportés')).toBeNull();
  });

  it('I-04 critère 8 : « Effacer » refusé (lien, disque) -> message avec code, les entrées restent affichées, un second essai réussit', async () => {
    const inner = createMemoryLogTransport(SAMPLE);
    let refuse: string | null = 'unsafe-file';
    const transport: LogTransport = { append: (e) => inner.append(e), read: (m) => inner.read(m), clear: () => (refuse ? Promise.reject({ code: refuse }) : inner.clear()) };
    renderScreen(transport);
    await screen.findByRole('log');
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    await confirmClear();
    await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => /Code : unsafe-file/.test(alert.textContent ?? ''))).toBe(true));
    expect(within(await screen.findByRole('log')).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeEnabled();
    refuse = null;
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    await confirmClear();
    await waitFor(() => expect(within(screen.getByRole('log')).getByText('logs-cleared')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText(/Code : unsafe-file/)).toBeNull());
  });

  it('I-04 critère 10 : journal illisible (fichier corrompu côté Rust) -> message avec code, et « Effacer » permet de repartir', async () => {
    const transport = createMemoryLogTransport(SAMPLE);
    transport.failRead('unreadable');
    const journal = renderScreen(transport);
    expect(await screen.findByText(/Le journal n’a pas pu être lu.*Code : unreadable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeEnabled();
    transport.failRead(null);
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    await confirmClear();
    await waitFor(() => expect(screen.queryByText(/Le journal n’a pas pu être lu/)).toBeNull());
    expect(journal.status().readError).toBeNull();
  });
});
