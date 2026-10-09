// @vitest-environment jsdom
// Y-IOS-02, QA du parcours d'association : défauts D1 à D6 constatés par la QA (PR #15), rouges avant la correction (branche fix-pairing-d1-d6).
// Chaque test dit l'attendu ; il passe au vert quand le défaut est corrigé, puis rejoint pairingMatrix.test.tsx ou pairingScreens.test.tsx.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncPlatform } from '../../platform/sync';
import { syncPairingWindowFr } from '../../i18n/fr.syncPairing';
import { PAIRING_PHONE_ID as SELF, publishedPcFolder, type PcWorld } from '../../../tests/fixtures/pairingWorld';
import { settle } from '../../../tests/setup/settle';
import {
  associate,
  bannerText,
  closeRig,
  current,
  fakePhase,
  harness,
  observe,
  openRig,
  renderIn,
  visibleActions,
  type Os,
} from '../../../tests/fixtures/pairingMatrixKit';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';
import { IosPairingScreen } from './IosPairingScreen';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService } from './testKit';

beforeEach(async () => {
  await openRig();
});
afterEach(async () => {
  await closeRig();
});

describe('D1 appareil oublié (forgotten) sur PC : aucun QR à afficher', () => {
  it('« Associer l’iPhone » n’est offert ni dans Réglages ni dans Détails (seul « Associer de nouveau » l’est)', async () => {
    const h = await fakePhase('windows', { phase: 'forgotten', errorCode: null });
    const seen = await observe(h);
    expect(seen.settings).not.toContain('showQr');
    expect(seen.details).not.toContain('showQr');
    expect(seen.details).toContain('rejoin');
    h.integration.dispose();
  });
});

describe('D2 erreur permanente de dossier à rechoisir (not-bound, unsafe-folder, folder-too-large) : Détails', () => {
  for (const os of ['windows', 'ios'] as Os[]) {
    it(`Détails ne propose ni « Réinitialiser » ni « Associer l’iPhone » — ${os}`, async () => {
      const h = await fakePhase(os, { phase: 'error', errorCode: 'not-bound' });
      const seen = await observe(h);
      expect(seen.details).not.toContain('reset');
      expect(seen.details).not.toContain('showQr');
      h.integration.dispose();
    });

    it(`« Voir » du bandeau (« Réglages → Synchronisation ») mène à un écran qui offre « Choisir le dossier » — ${os}`, async () => {
      const h = await fakePhase(os, { phase: 'error', errorCode: 'not-bound' });
      await observe(h);
      useAppStatusStore.getState().sources.syncTrouble?.onAction?.();
      expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'sync' });
      renderIn(h.container, <SyncDetailsScreen />);
      await settle(current().db.driver);
      expect(visibleActions()).toContain('choose');
      cleanup();
      h.integration.dispose();
    });
  }
});

describe('D3 coffre illisible sur PC : pas de QR à afficher', () => {
  it('Trousseau / coffre verrouillé : « Associer l’iPhone » n’est pas offert dans Détails', async () => {
    const platform = await current().world.device('windows', SELF, true);
    await associate(platform, 'windows', await current().world.qr());
    platform.testing.setVaultAvailable(false);
    const h = await harness(platform, 'windows');
    expect((await observe(h)).details).not.toContain('showQr');
    h.integration.dispose();
  });
});

describe('D4 erreur passagère répétée : le texte garde l’explication de la cause', () => {
  it('iPhone verrouillé, trois cycles de suite : le bandeau dit toujours « Trousseau » et « déverrouillez l’iPhone »', async () => {
    const platform = await current().world.device('ios', SELF, true);
    await associate(platform, 'ios', await current().world.qr());
    platform.testing.setVaultAvailable(false);
    const h = await harness(platform, 'ios', { cycles: 3 });
    await observe(h);
    expect(bannerText()).toMatch(/Trousseau/);
    expect(bannerText()).toMatch(/déverrouillez l’iPhone/);
    h.integration.dispose();
  });
});

describe('D6 écran « Associer au PC » : cause masquée pendant le scan', () => {
  let db: TestDb;
  let world: PcWorld;
  beforeEach(async () => {
    db = await openTestDb(SELF, '2026-10-09T08:00:00.000Z');
    world = await publishedPcFolder(() => db.clock.nowMs());
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await db.close();
  });

  function open(platform: SyncPlatform): void {
    const container = createAppContainer({
      clock: db.clock,
      hlc: createHlcClock({ clock: db.clock, deviceId: SELF }),
      data: db.data,
      sync: createFakeSyncService(),
      syncPlatform: platform,
      platform: { runtime: 'tauri', os: 'ios' },
    });
    render(
      <AppContainerProvider container={container}>
        <IosPairingScreen platform={platform} onClose={() => undefined} />
      </AppContainerProvider>,
    );
  }

  it('Trousseau indisponible pendant l’import : le message dit de déverrouiller l’iPhone (pas « L’association a échoué : réessayez »)', async () => {
    const phone = await world.device('ios', SELF, true);
    phone.testing.setCameraPermission('granted');
    phone.testing.setVaultAvailable(false);
    phone.testing.setScanResult(await world.qr());
    open(phone);
    fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' }));
    await settle(db.driver);
    expect(screen.getByTestId('ios-pairing-message').textContent).toMatch(/Trousseau|déverrouill/);
  });

  it('dossier devenu inaccessible pendant le scan : « Choisir le dossier iCloud Drive / CircleTasks » est offert pour le rechoisir', async () => {
    const phone = await world.device('ios', SELF, true);
    const failing: SyncPlatform = { ...phone, key: { ...phone.key, scanAndImport: () => Promise.resolve({ kind: 'failed', code: 'folder-unreachable' } as const) } };
    open(failing);
    fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' }));
    await settle(db.driver);
    expect(screen.getByRole('button', { name: 'Choisir le dossier iCloud Drive / CircleTasks' })).toBeInTheDocument();
  });
});

describe('D5 fenêtre QR du PC : ordre des étapes', () => {
  it('l’étape « choisir le dossier » précède « scanner » (dossier d’abord, clé ensuite, ADR 0011 §10.3 et §23 point 7)', () => {
    const T = syncPairingWindowFr.window;
    const order = [T.step1, T.step2, T.step3];
    const folderIndex = order.findIndex((text) => /dossier/i.test(text));
    const scanIndex = order.findIndex((text) => /scann/i.test(text));
    expect(folderIndex).toBeLessThan(scanIndex);
  });
});
