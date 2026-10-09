// Tests QA de I-06 (cas limites du contrôle de la source et des notes de version). Aucun fichier écrit : fonctions pures et fixtures versionnées.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sans déclaration de types
import { buildSource, ipaUrlFor, loadTemplate } from './make-source-json.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { BASE_MIN_OS, checkSource } from './check-source.mjs';
// @ts-expect-error script .mjs sans déclaration de types
import { extractReleaseNotes } from '../release/release-notes.mjs';

type Version = Record<string, unknown> & { version: string };
type App = Record<string, unknown> & { versions: Version[] };
type Source = { apps: App[] };
type Check = { errors: string[]; warnings: string[] };

const root = resolve(__dirname, '..', '..');
const run = (script: string, args: string[]) => spawnSync(process.execPath, [join(root, script), ...args], { encoding: 'utf8', cwd: root });
const sha = (c: string): string => c.repeat(64);

function publish(existing: Source | null, version: string, build = version): Source {
  return buildSource({
    template: loadTemplate(),
    existing,
    info: { CFBundleIdentifier: 'fr.circletasks.planner', CFBundleShortVersionString: version, CFBundleVersion: build, MinimumOSVersion: '18.0' },
    version,
    downloadURL: ipaUrlFor(version),
    size: 7_000_000,
    sha256: sha(version.endsWith('0') ? 'a' : 'b'),
    notes: `Notes ${version}`,
    date: '2026-10-20T08:00:00.000Z',
    minOSVersion: '18.0',
  }) as Source;
}

const clone = (source: Source): Source => JSON.parse(JSON.stringify(source)) as Source;
const check = (source: unknown, published?: string): Check => checkSource(source, published === undefined ? {} : { published }) as Check;
const first = (source: Source): Version => (source.apps[0] as App).versions[0] as Version;

describe('critère 2 (QA) : refus du contrôle de la source, un message par écart', () => {
  const valid = publish(publish(null, '0.2.3'), '0.3.0');

  it('source vide, sans app, sans version : refusée (jamais « valide » par défaut)', () => {
    expect(check({}).errors).toEqual(['aucune app dans la source']);
    expect(check({ apps: [] }).errors).toEqual(['aucune app dans la source']);
    expect(check(null).errors).toEqual(['aucune app dans la source']);
    const empty = clone(valid);
    (empty.apps[0] as App).versions = [];
    expect(check(empty).errors).toContain('aucune version');
  });

  it('version publiée absente de la source : refusée', () => {
    expect(check(valid, '0.9.9').errors).toContain('version publiée 0.9.9 absente de la source');
  });

  it('empreinte mal formée, taille invalide, build absent : refusés pour la version publiée', () => {
    for (const bad of ['abc', 'A'.repeat(64), '', 'g'.repeat(64)]) {
      const source = clone(valid);
      first(source)['sha256'] = bad;
      expect(check(source, '0.3.0').errors.some((e) => e.includes('sha256 absent ou invalide')), bad).toBe(true);
    }
    for (const size of [0, -5, 1.5, '7000000', null]) {
      const source = clone(valid);
      first(source)['size'] = size;
      expect(check(source, '0.3.0').errors.some((e) => e.includes('size absente ou invalide')), String(size)).toBe(true);
    }
    const noBuild = clone(valid);
    delete first(noBuild)['buildVersion'];
    expect(check(noBuild, '0.3.0').errors.some((e) => e.includes('buildVersion absent'))).toBe(true);
  });

  it('même version deux fois, numéro invalide, ordre inversé : refusés', () => {
    const twice = clone(valid);
    (twice.apps[0] as App).versions.push({ ...((twice.apps[0] as App).versions[1] as Version) });
    expect(check(twice).errors.some((e) => e.includes('présente deux fois'))).toBe(true);
    const bad = clone(valid);
    ((bad.apps[0] as App).versions[1] as Version).version = '0.2';
    expect(check(bad).errors.some((e) => e.includes('numéro invalide'))).toBe(true);
    const swapped = clone(valid);
    (swapped.apps[0] as App).versions.reverse();
    expect(check(swapped).errors.some((e) => e.includes('non respecté'))).toBe(true);
  });

  it('iOS minimum : 17.0, 18.0 et 18.5 acceptés sans note, 19.0 refusé sans note', () => {
    expect(BASE_MIN_OS).toBe(18);
    for (const minOS of ['18.0', '18.5', '17.0']) {
      const source = clone(valid);
      first(source)['minOSVersion'] = minOS;
      expect(check(source, '0.3.0').errors, minOS).toEqual([]);
    }
    const raised = clone(valid);
    first(raised)['minOSVersion'] = '19.0';
    expect(check(raised, '0.3.0').errors.some((e) => e.includes('iOS minimum 19.0'))).toBe(true);
  });

  it('l’ordre des builds est numérique, pas alphabétique (0.2.10 après 0.2.9)', () => {
    const n = publish(null, '0.2.9');
    expect(check(publish(n, '0.2.10', '0.2.10'), '0.2.10').errors).toEqual([]);
    expect(check(publish(n, '0.2.10', '0.2.9'), '0.2.10').errors.some((e) => e.includes('identique'))).toBe(true);
    expect(check(publish(n, '0.2.10', '0.2.2'), '0.2.10').errors.some((e) => e.includes('non croissant'))).toBe(true);
  });

  it('N (URL, sha256, taille, date) reste intacte après la publication de N+1', () => {
    const n = publish(null, '0.2.3');
    const before = JSON.stringify((n.apps[0] as App).versions[0]);
    const after = publish(n, '0.3.0');
    expect(JSON.stringify((after.apps[0] as App).versions[1])).toBe(before);
  });
});

describe('critère 2 (QA) : ligne de commande de check-source.mjs, jamais un échec silencieux', () => {
  it('fichier absent, JSON illisible, aucun argument, argument inconnu : code 1 et une ligne ::error::', () => {
    const results = [
      run('scripts/ios/check-source.mjs', ['tests/fixtures/release/absent.json']),
      run('scripts/ios/check-source.mjs', ['tests/fixtures/release/CHANGELOG.i06.md']),
      run('scripts/ios/check-source.mjs', []),
      run('scripts/ios/check-source.mjs', ['tests/fixtures/release/source.i06.json', '--verbose', 'x']),
    ];
    for (const result of results) {
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::check-source :');
      expect(result.stdout).not.toContain('source valide');
    }
  });

  it('version publiée qui est un retour en arrière : code 1, message de rétrogradation', () => {
    const result = run('scripts/ios/check-source.mjs', ['tests/fixtures/release/source.i06.json', '--published', '0.2.3']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('inférieure à la plus haute déjà présente (0.3.0)');
  });
});

describe('critère 3 (QA) : notes de version, cas limites', () => {
  const qa = readFileSync(join(root, 'tests/fixtures/release/CHANGELOG.i06.qa.md'), 'utf8');

  it('section vide : absente (un tag sans notes échoue) ; pré-version et version voisine jamais prises pour la bonne', () => {
    expect(extractReleaseNotes(qa, '0.4.0')).toBeNull();
    expect(extractReleaseNotes(qa, '0.3.1')).toBe('### Ajouts\n\n- Premier changement visible.\n\n### Corrections\n\n- Second changement visible.');
    expect(extractReleaseNotes(qa, '0.3.10')).toBe('- Version voisine : ne doit pas être prise pour 0.3.1.');
    expect(extractReleaseNotes(qa, '0.3')).toBeNull();
    // La pré-version a sa propre section ; elle n'est pas dans celle de 0.3.1.
    expect(extractReleaseNotes(qa, '0.3.1')).not.toContain('Pré-version');
  });

  it('titre avec lien et date : reconnu ; texte vide ou sans titre : null, jamais d’exception', () => {
    expect(extractReleaseNotes(qa, '0.3.0')).toBe('- Titre avec lien : reconnu.');
    expect(extractReleaseNotes('', '0.3.0')).toBeNull();
    expect(extractReleaseNotes('pas de titre', '0.3.0')).toBeNull();
    expect(extractReleaseNotes(undefined, '0.3.0')).toBeNull();
  });

  it('ligne de commande : section vide = code 2 sans rien sur stdout ; CHANGELOG absent = code 2 ; version mal écrite = code 1', () => {
    const empty = run('scripts/release/release-notes.mjs', ['0.4.0', 'tests/fixtures/release/CHANGELOG.i06.qa.md']);
    expect(empty.status).toBe(2);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('Aucune section');
    const absent = run('scripts/release/release-notes.mjs', ['0.3.1', 'tests/fixtures/release/absent.md']);
    expect(absent.status).toBe(2);
    expect(absent.stdout).toBe('');
    for (const bad of ['0.3', 'v0.3.1', '']) {
      const result = run('scripts/release/release-notes.mjs', bad === '' ? [] : [bad, 'tests/fixtures/release/CHANGELOG.i06.qa.md']);
      expect(result.status, bad).toBe(1);
      expect(result.stdout).toBe('');
    }
  });
});
