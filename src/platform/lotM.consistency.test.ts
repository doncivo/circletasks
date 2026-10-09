import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Lot M (ADR 0013 §5) : I-03 critère 3, A-07 critère 15. Un seul fichier TypeScript nomme chaque plugin ; les résolveurs ne chargent
 * l'adaptateur réel que pour (tauri, ios) ; Cargo.toml, lib.rs et capabilities réservent les plugins à l'iPhone ; contrôle statique du
 * Swift des deux plugins locaux (aucun Mac : seule la CI compile le Swift).
 */
const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string): string => readFileSync(join(rootDir, path), 'utf8');

function sourcesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourcesOf(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const PLUGINS = [
  { marker: 'plugin:biometric|', file: join('src', 'platform', 'biometric', 'tauriBiometric.ts'), resolver: 'src/platform/biometric/index.ts', adapter: './tauriBiometric' },
  { marker: 'plugin:haptics|', file: join('src', 'platform', 'haptics', 'tauriHaptics.ts'), resolver: 'src/platform/haptics/index.ts', adapter: './tauriHaptics' },
  { marker: 'plugin:privacy-shield|', file: join('src', 'platform', 'privacyShield', 'tauriPrivacyShield.ts'), resolver: 'src/platform/privacyShield/index.ts', adapter: './tauriPrivacyShield' },
] as const;

describe('lot M : plugins iOS nommés par un seul adaptateur (I-03 critère 3, A-07 critère 15)', () => {
  const files = sourcesOf(join(rootDir, 'src'));

  it.each(PLUGINS)('seul $file nomme $marker', ({ marker, file }) => {
    expect(files.map((path) => relative(rootDir, path))).toContain(file);
    for (const path of files) {
      const text = readFileSync(path, 'utf8');
      if (relative(rootDir, path) === file) expect(text).toContain(marker);
      else expect(text, relative(rootDir, path)).not.toContain(marker);
    }
    // Aucune dépendance npm de plugin : invoke de @tauri-apps/api seulement.
    expect(read('package.json')).not.toMatch(/plugin-(biometric|haptics)/);
  });

  it.each(PLUGINS)('$resolver : adaptateur réel chargé après la garde (tauri, ios) seulement', ({ resolver, adapter }) => {
    const lines = read(resolver).split(/\r?\n/);
    const guard = lines.findIndex((line) => /runtime\s*===\s*'tauri'\s*&&\s*os\s*===\s*'ios'/.test(line));
    expect(guard).toBeGreaterThan(-1);
    const imports = lines.flatMap((line, index) => (line.includes(`import('${adapter}')`) ? [index] : []));
    expect(imports.length).toBeGreaterThan(0);
    for (const index of imports) expect(index).toBeGreaterThan(guard);
    expect(lines.some((line) => line.includes(`from '${adapter}'`))).toBe(false);
    expect(lines.join('\n')).not.toMatch(/os\s*===\s*'windows'/);
  });
});

describe('lot M : Rust et capabilities (iOS seulement)', () => {
  const sectionOf = (krate: string): string[] => {
    let section = '';
    const found: string[] = [];
    for (const line of read('src-tauri/Cargo.toml').split(/\r?\n/)) {
      const header = /^\s*\[(.+)\]\s*$/.exec(line);
      if (header !== null) section = header[1] ?? '';
      if (new RegExp(`^\\s*${krate}\\s*=`).test(line)) found.push(`${section} | ${line.trim()}`);
    }
    return found;
  };

  it('Cargo.toml : biometric =2.4.1, haptics et privacy-shield locaux, sous cfg(target_os = "ios") seulement', () => {
    const ios = 'target.\'cfg(target_os = "ios")\'.dependencies';
    expect(sectionOf('tauri-plugin-biometric')).toEqual([`${ios} | tauri-plugin-biometric = "=2.4.1"`]);
    expect(sectionOf('tauri-plugin-ct-haptics')).toEqual([`${ios} | tauri-plugin-ct-haptics = { path = "plugins/haptics" }`]);
    expect(sectionOf('tauri-plugin-privacy-shield')).toEqual([`${ios} | tauri-plugin-privacy-shield = { path = "plugins/privacy-shield" }`]);
    expect(sectionOf('tauri-plugin-haptics')).toEqual([]);
  });

  it('lib.rs : chaque plugin enregistré une fois, sous cfg(target_os = "ios")', () => {
    const lines = read('src-tauri/src/lib.rs').split(/\r?\n/);
    for (const krate of ['tauri_plugin_biometric', 'tauri_plugin_ct_haptics', 'tauri_plugin_privacy_shield']) {
      const uses = lines.flatMap((line, index) => (line.includes(krate) ? [index] : []));
      expect(uses, krate).toHaveLength(1);
      expect(lines[(uses[0] ?? 0) - 1]?.trim(), krate).toBe('#[cfg(target_os = "ios")]');
    }
  });

  it('capabilities : listes exactes, iOS et main seulement ; aucune autre capability n’accorde ces préfixes', () => {
    const expected: Record<string, readonly string[]> = {
      'biometric-ios.json': ['biometric:allow-authenticate', 'biometric:allow-status'],
      'haptics-ios.json': ['haptics:allow-impact-feedback', 'haptics:allow-notification-feedback', 'haptics:allow-selection-feedback'],
      'privacy-shield-ios.json': ['privacy-shield:allow-set-enabled'],
    };
    const names = readdirSync(join(rootDir, 'src-tauri', 'capabilities')).filter((name) => name.endsWith('.json'));
    for (const name of names) {
      const capability = JSON.parse(read(`src-tauri/capabilities/${name}`)) as { platforms?: string[]; windows: string[]; permissions: (string | { identifier: string })[] };
      const ids = capability.permissions.map((permission) => (typeof permission === 'string' ? permission : permission.identifier));
      const own = expected[name];
      if (own === undefined) {
        expect(ids.filter((id) => /^(biometric|haptics|privacy-shield):/.test(id)), name).toEqual([]);
        continue;
      }
      expect(capability.platforms, name).toEqual(['iOS']);
      expect(capability.windows, name).toEqual(['main']);
      expect([...ids].sort(), name).toEqual(own);
    }
    for (const name of Object.keys(expected)) expect(names).toContain(name);
  });

  it('build-ios.yml vérifie par cargo tree les trois crates (iOS oui, Windows non)', () => {
    const workflow = read('.github/workflows/build-ios.yml');
    expect(workflow).toContain('for CRATE in tauri-plugin-biometric tauri-plugin-ct-haptics tauri-plugin-privacy-shield tauri-plugin-vision tauri-plugin-speech; do');
    expect(workflow).toContain('cargo tree --target aarch64-apple-ios -i "$CRATE"');
    expect(workflow).toContain('cargo tree --target x86_64-pc-windows-msvc -i "$CRATE"');
  });
});

describe('lot M : contrôle statique du Swift (compilé par la CI seulement)', () => {
  const haptics = read('src-tauri/plugins/haptics/ios/Sources/HapticsPlugin.swift');
  const shield = read('src-tauri/plugins/privacy-shield/ios/Sources/PrivacyShieldPlugin.swift');

  it('haptics : une méthode @objc par commande de build.rs (lowerCamelCase), point d’entrée lié au binding Rust', () => {
    for (const method of ['impactFeedback', 'notificationFeedback', 'selectionFeedback']) {
      expect(haptics).toContain(`@objc public func ${method}(_ invoke: Invoke)`);
    }
    expect(haptics).toContain('@_cdecl("init_plugin_ct_haptics")');
    expect(read('src-tauri/plugins/haptics/src/lib.rs')).toContain('ios_plugin_binding!(init_plugin_ct_haptics)');
    expect(read('src-tauri/plugins/haptics/ios/Package.swift')).toContain('name: "tauri-plugin-ct-haptics"');
  });

  it('haptics : chaque générateur UIKit déclenché sur le fil principal ; ni vibrate ni Core Haptics ; valeurs exactes du port', () => {
    const code = haptics
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code.match(/Generator\((style: style)?\)/g)).toHaveLength(3);
    expect(code.match(/DispatchQueue\.main\.async \{/g)).toHaveLength(3);
    // Dans chaque méthode, le générateur n'est créé qu'à l'intérieur du bloc DispatchQueue.main.async.
    for (const block of code.split('@objc public func').slice(1)) {
      const main = block.indexOf('DispatchQueue.main.async {');
      expect(main).toBeGreaterThan(-1);
      expect(block.indexOf('Generator(')).toBeGreaterThan(main);
    }
    expect(code).not.toMatch(/CHHapticEngine|CoreHaptics|vibrate/);
    for (const value of ['"light"', '"medium"', '"heavy"', '"success"', '"warning"', '"error"']) expect(haptics).toContain(`case ${value}:`);
    expect(haptics).toContain('invoke.reject("invalid-argument", code: "invalid-argument")');
  });

  it('privacy-shield : setEnabled, cache sur willResignActive (et arrière-plan), retiré à didBecomeActive, état sur le fil principal', () => {
    expect(shield).toContain('@objc public func setEnabled(_ invoke: Invoke)');
    expect(shield).toContain('@_cdecl("init_plugin_privacy_shield")');
    expect(read('src-tauri/plugins/privacy-shield/src/lib.rs')).toContain('ios_plugin_binding!(init_plugin_privacy_shield)');
    expect(read('src-tauri/plugins/privacy-shield/ios/Package.swift')).toContain('name: "tauri-plugin-privacy-shield"');
    expect(shield).toMatch(/willResignActiveNotification[\s\S]*didEnterBackgroundNotification[\s\S]*didBecomeActiveNotification/);
    expect(shield).toMatch(/appWillResignActive\(\) \{\s*onMain \{ self\.showShield\(\) \}/);
    expect(shield).toMatch(/appDidBecomeActive\(\) \{\s*onMain \{ self\.hideShield\(\) \}/);
    expect(shield).toMatch(/guard enabled, shield == nil/);
    expect(shield).toMatch(/DispatchQueue\.main\.async \{\s*self\.enabled = args\.enabled/);
    expect(shield).toContain('view.isOpaque = true');
  });

  it('aucune chaîne d’interface dans le Swift des plugins locaux (textes dans src/i18n)', () => {
    for (const source of [haptics, shield]) {
      const strings = [...source.matchAll(/"([^"\\]*)"/g)].map((match) => match[1] ?? '');
      for (const value of strings) expect(value).toMatch(/^[a-z-]*$|^init_plugin_[a-z_]+$/);
    }
  });
});
