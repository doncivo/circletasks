import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createIosFiles, createMemoryFiles, type FileService, type IosFileApi } from '../../platform/files';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { configureExcursions, currentExcursion } from '../security/excursion';
import { ImportScreen } from './ImportScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f8');
const HEADER = 'titre;date;heure;espace;projet;note';
const CSV = `${HEADER}\nAppeler Paul;2026-10-03;10:00;Perso;;\n=Somme;2026-10-03;;;;\n;2026-10-03;;;;\nSoirée;31/02/2026;;;;\nAilleurs;;;Famille;;`;

/** Faux de la commande Rust de l'iPhone : garde ce qui serait remis au sélecteur « Enregistrer dans Fichiers ». */
interface FakeIosApi extends IosFileApi {
  readonly saved: { readonly name: string; readonly data: Uint8Array; readonly excursion: string | undefined }[];
  next: 'save' | 'cancel' | { readonly code: string };
}

function fakeIosApi(): FakeIosApi {
  const api: FakeIosApi = {
    saved: [],
    next: 'save',
    saveFile(name, data) {
      const mode = api.next;
      api.next = 'save';
      if (mode === 'cancel') return Promise.resolve({ completed: false });
      if (typeof mode === 'object') return Promise.reject(mode);
      api.saved.push({ name, data, excursion: currentExcursion()?.kind });
      return Promise.resolve({ completed: true });
    },
  };
  return api;
}

describe('FILES-IOS-01 : P-07 sur iPhone (critères 5, 6 et 9)', () => {
  let db: TestDb;
  let api: FakeIosApi;
  let phone: FileService;
  let container: AppContainer;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T10:00:00.000Z');
    api = fakeIosApi();
    phone = { ...createIosFiles(api), pickText: () => Promise.resolve({ name: 'taches.csv', text: CSV }) };
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, files: phone });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    configureExcursions();
    useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  const renderScreen = (target: AppContainer = container) =>
    render(
      <AppContainerProvider container={target}>
        <ImportScreen />
      </AppContainerProvider>,
    );
  const click = (element: HTMLElement) => act(async () => void fireEvent.click(element));

  it('critère 5 : « Télécharger un modèle » et le rapport des rejets sont affichés et enregistrés par le sélecteur (excursion file-picker)', async () => {
    renderScreen();
    await click(screen.getByRole('button', { name: 'Télécharger un modèle' }));
    await waitFor(() => expect(api.saved).toHaveLength(1));
    expect(api.saved[0]).toMatchObject({ name: 'circletasks-modele-import.csv', excursion: 'file-picker' });
    expect(await screen.findByText('Modèle enregistré')).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
    await click(await screen.findByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }));
    await waitFor(() => expect(api.saved).toHaveLength(2));
    expect(api.saved[1]?.name).toBe('circletasks-import-lignes-rejetees.csv');
    expect(await screen.findByText('Rapport enregistré')).toBeInTheDocument();
  });

  it('critère 5 : contenu du modèle et du rapport identique à celui du PC (mêmes octets, mêmes noms)', async () => {
    const pc = createMemoryFiles();
    pc.setPick({ name: 'taches.csv', text: CSV });
    const pcContainer = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, files: pc });
    for (const [target, choose] of [
      [pcContainer, true],
      [container, true],
    ] as const) {
      const view = renderScreen(target);
      await click(screen.getByRole('button', { name: 'Télécharger un modèle' }));
      await screen.findByText('Modèle enregistré');
      if (choose) {
        await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
        await click(await screen.findByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }));
        await screen.findByText('Rapport enregistré');
      }
      view.unmount();
    }
    expect(pc.saved.map((file) => file.suggestedName)).toEqual(api.saved.map((file) => file.name));
    expect(pc.saved.map((file) => Array.from(file.data))).toEqual(api.saved.map((file) => Array.from(file.data)));
  });

  it('critère 5 et 9 : un échec affiche « L’enregistrement n’a pas abouti » avec le code et « Réessayer » ; l’import en cours n’est pas perdu', async () => {
    renderScreen();
    await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
    await screen.findByRole('button', { name: 'Télécharger le rapport des lignes rejetées' });
    api.next = { code: 'io' };
    await click(screen.getByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('L’enregistrement n’a pas abouti.');
    expect(alert).toHaveTextContent('Code : io');
    expect(warn).toHaveBeenCalled();
    // L'aperçu est toujours là ; « Réessayer » relance le même enregistrement.
    expect(screen.getByRole('button', { name: 'Importer 2 tâches' })).toBeInTheDocument();
    await click(within(alert).getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(api.saved).toHaveLength(1));
    expect(api.saved[0]?.name).toBe('circletasks-import-lignes-rejetees.csv');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('annuler le sélecteur n’affiche rien', async () => {
    renderScreen();
    api.next = 'cancel';
    await click(screen.getByRole('button', { name: 'Télécharger un modèle' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Modèle enregistré')).not.toBeInTheDocument();
  });

  it('critère 6 : le rapport rechargé se réimporte sans erreur (colonnes « ligne » et « motif » ignorées, apostrophe de neutralisation retirée)', async () => {
    const view = renderScreen();
    await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
    await click(await screen.findByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }));
    await waitFor(() => expect(api.saved).toHaveLength(1));
    const report = new TextDecoder().decode(api.saved[0]?.data);
    view.unmount();
    const again = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: db.data,
      files: { ...createIosFiles(api), pickText: () => Promise.resolve({ name: 'rapport.csv', text: report }) },
    });
    renderScreen(again);
    await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
    expect(await screen.findByText(/Colonnes ignorées : ligne, motif/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('critère 6 : une cellule neutralisée par l’export (apostrophe) est relue sans l’apostrophe', async () => {
    const neutralized = `${HEADER}\n'=Somme;2026-10-03;;;;`;
    const target = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }),
      data: db.data,
      files: { ...createIosFiles(api), pickText: () => Promise.resolve({ name: 'n.csv', text: neutralized }) },
    });
    renderScreen(target);
    await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
    expect(await screen.findByText('=Somme')).toBeInTheDocument();
  });
});
