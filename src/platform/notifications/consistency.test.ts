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
/** Seul fichier autorisé à nommer le plugin des actions « Fait » / « +15 min » (N-03). */
const IOS_ACTIONS_ADAPTER = join('src', 'platform', 'notifications', 'tauriNotificationActions.ts');

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
  'notification:allow-request-permission',
  'notification:allow-show',
];
/** N-03 : catégories, écoute et fichier des actions par le plugin maison (un seul délégué ; le plugin officiel n'enregistre plus de catégories). */
const IOS_ACTION_PERMISSIONS = [
  'notification-actions:allow-ack',
  'notification-actions:allow-drain',
  'notification-actions:allow-register-action-types',
  'notification-actions:allow-register-listener',
  'notification-actions:allow-remove-listener',
  'notification-actions:allow-status',
];

describe('rappels : aucun envoi réel hors adaptateur iOS (N-TECH-01 critère 5, N-01 critère 1)', () => {
  const files = sourcesOf(join(rootDir, 'src'));

  it('seuls tauriNotifications.ts et tauriNotificationActions.ts référencent les plugins ni l’API Notification du navigateur', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((file) => relative(rootDir, file))).toContain(IOS_ADAPTER);
    expect(files.map((file) => relative(rootDir, file))).toContain(IOS_ACTIONS_ADAPTER);
    for (const file of files) {
      const path = relative(rootDir, file);
      if (path === IOS_ADAPTER) {
        expect(readFileSync(file, 'utf8')).toContain('plugin:notification|');
        continue;
      }
      if (path === IOS_ACTIONS_ADAPTER) {
        // Le plugin des actions, et lui seul : ni le plugin officiel ni l'API Notification du navigateur.
        const text = readFileSync(file, 'utf8');
        expect(text).toContain('plugin:notification-actions|');
        expect(text.replaceAll('plugin:notification-actions|', ''), path).not.toMatch(PLUGIN_USE);
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
      const imports = lines.flatMap((line, index) => (/\bimport\(['"]\.\/tauri(Notifications|NotificationActions|FocusEnd)|import\(['"]\.\.\/notifications\/tauriNotifications/.test(line) ? [index] : []));
      expect(imports.length, path).toBeGreaterThan(0);
      for (const index of imports) expect(index, path).toBeGreaterThan(guard);
      expect(lines.join('\n'), path).not.toMatch(/runtime\s*===\s*'web'|os\s*===\s*'windows'/);
    }
  });

  it('src-tauri/Cargo.toml ne déclare le plugin que sous cfg(target_os = "ios"), épinglé à =2.5.1', () => {
    let section = '';
    let declarations = 0;
    let actionDeclarations = 0;
    for (const line of read('src-tauri/Cargo.toml').split(/\r?\n/)) {
      const header = /^\s*\[(.+)\]\s*$/.exec(line);
      if (header !== null) section = header[1] ?? '';
      if (/^\s*tauri-plugin-notification-actions/.test(line)) {
        // N-03 : plugin Swift local (chemin), iPhone seulement lui aussi.
        actionDeclarations += 1;
        expect(section, line).toBe('target.\'cfg(target_os = "ios")\'.dependencies');
        expect(line, line).toMatch(/path = "plugins\/notification-actions"/);
      } else if (/tauri-plugin-notification/.test(line) && !/^\s*#/.test(line)) {
        declarations += 1;
        expect(section, line).toBe('target.\'cfg(target_os = "ios")\'.dependencies');
        expect(line, line).toMatch(/"=2\.5\.1"/);
      }
    }
    expect(declarations).toBe(1);
    expect(actionDeclarations).toBe(1);
  });

  it('src-tauri/src/lib.rs n’enregistre les plugins que sous cfg(target_os = "ios"), celui des actions après le plugin officiel', () => {
    const lines = read('src-tauri/src/lib.rs').split(/\r?\n/);
    const uses = lines.flatMap((line, index) => (line.includes('tauri_plugin_notification::') ? [index] : []));
    const actionUses = lines.flatMap((line, index) => (line.includes('tauri_plugin_notification_actions::') ? [index] : []));
    expect(uses).toHaveLength(1);
    expect(actionUses).toHaveLength(1);
    expect(lines[(uses[0] ?? 0) - 1]?.trim()).toBe('#[cfg(target_os = "ios")]');
    expect(lines[(actionUses[0] ?? 0) - 1]?.trim()).toBe('#[cfg(target_os = "ios")]');
    // Un seul délégué existe : le plugin d'actions est enregistré en second pour prendre la place de celui du plugin officiel.
    expect(actionUses[0] ?? 0).toBeGreaterThan(uses[0] ?? 0);
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
      const grantedActions = ids.filter((id) => id.startsWith('notification-actions:'));
      if (name !== 'notifications-ios.json') {
        expect(granted, name).toEqual([]);
        expect(grantedActions, name).toEqual([]);
        continue;
      }
      expect((capability.platforms ?? []).map((platform) => platform.toLowerCase())).toEqual(['ios']);
      expect(capability.windows).toEqual(['main']);
      expect([...granted].sort()).toEqual(IOS_PERMISSIONS);
      // Aucune permission autre (pas de `core:`), jamais le chemin qui perd les erreurs ni la lecture des notifications livrées.
      expect([...grantedActions].sort()).toEqual(IOS_ACTION_PERMISSIONS);
      expect(ids).toHaveLength(IOS_PERMISSIONS.length + IOS_ACTION_PERMISSIONS.length);
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
    expect(workflow).toContain('cargo tree --target aarch64-apple-ios -i tauri-plugin-notification-actions');
    expect(workflow).toContain('cargo tree --target x86_64-pc-windows-msvc -i tauri-plugin-notification-actions');
  });
});
