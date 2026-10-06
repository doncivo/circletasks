import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncPlatformError } from '../../../../src/platform/sync/types';
import { syncFolders, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, closeAll, reassociate, setupRoom, settle, type Room } from './resetKit';

/**
 * Y-11 critère 20 (même méthode que Y-06 critère 16) : réinitialisation complète à deux appareils avec capture de toutes les sorties :
 * `console.*`, journal technique du moteur, `sync_meta` et `sync_state`, état exposé (`status()`), stockages du navigateur, message des
 * erreurs ; aucune ne contient K, K2, une clé de secours, le texte d'un QR ni un titre de tâche. La nouvelle clé repart d'un budget nul.
 */

const room: Room = { devices: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  await closeAll(room);
});

/** Clé (base64url) portée par un texte de QR `CTPAIR1.<base64url(JSON)>`. */
function keyOfQr(qrText: string): string {
  const json = JSON.parse(Buffer.from(qrText.slice('CTPAIR1.'.length), 'base64url').toString('utf8')) as { k: string };
  return json.k;
}

describe('aucune clé ni contenu dans les sorties (critère 20)', () => {
  it('captures d’une réinitialisation complète', async () => {
    const outputs: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        outputs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }
    const [a, b] = (await setupRoom(room, [B_ID])) as [SimDevice, SimDevice];
    const secrets: string[] = ['Titre secret de A', 'Titre secret de B'];
    await a.createTask(secrets[0] as string);
    await b.createTask(secrets[1] as string);
    await settle(room.devices);
    // Ancienne clé : texte du QR, clé qu'il porte, clé de secours.
    await a.platform.key.openPairing('show');
    const before = await a.platform.key.pairingPayload();
    await a.platform.key.closePairing();
    secrets.push(before.qrText, keyOfQr(before.qrText), before.recoveryKey);
    expect((await a.service.resetSync()).kind).toBe('started');
    // Nouvelle clé (pendant la transition, la fenêtre pairing porte K2).
    a.clock.advance(11 * 60_000);
    await a.platform.key.openPairing('show');
    const after = await a.platform.key.pairingPayload();
    await a.platform.key.closePairing();
    expect(after.recoveryKey).not.toBe(before.recoveryKey);
    secrets.push(after.qrText, keyOfQr(after.qrText), after.recoveryKey);
    expect(a.platform.testing.sealedNextRecords(), 'budget de nonces de K2 compté à part, depuis zéro').toBeGreaterThan(0);
    a.clock.advance(11 * 60_000);
    await reassociate(a, b, room.devices);
    // Une erreur de saisie : le message ne recopie jamais l'entrée.
    await b.platform.key.openPairing('import');
    const wrong = await b.platform.key.import({ recoveryKey: `${before.recoveryKey}X` }).catch((error: unknown) => error as SyncPlatformError);
    await b.platform.key.closePairing().catch(() => undefined);
    outputs.push(String((wrong as Error).message));
    await b.cycle();
    syncFolders(room.devices);
    await a.cycle();
    await settle(room.devices, 2);
    expect(a.service.status().reset?.step).toBe('done');

    for (const d of room.devices) {
      outputs.push(...d.logger.entries.map((e) => `${e.event} ${JSON.stringify(e.detail)}`));
      outputs.push(JSON.stringify(d.service.status()));
      outputs.push(JSON.stringify(await d.driver.select('SELECT * FROM sync_meta')));
      outputs.push(JSON.stringify(await d.driver.select('SELECT * FROM sync_state')));
    }
    const storage = (globalThis as { localStorage?: Storage; sessionStorage?: Storage });
    for (const s of [storage.localStorage, storage.sessionStorage]) {
      if (!s) continue;
      for (let i = 0; i < s.length; i += 1) outputs.push(`${s.key(i) ?? ''}=${s.getItem(s.key(i) ?? '') ?? ''}`);
    }
    expect(outputs.length).toBeGreaterThan(10);
    for (const out of outputs) for (const secret of secrets) expect(out.includes(secret), `${secret.slice(0, 12)}… dans une sortie`).toBe(false);
  });
});
