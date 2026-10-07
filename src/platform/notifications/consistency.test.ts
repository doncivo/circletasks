import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * N-TECH-01 critère 5 (ADR 0012 section 7) : le PC n'émet aucune notification de rappel. Le test prouve qu'aucun chemin ne peut y
 * obtenir un envoi réel : résolveur, sources, Cargo.toml et capabilities. Une divergence casse ce test, pas l'app installée.
 */
const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(rootDir, path), 'utf8');

/** Seul fichier autorisé à référencer le plugin (adaptateur iOS, ajouté par N-01). */
const IOS_ADAPTER = join('src', 'platform', 'notifications', 'tauriNotifications.ts');

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourcesOf(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const PLUGIN_USE = /plugin-notification|tauri_plugin_notification|new Notification\(|window\.Notification|sendNotification/;

describe('rappels : aucun envoi réel hors adaptateur iOS (N-TECH-01 critère 5)', () => {
  const files = sourcesOf(join(rootDir, 'src'));

  it('aucun fichier de src, hors adaptateur iOS, ne référence le plugin ni l’API Notification du navigateur', () => {
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const path = relative(rootDir, file);
      if (path === IOS_ADAPTER) continue;
      expect(readFileSync(file, 'utf8'), path).not.toMatch(PLUGIN_USE);
    }
  });

  it('le résolveur ne charge un adaptateur réel que pour (tauri, ios)', () => {
    const resolver = read('src/platform/notifications/index.ts');
    const dynamicImports = resolver.match(/import\(/g) ?? [];
    if (dynamicImports.length > 0) {
      expect(resolver).toMatch(/runtime\s*===\s*'tauri'/);
      expect(resolver).toMatch(/os\s*===\s*'ios'/);
    }
    // À N-TECH-01 : aucun adaptateur réel, donc aucun import dynamique ni import du plugin.
    expect(resolver).not.toMatch(PLUGIN_USE);
  });

  it('src-tauri/Cargo.toml ne déclare le plugin que sous cfg(target_os = "ios"), ou pas du tout', () => {
    let section = '';
    for (const line of read('src-tauri/Cargo.toml').split(/\r?\n/)) {
      const header = /^\s*\[(.+)\]\s*$/.exec(line);
      if (header !== null) section = header[1] ?? '';
      if (/tauri-plugin-notification/.test(line) && !/^\s*#/.test(line)) {
        expect(section, line).toMatch(/^target\.'cfg\(target_os = "ios"\)'\.(dev-|build-)?dependencies$/);
      }
    }
  });

  it('aucune capability ne donne notification: à une fenêtre Windows', () => {
    const names = readdirSync(join(rootDir, 'src-tauri', 'capabilities')).filter((name) => name.endsWith('.json'));
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const capability = JSON.parse(read(`src-tauri/capabilities/${name}`)) as {
        platforms?: string[];
        permissions: (string | { identifier: string })[];
      };
      const grantsNotification = capability.permissions.some((permission) => (typeof permission === 'string' ? permission : permission.identifier).startsWith('notification:'));
      if (grantsNotification) expect((capability.platforms ?? []).map((platform) => platform.toLowerCase()), name).toEqual(['ios']);
    }
  });

  it('la configuration Windows ne déclare aucun plugin de notification', () => {
    expect(read('src-tauri/tauri.windows.conf.json')).not.toMatch(/notification/i);
  });
});
