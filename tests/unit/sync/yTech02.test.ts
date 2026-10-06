import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FOLDER_WARN_BYTES, NONCE_WARN_RECORDS } from '../../../src/domain/sync/limits';
import type { DeviceId, IsoDateTime } from '../../../src/domain/types';
import { parseStoredAcks, SyncStateUnreadableError } from '../../../src/db/repositories/syncRepository';
import { SyncPlatformError, type FolderScan, type SyncPlatform } from '../../../src/platform/sync/types';
import { knownDevices } from '../../../src/sync/maintenance';
import { readJson } from '../../../src/sync/meta';
import { createMemorySyncLogger } from '../../../src/sync';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-02 (revue d'ensemble de fin d'ordre 4) : avertissements du scan rendus visibles, échecs qui étaient avalés (abonnés, lectures de
 * l'état local, code réel d'un cycle en échec, vérification de la fenêtre de restauration, suppressions de ses fichiers), accusés stockés
 * illisibles (une seule analyse, `state-unreadable`). Horloge manuelle, aucun délai réel.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function first(): Promise<SimDevice> {
  const a = await createSimDevice(A_ID);
  devices.push(a);
  await setupFirst(a);
  await a.cycle();
  return a;
}

const events = (d: SimDevice, name: string) => d.logger.entries.filter((e) => e.event === name).map((e) => e.detail);

/** Remplace une méthode de la plateforme partagée par le service (même objet). */
function patchScan(d: SimDevice, extra: (scan: FolderScan) => FolderScan): void {
  const platform = d.platform as unknown as SyncPlatform & Record<string, unknown>;
  const real = platform.scan.bind(platform);
  platform['scan'] = async (r: Parameters<SyncPlatform['scan']>[0]) => extra(await real(r));
}

describe('point 1 : avertissements du scan dans SyncStatus', () => {
  it('budget de nonces, dossier de plus de 1 Gio, plus de 16 dossiers, scan incomplet : avertissements rendus, dans l’ordre d’urgence', async () => {
    const a = await first();
    expect(a.service.status().warnings ?? []).toEqual([]);
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    a.folder.padFolder(FOLDER_WARN_BYTES);
    patchScan(a, (scan) => ({ ...scan, incomplete: true, tooManyDevices: true }));
    const status = await a.cycle();
    expect(status.phase).toBe('idle');
    expect(status.warnings).toEqual(['nonce-budget', 'folder-large', 'too-many-devices', 'scan-incomplete']);
  });

  it('un cycle qui échoue avant le scan garde les avertissements connus ; un scan sans avertissement les retire', async () => {
    const a = await first();
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    expect((await a.cycle()).warnings).toEqual(['nonce-budget']);
    const platform = a.platform as unknown as Record<string, unknown>;
    const realScan = platform['scan'];
    platform['scan'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    const failed = await a.cycle();
    expect(failed.phase).toBe('error');
    expect(failed.warnings).toEqual(['nonce-budget']);
    platform['scan'] = realScan;
    a.platform.testing.setSealedRecords(0);
    expect((await a.cycle()).warnings ?? []).toEqual([]);
  });

  it('memory.ts : folderLarge au-delà de 1 Gio, nonceWarning au-delà du seuil (même règle que Rust)', async () => {
    const a = await first();
    const before = await a.platform.scan({ keep: [] });
    expect([before.folderLarge, before.nonceWarning]).toEqual([false, false]);
    a.folder.padFolder(FOLDER_WARN_BYTES - before.totalBytes);
    expect((await a.platform.scan({ keep: [] })).folderLarge).toBe(false);
    a.folder.padFolder(1);
    expect((await a.platform.scan({ keep: [] })).folderLarge).toBe(true);
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS);
    expect((await a.platform.scan({ keep: [] })).nonceWarning).toBe(false);
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    expect((await a.platform.scan({ keep: [] })).nonceWarning).toBe(true);
  });
});

describe('point 3 : échecs avalés', () => {
  it('abonné de onRemoteChanges qui lève : journalisé sans contenu, les autres abonnés prévenus, la synchro continue', async () => {
    const a = await first();
    const b = await createSimDevice(B_ID, { clock: a.clock });
    devices.push(b);
    await pair(a, b);
    await b.cycle();
    await b.createTask('B1');
    await b.cycle();
    syncFolders([a, b]);
    const seen: number[] = [];
    a.service.onRemoteChanges(() => {
      throw new Error('écran cassé');
    });
    a.service.onRemoteChanges(() => seen.push(1));
    const status = await a.cycle();
    expect(status.phase).toBe('idle');
    expect(seen.length).toBeGreaterThan(0);
    expect(events(a, 'remote-listener-failed').length).toBe(seen.length);
    expect(JSON.stringify(a.logger.entries)).not.toContain('écran cassé');
  });

  it('lecture de l’état local en échec en fin de cycle : state-unreadable visible et journalisé, retiré à la lecture réussie suivante', async () => {
    const a = await first();
    const sync = a.data.repos.sync as unknown as Record<string, unknown>;
    const real = sync['countConflictsSince'];
    sync['countConflictsSince'] = () => Promise.reject(new Error('base occupée'));
    const status = await a.cycle();
    expect(status.stateUnreadable).toBe(true);
    expect(events(a, 'state-read-failed').length).toBeGreaterThan(0);
    sync['countConflictsSince'] = real;
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });

  it('relecture de l’oubli en échec après une déclaration refusée : state-unreadable visible', async () => {
    const a = await first();
    const sync = a.data.repos.sync as unknown as Record<string, unknown>;
    const realGet = sync['getMeta'] as (key: string) => Promise<string | null>;
    const forget = a.platform.forget as unknown as Record<string, unknown>;
    forget['device'] = () => {
      sync['getMeta'] = () => Promise.reject(new Error('base occupée'));
      return Promise.reject(new SyncPlatformError('consent-denied'));
    };
    expect(await a.service.forgetDevice(C_ID)).toEqual({ kind: 'cancelled' });
    sync['getMeta'] = realGet;
    expect(a.service.status().stateUnreadable).toBe(true);
    expect(events(a, 'state-read-failed').length).toBeGreaterThan(0);
  });

  it('cycle interrompu par une erreur hors des étapes gardées : code réel, jamais « io » par défaut', async () => {
    const a = await first();
    const sync = a.data.repos.sync as unknown as Record<string, unknown>;
    sync['getStates'] = () => Promise.reject(new SyncPlatformError('vault-unavailable'));
    const status = await a.cycle();
    expect(status.phase).toBe('error');
    expect(status.errorCode).toBe('vault-unavailable');
    expect(events(a, 'cycle-crashed')).toEqual([{ code: 'vault-unavailable' }]);
  });

  it('fenêtre de restauration, scan en échec : journalisé, vérification signalée, « Appliquer partout » retiré par prudence', async () => {
    const a = await first();
    a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
    (a.platform as unknown as Record<string, unknown>)['scan'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    const context = await a.service.restoreContext();
    expect(context?.options).toEqual(['keep-synced']);
    expect(context?.notice).toBe('scan-failed');
    expect(events(a, 'restore-scan-failed')).toEqual([{ code: 'cloud-error' }]);
  });

  it('suppression de ses anciens instantanés en échec : journalisée (plus de .catch(() => 0))', async () => {
    const a = await first();
    (a.platform as unknown as Record<string, unknown>)['deleteOwn'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(8 * DAY);
      await a.cycle();
    }
    expect(events(a, 'snapshot-written').length).toBeGreaterThanOrEqual(2);
    expect(events(a, 'delete-own-failed')).toContainEqual({ kind: 's', code: 'cloud-error' });
  });

  it('suppression de ses anciennes époques en échec : journalisée (plus de .catch(() => 0))', async () => {
    const a = await first();
    a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
    (a.platform as unknown as Record<string, unknown>)['deleteOwn'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    await a.service.chooseRestoreOption('apply-everywhere');
    await a.cycle();
    expect(events(a, 'delete-own-failed')).toContainEqual({ kind: 'epoch', code: 'cloud-error' });
    expect(events(a, 'old-epochs-deleted')).toEqual([]);
  });
});

describe('point 4 : accusés et valeurs stockés illisibles', () => {
  it('une seule analyse (repository) : JSON corrompu ou forme invalide → SyncStateUnreadableError journalisée', () => {
    const logger = createMemorySyncLogger();
    expect(() => parseStoredAcks('{pas du json', 'sync_state.last_acks', logger)).toThrow(SyncStateUnreadableError);
    expect(() => parseStoredAcks('[1]', 'sync_state.last_acks', logger)).toThrow(SyncStateUnreadableError);
    expect(logger.entries.map((e) => e.event)).toEqual(['state-unreadable', 'state-unreadable']);
    expect(JSON.stringify(logger.entries)).not.toContain('pas du json');
    expect(parseStoredAcks('{}', 'sync_state.last_acks', logger).size).toBe(0);
  });

  it('knownDevices (purge) et readJson (sync_meta) ne lisent plus une valeur illisible comme « aucune »', async () => {
    const a = await first();
    await a.data.repos.sync.saveState(C_ID, { status: 'active', lastAcks: '{pas du json' });
    const rows = await a.data.repos.sync.getStates();
    expect(() => knownDevices(rows, a.logger)).toThrow(SyncStateUnreadableError);
    await a.data.repos.sync.setMeta('epoch', '{pas du json');
    await expect(readJson(a.data.repos, 'epoch')).rejects.toThrow(SyncStateUnreadableError);
  });

  it('cycle : accusés d’un appareil illisibles → state-unreadable, jamais « aucun accusé »', async () => {
    const a = await first();
    await a.data.repos.sync.saveState(C_ID, { status: 'active', lastAcks: '{pas du json' });
    const status = await a.cycle();
    expect(status.stateUnreadable).toBe(true);
    expect(events(a, 'state-unreadable').length).toBeGreaterThan(0);
  });

  it('« Associer de nouveau » : accusés illisibles → échec visible, rien n’est republié', async () => {
    const a = await first();
    await a.data.repos.sync.saveState(C_ID, { status: 'active', lastAcks: '{pas du json' });
    const outcome = await a.service.rejoin();
    expect(outcome.kind).toBe('failed');
    expect(await a.data.repos.settings.get('device.id')).toBe(A_ID);
  });
});
