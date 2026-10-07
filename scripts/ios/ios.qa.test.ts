// QA I-01 : cas limites du contrat Info.plist, de la source SideStore et de la cohérence du guide.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sans déclaration de types
import { parsePlist } from './plist.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { checkPlistContract } from './check-plist-contract.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { ipaUrlFor, RELEASES_REPO, SOURCE_URL } from './make-source-json.mjs';

type Ver = { version: string; size: number; sha256: string };
type Src = { apps: { versions: Ver[] }[] };

const here = resolve(__dirname);
const root = resolve(here, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
let tmp = '';
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ct-ios-qa-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
const put = (name: string, c: string | Buffer): string => {
  const p = join(tmp, name);
  writeFileSync(p, c);
  return p;
};
const node = (script: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const plist = (kv: Record<string, string>): string =>
  `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(kv)
    .map(([k, v]) => `<key>${k}</key><string>${v}</string>`)
    .join('')}</dict></plist>`;
const EMPTY = "description d'usage vide";

describe('I-01 QA : contrat Info.plist (cas limites)', () => {
  const camera = { formatVersion: 1, plugins: { scanner: { story: 'Y-IOS-02', usageDescriptions: ['NSCameraUsageDescription'] } } };

  it('I-01 critère 2 : description faite d’espaces, tabulations et retours à la ligne refusée', () => {
    for (const blank of [' ', '\t', '\n  \t\n', ' ']) {
      const { errors } = checkPlistContract(camera, { NSCameraUsageDescription: blank });
      expect(errors, JSON.stringify(blank)).toEqual([`NSCameraUsageDescription : ${EMPTY}`]);
    }
  });

  it('I-01 critère 2 : en ligne de commande, description d’espaces dans un plist XML refusée (code 1)', () => {
    const c = put('c1.json', JSON.stringify(camera));
    const p = put('blank.plist', plist({ NSCameraUsageDescription: '   ' }));
    const r = node('check-plist-contract.mjs', [c, p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`::error::NSCameraUsageDescription : ${EMPTY}`);
  });

  it('I-01 critère 2 : plist XML avec prologue, DOCTYPE et indentation accepté', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>NSCameraUsageDescription</key>\n\t<string>Scanner le QR code.</string>\n</dict>\n</plist>\n`;
    expect(checkPlistContract(camera, parsePlist(xml))).toEqual({ errors: [], warnings: [] });
  });

  it('I-01 critère 2 : un plist binaire (non converti par plutil) est refusé, jamais accepté en silence', () => {
    const bin = Buffer.concat([Buffer.from('bplist00'), Buffer.from([0xd1, 0x01, 0x02, 0x5f, 0x10, 0x18]), Buffer.from('NSCameraUsageDescription'), Buffer.from([0x00, 0x08, 0xff])]);
    expect(() => parsePlist(bin.toString('utf8'))).toThrow();
    const c = put('c2.json', JSON.stringify(camera));
    const r = node('check-plist-contract.mjs', [c, put('bin.plist', bin)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('::error::Contrat Info.plist illisible');
    expect(node('check-plist-contract.mjs', [c, put('empty.plist', '')]).status).toBe(1);
  });

  it('I-01 critère 2 : contrat absent ou JSON invalide fait échouer le contrôle', () => {
    const p = put('ok2.plist', plist({ NSCameraUsageDescription: 'Scanner.' }));
    expect(node('check-plist-contract.mjs', [join(tmp, 'absent.json'), p]).status).toBe(1);
    expect(node('check-plist-contract.mjs', [put('bad.json', '{ nope'), p]).status).toBe(1);
  });

  it('I-01 critère 2 : contrat avec plusieurs plugins, chaque manque nomme son plugin et sa story', () => {
    const multi = {
      formatVersion: 1,
      plugins: {
        scanner: { story: 'Y-IOS-02', usageDescriptions: ['NSCameraUsageDescription'] },
        speech: { story: 'Y-IOS-03', usageDescriptions: ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription'] },
        biometric: { story: 'Y-IOS-05', usageDescriptions: ['NSFaceIDUsageDescription'], keys: ['UIRequiredDeviceCapabilities'] },
        reminders: { story: 'Y-IOS-04', usageDescriptions: ['NSRemindersFullAccessUsageDescription'] },
      },
    };
    const full = {
      NSCameraUsageDescription: 'a',
      NSMicrophoneUsageDescription: 'b',
      NSSpeechRecognitionUsageDescription: 'c',
      NSFaceIDUsageDescription: 'd',
      UIRequiredDeviceCapabilities: ['arm64'],
      NSRemindersFullAccessUsageDescription: 'e',
    };
    expect(checkPlistContract(multi, full)).toEqual({ errors: [], warnings: [] });
    const { errors } = checkPlistContract(multi, { NSCameraUsageDescription: 'a', NSMicrophoneUsageDescription: '' });
    expect(errors).toEqual([
      'NSSpeechRecognitionUsageDescription absente (plugin speech, Y-IOS-03)',
      'NSFaceIDUsageDescription absente (plugin biometric, Y-IOS-05)',
      'UIRequiredDeviceCapabilities absente (plugin biometric, Y-IOS-05)',
      'NSRemindersFullAccessUsageDescription absente (plugin reminders, Y-IOS-04)',
      `NSMicrophoneUsageDescription : ${EMPTY}`,
    ]);
  });

  it('I-01 critère 2 : une clé déclarée par deux plugins est acceptée sans avertissement', () => {
    const both = {
      formatVersion: 1,
      plugins: { a: { story: 'A-1', usageDescriptions: ['NSCameraUsageDescription'] }, b: { story: 'B-1', usageDescriptions: ['NSCameraUsageDescription'] } },
    };
    expect(checkPlistContract(both, { NSCameraUsageDescription: 'ok' })).toEqual({ errors: [], warnings: [] });
    expect(checkPlistContract(both, {}).errors).toHaveLength(2);
  });

  it('I-01 critère 2 : une description qui n’est pas une chaîne (nombre, tableau) est signalée', () => {
    expect(checkPlistContract(camera, { NSCameraUsageDescription: 3 }).errors).toEqual([`NSCameraUsageDescription : ${EMPTY}`]);
    expect(checkPlistContract(camera, { NSCameraUsageDescription: ['x'] }).errors).toEqual([`NSCameraUsageDescription : ${EMPTY}`]);
  });
});

describe('I-01 QA : source SideStore (cas limites)', () => {
  const info = (version: string, extra: Record<string, string> = {}): Record<string, string> => ({
    CFBundleIdentifier: 'fr.circletasks.planner',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    MinimumOSVersion: '18.0',
    ...extra,
  });
  function cli(version: string, bytes: Buffer, existing: string | null): { status: number | null; json: Src | null; stderr: string } {
    const ipa = put(`q-${version}-${bytes.length}.ipa`, bytes);
    const pl = put(`q-${version}.plist`, plist(info(version)));
    const args = ['--version', version, '--ipa', ipa, '--info-plist', pl, '--url', ipaUrlFor(version), '--date', '2026-10-07T08:00:00.000Z'];
    if (existing) args.push('--existing', existing);
    const r = node('make-source-json.mjs', args);
    return { status: r.status, json: r.status === 0 ? (JSON.parse(r.stdout) as Src) : null, stderr: r.stderr };
  }

  it('I-01 critère 3 : taille et SHA-256 viennent des octets exacts de l’IPA', () => {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256));
    const v = cli('3.0.0', bytes, null).json?.apps[0]?.versions[0];
    expect(v?.size).toBe(5000);
    expect(v?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const other = cli('3.0.1', Buffer.concat([bytes, Buffer.from([1])]), null).json?.apps[0]?.versions[0];
    expect(other?.size).toBe(5001);
    expect(other?.sha256).not.toBe(v?.sha256);
  });

  it('I-01 critère 3 : un IPA vide ou absent fait échouer la génération', () => {
    expect(cli('3.1.0', Buffer.alloc(0), null).status).toBe(1);
    const pl = put('q-abs.plist', plist(info('3.1.0')));
    const r = node('make-source-json.mjs', ['--version', '3.1.0', '--ipa', join(tmp, 'absent.ipa'), '--info-plist', pl, '--url', ipaUrlFor('3.1.0')]);
    expect(r.status).toBe(1);
  });

  it('I-01 critère 3 : source publiée absente (fichier inexistant) : source neuve avec la seule nouvelle version', () => {
    const r = cli('4.0.0', Buffer.from('x'), join(tmp, 'n-existe-pas.json'));
    expect(r.status).toBe(0);
    expect(r.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['4.0.0']);
  });

  it('I-01 critère 3 : source publiée illisible ou invalide : échec net, jamais d’écrasement des versions', () => {
    for (const [name, body] of [
      ['trunc.json', '{"apps":[{"bundleIdentifier"'],
      ['empty.json', ''],
      ['html.json', '<html>404</html>'],
    ] as const) {
      const r = cli('4.1.0', Buffer.from('x'), put(name, body));
      expect(r.status, name).toBe(1);
      expect(r.stderr).toContain('::error::make-source-json');
    }
  });

  it('I-01 critère 3 : source publiée sans app ou avec une autre app : pas de plantage, versions étrangères non reprises', () => {
    const r = cli('4.2.0', Buffer.from('x'), put('noapps.json', JSON.stringify({ name: 'x' })));
    expect(r.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['4.2.0']);
    const other = { apps: [{ bundleIdentifier: 'autre', versions: [{ version: '9.9.9' }] }] };
    const r2 = cli('4.2.1', Buffer.from('x'), put('other.json', JSON.stringify(other)));
    expect(r2.json?.apps).toHaveLength(1);
    expect(r2.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['4.2.1']);
  });

  it('I-01 critère 3 : version déjà publiée republiée avec un autre IPA : seule son entrée est remplacée', () => {
    const a = cli('5.0.0', Buffer.from('aaa'), null);
    const b = cli('5.1.0', Buffer.from('bbbb'), put('s5a.json', JSON.stringify(a.json)));
    const c = cli('5.1.0', Buffer.from('cc'), put('s5b.json', JSON.stringify(b.json)));
    const vs = c.json?.apps[0]?.versions ?? [];
    expect(vs.map((v) => [v.version, v.size])).toEqual([
      ['5.1.0', 2],
      ['5.0.0', 3],
    ]);
    expect(vs[0]?.sha256).toBe(createHash('sha256').update('cc').digest('hex'));
    expect(vs[1]).toEqual(a.json?.apps[0]?.versions[0]);
  });

  it('I-01 critère 3 : ordre des versions croissantes, la dernière publiée en tête, champs hérités alignés', () => {
    const a = cli('1.0.0', Buffer.from('1'), null);
    const b = cli('1.1.0', Buffer.from('22'), put('s6a.json', JSON.stringify(a.json)));
    const c = cli('1.2.0', Buffer.from('333'), put('s6b.json', JSON.stringify(b.json)));
    expect(c.json?.apps[0]?.versions.map((v) => v.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    const app = c.json?.apps[0] as unknown as { version: string; size: number };
    expect(app.version).toBe('1.2.0');
    expect(app.size).toBe(3);
  });

  it('I-01 critère 3 : versions invalides refusées (préfixe v, suffixe, quatre nombres, vide)', () => {
    for (const bad of ['v1.0.0', '1.0.0-beta', '1.0.0.0', '']) {
      const r = node('make-source-json.mjs', ['--version', bad, '--ipa', put('x.ipa', 'x'), '--info-plist', put('x.plist', plist(info('1.0.0'))), '--url', ipaUrlFor(bad)]);
      expect(r.status, bad).toBe(1);
    }
  });
});

describe('I-01 QA : cohérence du guide après modification d’une valeur', () => {
  const guide = read('docs/install-iphone.md');
  const workflow = read('.github/workflows/build-ios.yml');
  const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as { productName: string; identifier: string };
  const template = JSON.parse(read('scripts/ios/source.template.json')) as { name: string; apps: { name: string; bundleIdentifier: string }[] };

  /** Problèmes de cohérence entre un texte de guide et la config et les scripts. */
  function problems(g: string): string[] {
    const out: string[] = [];
    const urls = g.match(/https:\/\/raw\.githubusercontent\.com\/[^\s`)]+/g) ?? [];
    if (urls.length !== 1 || urls[0] !== SOURCE_URL) out.push('url');
    if (!g.includes(`\`${conf.identifier}\``)) out.push('bundle');
    if (!g.includes(`${conf.productName}.ipa`)) out.push('nom');
    if (!g.includes('`ios-vX.Y.Z`') || /ios-v(?!X\.Y\.Z|\*)/.test(g)) out.push('tag');
    return out;
  }

  it('I-01 critère 4 : le guide actuel est cohérent avec le modèle, la config et le workflow', () => {
    expect(problems(guide)).toEqual([]);
    expect(template.apps[0]?.bundleIdentifier).toBe(conf.identifier);
    expect(template.apps[0]?.name).toBe(conf.productName);
    expect(workflow).toContain(`REPO="${RELEASES_REPO}"`);
  });

  it('I-01 critère 4 : changer l’URL, le bundle, le nom ou le tag dans le guide est détecté', () => {
    expect(problems(guide.replace(SOURCE_URL, SOURCE_URL.replace('circletasks-releases', 'autre-depot')))).toEqual(['url']);
    expect(problems(guide.replaceAll(conf.identifier, 'fr.circletasks.autre'))).toContain('bundle');
    expect(problems(guide.replaceAll('CircleTasks.ipa', 'App.ipa'))).toContain('nom');
    expect(problems(guide.replaceAll('ios-vX.Y.Z', 'v1.2.3'))).toContain('tag');
    expect(problems(`${guide}\nTag : ios-v1.0.0`)).toContain('tag');
    expect(problems(`${guide}\n${SOURCE_URL}x`)).toContain('url');
  });

  it('I-01 critère 1 : publication limitée au tag ios-v* avec environnement releases, même avec publish coché', () => {
    const job = workflow.slice(workflow.indexOf('\n  publish:'));
    expect(job).toMatch(/if: startsWith\(github\.ref, 'refs\/tags\/ios-v'\)/);
    expect(job).toContain('environment: releases');
  });

  it('I-01 critère 1 : le build par branche contrôle bundle, arm64 et iOS minimum', () => {
    expect(workflow).toContain(`[ "$ID" = "${conf.identifier}" ]`);
    expect(workflow).toMatch(/arm64/);
    expect(workflow).toMatch(/MinimumOSVersion/);
  });

  it('I-01 : aucun secret en clair dans le workflow, le guide, le modèle et le contrat', () => {
    for (const t of [workflow, guide, read('scripts/ios/source.template.json'), read('scripts/ios/plist-contract.json')]) {
      expect(t).not.toMatch(/ghp_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY/);
    }
    expect(workflow).toMatch(/secrets\.RELEASES_TOKEN/);
  });
});
