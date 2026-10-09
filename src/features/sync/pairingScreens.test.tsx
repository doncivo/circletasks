// @vitest-environment jsdom
// Y-IOS-02, QA du parcours d'association (demande d'Ali, 0.2.2) : écran « Associer au PC » de l'iPhone et fenêtre QR du PC, état par état.
// Chaque échec (QR expiré, illisible, d'une autre synchro, dossier pas encore listé, caméra refusée, scan annulé, clé de secours erronée,
// Trousseau verrouillé, trop de tentatives) dit sa cause en français et laisse l'action utile : jamais d'écran sans issue.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform, type SyncPlatform } from '../../platform/sync';
import { PAIRING_PHONE_ID as SELF, publishedPcFolder, type PcWorld } from '../../../tests/fixtures/pairingWorld';
import { settle } from '../../../tests/setup/settle';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer } from '../app/container';
import { IosPairingScreen } from './IosPairingScreen';
import { createFakeSyncService } from './testKit';

const NOW = '2026-10-09T08:00:00.000Z';

const SCREEN = {
  scan: 'Ouvrir la caméra et scanner le code d’association',
  chooseFolder: 'Choisir le dossier iCloud Drive / CircleTasks',
  openSettings: 'Ouvrir les réglages d’iOS pour autoriser la caméra',
  recovery: 'Saisir la clé de secours imprimée à la place du code',
  cancel: 'Annuler l’association',
  close: 'Fermer',
} as const;
type ScreenAction = keyof typeof SCREEN;

function screenActions(): ScreenAction[] {
  return (Object.keys(SCREEN) as ScreenAction[]).filter((key) => screen.queryAllByRole('button', { name: SCREEN[key] }).length > 0).sort();
}

let db: TestDb;
let world: PcWorld;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  world = await publishedPcFolder(() => db.clock.nowMs());
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await db.close();
});

function open(platform: SyncPlatform): { readonly closed: () => number; readonly sync: ReturnType<typeof createFakeSyncService> } {
  const sync = createFakeSyncService();
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platform, platform: { runtime: 'tauri', os: 'ios' } });
  let closed = 0;
  render(
    <AppContainerProvider container={container}>
      <IosPairingScreen platform={platform} onClose={() => (closed += 1)} />
    </AppContainerProvider>,
  );
  return { closed: () => closed, sync };
}

const scanNow = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: SCREEN.scan }));
  await settle(db.driver);
};

/** Échecs du scan : le message dit la cause et l'écran garde l'action utile (rescanner, saisir la clé, annuler). */
describe('Y-IOS-02 écran « Associer au PC » : un échec de scan ne laisse jamais sans issue', () => {
  const AGAIN: ScreenAction[] = ['cancel', 'recovery', 'scan'];

  async function phoneWithFolder(): Promise<MemorySyncPlatform> {
    const phone = await world.device('ios', SELF, true);
    phone.testing.setCameraPermission('granted');
    return phone;
  }

  it('S01 QR illisible (pas un code CircleTasks) : message, rescanner possible', async () => {
    const phone = await phoneWithFolder();
    phone.testing.setScanResult('https://exemple.test/pas-un-code');
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Ce code n’est pas un code d’association CircleTasks : affichez le code sur le PC et réessayez');
    expect(screenActions()).toEqual(AGAIN);
    expect((await phone.key.status()).present).toBe(false);
  });

  it('S02 QR expiré (plus de 5 minutes + 2 minutes de tolérance) : message, rescanner possible', async () => {
    const phone = await phoneWithFolder();
    const qr = await world.qr();
    db.clock.advance(8 * 60_000);
    phone.testing.setScanResult(qr);
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Ce code a expiré : affichez un nouveau code sur le PC');
    expect(screenActions()).toEqual(AGAIN);
    expect((await phone.key.status()).present).toBe(false);
  });

  it('S03 QR d’une autre synchro (son PC n’est pas dans le dossier choisi) : même attente que S04, rescanner possible', async () => {
    const phone = await phoneWithFolder();
    const otherFolder = new MemorySyncFolder('icloud');
    const other = createMemorySyncPlatform({ folder: otherFolder, nowMs: () => db.clock.nowMs() });
    await other.folder.choose();
    await other.key.create();
    await other.bindDevice('70000000-0000-4000-8000-0000000000e1' as never);
    await other.key.openPairing('show');
    const { qrText } = await other.key.pairingPayload();
    phone.testing.setScanResult(qrText);
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Le dossier ne contient pas encore les données du PC : attendez qu’iCloud les apporte, puis réessayez');
    expect(screenActions()).toEqual(AGAIN);
  });

  it('S04 dossier pas encore listé par iCloud (rien de lisible) : message d’attente, rescanner possible', async () => {
    const empty = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), platform: 'ios', nowMs: () => db.clock.nowMs() });
    await empty.folder.choose();
    await empty.bindDevice(SELF);
    empty.testing.setCameraPermission('granted');
    empty.testing.setScanResult(await world.qr());
    open(empty);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Le dossier ne contient pas encore les données du PC : attendez qu’iCloud les apporte, puis réessayez');
    expect(screenActions()).toEqual(AGAIN);
  });

  it('S05 caméra refusée à la demande d’iOS : dit, « Ouvrir les réglages » proposé, clé de secours possible', async () => {
    const phone = await world.device('ios', SELF, true);
    phone.testing.setCameraPermission('prompt', 'denied');
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-camera-denied')).toHaveTextContent('L’accès à la caméra est refusé');
    expect(screenActions()).toEqual(['cancel', 'openSettings', 'recovery']);
    fireEvent.click(screen.getByRole('button', { name: SCREEN.openSettings }));
    expect(phone.testing.cameraSettingsOpened()).toBe(1);
  });

  it('S06 scan annulé : « Scan annulé », rescanner possible', async () => {
    const phone = await phoneWithFolder();
    phone.testing.setScanResult(null);
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Scan annulé');
    expect(screenActions()).toEqual(AGAIN);
  });

  it('S07 application pas au premier plan : « Revenez dans l’application », rescanner possible', async () => {
    const phone = await phoneWithFolder();
    phone.testing.setForeground(false);
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Revenez dans l’application et réessayez');
    phone.testing.setForeground(true);
    phone.testing.setScanResult(await world.qr());
    await scanNow();
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
    expect(screen.queryByTestId('ios-pairing-message')).toBeNull();
  });

  it('S08 trop de tentatives (5 par 10 minutes) : dit combien attendre, puis le scan réussit passé le délai', async () => {
    const phone = await phoneWithFolder();
    open(phone);
    for (let i = 0; i < 5; i += 1) {
      phone.testing.setScanResult('pas-un-code');
      await scanNow();
    }
    phone.testing.setScanResult(await world.qr());
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toHaveTextContent('Trop de tentatives : réessayez dans 10 minutes');
    expect(screenActions()).toEqual(AGAIN);
    db.clock.advance(10 * 60_000 + 1);
    phone.testing.setScanResult(await world.qr());
    await scanNow();
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
  });

  it('S09 nouvel essai réussi : le message d’échec disparaît, « Fermer » seul reste avec la progression', async () => {
    const phone = await phoneWithFolder();
    phone.testing.setScanResult('pas-un-code');
    open(phone);
    await scanNow();
    expect(screen.getByTestId('ios-pairing-message')).toBeInTheDocument();
    phone.testing.setScanResult(await world.qr());
    await scanNow();
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
    expect(screen.queryByTestId('ios-pairing-message')).toBeNull();
    expect(screenActions()).toEqual(['cancel', 'close']);
  });
});

describe('Y-IOS-02 écran « Associer au PC » : clé de secours à la place du code', () => {
  it('S10 clé erronée (autre synchro) : message, saisie et « Annuler » restent ; Annuler ramène au scan', async () => {
    const phone = await world.device('ios', SELF, true);
    phone.testing.setCameraPermission('granted');
    const other = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), nowMs: () => db.clock.nowMs() });
    await other.folder.choose();
    await other.key.create();
    await other.bindDevice('70000000-0000-4000-8000-0000000000e2' as never);
    await other.key.openPairing('show');
    const { recoveryKey } = await other.key.pairingPayload();
    open(phone);
    fireEvent.click(await screen.findByRole('button', { name: SCREEN.recovery }));
    const field = await screen.findByLabelText('Clé de secours');
    fireEvent.change(field, { target: { value: recoveryKey } });
    fireEvent.click(screen.getByRole('button', { name: 'Associer' }));
    expect(await screen.findByTestId('pairing-import-message')).toHaveTextContent(/autre clé|ne correspond pas|dossier/i);
    expect(screen.getByLabelText('Clé de secours')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Associer' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }));
    expect(await screen.findByRole('button', { name: SCREEN.scan })).toBeInTheDocument();
    expect((await phone.key.status()).present).toBe(false);
  });

  it('S11 clé de secours illisible : message, nouvelle saisie possible, puis la bonne clé associe', async () => {
    const phone = await world.device('ios', SELF, true);
    open(phone);
    fireEvent.click(await screen.findByRole('button', { name: SCREEN.recovery }));
    fireEvent.change(await screen.findByLabelText('Clé de secours'), { target: { value: 'CT1-ABCDE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Associer' }));
    expect(await screen.findByTestId('pairing-import-message')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Clé de secours'), { target: { value: await world.recoveryKey() } });
    fireEvent.click(screen.getByRole('button', { name: 'Associer' }));
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
    expect((await phone.key.status()).present).toBe(true);
  });
});

describe('Y-IOS-02 écran « Associer au PC » : étapes dans l’ordre dossier, caméra, clé', () => {
  it('S12 aucun dossier : seul « Choisir le dossier » mène plus loin ; clé de secours et scan absents', async () => {
    const phone = await world.device('ios', SELF, false);
    open(phone);
    expect(await screen.findByRole('button', { name: SCREEN.chooseFolder })).toBeInTheDocument();
    expect(screenActions()).toEqual(['cancel', 'chooseFolder']);
  });

  it('S13 sélecteur de dossier annulé : rien ne change, « Choisir le dossier » reste proposé', async () => {
    const phone = await world.device('ios', SELF, false);
    phone.testing.setChooser(null);
    open(phone);
    fireEvent.click(await screen.findByRole('button', { name: SCREEN.chooseFolder }));
    await settle(db.driver);
    expect(screenActions()).toEqual(['cancel', 'chooseFolder']);
    expect(screen.queryByTestId('ios-pairing-message')).toBeNull();
  });

  it('S14 retour au premier plan avec la caméra autorisée dans les réglages d’iOS : le scan est proposé', async () => {
    const phone = await world.device('ios', SELF, true);
    phone.testing.setCameraPermission('denied');
    open(phone);
    expect(await screen.findByTestId('ios-camera-denied')).toBeInTheDocument();
    phone.testing.setCameraPermission('granted');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await phone.key.cameraPermission?.();
    });
    expect(await screen.findByRole('button', { name: SCREEN.scan })).toBeInTheDocument();
    expect(screen.queryByTestId('ios-camera-denied')).toBeNull();
  });

  it('S15 « Annuler l’association » ferme l’écran à chaque étape sans rien changer', async () => {
    const phone = await world.device('ios', SELF, true);
    const view = open(phone);
    fireEvent.click(await screen.findByRole('button', { name: SCREEN.cancel }));
    expect(view.closed()).toBe(1);
    expect((await phone.key.status()).present).toBe(false);
  });
});
