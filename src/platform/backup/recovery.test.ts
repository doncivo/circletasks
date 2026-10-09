import { describe, expect, it, vi } from 'vitest';
import { openStartupRecovery, startupRecoveryAvailable, type StartupRecoveryApi } from './recovery';

/**
 * I-06 (ADR 0007 avenant I-06 point 7, revue I2 et M3) : restauration depuis l'écran d'échec, base fermée : retour arrière LOCAL
 * (`restore_backup` avec `local: true`), aucun marqueur de synchro ; une seule condition de disponibilité.
 */

function fakeApi(fail?: unknown): StartupRecoveryApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rollback: (name, stamp) => {
      calls.push(`rollback ${name} ${stamp}`);
      return fail === undefined ? Promise.resolve({ marker: 'skipped', markerCode: null }) : Promise.reject(fail);
    },
    relaunch: () => {
      calls.push('relaunch');
      return Promise.resolve();
    },
  };
}

describe('openStartupRecovery', () => {
  it('navigateur et système inconnu : aucune restauration proposée ; même condition que l’écran (une seule source)', () => {
    expect(openStartupRecovery('web', 'ios', fakeApi())).toBeNull();
    expect(openStartupRecovery('tauri', 'other', fakeApi())).toBeNull();
    for (const [runtime, os] of [['web', 'ios'], ['tauri', 'other'], ['tauri', 'ios'], ['tauri', 'windows']] as const) {
      expect(startupRecoveryAvailable(runtime, os)).toBe(openStartupRecovery(runtime, os, fakeApi()) !== null);
    }
  });

  it('PC : retour arrière local (aucun marqueur rendu), puis relance', async () => {
    const api = fakeApi();
    const service = openStartupRecovery('tauri', 'windows', api);
    expect(service?.available()).toBe(true);
    expect(service?.reveal).toBeUndefined();
    await expect(service?.restore({ name: 'n.db', stamp: '20261009T080000Z' })).resolves.toBeUndefined();
    await service?.restart();
    expect(api.calls).toEqual(['rollback n.db 20261009T080000Z', 'relaunch']);
  });

  it('échec de Rust : raison reconnue, base fermée (redémarrer)', async () => {
    const service = openStartupRecovery('tauri', 'windows', fakeApi({ code: 'restore-unconfirmed', message: 'x' }));
    await expect(service?.restore({ name: 'n.db', stamp: '20261009T080000Z' })).rejects.toMatchObject({ reason: 'restore-unconfirmed', databaseClosed: true });
  });

  it('iPhone : rechargement de la WebView au lieu de la relance', async () => {
    const api = fakeApi();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const service = openStartupRecovery('tauri', 'ios', api);
    await service?.restart();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(api.calls).not.toContain('relaunch');
    vi.unstubAllGlobals();
  });

  it('commande appelée : restore_backup avec local: true (jamais le chemin P-04 qui écrit un marqueur)', async () => {
    const invoke = vi.fn(() => Promise.resolve({ marker: 'skipped' }));
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { loadStartupRecoveryApi } = await import('./recovery');
    await loadStartupRecoveryApi().rollback('n.db', '20261009T080000Z');
    expect(invoke).toHaveBeenCalledWith('restore_backup', { name: 'n.db', stamp: '20261009T080000Z', local: true });
    vi.doUnmock('@tauri-apps/api/core');
  });
});
