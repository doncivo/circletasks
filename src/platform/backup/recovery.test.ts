import { describe, expect, it, vi } from 'vitest';
import { openStartupRecovery } from './recovery';
import type { TauriBackupApi } from './tauriBackup';

/** I-06 (ADR 0007 avenant I-06 point 7) : restauration depuis l'écran d'échec, base fermée, mêmes commandes que P-04 / P-04-iOS. */

function fakeApi(): TauriBackupApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: () => Promise.resolve({ directory: null, entries: [] }),
    daily: () => Promise.resolve({ created: true }),
    check: (name) => {
      calls.push(`check ${name}`);
      return Promise.resolve(18);
    },
    restore: (name, stamp) => {
      calls.push(`restore ${name} ${stamp}`);
      return Promise.resolve({ marker: 'written', markerCode: null });
    },
    reveal: () => Promise.resolve(),
    relaunch: () => {
      calls.push('relaunch');
      return Promise.resolve();
    },
  };
}

describe('openStartupRecovery', () => {
  it('navigateur et système inconnu : aucune restauration proposée', () => {
    expect(openStartupRecovery('web', 'ios')).toBeNull();
    expect(openStartupRecovery('tauri', 'other')).toBeNull();
  });

  it('PC : vérification puis échange (base déjà fermée : rien à fermer), relance, sans « Afficher dans le dossier »', async () => {
    const api = fakeApi();
    const service = openStartupRecovery('tauri', 'windows', api);
    expect(service?.available()).toBe(true);
    expect(service?.reveal).toBeUndefined();
    await expect(service?.restore({ name: 'n.db', stamp: '20261009T080000Z' })).resolves.toEqual({ marker: 'written', markerCode: null });
    await service?.restart();
    expect(api.calls).toEqual(['check n.db', 'restore n.db 20261009T080000Z', 'relaunch']);
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
});
