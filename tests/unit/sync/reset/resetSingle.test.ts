import { afterEach, describe, expect, it } from 'vitest';
import type { SyncPlatformError } from '../../../../src/platform/sync/types';
import { RESET_META } from '../../../../src/sync/reset';
import { closeAll, meta, publishedState, recoveryOf, setupRoom, titles, type Room } from './resetKit';

/**
 * Y-11 critères 2, 4 à 7, 14 et 17 avec un seul appareil (ADR 0011 §14.3) : la bascule se fait au premier cycle, sans liste ni rappel ;
 * la nouvelle clé de secours porte K2 ; l'ancienne clé de secours n'importe plus rien.
 */

const room: Room = { devices: [] };
afterEach(() => closeAll(room));

describe('appareil seul (critère 14)', () => {
  it('réinitialisation complète : K2 annoncée sous K, époque 2 ouverte sous K2, bascule au premier cycle, tâches intactes', async () => {
    const [a] = await setupRoom(room, []);
    if (!a) throw new Error('appareil');
    await a.createTask('Courses');
    await a.cycle();
    const before = await a.platform.key.status();
    const oldRecovery = await recoveryOf(a);
    const outcome = await a.service.resetSync();
    expect(outcome).toEqual({ kind: 'started', switched: true });
    const after = await a.platform.key.status();
    expect(after.kid).not.toBe(before.kid);
    expect(after.nextKid ?? null).toBeNull();
    expect(a.platform.testing.resetRecord()).toBeNull();
    // L'époque visée est ouverte et l'état publié sous la nouvelle clé dans state.ctx ; l'ancienne époque a disparu.
    const state = publishedState(a, a.id);
    expect(state?.epoch).toMatch(/^e0002-/);
    expect(state?.reset).toBeNull();
    expect(a.folder.devices.get(a.id)?.nextState).toBeNull();
    expect([...(a.folder.devices.get(a.id)?.epochs.keys() ?? [])].every((e) => e.startsWith('e0002-'))).toBe(true);
    expect(a.folder.devices.get(a.id)?.state?.header.kid).toBe(after.kid);
    expect(await titles(a)).toEqual(['Courses']);
    // État « terminée » affiché jusqu'à la fermeture de l'écran.
    expect(a.service.status().reset).toMatchObject({ role: 'initiator', step: 'done', failure: null });
    await a.service.dismissReset();
    expect(await meta(a, RESET_META)).toBeNull();
    expect(a.service.status().reset ?? null).toBeNull();
    // L'ancienne clé de secours n'importe plus rien (rien ne porte son kid) ; la nouvelle est celle de la fenêtre pairing.
    await a.platform.key.openPairing('import');
    const refused = await a.platform.key.import({ recoveryKey: oldRecovery }).then(
      () => 'ok',
      (error: unknown) => (error as SyncPlatformError).code,
    );
    expect(refused).toBe('key-mismatch');
    await a.platform.key.closePairing();
    expect((await a.platform.key.status()).kid).toBe(after.kid);
    expect(await recoveryOf(a)).not.toBe(oldRecovery);
    // Les cycles suivants restent à jour.
    expect((await a.cycle()).phase).toBe('idle');
  });

  it('refus de la boîte native : « annulée », rien n’est créé ni gardé', async () => {
    const [a] = await setupRoom(room, []);
    if (!a) throw new Error('appareil');
    a.platform.testing.setConsent(false);
    expect(await a.service.resetSync()).toEqual({ kind: 'cancelled' });
    expect((await a.platform.key.status()).nextKid ?? null).toBeNull();
    expect(a.platform.testing.resetRecord()).toBeNull();
    expect(await meta(a, RESET_META)).toBeNull();
    // Arrière-plan, puis trop de demandes : échecs gardés et visibles, sans boîte.
    a.platform.testing.setConsent(true);
    a.platform.testing.setForeground(false);
    expect(await a.service.resetSync()).toEqual({ kind: 'failed', code: 'not-foreground' });
    expect(a.service.status().reset?.failure).toMatchObject({ code: 'not-foreground', step: 'start' });
  });
});
