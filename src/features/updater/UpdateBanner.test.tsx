import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { UpdateInstallError } from '../../platform';
import { createFakeDesktop, fakePendingUpdate, type FakeDesktop } from '../../platform/desktop/testing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { UpdateBanner } from './UpdateBanner';
import { updaterStore } from './updaterStore';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d4');

describe('UpdateBanner (D-03)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let container: AppContainer;

  const renderBanner = () =>
    render(
      <AppContainerProvider container={container}>
        <UpdateBanner />
      </AppContainerProvider>,
    );
  const check = () => act(async () => void (await updaterStore.get(container).getState().check()));

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await db.close();
  });

  it('invisible sans mise à jour (critère 3)', async () => {
    renderBanner();
    await check();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('affiche « Nouvelle version X disponible » avec exactement trois actions, sans « Ignorer » (critère 2, QB-16)', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0');
    renderBanner();
    await check();
    const banner = screen.getByRole('region', { name: 'Mise à jour de CircleTasks' });
    expect(within(banner).getByText('Nouvelle version 1.2.0 disponible')).toBeInTheDocument();
    expect(within(banner).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Voir les notes',
      'Installer et redémarrer',
      'Plus tard',
    ]);
    expect(within(banner).queryByText(/ignorer/i)).not.toBeInTheDocument();
  });

  it('« Voir les notes » affiche les notes de la version (en texte brut)', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0', { notes: 'Ligne 1\n<b>Ligne 2</b>' });
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Voir les notes' }).click();
    expect(await screen.findByRole('heading', { name: 'Notes de la version 1.2.0' })).toBeInTheDocument();
    expect(screen.getByText(/Ligne 2/)).toHaveTextContent('<b>Ligne 2</b>');
    expect(screen.getByRole('button', { name: 'Masquer les notes' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('notes absentes : message neutre', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0', { notes: null });
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Voir les notes' }).click();
    expect(await screen.findByText('Aucune note pour cette version.')).toBeInTheDocument();
  });

  it('« Plus tard » ferme le bandeau', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0');
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Plus tard' }).click();
    await waitFor(() => expect(screen.queryByRole('region')).not.toBeInTheDocument());
  });

  it('« Installer et redémarrer » : progression en pourcentage, actions désactivées', async () => {
    let release: () => void = () => undefined;
    desktop.nextCheck = fakePendingUpdate('1.2.0', {
      install: (onProgress) =>
        new Promise<void>((resolve) => {
          onProgress({ downloadedBytes: 25, totalBytes: 100 });
          release = resolve;
        }),
    });
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Installer et redémarrer' }).click();
    expect(await screen.findByText('Téléchargement de la mise à jour… 25 %')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Installer et redémarrer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Plus tard' })).toBeDisabled();
    await act(async () => release());
  });

  it('taille inconnue : progression sans pourcentage', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0', { install: () => new Promise<void>(() => undefined) });
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Installer et redémarrer' }).click();
    expect(await screen.findByText('Téléchargement de la mise à jour…')).toBeInTheDocument();
  });

  it('signature invalide : « Mise à jour refusée : signature invalide », l’app continue (critère 5)', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0', { install: () => Promise.reject(new UpdateInstallError('signature', 'x')) });
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Installer et redémarrer' }).click();
    expect(await screen.findByRole('alert')).toHaveTextContent('Mise à jour refusée : signature invalide');
    expect(screen.getByRole('button', { name: 'Plus tard' })).toBeEnabled();
  });

  it('autre échec d’installation : message générique', async () => {
    desktop.nextCheck = fakePendingUpdate('1.2.0', { install: () => Promise.reject(new Error('disque plein')) });
    renderBanner();
    await check();
    screen.getByRole('button', { name: 'Installer et redémarrer' }).click();
    expect(await screen.findByRole('alert')).toHaveTextContent('La mise à jour a échoué');
  });
});
