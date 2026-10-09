import { describe, expect, it } from 'vitest';
import { SYNC_COMMAND_WINDOWS, SYNC_COMMANDS, SyncPlatformError, syncErrorCodeOf } from './types';

/** Contrat des commandes `sync_*` (ADR 0011, section 11.1). */
describe('commandes sync_*', () => {
  it('24 commandes : 21 accordées à main, 3 à la fenêtre pairing', () => {
    expect(SYNC_COMMANDS).toHaveLength(25);
    expect(SYNC_COMMANDS.filter((c) => SYNC_COMMAND_WINDOWS[c] === 'main')).toHaveLength(22);
    expect(SYNC_COMMANDS.slice(-3)).toEqual(['sync_device_forget', 'sync_forgotten_delete', 'sync_reset_key']);
    expect(SYNC_COMMANDS.filter((c) => SYNC_COMMAND_WINDOWS[c] === 'pairing').sort()).toEqual(['sync_key_import', 'sync_pairing_close', 'sync_pairing_payload']);
    expect(SYNC_COMMANDS.every((c) => /^sync_[a-z_]+$/.test(c))).toBe(true);
  });
});

describe('erreurs', () => {
  it('le message ne contient que le code ; code reconnu par sa forme, io par défaut', () => {
    const error = new SyncPlatformError('key-mismatch', { cause: new Error('détail') });
    expect(error.message).toBe('synchro : key-mismatch');
    expect(error.name).toBe('SyncPlatformError');
    expect(syncErrorCodeOf(error)).toBe('key-mismatch');
    expect(syncErrorCodeOf({ code: 'segment-full' })).toBe('segment-full');
    expect(syncErrorCodeOf({ code: 'inconnu' })).toBe('io');
    expect(syncErrorCodeOf(null)).toBe('io');
  });
});
