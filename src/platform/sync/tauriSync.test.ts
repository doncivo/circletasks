// Y-01 critères 3 et 18 : `tauriSync` est la seule porte vers les commandes `sync_*` ; aucun chemin, aucune recopie d'entrée.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceId, Hlc } from '../../domain/types';
import { publishedStateToJson, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../domain/sync/format';
import { openSyncPlatform } from './index';
import { createTauriSync, type SyncInvoker } from './tauriSync';
import { SYNC_COMMANDS, SyncPlatformError, type SyncCommand } from './types';

const DEVICE = '3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60' as DeviceId;
const EPOCH = `e0001-${DEVICE}` as EpochId;
const HLC = `000001759651200-0000-${DEVICE}` as Hlc;

const STATE: PublishedDeviceState = {
  deviceId: DEVICE,
  platform: 'windows',
  appVersion: '0.1.1',
  sm: 1,
  sv: 14,
  epoch: EPOCH,
  stateSeq: 3,
  head: { epoch: EPOCH, segment: 1, record: 2, hlc: HLC, stateSeq: 3 },
  acks: new Map<DeviceId, DeviceAck>(),
  snapshot: null,
  purgeHorizon: null,
  lastSyncHlc: HLC,
  forgotten: [],
  reset: null,
};

function fakeInvoker(results: Partial<Record<SyncCommand, unknown>> = {}) {
  const calls: { command: SyncCommand; args: unknown }[] = [];
  const invoke = vi.fn(async (command: SyncCommand, args?: unknown) => {
    calls.push({ command, args });
    const result = results[command];
    if (result instanceof Error || (typeof result === 'object' && result !== null && 'code' in result)) throw result;
    return result ?? null;
  }) as unknown as SyncInvoker;
  return { invoke, calls };
}

describe('tauriSync (Y-01 critère 18)', () => {
  it('appelle chaque commande avec ses arguments, sans chemin', async () => {
    const { invoke, calls } = fakeInvoker({
      sync_folder_info: { configured: true, name: 'CircleTasks', kind: 'icloud', pinned: false },
      sync_key_status: { present: true, kid: '0123456789abcdef' },
      sync_delete_own: { deleted: 2 },
      sync_snapshot_begin: { handle: 7 },
    });
    const sync = createTauriSync({ available: true, invoke });
    expect(await sync.folder.info()).toEqual({ configured: true, label: 'CircleTasks', kind: 'icloud', pinned: false });
    await sync.folder.forget({ eraseKey: true });
    await sync.bindDevice(DEVICE);
    expect(await sync.key.status()).toEqual({ present: true, kid: '0123456789abcdef' });
    await sync.key.openPairing('show');
    await sync.key.pairingPayload({ renew: true });
    await sync.key.pairingPayload();
    await sync.key.import({ recoveryKey: 'CT1-…' });
    await sync.key.closePairing();
    expect(await sync.deleteOwn([{ epoch: EPOCH, kind: 'j', n: 1 }])).toBe(2);
    await sync.writeSnapshot({
      epoch: EPOCH,
      seq: 1,
      sv: 14,
      records: (async function* () {
        yield ['a'];
        yield ['b', 'c'];
      })(),
    });
    expect(calls.map((c) => c.command)).toEqual([
      'sync_folder_info',
      'sync_folder_forget',
      'sync_bind_device',
      'sync_key_status',
      'sync_pairing_open',
      'sync_pairing_payload',
      'sync_pairing_payload',
      'sync_key_import',
      'sync_pairing_close',
      'sync_delete_own',
      'sync_snapshot_begin',
      'sync_snapshot_append',
      'sync_snapshot_append',
      'sync_snapshot_commit',
    ]);
    expect(calls[1]?.args).toEqual({ eraseKey: true });
    expect(calls[2]?.args).toEqual({ deviceId: DEVICE });
    expect(calls[5]?.args).toEqual({ renew: true });
    expect(calls[6]?.args).toEqual({});
    expect(calls[12]?.args).toEqual({ handle: 7, records: ['b', 'c'] });
  });

  it('writeState envoie la forme JSON canonique de l’état', async () => {
    const { invoke, calls } = fakeInvoker();
    await createTauriSync({ available: true, invoke }).writeState({ sv: 14, state: STATE });
    expect(calls[0]).toEqual({ command: 'sync_write_state', args: { sv: 14, state: publishedStateToJson(STATE) } });
  });

  it('scan analyse strictement les états reçus ; un état mal formé devient « corrompu »', async () => {
    const good = publishedStateToJson(STATE);
    const { invoke } = fakeInvoker({
      sync_scan: {
        devices: [
          { deviceId: DEVICE, kid: '0123456789abcdef', state: good, stateStatus: 'ok', epochs: [], pending: [] },
          { deviceId: DEVICE, kid: null, state: { ...good, extra: 1 }, stateStatus: 'ok', epochs: [], pending: [] },
        ],
        ignored: 0,
        totalBytes: 10,
        tooManyDevices: false,
        incomplete: false,
      },
    });
    const scan = await createTauriSync({ available: true, invoke }).scan({ keep: [] });
    expect(scan.devices[0]?.state?.head.record).toBe(2);
    expect(scan.devices[1]).toMatchObject({ state: null, stateStatus: 'corrupt' });
  });

  it('un rejet Rust devient SyncPlatformError { code } sans recopier le message ni l’entrée', async () => {
    const secret = 'CT1-AAAAA-BBBBB C:\\Users\\Ali\\iCloudDrive\\CircleTasks';
    const { invoke } = fakeInvoker({ sync_key_import: { code: 'key-mismatch', message: secret } });
    const error = await createTauriSync({ available: true, invoke })
      .key.import({ recoveryKey: secret })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncPlatformError);
    expect((error as SyncPlatformError).code).toBe('key-mismatch');
    expect(String((error as Error).message)).not.toContain('CT1');
    expect(JSON.stringify(error)).not.toContain('Users');
    const unknown = await createTauriSync({ available: true, invoke: (async () => Promise.reject(new Error('boom'))) as SyncInvoker })
      .folder.info()
      .catch((e: unknown) => e);
    expect((unknown as SyncPlatformError).code).toBe('io');
  });

  it('openSyncPlatform : Rust dans Tauri (PC et iPhone, Y-IOS-01 critère 8), mémoire dans le navigateur', () => {
    expect(openSyncPlatform('tauri', 'windows').available()).toBe(true);
    expect(openSyncPlatform('tauri', 'ios').available()).toBe(true);
    expect(openSyncPlatform('tauri', 'other').available()).toBe(false);
    const web = openSyncPlatform('web', 'other') as { testing?: unknown };
    expect(web.testing).toBeDefined();
  });
});

describe('frontière des commandes (Y-01 critères 3 et 18)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(root);

  it('seul tauriSync.ts appelle Tauri avec une commande sync_*', () => {
    const offenders = files.filter((path) => {
      const text = readFileSync(path, 'utf8');
      const callsTauri = text.includes('@tauri-apps/api/core');
      const namesCommand = SYNC_COMMANDS.some((command) => text.includes(`'${command}'`) || text.includes(`"${command}"`) || text.includes(`\`${command}\``));
      return callsTauri && namesCommand;
    });
    expect(offenders.map((path) => relative(root, path).replace(/\\/g, '/'))).toEqual(['platform/sync/tauriSync.ts']);
  });

  it('aucun paramètre ni champ de réponse de commande ne porte un chemin', () => {
    const types = readFileSync(join(root, 'platform', 'sync', 'types.ts'), 'utf8');
    const map = types.slice(types.indexOf('export interface SyncCommandMap'), types.indexOf('export type SyncCommand ='));
    expect(map).not.toMatch(/\b(path|dir|directory|folderPath|file(name)?Path)\b/i);
  });
});
