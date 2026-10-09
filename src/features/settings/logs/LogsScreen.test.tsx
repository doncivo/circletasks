import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../domain/clock';
import { createHlcClock } from '../../../domain/hlc';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { createMemoryFiles, type MemoryFiles } from '../../../platform/files';
import { createLogJournal, createMemoryLogTransport, type LogEntry, type MemoryLogTransport } from '../../../platform/logs';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { createAppContainer } from '../../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../../app/navigation';
import { configureExcursions } from '../../security/excursion';
import { LogsScreen } from './LogsScreen';
import { buildLogExport, logExportName } from './logExport';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f9');

const entry = (at: string, scope: string, code: string, detail = ''): LogEntry => ({ at, scope, code, detail });

const SAMPLE: readonly LogEntry[] = [
  entry('2026-10-08T06:00:00.000Z', 'sync', 'sync-now', '{"reason":"open"}'),
  entry('2026-10-08T06:30:00.000Z', 'notifications', 'replan', 'open: unreadable (3)'),
  entry('2026-10-08T07:00:00.000Z', 'backup-daily', 'sauvegarde', ': io'),
  entry('2026-10-08T07:30:00.000Z', 'reminders-plan', 'ledger-unreadable'),
  entry('2026-10-08T07:45:00.000Z', 'sync-rust', 'pin-failed'),
];

describe('I-04 : écran Logs', () => {
  let transport: MemoryLogTransport;
  let files: MemoryFiles;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transport = createMemoryLogTransport(SAMPLE);
    files = createMemoryFiles();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    configureExcursions();
    useNavigationStore.setState(INITIAL_NAVIGATION);
  });

  function renderScreen(options: { readonly os?: 'windows' | 'ios'; readonly withFiles?: MemoryFiles } = {}) {
    const clock = createManualClock('2026-10-08T08:12:00.000Z');
    const container = createAppContainer({ clock, hlc: createHlcClock({ clock, deviceId: DEVICE }), data: {} as never, files: options.withFiles ?? files, platform: { runtime: 'tauri', os: options.os ?? 'ios' } });
    const journal = createLogJournal(transport, { document: null, window: null });
    const view = render(
      <AppContainerProvider container={container}>
        <LogsScreen journal={journal} version={() => Promise.resolve('0.2.0')} />
      </AppContainerProvider>,
    );
    return { view, journal };
  }

  const rows = () => within(screen.getByRole('log')).getAllByRole('listitem').map((item) => item.textContent ?? '');

  it('critère 1 : titre h1 focalisé, retour vers Réglages', async () => {
    renderScreen();
    const title = screen.getByRole('heading', { level: 1, name: 'Logs' });
    await waitFor(() => expect(title).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Retour aux réglages' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'home' });
  });

  it('critère 2 : de la plus récente à la plus ancienne (heure locale 24 h, scope, code) ; filtres Tout, Synchro, Notifications, Erreurs', async () => {
    renderScreen();
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(rows()[0]).toContain('sync-rust pin-failed');
    expect(rows()[4]).toContain('sync sync-now {"reason":"open"}');
    // Heure locale par le formateur unique (P-03, 24 h par défaut) : « 8 oct. HH:45 ».
    expect(rows()[0]).toMatch(/^8 oct\. \d{2}:45 /);
    const filter = (name: string) => screen.getByRole('button', { name });
    expect(filter('Tout')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(filter('Synchro'));
    expect(filter('Synchro')).toHaveAttribute('aria-pressed', 'true');
    expect(filter('Tout')).toHaveAttribute('aria-pressed', 'false');
    expect(rows()).toEqual([expect.stringContaining('sync-rust'), expect.stringContaining('sync sync-now')]);
    fireEvent.click(filter('Notifications'));
    expect(rows()).toEqual([expect.stringContaining('reminders-plan'), expect.stringContaining('notifications replan')]);
    fireEvent.click(filter('Erreurs'));
    expect(rows()).toEqual([expect.stringContaining('backup-daily')]);
  });

  it('critère 2 : un journal vide affiche « Aucune entrée »', async () => {
    transport = createMemoryLogTransport([]);
    renderScreen();
    expect(await screen.findByText('Aucune entrée')).toBeInTheDocument();
  });

  it('critère 7 : « Exporter » -> texte UTF-8 circletasks-logs-AAAAMMJJ-HHMM.txt (en-tête, lignes UTC), sélecteur iPhone en excursion', async () => {
    renderScreen();
    await waitFor(() => expect(rows()).toHaveLength(5));
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));
    expect(await screen.findByText('Logs exportés')).toBeInTheDocument();
    expect(files.saved).toHaveLength(1);
    const saved = files.saved[0];
    expect(saved?.suggestedName).toBe(logExportName(new Date('2026-10-08T08:12:00.000Z')));
    expect(saved?.suggestedName).toMatch(/^circletasks-logs-\d{8}-\d{4}\.txt$/);
    expect(saved?.mime).toBe('text/plain');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(saved?.data);
    expect(text).toContain('Application : CircleTasks 0.2.0');
    expect(text).toContain('Système : iPhone (iOS)');
    expect(text).toMatch(/Version de schéma : \d+/);
    expect(text).toContain('Entrées : 5');
    expect(text).toContain('Ce fichier ne contient ni titres ni notes.');
    expect(text).toMatch(/Heures des entrées en UTC \(heure locale = UTC[+-]\d{2}:\d{2}\)/);
    expect(text).toContain('2026-10-08 06:00:00 sync sync-now {"reason":"open"}\r\n');
    expect(text.endsWith('2026-10-08 07:45:00 sync-rust pin-failed\r\n')).toBe(true);
  });

  it('critère 7 : annulation = rien ; échec = « L’export n’a pas abouti » avec le code et « Réessayer »', async () => {
    renderScreen();
    await waitFor(() => expect(rows()).toHaveLength(5));
    files.cancelNext();
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Exporter' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    files.failNext('write-failed', 'io');
    fireEvent.click(screen.getByRole('button', { name: 'Exporter' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('L’export n’a pas abouti.');
    expect(alert).toHaveTextContent('Code : io');
    expect(warn).toHaveBeenCalled();
    fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Logs exportés')).toBeInTheDocument();
  });

  it('critère 8 : « Effacer » demande confirmation (Annuler par défaut) ; après confirmation, logs-cleared est la seule entrée', async () => {
    renderScreen();
    await waitFor(() => expect(rows()).toHaveLength(5));
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Annuler' })).toHaveFocus());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(rows()).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Effacer' }));
    await waitFor(() => expect(rows()).toEqual([expect.stringContaining('logs logs-cleared')]));
  });

  it('critère 10 : échec d’écriture affiché en rouge avec le code ; échec de lecture affiché au lieu d’une liste vide', async () => {
    transport.failAppend('disk-full');
    transport.failRead('unreadable');
    const { journal } = renderScreen();
    await act(async () => {
      journal.record('sync', 'sync-now');
      await journal.flush();
    });
    expect(await screen.findByText(/Le journal n’a pas pu être écrit. Code : disk-full/)).toBeInTheDocument();
    expect(screen.getByText(/Le journal n’a pas pu être lu.*Code : unreadable/)).toBeInTheDocument();
    // Les entrées de la session restent affichées (lecture de secours).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Synchro' }));
      await Promise.resolve();
    });
    // Le message disparaît à la prochaine écriture réussie.
    transport.failAppend(null);
    await act(async () => {
      journal.record('sync', 'again');
      await journal.flush();
    });
    expect(screen.queryByText(/Le journal n’a pas pu être écrit/)).toBeNull();
  });

  it('critère 12 : filtres en aria-pressed, liste role="log" non annoncée en continu, boutons de 44 px au moins (classe)', async () => {
    renderScreen();
    const log = await screen.findByRole('log');
    expect(log).toHaveAttribute('aria-live', 'off');
    for (const name of ['Tout', 'Synchro', 'Notifications', 'Erreurs']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed');
    expect(screen.getByRole('button', { name: 'Exporter' }).className).toBe('ct-logs__export');
  });

  it('PC : même écran ; sans enregistrement de fichier, « Exporter » n’est pas affiché', async () => {
    renderScreen({ os: 'windows', withFiles: createMemoryFiles({ canSave: false }) });
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(screen.queryByRole('button', { name: 'Exporter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Effacer' })).toBeEnabled();
  });

  it('500 entrées au plus', async () => {
    transport = createMemoryLogTransport(Array.from({ length: 600 }, (_, i) => entry('2026-10-08T07:00:00.000Z', 'sync', `e${String(i)}`)));
    renderScreen();
    await waitFor(() => expect(rows()).toHaveLength(500));
    expect(rows()[0]).toContain('e599');
  });

  it('export : entrées fusionnées (×n) et en-tête en anglais possibles (texte i18n)', () => {
    const file = buildLogExport([{ ...entry('2026-10-08T07:00:00.000Z', 'sync', 'x'), n: 3 }], { version: '0.2.0', os: 'windows', schemaVersion: 17, now: new Date('2026-10-08T08:00:00.000Z') });
    expect(file.text).toContain('2026-10-08 07:00:00 sync x ×3\r\n');
    expect(file.text).toContain('Système : Windows');
    expect(file.text).toContain('Version de schéma : 17');
  });
});
