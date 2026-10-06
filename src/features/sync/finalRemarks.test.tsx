// Y-06, remarques finales de la seconde revue : not-foreground (Réglages, « Nouveau code »), échec de protection de la fenêtre,
// arrivée reconnue par l'époque suivie de la ligne de l'appareil.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import qrcode from 'qrcode-generator';
import { afterEach, describe, expect, it } from 'vitest';
import { asEntityId, type DeviceId } from '../../domain/types';
import { epochId } from '../../domain/sync/format';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { syncPairingWindowFr } from '../../i18n/fr.syncPairing';
import { SyncPlatformError, type KeyImportResult, type PairingPayload } from '../../platform/sync';
import { isJoining } from '../../sync/join';
import { pairingOpenErrorKey } from './pairingStatus';
import type { PairingPlatform } from './pairing-window/pairingPlatform';
import { PairingView } from './pairing-window/PairingView';
import { syncErrorMessageKey } from './SyncSettingsSection';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000e1');
const T = syncPairingWindowFr;
/** Horloge fixe (aucune horloge réelle, Y-TECH-02). */
const NOW_MS = 1_790_000_000_000;

afterEach(() => cleanup());

describe('remarques finales de Y-06', () => {
  it('1. Réglages : not-foreground → « Revenez dans l’application et réessayez »', () => {
    expect(syncErrorMessageKey('not-foreground')).toBe('sync.pairing.openBackground');
  });

  it('2. « Nouveau code » refusé faute de premier plan : texte not-foreground, l’ancien code reste', async () => {
    let calls = 0;
    const payload: PairingPayload = { qrText: 'CTPAIR1.abc', recoveryKey: 'CT1-AAAAA-BBBBB', expiresAt: NOW_MS + 300_000 };
    const platform: PairingPlatform = {
      pairingPayload: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(payload) : Promise.reject(new SyncPlatformError('not-foreground'));
      },
      closePairing: () => Promise.resolve(),
      import: () => Promise.reject(new Error('jamais')) as Promise<KeyImportResult>,
    };
    render(<PairingView platform={platform} now={() => NOW_MS} loadQr={() => Promise.resolve(qrcode)} print={() => undefined} />);
    await screen.findByRole('img', { name: T.window.qrLabel });
    fireEvent.click(screen.getByRole('button', { name: T.window.renewLabel }));
    expect(await screen.findByText(T.errors.notForeground)).toBeTruthy();
    expect(screen.getByRole('img', { name: T.window.qrLabel })).toBeTruthy();
  });

  it('3. arrivée : reconnue par l’absence d’époque suivie sur la ligne de l’appareil, pas par lastSyncAt', async () => {
    const db = await openTestDb(SELF, '2026-10-06T08:00:00.000Z');
    try {
      const repos = db.data.repos;
      const epoch = epochId(1, SELF);
      expect(await isJoining(repos, epoch)).toBe(true); // aucune ligne de l'appareil
      await repos.sync.saveState(SELF, { isSelf: true, status: 'active' });
      expect(await isJoining(repos, epoch)).toBe(true); // ligne sans époque suivie
      await repos.sync.saveState(SELF, { epoch, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
      // Époque suivie, mais aucun cycle terminé sans fichier en attente (lastSyncAt nul) : ce n'est plus une arrivée.
      expect(await isJoining(repos, epoch)).toBe(false);
      expect(await isJoining(repos, null)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('4. protection de la fenêtre impossible (window-unprotected) : texte générique, jamais « Installation incomplète »', () => {
    expect(pairingOpenErrorKey('window-unprotected', 'show')).toBe('sync.pairing.openFailed');
    expect(pairingOpenErrorKey('window-unprotected', 'import')).toBe('sync.pairing.openFailed');
    expect(pairingOpenErrorKey('io', 'show')).toBe('sync.pairing.openIncomplete');
  });
});
