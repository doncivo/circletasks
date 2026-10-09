import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMINDERS_ERROR_CODES } from './types';

/**
 * K-05 critère 5 (ADR 0008 §10.4) : le contrat du plugin Swift `reminders` (fixture) est le même côté Swift, côté TypeScript, dans la
 * capability iOS, dans Cargo et dans le contrat Info.plist ; aucune chaîne française en Swift ; le plugin n'est nommé que par `tauriReminders.ts`.
 */
const root = join(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

interface Contract {
  readonly plugin: string;
  readonly commands: readonly { readonly name: string; readonly swiftMethod: string; readonly input: readonly string[]; readonly output: readonly string[] }[];
  readonly baseCommands: readonly string[];
  readonly shapes: Readonly<Record<string, readonly string[]>>;
  readonly access: readonly string[];
  readonly errors: readonly string[];
  readonly events: readonly string[];
}

const contract = JSON.parse(read('tests/fixtures/calendars/reminders-contract.json')) as Contract;
const swiftRaw = read('src-tauri/plugins/reminders/ios/Sources/RemindersPlugin.swift');

/** Swift sans commentaires `//` (hors chaîne). */
const swift = swiftRaw
  .split('\n')
  .map((line) => {
    let inString = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"' && line[i - 1] !== '\\') inString = !inString;
      if (!inString && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  })
  .join('\n');

const structFields = (name: string): string[] => {
  const start = swift.indexOf(`struct ${name}: Decodable {`);
  expect(start, name).toBeGreaterThan(-1);
  const body = swift.slice(start, swift.indexOf('}', start));
  return body
    .split('\n')
    .map((line) => /^\s*let (\w+):/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined);
};

describe('contrat du plugin reminders : Swift', () => {
  it('chaque commande existe en Swift avec le nom de méthode du contrat, et rien d’autre n’est exposé', () => {
    const methods = [...swift.matchAll(/@objc public func (\w+)\(_ invoke: Invoke\)/g)].map((match) => match[1]);
    expect(methods.sort()).toEqual(contract.commands.map((command) => command.swiftMethod).sort());
    for (const command of contract.commands) {
      // Le nom côté WebView est le snake_case de la méthode lowerCamelCase (transmission des commandes de plugin sur mobile).
      expect(command.swiftMethod.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)).toBe(command.name);
    }
  });

  it('champs d’entrée : les structures Decodable portent exactement les champs du contrat', () => {
    const arguments_ = { fetch: 'FetchArgs', upsert: 'UpsertArgs', set_completed: 'CompletedArgs', delete: 'DeleteArgs' } as const;
    for (const command of contract.commands) {
      const struct = (arguments_ as Record<string, string>)[command.name];
      if (struct === undefined) {
        expect(command.input, command.name).toEqual([]);
        continue;
      }
      expect(structFields(struct).sort(), command.name).toEqual([...command.input].sort());
    }
    expect(structFields('IdRef').sort()).toEqual([...(contract.shapes['idRef'] ?? [])].sort());
    expect(structFields('DueArgs').sort()).toEqual([...(contract.shapes['due'] ?? [])].sort());
  });

  it('clés des réponses : l’élément, la liste, la liste lue et chaque réponse portent les clés du contrat', () => {
    const item = swift.slice(swift.indexOf('private func itemJSON'), swift.indexOf('/// Échéance reçue'));
    const itemKeys = [...item.matchAll(/^\s+"(\w+)":/gm)].map((match) => match[1]);
    expect(itemKeys.sort()).toEqual([...(contract.shapes['item'] ?? [])].sort());
    const due = swift.slice(swift.indexOf('private func dueJSON'), swift.indexOf('private func itemJSON'));
    expect([...due.matchAll(/"(date|time)": /g)].map((match) => match[1]).sort()).toEqual([...(contract.shapes['due'] ?? [])].sort());
    expect(swift).toContain('"id": calendar.calendarIdentifier, "name": calendar.title, "writable": calendar.allowsContentModifications');
    expect(swift).toContain('lists.append(["listId": listId, "total": ordered.count, "items":');
    expect(swift).toContain('["lists": lists, "byId": byId, "missing": missing, "missingLists": missingLists]');
    expect(swift).toContain('["access": accessState()]');
    expect(swift).toContain('["access": self.accessState()]');
    expect(swift).toContain('["lists": lists]');
    expect(swift).toContain('["item": itemJSON(reread)]');
  });

  it('codes d’erreur : exactement ceux du contrat et du type TypeScript ; tout rejet passe par `reject`', () => {
    const start = swift.indexOf('private enum Code: String {');
    const body = swift.slice(start, swift.indexOf('\n}', start));
    const codes = [...body.matchAll(/= "([a-z-]+)"/g)].map((match) => match[1]);
    expect(codes.sort()).toEqual([...contract.errors].sort());
    expect([...REMINDERS_ERROR_CODES].sort()).toEqual([...contract.errors].sort());
    expect(swift.match(/invoke\.reject\(/g)).toHaveLength(1);
    expect(swift).toContain('invoke.reject(code.rawValue, code: code.rawValue)');
  });

  it('accès : les quatre états du contrat, l’écriture seule vaut « denied »', () => {
    for (const state of contract.access) expect(swift).toContain(`"${state}"`);
    expect(swift).toContain('default:\n        return "denied"');
  });

  it('aucune chaîne française ni libellé en Swift ; aucun journal ; événement `changed` ; accès demandé seulement par `requestAccess`', () => {
    const literals = [...swift.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
    for (const literal of literals) expect([...literal].some((char) => char.charCodeAt(0) > 127), literal).toBe(false);
    for (const forbidden of ['print(', 'NSLog', 'os_log', 'Logger(', 'debugPrint', 'dump(']) expect(swift).not.toContain(forbidden);
    expect(swift).toContain('trigger("changed"');
    expect(contract.events).toEqual(['changed']);
    expect(swift.match(/requestFullAccessToReminders/g)).toHaveLength(1);
    expect(swift.slice(swift.indexOf('public override func load('), swift.indexOf('@objc private func storeChanged'))).not.toContain('requestFullAccess');
  });

  it('périmètre des données (K-05 D1) : ni notes, ni priorité, ni drapeau, ni sous-tâches, ni lieu', () => {
    for (const forbidden of ['.notes', 'priority', 'isFlagged', 'location', 'structuredLocation', 'url =', '.url']) expect(swift, forbidden).not.toContain(forbidden);
  });

  it('un rappel récurrent n’est jamais modifié ni supprimé, une liste en lecture seule non plus', () => {
    for (const method of ['upsert', 'setCompleted', 'delete']) {
      const start = swift.indexOf(`@objc public func ${method}(`);
      const body = swift.slice(start, swift.indexOf('@objc public func', start + 10) === -1 ? undefined : swift.indexOf('@objc public func', start + 10));
      expect(body, method).toContain('hasRecurrenceRules');
      expect(body, method).toContain('recurringRefused');
      expect(body, method).toContain('allowsContentModifications');
    }
    expect(swift).toContain('Swift.abs(at.timeIntervalSince(old)) < 1');
  });

  it('Package.swift : plateforme connue de swift-tools-version 5.3 (le projet exige iOS 18 en aval)', () => {
    const pkg = read('src-tauri/plugins/reminders/ios/Package.swift');
    expect(pkg.startsWith('// swift-tools-version:5.3')).toBe(true);
    expect(pkg).toContain('.iOS(.v14)');
    for (const unknown of ['.v15', '.v16', '.v17', '.v18']) expect(pkg).not.toContain(unknown);
    expect(swift).toContain('#available(iOS 17.0, *)');
  });
});

describe('contrat du plugin reminders : TypeScript, capability, Cargo, Info.plist', () => {
  it('seul tauriReminders.ts nomme `plugin:reminders` ; il appelle exactement les commandes du contrat', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx') && read(relative(root, path)).includes('plugin:reminders')) offenders.push(relative(root, path).replaceAll('\\', '/'));
      }
    };
    walk(join(root, 'src'));
    expect(offenders).toEqual(['src/platform/reminders/tauriReminders.ts']);
    const adapter = read('src/platform/reminders/tauriReminders.ts');
    const called = [...adapter.matchAll(/run\('(\w+)'/g)].map((match) => match[1]);
    expect([...new Set(called)].sort()).toEqual(contract.commands.map((command) => command.name).sort());
    expect(adapter).toContain("addPluginListener(PLUGIN_NAME, event, handler)");
    expect(adapter).toContain("listen('changed'");
  });

  it('capability iOS à liste exacte (commandes du contrat et écoute), fenêtre principale, aucune autre capability n’accorde reminders:', () => {
    const capability = JSON.parse(read('src-tauri/capabilities/reminders-ios.json')) as { platforms: string[]; windows: string[]; permissions: string[] };
    expect(capability.platforms).toEqual(['iOS']);
    expect(capability.windows).toEqual(['main']);
    const expected = [...contract.commands.map((command) => command.name), ...contract.baseCommands].map((name) => `reminders:allow-${name.replaceAll('_', '-')}`);
    expect([...capability.permissions].sort()).toEqual(expected.sort());
    const dir = join(root, 'src-tauri/capabilities');
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'reminders-ios.json')) expect(read(`src-tauri/capabilities/${file}`), file).not.toContain('reminders:');
  });

  it('les commandes de build.rs sont celles du contrat et de l’écoute', () => {
    const build = read('src-tauri/plugins/reminders/build.rs');
    const commands = /COMMANDS: &\[&str\] = &\[([^\]]*)\]/.exec(build)?.[1]?.match(/"(\w+)"/g)?.map((text) => text.replaceAll('"', ''));
    expect(commands?.sort()).toEqual([...contract.commands.map((command) => command.name), ...contract.baseCommands].sort());
  });

  it('crate sous cfg(target_os = "ios") seulement, enregistré dans le bloc iOS de lib.rs', () => {
    const cargo = read('src-tauri/Cargo.toml');
    const ios = cargo.slice(cargo.indexOf("[target.'cfg(target_os = \"ios\")'.dependencies]"));
    expect(ios).toContain('tauri-plugin-reminders = { path = "plugins/reminders" }');
    expect(cargo.match(/tauri-plugin-reminders/g)).toHaveLength(1);
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toContain('#[cfg(target_os = "ios")]\n    let builder = builder.plugin(tauri_plugin_folder_bookmark::init())');
    expect(lib.match(/tauri_plugin_reminders/g)).toHaveLength(1);
    const desktopBlock = lib.slice(0, lib.indexOf('#[cfg(target_os = "ios")]'));
    expect(desktopBlock).not.toContain('reminders');
  });

  it('Info.plist : la clé d’accès complet est déclarée au contrat (K-05) avec un texte français, sans NSRemindersUsageDescription', () => {
    const plistContract = JSON.parse(read('scripts/ios/plist-contract.json')) as { plugins: Record<string, { story: string; usageDescriptions: string[] }> };
    expect(plistContract.plugins['reminders']).toEqual({ story: 'K-05', usageDescriptions: ['NSRemindersFullAccessUsageDescription'] });
    const plist = read('src-tauri/Info.ios.plist');
    const text = /<key>NSRemindersFullAccessUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? '';
    expect(text).toMatch(/Rappels/);
    expect(plist).not.toContain('<key>NSRemindersUsageDescription</key>');
  });
});
