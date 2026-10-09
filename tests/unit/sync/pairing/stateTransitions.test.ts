import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../../../src/domain/hlc';
import { openTestDb, type TestDb } from '../../../../src/db/repositories/sql/testSetup';
import { MemorySyncFolder, createMemorySyncPlatform, type MemorySyncPlatform } from '../../../../src/platform/sync';
import { createSyncService, silentSyncLogger } from '../../../../src/sync';
import { PAIRING_PHONE_ID as SELF, publishedPcFolder, type PcWorld } from '../../../fixtures/pairingWorld';

/**
 * Y-IOS-02, QA du parcours d'association (demande d'Ali, 0.2.2), moteur : transitions entre les états de l'association, sur le moteur et la
 * plateforme réels (mémoire). Chaque état de départ a une issue qui ramène à « à jour » par une action de l'utilisateur seulement
 * (associer, rechoisir le dossier, déverrouiller), sans cycle qui boucle ni clé créée en silence.
 */

let db: TestDb;
let world: PcWorld;

beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-09T08:00:00.000Z');
  world = await publishedPcFolder(() => db.clock.nowMs());
});

afterEach(async () => {
  await db.close();
});

function serviceOn(platform: MemorySyncPlatform, os: 'ios' | 'windows') {
  return createSyncService({
    data: db.data,
    platform,
    hlc: createHlcClock({ clock: db.clock, deviceId: SELF }),
    clock: db.clock,
    deviceId: SELF,
    devicePlatform: os,
    sv: 14,
    appVersion: '0.2.3',
    logger: silentSyncLogger,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
}

/** Import d'une clé : fenêtre `pairing` d'abord sur PC, depuis la fenêtre principale sur iPhone. */
async function importQr(platform: MemorySyncPlatform, os: 'ios' | 'windows', qrText: string): Promise<void> {
  // PC : la fenêtre reste ouverte après un refus (la saisie se refait dans la même fenêtre).
  if (os === 'windows' && platform.testing.pairing() === null) await platform.key.openPairing('import');
  await platform.key.import({ qrText });
}

for (const os of ['windows', 'ios'] as const) {
  const where = os === 'ios' ? 'iPhone' : 'PC';

  describe(`Y-IOS-02 transitions de l’association — ${where}`, () => {
    it('T01 aucun dossier : not-configured, sans erreur ; le dossier choisi, la clé du PC absente : needs-pairing', async () => {
      const platform = await world.device(os, SELF, false);
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      expect(service.status()).toMatchObject({ phase: 'not-configured', errorCode: null });
      await platform.folder.choose();
      await platform.bindDevice(SELF);
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null });
      expect((await platform.key.status()).present).toBe(false);
    });

    it('T02 « Oublier le dossier » en gardant la clé, puis le même dossier : à jour sans nouvelle association', async () => {
      const platform = await world.device(os, SELF, true);
      await importQr(platform, os, await world.qr());
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      expect(service.status().phase).toBe('idle');
      await platform.folder.forget({ eraseKey: false });
      await service.syncNow('manual');
      expect(service.status().phase).toBe('not-configured');
      await platform.folder.choose();
      await platform.bindDevice(SELF);
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'idle', errorCode: null });
    });

    it('T03 « Oublier le dossier et la clé », puis le même dossier : needs-pairing, aucune clé recréée (folder-has-data)', async () => {
      const platform = await world.device(os, SELF, true);
      await importQr(platform, os, await world.qr());
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      await platform.folder.forget({ eraseKey: true });
      platform.testing.setChooser(world.folder);
      await platform.folder.choose();
      await platform.bindDevice(SELF);
      expect((await platform.key.status()).present).toBe(false);
      await expect(platform.key.create()).rejects.toMatchObject({ code: 'folder-has-data' });
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null });
      expect((await platform.key.status()).present).toBe(false);
    });

    it('T04 key-mismatch : le bon code associe, le cycle suivant est à jour (la clé du Trousseau est remplacée après confirmation)', async () => {
      const platform = await world.device(os, SELF, false);
      platform.testing.setChooser(new MemorySyncFolder('icloud'));
      await platform.folder.choose();
      await platform.key.create();
      platform.testing.setChooser(world.folder);
      await platform.folder.choose();
      await platform.bindDevice(SELF);
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      expect(service.status()).toMatchObject({ phase: 'key-mismatch' });
      const before = platform.testing.consentPrompts();
      await importQr(platform, os, await world.qr());
      expect(platform.testing.consentPrompts()).toBe(before + 1);
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'idle', errorCode: null });
    });

    it('T05 QR expiré : la clé reste absente et l’état reste « à associer » ; un QR valable associe ensuite', async () => {
      const platform = await world.device(os, SELF, true);
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      const old = await world.qr();
      db.clock.advance(8 * 60_000);
      if (os === 'windows') await platform.key.openPairing('import');
      await expect(platform.key.import({ qrText: old })).rejects.toMatchObject({ code: 'pairing-expired' });
      expect((await platform.key.status()).present).toBe(false);
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null });
      await importQr(platform, os, await world.qr());
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'idle', errorCode: null });
    });

    it('T06 Trousseau verrouillé : erreur passagère vault-unavailable, aucune action requise ; déverrouillé, le cycle suivant est à jour', async () => {
      const platform = await world.device(os, SELF, true);
      await importQr(platform, os, await world.qr());
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      platform.testing.setVaultAvailable(false);
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'error', errorCode: 'vault-unavailable' });
      platform.testing.setVaultAvailable(true);
      await service.syncNow('manual');
      expect(service.status()).toMatchObject({ phase: 'idle', errorCode: null });
    });

    it('T07 arrivée interrompue (app fermée entre l’import et le premier cycle) : la relance finit l’arrivée, à jour, rien de perdu', async () => {
      const platform = await world.device(os, SELF, true);
      await importQr(platform, os, await world.qr());
      // Relance : un nouveau service sur la même base et le même coffre.
      const restarted = serviceOn(platform, os);
      await restarted.syncNow('open');
      expect(restarted.status()).toMatchObject({ phase: 'idle', errorCode: null });
      expect(await db.data.repos.sync.getMeta('join')).toBeNull();
    });

    it('T08 clé de secours (autre voie que le QR) : même résultat que le QR', async () => {
      const platform = await world.device(os, SELF, true);
      if (os === 'windows') await platform.key.openPairing('import');
      await platform.key.import({ recoveryKey: await world.recoveryKey() });
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      expect(service.status()).toMatchObject({ phase: 'idle', errorCode: null });
    });

    it('T09 clé de secours d’une autre synchro : key-mismatch levé à l’import, rien d’enregistré, l’état reste « à associer »', async () => {
      const platform = await world.device(os, SELF, true);
      const other = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), nowMs: () => db.clock.nowMs() });
      await other.folder.choose();
      await other.key.create();
      await other.bindDevice('70000000-0000-4000-8000-0000000000e3' as never);
      await other.key.openPairing('show');
      const { recoveryKey } = await other.key.pairingPayload();
      if (os === 'windows') await platform.key.openPairing('import');
      await expect(platform.key.import({ recoveryKey })).rejects.toMatchObject({ code: 'key-mismatch' });
      expect((await platform.key.status()).present).toBe(false);
      const service = serviceOn(platform, os);
      await service.syncNow('open');
      expect(service.status()).toMatchObject({ phase: 'needs-pairing', errorCode: null });
    });
  });
}
