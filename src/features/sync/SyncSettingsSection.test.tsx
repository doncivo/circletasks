// Y-01 critères 1, 5, 8, 10, 17 et 19 : section « SYNCHRONISATION » de Réglages, sur l'implémentation mémoire de SyncPlatform.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type Hlc } from '../../domain/types';
import type { EpochId } from '../../domain/sync/format';
import type { DataAccess } from '../../db/repositories';
import { MemorySyncFolder, SyncPlatformError, createMemorySyncPlatform, type SyncPlatform } from '../../platform/sync';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer } from '../app/container';
import { SyncSettingsSection } from './SyncSettingsSection';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000007');
const OTHER = '70000000-0000-4000-8000-000000000008' as DeviceId;
const clock = createManualClock('2026-10-05T08:00:00.000Z');

function renderSection(platform: SyncPlatform) {
  const container = createAppContainer({ hlc: createHlcClock({ clock, deviceId: DEVICE }), data: {} as DataAccess });
  return render(
    <AppContainerProvider container={container}>
      <SyncSettingsSection platform={platform} />
    </AppContainerProvider>,
  );
}

/** Dossier qui contient déjà des données chiffrées (écrites par un autre appareil). */
async function folderWithData(): Promise<MemorySyncFolder> {
  const folder = new MemorySyncFolder('shared');
  const other = createMemorySyncPlatform({ folder });
  await other.folder.choose();
  await other.key.create();
  await other.bindDevice(OTHER);
  await other.appendJournal({ epoch: `e0001-${OTHER}` as EpochId, segment: 1, expectRecords: 0, sv: 14, maxHlc: `000001759651200-0000-${OTHER}` as Hlc, records: ['{}'] });
  return folder;
}

const state = () => screen.getByTestId('sync-folder-state');

describe('SyncSettingsSection (Y-01)', () => {
  afterEach(() => cleanup());

  it('sans dossier : « Non configurée » et « Choisir le dossier » ; ni « Détails » ni « Associer » (critère 1)', async () => {
    renderSection(createMemorySyncPlatform());
    expect(screen.getByText('SYNCHRONISATION')).toBeInTheDocument();
    expect(await screen.findByText('Non configurée')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choisir le dossier de synchronisation' })).toBeInTheDocument();
    expect(screen.queryByText('Détails')).toBeNull();
    expect(screen.queryByText('Associer')).toBeNull();
  });

  it('choix du dossier : libellé, « Dossier choisi », clé créée et appareil lié (critères 1 et 10)', async () => {
    const platform = createMemorySyncPlatform();
    renderSection(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByText('iCloud Drive / CircleTasks')).toBeInTheDocument();
    expect(state()).toHaveTextContent('Dossier choisi');
    expect(screen.queryByTestId('sync-folder-warning')).toBeNull();
    expect((await platform.key.status()).present).toBe(true);
    // Appareil lié : un autre identifiant est refusé (critère 5).
    await expect(platform.bindDevice(OTHER)).rejects.toMatchObject({ code: 'already-bound' });
    // Une fois lié, « Choisir le dossier » n'est plus proposé (D2).
    expect(screen.queryByRole('button', { name: 'Choisir le dossier de synchronisation' })).toBeNull();
  });

  it('choix annulé : rien ne change (critère 2)', async () => {
    const platform = createMemorySyncPlatform();
    platform.testing.setChooser(null);
    renderSection(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choisir le dossier de synchronisation' })).not.toBeDisabled());
    expect(state()).toHaveTextContent('Non configurée');
    expect((await platform.folder.info()).configured).toBe(false);
  });

  it('dossier qui contient déjà des données chiffrées : aucune clé, « associez cet appareil » (critère 10)', async () => {
    const platform = createMemorySyncPlatform({ folder: await folderWithData() });
    renderSection(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toHaveAttribute('role', 'status');
    expect((await platform.key.status()).present).toBe(false);
  });

  it('dossier hors iCloud : avertissement sous la ligne (critère 8)', async () => {
    renderSection(createMemorySyncPlatform({ folder: new MemorySyncFolder('local', 'ct-test', 'local') }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByTestId('sync-folder-warning')).toHaveTextContent('Ce dossier n’est pas dans iCloud Drive : vos appareils ne le partageront pas');
  });

  it('erreur du dossier annoncée (role="status"), message français sans détail technique (critères 6, 7 et 19)', async () => {
    const platform = createMemorySyncPlatform();
    const failing: SyncPlatform = { ...platform, folder: { ...platform.folder, choose: () => Promise.reject(new SyncPlatformError('unsafe-folder')) } };
    renderSection(failing);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByText('Ce dossier ne peut pas servir à la synchronisation')).toHaveAttribute('role', 'status');
    const unreachable: SyncPlatform = { ...platform, folder: { ...platform.folder, info: () => Promise.reject(new SyncPlatformError('folder-unreachable')) } };
    cleanup();
    renderSection(unreachable);
    expect(await screen.findByText('Le dossier de synchro est introuvable')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Oublier le dossier de synchronisation' })).toBeInTheDocument();
  });

  it('« Oublier le dossier » : focus sur « Annuler », la clé est gardée et rechoisir le même dossier reprend sans association (critère 17)', async () => {
    const platform = createMemorySyncPlatform();
    renderSection(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier de synchronisation' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Oublier le dossier de synchro ?' });
    expect(dialog).toHaveTextContent('La désinstallation de l’app n’efface pas la clé');
    expect(document.activeElement).toHaveTextContent('Annuler');
    const kid = (await platform.key.status()).kid;
    fireEvent.click(screen.getByRole('button', { name: 'Oublier le dossier' }));
    expect(await screen.findByText('Non configurée')).toBeInTheDocument();
    expect(await platform.key.status()).toEqual({ present: true, kid });
    fireEvent.click(screen.getByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByText('Dossier choisi')).toBeInTheDocument();
    expect((await platform.key.status()).kid).toBe(kid);
  });

  it('« Oublier le dossier et la clé » : confirmation native, puis plus de clé', async () => {
    const platform = createMemorySyncPlatform();
    renderSection(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier de synchronisation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier et la clé' }));
    expect(await screen.findByText('Non configurée')).toBeInTheDocument();
    expect(platform.testing.consentPrompts()).toBe(1);
    expect((await platform.key.status()).present).toBe(false);
  });

  it('confirmation native refusée : le dossier reste lié, refus annoncé', async () => {
    const platform = createMemorySyncPlatform();
    renderSection(platform);
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    platform.testing.setConsent(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier de synchronisation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier et la clé' }));
    expect(await screen.findByText('Action annulée')).toHaveAttribute('role', 'status');
    expect((await platform.folder.info()).configured).toBe(true);
    expect((await platform.key.status()).present).toBe(true);
  });

  it('absente quand la plateforme ne synchronise pas (iPhone avant l’ordre 5, critère 18)', () => {
    const { container } = renderSection(createMemorySyncPlatform({ available: false }));
    expect(container).toBeEmptyDOMElement();
  });
});
