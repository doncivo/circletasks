import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAppVersion, publishedAppVersion, readAppVersion, resetAppVersionMemo, UNKNOWN_APP_VERSION } from './appVersion';

const confVersion = (JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8')) as { version: string }).version;

/** I-06 critère 6 (ADR 0007 avenant I-06 point 1) : seul lecteur de la version, PC et iPhone, jamais 0.0.0. */
describe('readAppVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAppVersionMemo();
  });

  it('getVersion de Tauri en premier (valeur de tauri.conf.json compilée)', async () => {
    await expect(readAppVersion({ getVersion: () => Promise.resolve('0.3.0') })).resolves.toEqual({ ok: true, version: '0.3.0', source: 'runtime' });
  });

  it('Tauri indisponible ou illisible : constante de build', async () => {
    await expect(readAppVersion({ getVersion: () => Promise.reject(new Error('pas de Tauri')), buildVersion: '0.3.0' })).resolves.toEqual({ ok: true, version: '0.3.0', source: 'build' });
    await expect(readAppVersion({ getVersion: () => Promise.resolve('0.0.0'), buildVersion: '0.3.0' })).resolves.toMatchObject({ version: '0.3.0', source: 'build' });
    await expect(readAppVersion({ getVersion: () => Promise.resolve('dev'), buildVersion: '0.3.0' })).resolves.toMatchObject({ version: '0.3.0', source: 'build' });
  });

  it('les deux illisibles : ok faux, version null, une ligne de journal au code seul, jamais 0.0.0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const read = await readAppVersion({ getVersion: () => Promise.resolve('0.0.0'), buildVersion: '0.0.0' });
    expect(read).toEqual({ ok: false, version: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe('[desktop:app] app-version-unreadable');
    expect(publishedAppVersion(read)).toBe(UNKNOWN_APP_VERSION);
    expect(UNKNOWN_APP_VERSION).not.toBe('0.0.0');
  });

  it('la constante de build est la version de tauri.conf.json (vite.config.ts)', () => {
    expect(__CT_APP_VERSION__).toBe(confVersion);
    expect(buildAppVersion()).toEqual({ ok: true, version: confVersion, source: 'build' });
  });

  it('sans dépendance : hors Tauri (Vitest), constante de build ; valeur mémorisée pour le processus', async () => {
    const first = await readAppVersion();
    expect(first).toEqual({ ok: true, version: confVersion, source: 'build' });
    expect(readAppVersion()).toBe(readAppVersion());
  });

  it('publishedAppVersion : la version lue telle quelle', () => {
    expect(publishedAppVersion({ ok: true, version: '0.3.0', source: 'runtime' })).toBe('0.3.0');
  });
});
