import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../notifications/fakeBridge';
import { NotificationSchedulerError } from '../notifications/types';
import { createUnsupportedSigning, openSigning } from './index';
import { createTauriSigningSource } from './tauriSigning';
import { createTauriSigningAlert, SIGNING_ALERT_NUMERIC_ID } from './tauriSigningAlert';

/** I-02 critères 3 et 10 : adaptateurs, résolveur et cohérence (un seul fichier nomme la commande, aucun accès hors iPhone). */
describe('tauriSigning : commande app_signing_info', () => {
  it('rend les deux dates UTC', async () => {
    const call = vi.fn().mockResolvedValue({ expiresAt: '2026-10-15T09:12:34Z', issuedAt: '2026-10-08T09:12:34Z' });
    const result = await createTauriSigningSource(call).read();
    expect(call).toHaveBeenCalledExactlyOnceWith('app_signing_info');
    expect(result).toEqual({ ok: true, expiresAt: '2026-10-15T09:12:34Z', issuedAt: '2026-10-08T09:12:34Z' });
  });

  it('CreationDate absente : issuedAt nul', async () => {
    const result = await createTauriSigningSource(() => Promise.resolve({ expiresAt: '2026-10-15T09:12:34Z', issuedAt: null })).read();
    expect(result).toEqual({ ok: true, expiresAt: '2026-10-15T09:12:34Z', issuedAt: null });
  });

  it('rejets du code Rust : profile-missing et profile-unreadable, tels quels', async () => {
    expect(await createTauriSigningSource(() => Promise.reject('profile-missing')).read()).toEqual({ ok: false, code: 'profile-missing' });
    expect(await createTauriSigningSource(() => Promise.reject('profile-unreadable')).read()).toEqual({ ok: false, code: 'profile-unreadable' });
  });

  it('commande absente ou refusée par la capability : unavailable (jamais un rejet)', async () => {
    expect(await createTauriSigningSource(() => Promise.reject(new Error('Command app_signing_info not allowed by ACL'))).read()).toEqual({ ok: false, code: 'unavailable' });
    expect(await createTauriSigningSource(() => Promise.reject('autre')).read()).toEqual({ ok: false, code: 'unavailable' });
  });

  it('réponse mal formée : profile-unreadable', async () => {
    for (const answer of [null, 'texte', {}, { expiresAt: 12 }, { expiresAt: 'demain' }, { expiresAt: '2026-10-15T09:12:34Z', issuedAt: 'hier' }, { expiresAt: '2026-10-15 09:12:34' }]) {
      expect(await createTauriSigningSource(() => Promise.resolve(answer)).read()).toEqual({ ok: false, code: 'profile-unreadable' });
    }
  });
});

describe('tauriSigningAlert : identifiant réservé 2 par le pont', () => {
  it('show avec l’identifiant 2, sans catégorie, heure murale du fuseau', async () => {
    const bridge = createFakeBridge();
    const alert = createTauriSigningAlert(bridge);
    await alert.schedule({ instant: Date.parse('2026-10-13T08:00:00Z'), zone: 'Europe/Paris', title: 'Titre', body: 'Corps' });
    expect(SIGNING_ALERT_NUMERIC_ID).toBe(2);
    expect(bridge.shown).toEqual([
      {
        id: 2,
        title: 'Titre',
        body: 'Corps',
        sound: 'default',
        extra: { sid: 'signing' },
        schedule: { at: { date: '2026-10-13T10:00:00.000Z', repeating: false, allowWhileIdle: false } },
      },
    ]);
    expect(await alert.isPending()).toBe(true);
  });

  it('remplacée par le même identifiant ; cancel ne retire que 2', async () => {
    const bridge = createFakeBridge();
    bridge.pendingMap.set(1, { id: 1, title: 'Fin de Focus', body: '', date: '' });
    const alert = createTauriSigningAlert(bridge);
    await alert.schedule({ instant: Date.parse('2026-10-13T08:00:00Z'), zone: null, title: 'A', body: 'a' });
    await alert.schedule({ instant: Date.parse('2026-10-14T08:00:00Z'), zone: null, title: 'B', body: 'b' });
    expect([...bridge.pendingMap.keys()].sort()).toEqual([1, 2]);
    await alert.cancel();
    expect(bridge.cancels).toEqual([[2]]);
    expect([...bridge.pendingMap.keys()]).toEqual([1]);
    expect(await alert.isPending()).toBe(false);
  });

  it('rejets typés (NotificationSchedulerError) : jamais d’erreur brute', async () => {
    const bridge = createFakeBridge();
    const alert = createTauriSigningAlert(bridge);
    bridge.failShow = () => true;
    await expect(alert.schedule({ instant: 1, zone: null, title: 'A', body: 'a' })).rejects.toBeInstanceOf(NotificationSchedulerError);
    bridge.failCancel = true;
    await expect(alert.cancel()).rejects.toMatchObject({ reason: 'schedule-failed' });
    bridge.failPending = true;
    await expect(alert.isPending()).rejects.toMatchObject({ reason: 'verify-failed' });
  });
});

describe('résolveur openSigning', () => {
  it('PC et navigateur : non pris en charge, aucune alerte, jamais d’erreur', async () => {
    for (const [runtime, os] of [['tauri', 'windows'], ['web', 'other'], ['tauri', 'other']] as const) {
      const platform = openSigning(runtime, os);
      expect(platform.source.supported).toBe(false);
      expect(await platform.source.read()).toEqual({ ok: false, code: 'unavailable' });
      await expect(platform.alert.schedule({ instant: 1, zone: null, title: 'A', body: 'a' })).resolves.toBeUndefined();
      await expect(platform.alert.isPending()).resolves.toBe(false);
    }
    expect(createUnsupportedSigning().source.supported).toBe(false);
  });

  it('iPhone installé : pris en charge', () => {
    expect(openSigning('tauri', 'ios').source.supported).toBe(true);
  });
});

describe('cohérence : un seul fichier TypeScript nomme la commande (I-02 critère 3)', () => {
  const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
  const sourcesOf = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourcesOf(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

  it('seul src/platform/signing/tauriSigning.ts contient « app_signing_info »', () => {
    const files = sourcesOf(join(rootDir, 'src'));
    expect(files.length).toBeGreaterThan(100);
    const naming = files.filter((file) => readFileSync(file, 'utf8').includes('app_signing_info')).map((file) => relative(rootDir, file).replaceAll('\\', '/'));
    expect(naming).toEqual(['src/platform/signing/tauriSigning.ts']);
  });

  it('aucune capability Windows ni du bureau n’accorde la commande ; seule signing-ios.json la porte', () => {
    const dir = join(rootDir, 'src-tauri', 'capabilities');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      const text = readFileSync(join(dir, name), 'utf8');
      if (name === 'signing-ios.json') expect(JSON.parse(text)).toMatchObject({ platforms: ['iOS'], windows: ['main'], permissions: ['allow-app-signing-info'] });
      else expect(text, name).not.toContain('app-signing-info');
    }
  });

  it('le résolveur n’est consommé que par bootstrap : le conteneur par défaut est non pris en charge', async () => {
    const { createAppContainer } = await import('../../features/app/container');
    const container = createAppContainer({ hlc: {} as never, data: {} as never });
    expect(container.signing.source.supported).toBe(false);
  });
});
