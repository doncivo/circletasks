import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Y-TECH-03 (B13), critère 18 : règle « tout faux iCloud rejoue la même fixture ». Chaque faux de la liste fixe ci-dessous est rejoué par au
 * moins un fichier de test qui charge `syncfs-conformance.json` ET `fault-plan.json` et qui exerce ce faux ; un faux ajouté au dépôt sans
 * cette lecture (implémentation de `SyncFs` ou du transport du plugin dans les tests Rust, dossier simulé ou plateforme mémoire en
 * TypeScript) fait échouer le test avec le nom du fichier fautif.
 */

const root = join(__dirname, '../../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const CONFORMANCE = 'tests/fixtures/sync/syncfs-conformance.json';
const FAULT_PLAN = 'tests/fixtures/sync/fault-plan.json';
/** Ce fichier cite les deux fixtures sans rien rejouer : jamais compté. */
const SELF = 'tests/unit/sync/hostile/fakesLoadFixtures.test.ts';

function filesUnder(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (name === 'node_modules' || name === 'target') continue;
    if (statSync(join(root, path)).isDirectory()) out.push(...filesUnder(path, pattern));
    else if (pattern.test(name)) out.push(path);
  }
  return out.sort();
}

/** Les faux iCloud du dépôt (memory.ts, MemFs, fake_bookmark, et l'enveloppe de pannes sur StdFs de la conformité Rust) : fichier qui le définit, nom qui l'exerce, langage. */
const FAKES = [
  { fake: 'memory.ts (MemorySyncFolder)', source: 'src/platform/sync/memory.ts', uses: 'MemorySyncFolder', lang: 'ts' },
  { fake: 'MemFs', source: 'src-tauri/tests/desktop/sync_support.rs', uses: 'MemFs', lang: 'rs' },
  { fake: 'fake_bookmark (FakePlugin)', source: 'src-tauri/tests/desktop/support/fake_bookmark.rs', uses: 'FakePlugin', lang: 'rs' },
  { fake: 'FaultyStd (enveloppe de pannes au-dessus de StdFs)', source: 'src-tauri/tests/desktop/sync_fs_conformance.rs', uses: 'FaultyStd', lang: 'rs' },
] as const;

/** Enveloppes et bouchons qui ne sont pas des faux iCloud (raison écrite) : jamais comptés comme un faux à rejouer. */
const NOT_FAKES: Readonly<Record<string, string>> = {
  SharedFs: 'enveloppe partagée de MemFs (sync_support.rs), aucun comportement propre',
  SharedPlugin: 'enveloppe partagée de FakePlugin (fake_bookmark.rs), aucun comportement propre',
  VirtualSnapshot: 'instantané virtuel de lecture en flux (sync_bookmark.rs), list/read hors de son test « unreachable »',
  Never: 'transport jamais appelé (sync_bookmark.rs), garde du faux',
  FirstCallRouted:
    'aiguillage de test (sync_bookmark.rs, Y-IOS-05, revue I2) : envoie la première commande désignée à un DeadlineTransport à échéance nulle et les autres à un second, tous deux sur MutedTransport ; aucun comportement de fichier propre',
  MutedTransport:
    'transport muet dédié aux tests de l’échéance (sync_bookmark.rs, Y-IOS-05, ADR 0011 §32) : bloque une commande désignée jusqu’à sa libération par le test, sinon répond comme FakePlugin ; l’effet mute reste refusé par MemFs et fake_bookmark (un appel synchrone sans retour ne se rejoue pas sans attente)',
};

/**
 * Marqueur d'un rejeu réel des cas de pannes (revue m3) : charger les fixtures ne suffit pas, le fichier doit aussi armer un plan et rejouer
 * la table (Rust : `run_fault_table(` ; TypeScript : `armFaults(`).
 */
const REPLAY_MARKER = { rs: 'run_fault_table(', ts: 'armFaults(' } as const;

/** Le fichier charge-t-il les deux fixtures (Rust : `include_str!` ; TypeScript : lecture du fichier) et rejoue-t-il les cas de pannes ? */
function loadsBoth(path: string, lang: 'ts' | 'rs'): boolean {
  const text = read(path);
  const loads = (fixture: string): boolean => {
    const name = fixture.split('/').at(-1) as string;
    return lang === 'rs' ? new RegExp(`include_str!\\([^)]*${name.replace('.', '\\.')}`).test(text) : text.includes('readFileSync') && text.includes(`'${name}'`);
  };
  return loads(CONFORMANCE) && loads(FAULT_PLAN) && text.includes(REPLAY_MARKER[lang]);
}

describe('Y-TECH-03 : chaque faux iCloud rejoue syncfs-conformance.json et fault-plan.json (critère 18)', () => {
  for (const f of FAKES) {
    it(f.fake, () => {
      expect(statSync(join(root, f.source)).isFile(), `${f.source} : faux introuvable`).toBe(true);
      const candidates = f.lang === 'ts' ? filesUnder('src', /\.test\.ts$/).concat(filesUnder('tests/unit', /\.test\.ts$/)) : filesUnder('src-tauri/tests', /\.rs$/);
      const replaying = candidates.filter((path) => path !== SELF && read(path).includes(f.uses) && loadsBoth(path, f.lang));
      expect(replaying, `${f.source} : aucun test ne rejoue les deux fixtures sur ${f.fake}`).not.toEqual([]);
    });
  }

  it('aucun faux iCloud hors de la liste fixe (nouveau faux : ajouté à la liste et rejoué, ou test en échec avec son fichier)', () => {
    const known = new Set(FAKES.map((f) => f.uses));
    const unknown: string[] = [];
    for (const path of filesUnder('src-tauri/tests', /\.rs$/)) {
      for (const match of read(path).matchAll(/impl(?:<[^>]*>)?\s+(?:SyncFs|BookmarkTransport)\s+for\s+(\w+)/g)) {
        const name = match[1] as string;
        if (!known.has(name as never) && !(name in NOT_FAKES)) unknown.push(`${path} : ${name}`);
      }
    }
    for (const path of [...filesUnder('src', /\.ts$/), ...filesUnder('tests/sim', /\.ts$/)].filter((p) => !p.endsWith('.test.ts'))) {
      for (const match of read(path).matchAll(/export (?:class (\w*SyncFolder)\b|function (create\w*Memory\w*Sync\w*|createMemorySync\w*)\s*\()/g)) {
        const name = (match[1] ?? match[2]) as string;
        if (name !== 'MemorySyncFolder' && name !== 'createMemorySyncPlatform' && name !== 'createMemorySyncLogger') unknown.push(`${path} : ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
