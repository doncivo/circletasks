// Tests de la chaîne iPhone (I-01) : lecture du Info.plist, contrat des permissions, source SideStore,
// cohérence du guide d'installation avec le workflow et les scripts. Aucun secret, aucune commande iOS.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sans déclaration de types
import { parsePlist } from './plist.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { checkPlistContract, validateContract } from './check-plist-contract.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { buildSource, ipaUrlFor, loadTemplate, minOSVersionFromConf, RELEASES_REPO, SOURCE_URL } from './make-source-json.mjs';

type Json = Record<string, unknown>;
type Version = { version: string; buildVersion?: string; date: string; localizedDescription: string; downloadURL: string; size: number; sha256?: string; minOSVersion: string };
type App = Json & { name: string; bundleIdentifier: string; iconURL: string; versions: Version[]; appPermissions: { entitlements: string[]; privacy: Record<string, string> } };
type Source = Json & { name: string; apps: App[]; news: unknown[] };

const here = resolve(__dirname);
const root = resolve(here, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
let tmp = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ct-ios-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function plistXml(entries: Record<string, string | boolean | string[]>): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = Object.entries(entries)
    .map(([k, v]) => {
      const value =
        typeof v === 'boolean' ? (v ? '<true/>' : '<false/>') : Array.isArray(v) ? `<array>${v.map((s) => `<string>${esc(s)}</string>`).join('')}</array>` : `<string>${esc(v)}</string>`;
      return `\t<key>${esc(k)}</key>\n\t${value}`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function runNode(script: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeTmp(name: string, content: string | Buffer): string {
  const p = join(tmp, name);
  writeFileSync(p, content);
  return p;
}

describe('parsePlist', () => {
  it('lit les types plist, les entités, les commentaires et les valeurs vides', () => {
    const xml = `<?xml version="1.0"?><!-- c --><plist version="1.0"><dict>
      <key>S</key><string>Caméra &amp; micro &lt;ok&gt; &#233;&#x41;</string>
      <key>E</key><string/>
      <key>T</key><true/><key>F</key><false/>
      <key>I</key><integer>-3</integer><key>R</key><real>1.5</real>
      <key>D</key><date>2026-10-07T00:00:00Z</date><key>B</key><data> AAEC
      </data>
      <key>A</key><array><string>a</string><dict/><array/></array>
    </dict></plist>`;
    expect(parsePlist(xml)).toEqual({ S: 'Caméra & micro <ok> éA', E: '', T: true, F: false, I: -3, R: 1.5, D: '2026-10-07T00:00:00Z', B: 'AAEC', A: ['a', {}, []] });
  });

  it('lit src-tauri/Info.ios.plist', () => {
    const p = parsePlist(read('src-tauri/Info.ios.plist')) as Json;
    expect(p['UISupportedInterfaceOrientations']).toEqual(['UIInterfaceOrientationPortrait']);
    expect(p['ITSAppUsesNonExemptEncryption']).toBe(false);
  });

  it('refuse un XML mal formé, une clé en double, un type inconnu', () => {
    expect(() => parsePlist('<plist><dict><key>a</key><string>x</dict></plist>')).toThrow();
    expect(() => parsePlist('<plist><dict><key>a</key><true/><key>a</key><true/></dict></plist>')).toThrow(/double/);
    expect(() => parsePlist('<plist><foo/></plist>')).toThrow(/inconnu/);
    expect(() => parsePlist('<plist><dict/></plist><x/>')).toThrow();
    expect(() => parsePlist('<plist><integer>abc</integer></plist>')).toThrow(/nombre/);
  });
});

describe('contrat des permissions Info.plist', () => {
  const contract = JSON.parse(read('scripts/ios/plist-contract.json')) as Json;
  const camera = {
    formatVersion: 1,
    plugins: {
      'barcode-scanner': { story: 'Y-IOS-02', usageDescriptions: ['NSCameraUsageDescription'] },
      background: { story: 'Y-IOS-01', keys: ['BGTaskSchedulerPermittedIdentifiers'], arrayIncludes: { UIBackgroundModes: ['fetch'] } },
    },
  };

  it('le contrat versionné est bien formé et src-tauri/Info.ios.plist le respecte', () => {
    expect(validateContract(contract)).toEqual([]);
    const { errors } = checkPlistContract(contract, parsePlist(read('src-tauri/Info.ios.plist')));
    expect(errors).toEqual([]);
  });

  it('accepte un Info.plist complet', () => {
    const plist = { NSCameraUsageDescription: 'Scanner le QR code du PC.', BGTaskSchedulerPermittedIdentifiers: [], UIBackgroundModes: ['fetch', 'processing'] };
    expect(checkPlistContract(camera, plist)).toEqual({ errors: [], warnings: [] });
  });

  it('échoue si une clé listée manque, si un tableau ne contient pas la valeur', () => {
    const { errors } = checkPlistContract(camera, { UIBackgroundModes: ['processing'] });
    expect(errors).toEqual([
      'NSCameraUsageDescription absente (plugin barcode-scanner, Y-IOS-02)',
      'BGTaskSchedulerPermittedIdentifiers absente (plugin background, Y-IOS-01)',
      'UIBackgroundModes ne contient pas « fetch » (plugin background, Y-IOS-01)',
    ]);
    expect(checkPlistContract(camera, { NSCameraUsageDescription: 'x', BGTaskSchedulerPermittedIdentifiers: [] }).errors).toEqual([
      'UIBackgroundModes absente ou n\'est pas un tableau (plugin background, Y-IOS-01)',
    ]);
  });

  it('ne prend pas une propriété héritée (constructor, toString) pour une clé présente', () => {
    const c = { formatVersion: 1, plugins: { p: { story: 'X-01', keys: ['constructor', 'toString'] } } };
    expect(checkPlistContract(c, {}).errors).toEqual(['constructor absente (plugin p, X-01)', 'toString absente (plugin p, X-01)']);
    expect(checkPlistContract(c, { constructor: 'x', toString: 'y' }).errors).toEqual([]);
  });

  it('échoue sur toute description d’usage vide, déclarée ou non ; avertit si elle n’est pas déclarée', () => {
    const plist = { NSCameraUsageDescription: '  ', NSMicrophoneUsageDescription: '', NSFaceIDUsageDescription: 'Déverrouiller CircleTasks.', BGTaskSchedulerPermittedIdentifiers: [], UIBackgroundModes: ['fetch'] };
    const { errors, warnings } = checkPlistContract(camera, plist);
    expect(errors).toEqual(['NSCameraUsageDescription : description d\'usage vide', 'NSMicrophoneUsageDescription : description d\'usage vide']);
    expect(warnings).toEqual(['NSFaceIDUsageDescription présente mais absente de plist-contract.json']);
    expect(checkPlistContract(contract, { NSCameraUsageDescription: true }).errors).toEqual(['NSCameraUsageDescription : description d\'usage vide']);
  });

  it('refuse un contrat mal écrit (champ inconnu, story absente, clé non NS…UsageDescription, version)', () => {
    expect(validateContract({ formatVersion: 1, plugins: { a: { story: 'X-01', usageDescription: ['NSCameraUsageDescription'] } } })).toEqual([
      'Contrat, plugin a : champ inconnu « usageDescription »',
    ]);
    expect(validateContract({ formatVersion: 1, plugins: { a: { usageDescriptions: ['Camera'] } } })).toEqual([
      'Contrat, plugin a : « story » obligatoire',
      'Contrat, plugin a : « Camera » n\'est pas une clé NS…UsageDescription',
    ]);
    expect(validateContract({ formatVersion: 2, plugins: [] })).toHaveLength(2);
    expect(validateContract({ formatVersion: 1, plugins: { a: { story: 'X', keys: 'k', arrayIncludes: { K: 'v' } } } })).toHaveLength(2);
    expect(validateContract(null)).toEqual(['Contrat : objet JSON attendu']);
    expect(checkPlistContract({ formatVersion: 1, plugins: {} }, [])).toEqual({ errors: ['Info.plist : dictionnaire racine attendu'], warnings: [] });
  });

  it('en ligne de commande : code 0 si respecté, 1 avec ::error:: sinon', () => {
    const c = writeTmp('contract.json', JSON.stringify(camera));
    const ok = writeTmp('ok.plist', plistXml({ NSCameraUsageDescription: 'Scanner le QR.', BGTaskSchedulerPermittedIdentifiers: [], UIBackgroundModes: ['fetch'] }));
    const ko = writeTmp('ko.plist', plistXml({ NSCameraUsageDescription: '' }));
    const r1 = runNode('check-plist-contract.mjs', [c, ok]);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('Contrat Info.plist respecté (2 plugin(s)');
    const r2 = runNode('check-plist-contract.mjs', [c, ko]);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain('::error::NSCameraUsageDescription : description d\'usage vide');
    expect(r2.stderr).toContain('::error::BGTaskSchedulerPermittedIdentifiers absente');
    expect(runNode('check-plist-contract.mjs', [c, writeTmp('bad.plist', '<plist><dict>')]).status).toBe(1);
    expect(runNode('check-plist-contract.mjs', [c]).status).toBe(1);
  });
});

describe('make-source-json (source SideStore)', () => {
  const info = (version: string, extra: Record<string, string> = {}): Record<string, string> => ({
    CFBundleIdentifier: 'fr.circletasks.planner',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    MinimumOSVersion: '18.0',
    ...extra,
  });

  function cli(version: string, existing: string | null, extra: string[] = [], plist = info(version)): { status: number | null; json: Source | null; stderr: string } {
    const ipa = writeTmp(`ipa-${version}.ipa`, Buffer.from(`IPA ${version}`));
    const pl = writeTmp(`info-${version}.plist`, plistXml(plist));
    const args = ['--version', version, '--ipa', ipa, '--info-plist', pl, '--url', ipaUrlFor(version), '--notes', `Notes ${version}`, ...extra];
    if (existing) args.push('--existing', existing);
    const r = runNode('make-source-json.mjs', args);
    return { status: r.status, json: r.status === 0 ? (JSON.parse(r.stdout) as Source) : null, stderr: r.stderr };
  }

  it('produit les champs attendus par SideStore (version, date, URL, taille, iOS minimum, notes)', () => {
    const { status, json } = cli('1.2.3', null, ['--date', '2026-10-07T08:00:00.000Z'], info('1.2.3', { NSCameraUsageDescription: 'Scanner le QR.' }));
    expect(status).toBe(0);
    const s = json as Source;
    for (const k of ['name', 'apps', 'news']) expect(s).toHaveProperty(k);
    const app = s.apps[0] as App;
    for (const k of ['name', 'bundleIdentifier', 'developerName', 'localizedDescription', 'iconURL', 'versions']) expect(app[k]).toBeTruthy();
    expect(app.bundleIdentifier).toBe('fr.circletasks.planner');
    expect(app.iconURL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/doncivo\/circletasks-releases\/main\/icon\.png$/);
    expect(app.versions).toEqual([
      {
        version: '1.2.3',
        buildVersion: '1.2.3',
        date: '2026-10-07T08:00:00.000Z',
        localizedDescription: 'Notes 1.2.3',
        downloadURL: 'https://github.com/doncivo/circletasks-releases/releases/download/ios-v1.2.3/CircleTasks.ipa',
        size: Buffer.byteLength('IPA 1.2.3'),
        sha256: createHash('sha256').update(Buffer.from('IPA 1.2.3')).digest('hex'),
        minOSVersion: '18.0',
      },
    ]);
    expect(app['version']).toBe('1.2.3');
    expect(app['downloadURL']).toBe(app.versions[0]?.downloadURL);
    expect(app['size']).toBe(app.versions[0]?.size);
    expect(app.appPermissions).toEqual({ entitlements: [], privacy: { NSCameraUsageDescription: 'Scanner le QR.' } });
    expect(JSON.stringify(s)).not.toMatch(/__[A-Z_]+__/);
  });

  it('ajoute une version sans écraser les précédentes, la plus récente en premier ; une republication remplace sa seule entrée', () => {
    const first = cli('1.0.0', null);
    const p1 = writeTmp('source-1.json', JSON.stringify({ ...first.json, news: [{ title: 'Bienvenue' }] }));
    const second = cli('1.1.0', p1);
    expect(second.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    expect(second.json?.apps[0]?.versions[1]).toEqual(first.json?.apps[0]?.versions[0]);
    expect(second.json?.news).toEqual([{ title: 'Bienvenue' }]);
    const p2 = writeTmp('source-2.json', JSON.stringify(second.json));
    const again = cli('1.1.0', p2, ['--notes', 'Correctif']);
    expect(again.json?.apps[0]?.versions.map((v) => [v.version, v.localizedDescription])).toEqual([
      ['1.1.0', 'Correctif'],
      ['1.0.0', 'Notes 1.0.0'],
    ]);
    const many = Array.from({ length: 12 }, (_, i) => ({ version: `0.0.${i}`, date: '2026-10-01', downloadURL: 'u', size: 1 }));
    const p3 = writeTmp('source-3.json', JSON.stringify({ apps: [{ bundleIdentifier: 'fr.circletasks.planner', versions: many }] }));
    expect(cli('2.0.0', p3).json?.apps[0]?.versions).toHaveLength(13);
  });

  it('trie les versions par numéro : une version plus ancienne publiée après reste derrière, une republication garde sa place', () => {
    const v2 = cli('2.0.0', null);
    const p1 = writeTmp('order-1.json', JSON.stringify(v2.json));
    const v19 = cli('1.9.0', p1);
    expect(v19.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['2.0.0', '1.9.0']);
    // Champs d'app hérités : ceux de la version la plus haute.
    expect(v19.json?.apps[0]?.['version']).toBe('2.0.0');
    expect(v19.json?.apps[0]?.['downloadURL']).toBe(ipaUrlFor('2.0.0'));
    const p2 = writeTmp('order-2.json', JSON.stringify(v19.json));
    const v110 = cli('1.10.0', p2);
    expect(v110.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['2.0.0', '1.10.0', '1.9.0']);
    const p3 = writeTmp('order-3.json', JSON.stringify(v110.json));
    const again = cli('1.10.0', p3, ['--notes', 'Correctif']);
    expect(again.json?.apps[0]?.versions.map((v) => [v.version, v.localizedDescription])).toEqual([
      ['2.0.0', 'Notes 2.0.0'],
      ['1.10.0', 'Correctif'],
      ['1.9.0', 'Notes 1.9.0'],
    ]);
  });

  it('reprend la source publiée avant I-01 (sans iconURL) et la complète', () => {
    const published = {
      name: 'CircleTasks',
      apps: [{ name: 'CircleTasks', bundleIdentifier: 'fr.circletasks.planner', versions: [{ version: '0.1.0', date: '2026-10-04T15:26:20.914Z', localizedDescription: 'CircleTasks 0.1.0', downloadURL: ipaUrlFor('0.1.0'), size: 3861443, minOSVersion: '18.0' }] }],
      news: [],
    };
    const r = cli('0.1.1', writeTmp('published.json', JSON.stringify(published)));
    const app = r.json?.apps[0] as App;
    expect(app.iconURL).toBeTruthy();
    expect(app.versions.map((v) => v.version)).toEqual(['0.1.1', '0.1.0']);
    expect(app.versions[1]).toEqual(published.apps[0]?.versions[0]);
  });

  it('refuse un IPA dont la version, le bundle ou l’iOS minimum diffèrent, une URL ou une version invalides', () => {
    expect(cli('1.0.0', null, [], info('1.0.1')).stderr).toMatch(/Version de l'IPA 1\.0\.1/);
    expect(cli('1.0.0', null, [], info('1.0.0', { CFBundleIdentifier: 'fr.autre' })).status).toBe(1);
    expect(cli('1.0.0', null, [], info('1.0.0', { MinimumOSVersion: '17.0' })).stderr).toMatch(/iOS minimum/);
    expect(cli('1.0', null, [], info('1.0')).stderr).toMatch(/Version invalide/);
    const base = { template: loadTemplate(), existing: null, info: info('1.0.0'), version: '1.0.0', downloadURL: ipaUrlFor('1.0.0'), size: 10, sha256: 'a'.repeat(64), notes: '', date: '2026-10-07', minOSVersion: '18' };
    expect((buildSource(base) as Source).apps[0]?.versions[0]?.localizedDescription).toBe('CircleTasks 1.0.0');
    expect(() => buildSource({ ...base, downloadURL: 'http://ailleurs/CircleTasks.ipa' })).toThrow(/URL/);
    expect(() => buildSource({ ...base, size: 0 })).toThrow(/Taille/);
    expect(() => buildSource({ ...base, sha256: 'x' })).toThrow(/SHA-256/);
    expect(() => buildSource({ ...base, date: 'hier' })).toThrow(/Date/);
    expect(() => buildSource({ ...base, info: { ...info('1.0.0'), CFBundleVersion: '' } })).toThrow(/CFBundleVersion/);
    expect(runNode('make-source-json.mjs', ['--version', '1.0.0']).status).toBe(1);
  });

  it('prend l’iOS minimum dans tauri.conf.json', () => {
    expect(minOSVersionFromConf()).toBe('18.0');
    const bad = writeTmp('conf.json', JSON.stringify({ bundle: {} }));
    expect(() => minOSVersionFromConf(bad)).toThrow();
  });
});

describe('cohérence du guide, du workflow et des scripts', () => {
  const guide = read('docs/install-iphone.md');
  const workflow = read('.github/workflows/build-ios.yml');
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { productName: string; identifier: string };
  const template = loadTemplate() as Source;
  const app = template.apps[0] as App;

  it('même URL de source partout', () => {
    expect(workflow).toContain(`REPO="${RELEASES_REPO}"`);
    expect(workflow).toContain('IPA_URL="https://github.com/${REPO}/releases/download/${TAG}/CircleTasks.ipa"');
    const urls = guide.match(/https:\/\/raw\.githubusercontent\.com\/[^\s`)]+/g);
    expect(urls).toEqual([SOURCE_URL]);
    expect(SOURCE_URL).toBe(`https://raw.githubusercontent.com/${RELEASES_REPO}/main/source.json`);
    expect(template['website']).toBe(`https://github.com/${RELEASES_REPO}`);
    expect(app.iconURL.startsWith(`https://raw.githubusercontent.com/${RELEASES_REPO}/main/`)).toBe(true);
  });

  it('même nom d’app et même identifiant de bundle', () => {
    expect(conf.productName).toBe('CircleTasks');
    expect(app.name).toBe(conf.productName);
    expect(template.name).toBe(conf.productName);
    expect(workflow).toContain(`Payload/${conf.productName}.app`);
    expect(guide).toContain(`${conf.productName}.ipa`);
    expect(guide).toMatch(/^# Installer CircleTasks sur l'iPhone/);
    expect(app.bundleIdentifier).toBe(conf.identifier);
    expect(workflow).toContain(`[ "$ID" = "${conf.identifier}" ]`);
    expect(guide).toContain(`\`${conf.identifier}\``);
  });

  it('même tag ios-v : déclencheur, contrôle de version, publication et guide', () => {
    expect(workflow).toContain('tags: ["ios-v*"]');
    expect(workflow).toContain('if [ "ios-v${VERSION}" != "${GITHUB_REF_NAME}" ]');
    expect(workflow).toContain('TAG="ios-v${VERSION}"');
    expect(ipaUrlFor('1.2.3')).toContain('/download/ios-v1.2.3/CircleTasks.ipa');
    expect(guide).toContain('`ios-vX.Y.Z`');
    // ios-vX.Y.Z (tag d'une version) ou ios-v* (motif de l'environnement releases) ; jamais un numéro réel.
    expect(guide).not.toMatch(/ios-v(?!X\.Y\.Z|\*)/);
  });

  it('jamais de publication hors tag ios-v* : condition du job et seconde barrière', () => {
    expect(workflow).toContain("if: startsWith(github.ref, 'refs/tags/ios-v') && (github.event_name == 'push' || inputs.publish == true)");
    expect(workflow).toContain('case "${GITHUB_REF}" in refs/tags/ios-v*) ;;');
    expect(workflow).toMatch(/publish:\n {4}needs: ios[\s\S]*environment: releases/);
    expect(workflow).toMatch(/publish:\n\s+description:[^\n]*\n\s+type: boolean\n\s+default: false/);
    expect(workflow).toContain('node scripts/ios/check-plist-contract.mjs scripts/ios/plist-contract.json info/Info.plist');
  });

  it('push de source.json : rebase avant, une seule nouvelle tentative, échec visible sinon', () => {
    const publish = workflow.slice(workflow.indexOf('- name: Publier sur circletasks-releases'));
    expect(publish).toContain('if [ "${TAG}" != "${GITHUB_REF_NAME}" ]; then');
    expect(publish).not.toContain('GITHUB_REF_TYPE');
    const tail = publish.slice(publish.indexOf('git add source.json icon.png'));
    expect(tail.match(/git pull --rebase/g)).toHaveLength(2);
    expect(tail.match(/git push/g)).toHaveLength(2);
    expect(tail.indexOf('git pull --rebase')).toBeLessThan(tail.indexOf('git push'));
    expect(tail).toContain('::error::Push de source.json impossible');
    expect(tail).toMatch(/exit 1/);
  });

  it('dtolnay/rust-toolchain épinglé sur un SHA commenté, comme dans les autres workflows', () => {
    const lines = workflow.split('\n').filter((l) => l.includes('dtolnay/rust-toolchain'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/dtolnay\/rust-toolchain@[0-9a-f]{40} # \S+/);
  });

  it('consigne de l’environnement releases : sans approbation manuelle, limite des tags facultative', () => {
    const section = guide.slice(guide.indexOf('## Pour publier une version'), guide.indexOf('## Si ça se passe mal'));
    expect(section).toContain('Settings > Environments');
    expect(section).not.toContain('Required reviewers');
    expect(section).not.toContain('Approve');
    expect(section).toContain('Aucune approbation manuelle');
    expect(section).toContain('`ios-v*`');
    expect(section).toContain('`v*`');
  });

  it('secrets Google : seulement dans l’étape de compilation, client de bureau jamais dans le build iOS', () => {
    const steps = (yml: string) => yml.split(/^ {6}- /m).slice(1);
    const win = read('.github/workflows/build-windows.yml');
    const withSecret = (yml: string, name: string) => steps(yml).filter((s) => s.includes(name));
    for (const name of ['CT_GOOGLE_CLIENT_ID', 'CT_GOOGLE_CLIENT_SECRET']) {
      const found = withSecret(win, name);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("name: Compiler l'installeur NSIS");
      expect(found[0]).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    const iosSteps = withSecret(workflow, 'CT_GOOGLE_IOS_CLIENT_ID');
    expect(iosSteps).toHaveLength(1);
    expect(iosSteps[0]).toContain("name: Compiler l'IPA sans signature");
    expect(workflow).not.toContain('CT_GOOGLE_CLIENT_SECRET');
    expect(workflow).not.toContain('CT_GOOGLE_CLIENT_ID');
    expect(win).not.toContain('CT_GOOGLE_IOS_CLIENT_ID');
    expect(read('.github/workflows/tests.yml')).not.toContain('CT_GOOGLE');
    expect(win.slice(win.indexOf('\n  publish:\n'))).not.toContain('CT_GOOGLE');
    expect(workflow.slice(workflow.indexOf('\n  publish:\n'))).not.toContain('CT_GOOGLE');
    expect(read('src-tauri/build.rs')).toContain('"CT_GOOGLE_IOS_CLIENT_ID"');
  });

  it('garde la phrase de I-02 tant que I-02 n’est pas faite', () => {
    const row = read('docs/backlog.md').split('\n').find((l) => l.startsWith('| I-02 |')) ?? '';
    if (!/\|\s*fait/.test(row)) expect(guide).toContain('CircleTasks préviendra 24 h avant l\'expiration (à l\'ordre 5).');
  });

  it('tient en 15 minutes : durée annoncée, 8 étapes, lecture courte', () => {
    expect(guide).toContain('Durée : 15 minutes environ');
    expect(guide.match(/^## \d+\. /gm)).toHaveLength(8);
    // 1 100 mots ≈ 5 minutes de lecture : il reste 10 minutes pour les gestes.
    expect(guide.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1100);
  });
});
