import type { DeviceAck, EpochId } from '../../src/domain/sync/format';
import type { DeviceId, Hlc } from '../../src/domain/types';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from '../../src/platform/sync/memory';

/**
 * Jeu de données commun du parcours d'association (Y-IOS-02, QA du parcours) : un PC qui a créé la clé et publié dans le dossier iCloud
 * partagé, et des appareils (PC ou iPhone) qui ont choisi ce dossier ou non. Réutilisé par les tests Vitest des écrans et du moteur ;
 * les tests Playwright ont le même jeu côté simulateur (`tests/sim/syncFolderSim.ts`, rôles `first`, `bare`, `nofolder`).
 */

export const PAIRING_PC_ID = '70000000-0000-4000-8000-0000000000f1' as DeviceId;
export const PAIRING_PHONE_ID = '60000000-0000-4000-8000-0000000000f2' as DeviceId;

export interface PcWorld {
  readonly folder: MemorySyncFolder;
  readonly pc: MemorySyncPlatform;
  /** Texte du QR affiché par le PC (instance `show` ouverte puis fermée, comme la fenêtre `pairing`). */
  qr(): Promise<string>;
  /** Clé de secours affichée par le PC. */
  recoveryKey(): Promise<string>;
  /** Appareil (PC ou iPhone) qui a le dossier du PC à son sélecteur ; `chosen` : dossier déjà choisi et appareil lié. */
  device(os: 'ios' | 'windows', deviceId: DeviceId, chosen: boolean): Promise<MemorySyncPlatform>;
}

export async function publishedPcFolder(nowMs: () => number): Promise<PcWorld> {
  const folder = new MemorySyncFolder('icloud');
  const pc = createMemorySyncPlatform({ folder, nowMs });
  await pc.folder.choose();
  await pc.key.create();
  await pc.bindDevice(PAIRING_PC_ID);
  const epoch = `e0001-${PAIRING_PC_ID}` as EpochId;
  const hlc = `000001759651200-0000-${PAIRING_PC_ID}` as Hlc;
  await pc.appendJournal({ epoch, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc, records: ['{}'] });
  await pc.writeState({
    sv: 14,
    state: {
      deviceId: PAIRING_PC_ID,
      platform: 'windows',
      appVersion: '0.2.2',
      sm: 1,
      sv: 14,
      epoch,
      stateSeq: 1,
      head: { epoch, segment: 1, record: 1, hlc, stateSeq: 1 },
      acks: new Map<DeviceId, DeviceAck>(),
      snapshot: null,
      purgeHorizon: null,
      lastSyncHlc: hlc,
      forgotten: [],
      reset: null,
    },
  });
  const payload = async () => {
    await pc.key.openPairing('show');
    const value = await pc.key.pairingPayload();
    await pc.key.closePairing();
    return value;
  };
  return {
    folder,
    pc,
    qr: async () => (await payload()).qrText,
    recoveryKey: async () => (await payload()).recoveryKey,
    device: async (os, deviceId, chosen) => {
      const platform = createMemorySyncPlatform({ folder, platform: os, nowMs });
      platform.testing.setChooser(folder);
      if (chosen) {
        await platform.folder.choose();
        await platform.bindDevice(deviceId);
      }
      return platform;
    },
  };
}
