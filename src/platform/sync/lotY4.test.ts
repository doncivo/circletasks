// Lot Y4, étape 0 (ADR 0011 sections 11.1, 13 et 18) : les trois commandes sont déclarées et routées, sans comportement ;
// la plateforme mémoire refuse comme les corps provisoires de Rust (`not-configured`, sans effet).
import { describe, expect, it, vi } from 'vitest';
import type { DeviceId } from '../../domain/types';
import { createMemorySyncPlatform } from './memory';
import { createTauriSync, type SyncInvoker } from './tauriSync';
import { SYNC_COMMAND_WINDOWS, SyncPlatformError } from './types';

const OTHER = '3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60' as DeviceId;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    expect(error).toBeInstanceOf(SyncPlatformError);
    return (error as SyncPlatformError).code;
  }
}

describe('lot Y4, étape 0', () => {
  it('les trois commandes sont accordées à main seulement', () => {
    expect(SYNC_COMMAND_WINDOWS.sync_device_forget).toBe('main');
    expect(SYNC_COMMAND_WINDOWS.sync_forgotten_delete).toBe('main');
    expect(SYNC_COMMAND_WINDOWS.sync_reset_key).toBe('main');
  });

  it('mémoire : sans dossier, les trois refusent en not-configured ; Y-10 : sans liaison, forget refuse en not-bound ; reset.start reste not-configured (Y-11)', async () => {
    const platform = createMemorySyncPlatform();
    const all = () => [platform.forget.device(OTHER), platform.forget.deleteFiles(OTHER), platform.reset.start()];
    for (const p of all()) expect(await codeOf(p)).toBe('not-configured');
    await platform.folder.choose();
    await platform.key.create();
    expect(await codeOf(platform.forget.device(OTHER))).toBe('not-bound');
    expect(await codeOf(platform.forget.deleteFiles(OTHER))).toBe('not-bound');
    expect(await codeOf(platform.reset.start())).toBe('not-configured');
    expect(await platform.key.status()).toMatchObject({ present: true });
  });

  it('tauriSync : chaque méthode appelle sa commande, rejet Rust rendu en SyncPlatformError', async () => {
    const invoke = vi.fn(async () => {
      throw { code: 'not-configured', message: 'synchro' };
    }) as unknown as SyncInvoker;
    const sync = createTauriSync({ available: true, invoke });
    expect(await codeOf(sync.forget.device(OTHER))).toBe('not-configured');
    expect(await codeOf(sync.forget.deleteFiles(OTHER))).toBe('not-configured');
    expect(await codeOf(sync.reset.start())).toBe('not-configured');
    expect((invoke as unknown as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['sync_device_forget', { deviceId: OTHER }],
      ['sync_forgotten_delete', { deviceId: OTHER }],
      ['sync_reset_key', undefined],
    ]);
  });
});
