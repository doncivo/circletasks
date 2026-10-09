import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteWasmDriver } from '../../../src/db/drivers/sqliteWasm';
import { useAppStore } from '../../../src/features/app/appStore';
import { bootstrapApp } from '../../../src/features/app/bootstrap';
import { resetAppVersionMemo } from '../../../src/platform/appVersion';
import { createUnavailableBackup } from '../../../src/platform/backup';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS } from '../../../src/platform/calendars';
import { createUnavailableFiles } from '../../../src/platform/files';
import { createMemorySyncPlatform } from '../../../src/platform/sync/memory';
import type * as SyncModule from '../../../src/sync';
import type { SyncServiceOptions } from '../../../src/sync/service';

/**
 * I-06 critère 6 (dette « version publiée par l'iPhone ») : le service de synchro reçoit la version de l'app sur l'iPhone comme sur le PC,
 * par le même module (`platform/appVersion.ts`), égale à celle de tauri.conf.json ; illisible : `unknown`, jamais `0.0.0`, la synchro continue.
 */

const received: SyncServiceOptions[] = [];
vi.mock('../../../src/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof SyncModule>();
  return {
    ...actual,
    createSyncService: (options: SyncServiceOptions) => {
      received.push(options);
      return actual.createSyncService(options);
    },
  };
});

const tauriGetVersion = vi.fn(() => Promise.resolve('0.3.0'));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => tauriGetVersion() }));

const confVersion = (JSON.parse(readFileSync(resolve(__dirname, '..', '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8')) as { version: string }).version;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const common = { focusWindow: null, files: createUnavailableFiles(), calendars: createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS), backups: createUnavailableBackup() } as const;

beforeEach(() => {
  received.length = 0;
  resetAppVersionMemo();
  useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, dbFailure: null });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAppVersionMemo();
});

describe('version publiée par la synchro (critère 6)', () => {
  it('iPhone simulé, getVersion de Tauri à 0.3.0 : appVersion 0.3.0 (plus 0.0.0), plateforme ios, même valeur dans le conteneur', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const container = await bootstrapApp({ ...common, desktop: null, open: openSqliteWasmDriver, syncPlatform: createMemorySyncPlatform({ platform: 'ios' }) });
    expect(container?.sync).not.toBeNull();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ appVersion: '0.3.0', devicePlatform: 'ios' });
    expect(container?.appVersion).toEqual({ ok: true, version: '0.3.0', source: 'runtime' });
  });

  it('PC simulé, même module : même valeur, sans dépendre de l’intégration PC', async () => {
    vi.stubGlobal('navigator', { userAgent: WINDOWS });
    await bootstrapApp({ ...common, desktop: null, open: openSqliteWasmDriver, syncPlatform: createMemorySyncPlatform() });
    expect(received[0]).toMatchObject({ appVersion: '0.3.0', devicePlatform: 'windows' });
  });

  it('getVersion indisponible (navigateur, e2e) : version de tauri.conf.json (constante de build)', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    tauriGetVersion.mockRejectedValueOnce(new Error('pas de Tauri'));
    await bootstrapApp({ ...common, desktop: null, open: openSqliteWasmDriver, syncPlatform: createMemorySyncPlatform({ platform: 'ios' }) });
    expect(received[0]?.appVersion).toBe(confVersion);
  });

  it('échec de lecture : appVersion « unknown » (format respecté), une ligne de journal au code seul, la synchro démarre quand même', async () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const container = await bootstrapApp({
      ...common,
      desktop: null,
      open: openSqliteWasmDriver,
      syncPlatform: createMemorySyncPlatform({ platform: 'ios' }),
      appVersion: async () => (await import('../../../src/platform/appVersion')).readAppVersion({ getVersion: () => Promise.reject(new Error('x')), buildVersion: undefined }),
    });
    expect(received[0]?.appVersion).toBe('unknown');
    expect(container?.sync?.status().phase).toBeDefined();
    expect(warn.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[desktop:app] app-version-unreadable');
    await container?.sync?.syncNow('manual');
    expect(container?.sync?.status().phase).toBe('not-configured');
  });
});
