// Tests de la mise à jour iPhone par SideStore (I-06, ADR 0007 avenant I-06) : source à deux versions, contrôle de la source, notes de
// version communes PC / iPhone, identifiant immuable, workflow, guide (étape 7) et non-régression. Aucun fichier écrit hors du dépôt :
// fonctions pures, et fixtures versionnées pour les lignes de commande.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrations } from '../../src/db/migrations';
import { SYNC_FORMAT_MAJOR } from '../../src/domain/sync/format';
import { tUpdateRestore } from '../../src/i18n/appUpdateRestoreText';
// @ts-expect-error script .mjs sans déclaration de types
import { buildSource, ipaUrlFor, loadTemplate } from './make-source-json.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { BUNDLE_ID, checkSource, compareBuilds } from './check-source.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { parsePlist } from './plist.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { extractReleaseNotes, fallbackNotes } from '../release/release-notes.mjs';

type Version = { version: string; buildVersion?: string; date: string; localizedDescription: string; downloadURL: string; size: number; sha256?: string; minOSVersion: string };
type App = Record<string, unknown> & { bundleIdentifier: string; iconURL: string; versions: Version[] };
type Source = Record<string, unknown> & { apps: App[] };
type Check = { errors: string[]; warnings: string[] };

const here = resolve(__dirname);
const root = resolve(here, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const runNode = (script: string, args: string[]) => spawnSync(process.execPath, [join(root, script), ...args], { encoding: 'utf8' });
const sha = (c: string): string => c.repeat(64);

const info = (version: string, build = version, extra: Record<string, string> = {}) => ({ CFBundleIdentifier: 'fr.circletasks.planner', CFBundleShortVersionString: version, CFBundleVersion: build, MinimumOSVersion: '18.0', ...extra });

function publish(existing: Source | null, version: string, options: { build?: string; notes?: string; size?: number; sha?: string; date?: string } = {}): Source {
  return buildSource({
    template: loadTemplate(),
    existing,
    info: info(version, options.build ?? version),
    version,
    downloadURL: ipaUrlFor(version),
    size: options.size ?? 6_900_000,
    sha256: options.sha ?? sha('a'),
    notes: options.notes ?? `Notes ${version}`,
    date: options.date ?? '2026-10-09T08:00:00.000Z',
    minOSVersion: '18.0',
  }) as Source;
}

describe('critère 1 : source avec deux versions', () => {
  const n = publish(null, '0.2.3', { sha: sha('b'), size: 6_998_773, date: '2026-10-09T04:11:39.487Z', notes: 'Notes N' });
  const n1 = publish(n, '0.3.0', { sha: sha('c'), size: 7_100_000, date: '2026-10-20T08:00:00.000Z', notes: 'Notes N+1' });

  it('N+1 en premier, champs hérités de N+1, N intacte, même identifiant, iconURL présent', () => {
    const app = n1.apps[0] as App;
    expect(app.versions.map((v) => v.version)).toEqual(['0.3.0', '0.2.3']);
    expect(app.versions[1]).toEqual((n.apps[0] as App).versions[0]);
    expect(app['version']).toBe('0.3.0');
    expect(app['versionDate']).toBe('2026-10-20T08:00:00.000Z');
    expect(app['downloadURL']).toBe(ipaUrlFor('0.3.0'));
    expect(app['size']).toBe(7_100_000);
    expect(app.bundleIdentifier).toBe('fr.circletasks.planner');
    expect(app.iconURL).toBeTruthy();
    expect((checkSource(n1, { published: '0.3.0' }) as Check).errors).toEqual([]);
  });

  it('republier N+1 remplace sa seule entrée ; un correctif de N publié après N+1 ne passe pas devant (et le contrôle le refuse)', () => {
    const again = publish(n1, '0.3.0', { notes: 'Notes N+1 corrigées', sha: sha('d') });
    expect((again.apps[0] as App).versions.map((v) => [v.version, v.localizedDescription])).toEqual([
      ['0.3.0', 'Notes N+1 corrigées'],
      ['0.2.3', 'Notes N'],
    ]);
    const fix = publish(n1, '0.2.4', { sha: sha('e') });
    expect((fix.apps[0] as App).versions.map((v) => v.version)).toEqual(['0.3.0', '0.2.4', '0.2.3']);
    expect((fix.apps[0] as App)['version']).toBe('0.3.0');
    expect((checkSource(fix, { published: '0.2.4' }) as Check).errors).toContain('version publiée 0.2.4 inférieure à la plus haute déjà présente (0.3.0) : aucune rétrogradation');
  });
});

describe('critère 2 : contrôle de cohérence de la source (check-source.mjs)', () => {
  const n = publish(null, '0.2.3');
  const valid = publish(n, '0.3.0', { sha: sha('c') });
  const mutate = (fn: (app: App) => void): Source => {
    const copy = JSON.parse(JSON.stringify(valid)) as Source;
    fn(copy.apps[0] as App);
    return copy;
  };
  const errors = (source: Source, published = '0.3.0'): string[] => (checkSource(source, { published }) as Check).errors;

  it('source valide : aucun écart', () => {
    expect(checkSource(valid, { published: '0.3.0' })).toEqual({ errors: [], warnings: [] });
  });

  it('CFBundleVersion de N+1 inférieur ou égal à celui de N : refusé (D6)', () => {
    expect(errors(publish(n, '0.3.0', { build: '0.2.3' })).some((e) => e.includes('buildVersion 0.2.3 identique'))).toBe(true);
    expect(errors(publish(n, '0.3.0', { build: '0.2.1' })).some((e) => e.includes('buildVersion non croissant'))).toBe(true);
    expect(compareBuilds('0.3.0', '0.2.10')).toBeGreaterThan(0);
    expect(compareBuilds('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareBuilds('x', '1')).toBeNull();
  });

  it('iOS minimum relevé sans note, URL, sha256, taille, identifiant, champs hérités : refusés', () => {
    expect(errors(mutate((app) => ((app.versions[0] as Version).minOSVersion = '19.0'))).some((e) => e.includes('iOS minimum 19.0'))).toBe(true);
    expect(errors(mutate((app) => Object.assign(app.versions[0] as Version, { minOSVersion: '19.0', localizedDescription: 'Exige iOS 19.' })))).toEqual([]);
    expect(errors(mutate((app) => ((app.versions[0] as Version).downloadURL = 'https://example.com/x.ipa'))).some((e) => e.includes('downloadURL'))).toBe(true);
    expect(errors(mutate((app) => delete (app.versions[0] as Version).sha256)).some((e) => e.includes('sha256'))).toBe(true);
    expect(errors(mutate((app) => ((app.versions[0] as Version).size = 0))).some((e) => e.includes('size'))).toBe(true);
    expect(errors(mutate((app) => (app.bundleIdentifier = 'fr.circletasks.autre'))).some((e) => e.includes('la mise à jour perdrait les données'))).toBe(true);
    expect(errors(mutate((app) => (app['version'] = '0.2.3'))).some((e) => e.includes("champ d'app hérité version"))).toBe(true);
    expect(errors(mutate((app) => (app.iconURL = '')))).toContain('iconURL absent (obligatoire pour SideStore)');
  });

  it('notes égales au repli : avertissement, pas un échec', () => {
    const fallback = publish(n, '0.3.0', { notes: '' });
    expect((fallback.apps[0] as App).versions[0]?.localizedDescription).toBe(fallbackNotes('0.3.0'));
    expect(checkSource(fallback, { published: '0.3.0' })).toEqual({ errors: [], warnings: ['notes de 0.3.0 égales au repli : aucune section dans CHANGELOG.md'] });
  });

  it('version publiée avant I-01 (ni sha256 ni buildVersion) : laissée intacte, avertissement seulement', () => {
    const legacy = mutate((app) => {
      const old = app.versions[1] as Version;
      delete old.sha256;
      delete old.buildVersion;
    });
    const result = checkSource(legacy, { published: '0.3.0' }) as Check;
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(2);
  });

  it('en ligne de commande : « source valide » (code 0) ou ::error:: (code 1)', () => {
    const ok = runNode('scripts/ios/check-source.mjs', ['tests/fixtures/release/source.i06.json', '--published', '0.3.0']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('source valide');
    const ko = runNode('scripts/ios/check-source.mjs', ['tests/fixtures/release/source.i06.json', '--published', '0.2.4']);
    expect(ko.status).toBe(1);
    expect(ko.stdout).toContain('::error::check-source : version publiée 0.2.4 absente de la source');
  });
});

describe('critère 3 : notes de version (script commun PC et iPhone)', () => {
  const changelog = read('tests/fixtures/release/CHANGELOG.i06.md');

  it('« ## [0.3.0] - date » : exactement les 3 lignes ; « ## 0.2.3 » : sa ligne, jamais la section 0.2.30 ; absente : null', () => {
    expect(extractReleaseNotes(changelog, '0.3.0')).toBe(
      "- Version de l'app visible dans « À propos » sur l'iPhone.\n- Rappels replanifiés au premier lancement d'une nouvelle version.\n- Écran d'échec : restauration de la sauvegarde d'avant la mise à jour.",
    );
    expect(extractReleaseNotes(changelog, '0.2.3')).toBe("- Association : chaque état propose l'action utile.");
    expect(extractReleaseNotes(changelog, '0.9.9')).toBeNull();
    expect(extractReleaseNotes(changelog.replace(/\n/g, '\r\n'), '0.2.3')).toBe("- Association : chaque état propose l'action utile.");
  });

  it('en ligne de commande : notes sur stdout ; section absente : code 2 et message', () => {
    const ok = runNode('scripts/release/release-notes.mjs', ['0.3.0', 'tests/fixtures/release/CHANGELOG.i06.md']);
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim().split('\n')).toHaveLength(3);
    const ko = runNode('scripts/release/release-notes.mjs', ['0.9.9', 'tests/fixtures/release/CHANGELOG.i06.md']);
    expect(ko.status).toBe(2);
    expect(ko.stdout).toBe('');
    expect(ko.stderr).toContain('Aucune section « ## 0.9.9 »');
  });

  it('les deux workflows utilisent le même script (l’awk de build-windows.yml est remplacé) ; un tag sans section échoue', () => {
    const windows = read('.github/workflows/build-windows.yml');
    const ios = read('.github/workflows/build-ios.yml');
    expect(windows).not.toMatch(/\bawk\b/);
    expect(windows).toContain('node scripts/release/release-notes.mjs "${VERSION}"');
    expect(ios).toContain('node scripts/release/release-notes.mjs "$VERSION"');
    expect(ios).not.toContain('NOTES="CircleTasks ${VERSION}"\n          # Le jeton');
    for (const text of [windows, ios]) expect(text).toContain('CHANGELOG.md : publication refusée');
  });

  it('CHANGELOG.md du dépôt : la version courante de tauri.conf.json a sa section', () => {
    const version = (JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }).version;
    expect(extractReleaseNotes(read('CHANGELOG.md'), version)).not.toBeNull();
  });
});

describe('critère 4 : identifiant immuable entre N et N+1', () => {
  it('tauri.conf.json, build-ios.yml, modèle de source, Trousseau, dossier de synchro : identiques (sinon la mise à jour perdrait les données)', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { identifier: string };
    const vault = read('src-tauri/src/vault.rs');
    const folder = read('src-tauri/src/sync/folder.rs');
    const service = read('src-tauri/src/sync/service.rs');
    const values = {
      tauriConf: conf.identifier,
      buildIos: /\[ "\$ID" = "([^"]+)" \]/.exec(read('.github/workflows/build-ios.yml'))?.[1],
      template: (loadTemplate() as Source).apps[0]?.bundleIdentifier,
      checkSource: BUNDLE_ID,
      vault: /pub const VAULT_SERVICE: &str = "([^"]+)";/.exec(vault)?.[1],
    };
    for (const [where, value] of Object.entries(values)) expect(value, `${where} : la mise à jour perdrait les données`).toBe('fr.circletasks.planner');
    // Compte de la clé au Trousseau et fichiers du signet (dossier de configuration) : inchangés, sinon la clé et le dossier sont perdus.
    expect(service, 'clé du Trousseau : la mise à jour perdrait les données').toContain('pub const SYNC_KEY_ACCOUNT: &str = "circletasks.sync.key.v1";');
    expect(folder, 'signet du dossier : la mise à jour perdrait les données').toContain('pub const CONFIG_SUBDIR: &str = "sync";');
    expect(folder, 'signet du dossier : la mise à jour perdrait les données').toContain('pub const FOLDER_FILE: &str = "folder.json";');
  });
});

describe('critère 5 : build-ios.yml simule la source sur une branche, contrôle avant la publication', () => {
  const workflow = read('.github/workflows/build-ios.yml');
  const ios = workflow.slice(0, workflow.indexOf('\n  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));

  it('simulation : source publiée lue à l’URL publique sans secret, source construite avec l’IPA du build, contrôle et résumé', () => {
    expect(ios).toContain('- name: Source SideStore simulée');
    expect(ios).toContain('curl -fsSL "https://raw.githubusercontent.com/doncivo/circletasks-releases/main/source.json"');
    expect(ios).toContain('node scripts/ios/check-source.mjs sim/source.json --published "$VERSION"');
    for (const line of ['version ${VERSION}, build ${BUILD}', 'Notes (première ligne)', '- source valide']) expect(ios).toContain(line);
    const simulation = ios.slice(ios.indexOf('- name: Source SideStore simulée'));
    expect(simulation.slice(0, simulation.indexOf('\n      - '))).not.toMatch(/secrets\.|GH_TOKEN|gh release|git push/);
  });

  it('notes calculées avant la compilation : tag sans section = échec, branche = avertissement et repli', () => {
    const notes = ios.indexOf('- name: Notes de version');
    expect(notes).toBeGreaterThan(-1);
    expect(notes).toBeLessThan(ios.indexOf("- name: Compiler l'IPA sans signature"));
    expect(ios).toContain('refs/tags/ios-v*) echo "::error::Aucune section');
    expect(ios).toContain('::warning::Aucune section');
  });

  it('publication : contrôle de la source AVANT la release et le push ; toujours sur tag ios-v* seulement', () => {
    const check = publishJob.indexOf('node scripts/ios/check-source.mjs source.new.json --published "$VERSION"');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(publishJob.indexOf('gh release create'));
    expect(check).toBeLessThan(publishJob.indexOf('git push'));
    expect(publishJob).toContain("if: startsWith(github.ref, 'refs/tags/ios-v')");
  });
});

describe('critère 18 : guide, étape 7', () => {
  const guide = read('docs/install-iphone.md');
  const step = guide.slice(guide.indexOf('## 7. '), guide.indexOf('## 8. '));
  const plain = (text: string): string => text.replace(/[’']/g, "'");

  it('notes, mise à jour en un geste, conservé, vérification par « À propos », écran d’échec, pas de retour arrière, PC et iPhone', () => {
    for (const needle of ['Nouveautés', 'Mettre à jour', 'VPN', 'Wi-Fi', 'Conservé', 'clé de synchronisation', 'dossier iCloud Drive', 'rappels', '30 secondes', '« À propos »', 'Copier le détail', 'Pas de retour arrière', 'Mettez à jour l\'app', 'Rechercher une mise à jour']) {
      expect(plain(step), needle).toContain(plain(needle));
    }
    expect(plain(step)).toContain(plain(tUpdateRestore('restore')));
    expect(plain(step)).toContain('plus ancienne que vos données');
    expect(step).toMatch(/Ne supprime/);
  });

  it('lecture de l’étape en 2 minutes au plus (≈ 220 mots par minute)', () => {
    expect(step.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(440);
  });
});

describe('critère 19 : non-régression (aucune clé Info.plist, plugin, capability, migration ni format nouveaux)', () => {
  it('Info.ios.plist : mêmes clés qu’avant I-06', () => {
    const keys = Object.keys(parsePlist(read('src-tauri/Info.ios.plist')) as Record<string, unknown>).sort();
    expect(keys).toEqual(['ITSAppUsesNonExemptEncryption', 'NSCameraUsageDescription', 'NSFaceIDUsageDescription', 'NSMicrophoneUsageDescription', 'NSRemindersFullAccessUsageDescription', 'NSSpeechRecognitionUsageDescription', 'UIRequiresFullScreen', 'UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']);
  });

  it('plugins et capabilities : listes d’avant I-06', () => {
    expect(readdirSync(join(root, 'src-tauri', 'plugins')).filter((d) => d !== 'README.md').sort()).toEqual(['files', 'folder-bookmark', 'haptics', 'notification-actions', 'privacy-shield', 'reminders', 'speech', 'vision', 'web-auth']);
    expect(readdirSync(join(root, 'src-tauri', 'capabilities')).sort()).toEqual([
      'backups-ios.json', 'backups.json', 'biometric-ios.json', 'calendars.json', 'capture-ios.json', 'capture.json', 'default.json', 'desktop.json', 'export-ios.json', 'export.json', 'focus-launcher.json', 'focus.json', 'haptics-ios.json', 'import.json', 'logs-ios.json', 'logs.json', 'notifications-ios.json', 'ocr.json', 'privacy-shield-ios.json', 'reminders-ios.json', 'signing-ios.json', 'sync-ios.json', 'sync-pairing.json', 'sync.json',
    ]);
    // `getVersion` est couvert par core:default (aucune permission ajoutée).
    expect(read('src-tauri/capabilities/default.json')).toContain('"core:default"');
  });

  it('aucune migration de base ajoutée (les migrations des tests sont des fixtures), SYNC_FORMAT_MAJOR inchangé', () => {
    expect(migrations.at(-1)?.version).toBe(18);
    expect(SYNC_FORMAT_MAJOR).toBe(1);
  });
});

describe('revue M2 : rétrogradation = avertissement sur une branche, échec sur un tag ios-v*', () => {
  const n1 = publish(publish(null, '0.2.3'), '0.3.0', { sha: sha('c') });
  const fix = publish(n1, '0.2.4', { sha: sha('e') });
  const message = 'version publiée 0.2.4 inférieure à la plus haute déjà présente (0.3.0) : aucune rétrogradation';

  it('checkSource : downgrade « warn » met l’écart en avertissement, « error » (défaut) en échec', () => {
    expect((checkSource(fix, { published: '0.2.4', downgrade: 'warn' }) as Check)).toEqual({ errors: [], warnings: [message] });
    expect((checkSource(fix, { published: '0.2.4' }) as Check).errors).toContain(message);
  });

  it('build-ios.yml : la simulation passe --downgrade warn hors tag ios-v*, error sur un tag ; la publication garde l’échec', () => {
    const workflow = read('.github/workflows/build-ios.yml');
    const simulation = workflow.slice(workflow.indexOf('- name: Source SideStore simulée'), workflow.indexOf('\n  publish:'));
    expect(simulation).toContain('DOWNGRADE=error');
    expect(simulation).toContain('case "${GITHUB_REF}" in refs/tags/ios-v*) ;; *) DOWNGRADE=warn;; esac');
    expect(simulation).toContain('--downgrade "$DOWNGRADE"');
    const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
    expect(publishJob).toContain('node scripts/ios/check-source.mjs source.new.json --published "$VERSION"\n');
  });

  it('en ligne de commande : --downgrade warn rend 0 avec ::warning:: ; valeur inconnue refusée', () => {
    const warn = runNode('scripts/ios/check-source.mjs', ['tests/fixtures/release/source.i06.json', '--published', '0.3.0', '--downgrade', 'warn']);
    expect(warn.status).toBe(0);
    expect(runNode('scripts/ios/check-source.mjs', ['tests/fixtures/release/source.i06.json', '--published', '0.3.0', '--downgrade', 'peut-être']).status).toBe(1);
  });
});
