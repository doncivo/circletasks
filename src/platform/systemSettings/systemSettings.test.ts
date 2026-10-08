import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSystemSettings, openSystemSettings, setSystemSettings, SystemSettingsError } from './index';
import { createTauriSystemSettings, SETTINGS_OPEN_COMMAND } from './tauriSystemSettings';

describe('systemSettings : ouverture des Réglages iOS (un seul point d’appel)', () => {
  afterEach(() => setSystemSettings(null));

  it('succès : la commande est appelée une fois', async () => {
    const calls: string[] = [];
    const settings = createTauriSystemSettings((command) => {
      calls.push(command);
      return Promise.resolve({ opened: true });
    });
    await expect(settings.openApp()).resolves.toBeUndefined();
    expect(calls).toEqual([SETTINGS_OPEN_COMMAND]);
  });

  it('refus d’iOS, rejet de la commande, commande absente : toujours settings-open-failed, jamais un bouton muet', async () => {
    for (const reply of [() => Promise.resolve({ opened: false }), () => Promise.reject({ code: 'settings-open-failed', message: 'failed' }), () => Promise.reject('not allowed')]) {
      const error = await createTauriSystemSettings(reply)
        .openApp()
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SystemSettingsError);
      expect(error).toMatchObject({ code: 'settings-open-failed' });
    }
  });

  it('résolveur : iPhone Tauri = ouvreur ; PC, navigateur = aucun (aucune action proposée)', () => {
    expect(openSystemSettings('tauri', 'ios')).not.toBeNull();
    expect(openSystemSettings('tauri', 'windows')).toBeNull();
    expect(openSystemSettings('web', 'ios')).toBeNull();
    expect(getSystemSettings()).toBeNull();
  });

  it('un seul fichier de src nomme app_settings_open', () => {
    const root = resolve(__dirname, '..', '..', '..');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name) && readFileSync(join(root, path), 'utf8').includes('app_settings_open')) found.push(path);
      }
    };
    walk('src');
    expect(found).toEqual(['src/platform/systemSettings/tauriSystemSettings.ts']);
  });
});
