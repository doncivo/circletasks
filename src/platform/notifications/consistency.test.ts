import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * N-TECH-01 critère 5, durci par N-01 critère 1 (ADR 0012 section 7 et avenant N1.9) : le PC n'émet aucune notification de rappel.
 * Le test prouve qu'aucun chemin ne peut y obtenir un envoi réel : résolveurs, sources, Cargo.toml, lib.rs et capabilities. Une
 * divergence casse ce test, pas l'app installée.
 */
const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(rootDir, path), 'utf8');

/** Seul fichier autorisé à référencer le plugin (adaptateur iOS, N-01). */
const IOS_ADAPTER = join('src', 'platform', 'notifications', 'tauriNotifications.ts');

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourcesOf(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const PLUGIN_USE = /plugin-notification|tauri_plugin_notification|plugin:notification|new Notification\(|window\.Notification|sendNotification/;

const IOS_PERMISSIONS = [
  'notification:allow-cancel',
  'notification:allow-get-pending',
  'notification:allow-is-permission-granted',
  'notification:allow-register-action-types',
  'notification:allow-register-listener',
  'notification:allow-remove-listener',
  'notification:allow-request-permission',
  'notification:allow-show',
];

describe('rappels : aucun envoi réel hors adaptateur iOS (N-TECH-01 critère 5, N-01 critère 1)', () => {
  const files = sourcesOf(join(rootDir, 'src'));

  it('seul tauriNotifications.ts référence le plugin ni l’API Notification du navigateur', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(rootDir, file))).toContain(IOS_ADAPTER);
    for (const file of files) {
      const path = relative(rootDir, file);
      if (path === IOS_ADAPTER) {
        expect(readFileSync(file, 'utf8')).toContain('plugin:notification|');
        continue;
      }
      expect(readFileSync(file, 'utf8'), path).not.toMatch(PLUGIN_USE);
    }
  });

  it('les résolveurs ne chargent un adaptateur réel que pour (tauri, ios), jamais pour windows ni web', () => {
    for (const path of ['src/platform/notifications/index.ts', 'src/platform/focus/index.ts']) {
      const lines = read(path).split(/\r?\n/);
      const guard = lines.findIndex((line) => /runtime\s*===\s*'tauri'\s*&&\s*os\s*===\s*'ios'/.test(line));
      expect(guard, path).toBeGreaterThan(-1);
      // Tout import dynamique d'adaptateur de notification vient APRÈS la garde, jamais avant.
      const imports = lines.flatMap((line, index) => (/\bimport\(['"]\.\/tauri(Notifications|FocusEnd)|import\(['"]\.\.\/notifications\/tauriNotifications/.test(line) ? [index] : []));
      expect(imports.length, path).toBeGreaterThan(0);
      for (const index of imports) expect(index, path).toBeGreaterThan(guard);
      expect(lines.join('\n'), path).not.toMatch(/runtime\s*===\s*'web'|os\s*===\s*'windows'/);
    }
  });

  it('src-tauri/Cargo.toml ne déclare le plugin que sous cfg(target_os = "ios"), épinglé à =2.5.1', () => {
    let section = '';
    let declarations = 0;
    for (const line of read('src-tauri/Cargo.toml').split(/\r?\n/)) {
      const header = /^\s*\[(.+)\]\s*$/.exec(line);
      if (header !== null) section = header[1] ?? '';
      if (/tauri-plugin-notification/.test(line) && !/^\s*#/.test(line)) {
        declarations += 1;
        expect(section, line).toBe('target.\'cfg(target_os = "ios")\'.dependencies');
        expect(line, line).toMatch(/"=2\.5\.1"/);
      }
    }
    expect(declarations).toBe(1);
  });

  it('src-tauri/src/lib.rs n’enregistre le plugin que sous cfg(target_os = "ios")', () => {
    const lines = read('src-tauri/src/lib.rs').split(/\r?\n/);
    const uses = lines.flatMap((line, index) => (line.includes('tauri_plugin_notification') ? [index] : []));
    expect(uses).toHaveLength(1);
    expect(lines[(uses[0] ?? 0) - 1]?.trim()).toBe('#[cfg(target_os = "ios")]');
    expect(lines.join('\n')).not.toMatch(/NotificationExt/);
  });

  it('seule notifications-ios.json accorde notification: (iOS seulement, liste exacte) : aucune fenêtre Windows', () => {
    const names = readdirSync(join(rootDir, 'src-tauri', 'capabilities')).filter((name) => name.endsWith('.json'));
    expect(names.length).toBeGreaterThan(5);
    expect(names).toContain('notifications-ios.json');
    for (const name of names) {
      const capability = JSON.parse(read(`src-tauri/capabilities/${name}`)) as {
        platforms?: string[];
        windows: string[];
        permissions: (string | { identifier: string })[];
      };
      const ids = capability.permissions.map((permission) => (typeof permission === 'string' ? permission : permission.identifier));
      const granted = ids.filter((id) => id.startsWith('notification:'));
      if (name !== 'notifications-ios.json') {
        expect(granted, name).toEqual([]);
        continue;
      }
      expect((capability.platforms ?? []).map((platform) => platform.toLowerCase())).toEqual(['ios']);
      expect(capability.windows).toEqual(['main']);
      expect([...granted].sort()).toEqual(IOS_PERMISSIONS);
      // Aucune permission autre (pas de `core:`), jamais le chemin qui perd les erreurs ni la lecture des notifications livrées.
      expect(ids).toHaveLength(IOS_PERMISSIONS.length);
      expect(ids.some((id) => /allow-(notify|batch|get-active|remove-active|check-permissions|permission-state)|:default/.test(id))).toBe(false);
    }
  });

  it('la configuration Windows ne déclare aucun plugin de notification', () => {
    expect(read('src-tauri/tauri.windows.conf.json')).not.toMatch(/notification/i);
  });

  it('build-ios.yml vérifie par cargo tree que le plugin est compilé pour iOS et pas pour Windows', () => {
    const workflow = read('.github/workflows/build-ios.yml');
    expect(workflow).toContain('cargo tree --target aarch64-apple-ios -i tauri-plugin-notification');
    expect(workflow).toContain('cargo tree --target x86_64-pc-windows-msvc -i tauri-plugin-notification');
  });
});
