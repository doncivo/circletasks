import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYNC_FORMAT_MAJOR } from '../../../../src/domain/sync/format';

/**
 * Y-10, QA, critères 21 et 22 (ADR 0011 §14.4, §18) : aucune migration ni changement de format sur disque ; la fenêtre `pairing` n'obtient
 * aucune commande nouvelle ; `tauriSync.ts` reste la seule porte vers `invoke('sync_*')`.
 */

const root = new URL('../../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) out.push(...sourcesUnder(`${path}/`));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

describe('critère 21 : aucune migration, aucun changement de format sur disque', () => {
  it('SYNC_FORMAT_MAJOR vaut toujours 1 et aucun fichier de migration ne porte sur l’oubli (le statut forgotten de sync_state existe depuis la migration 0015)', () => {
    expect(SYNC_FORMAT_MAJOR).toBe(1);
    const names = readdirSync(new URL('src/db/migrations/', root)).filter((f) => /^\d{4}_/.test(f));
    expect(names.length).toBeGreaterThan(0);
    for (const file of names) expect(file, file).not.toMatch(/forgot|forget|oubli|device_status/i);
    expect(read('src/db/migrations/0015_sync_tables.ts')).toMatch(/forgotten/);
  });

  it('les clés de sync_meta de Y-10 ne sont jamais publiées : aucune n’apparaît dans le format des fichiers (domain/sync)', () => {
    for (const file of sourcesUnder('src/domain/sync/')) {
      expect(read(file), file).not.toMatch(/forgetFailure|forgetDeletions|forgetDeclarations|forgetPublish/);
    }
  });
});

describe('critère 22 : commandes, fenêtres et porte unique', () => {
  it('sync.json accorde les deux commandes de Y-10 à main ; sync-pairing.json n’en a aucune de plus (trois commandes)', () => {
    const sync = JSON.parse(read('src-tauri/capabilities/sync.json')) as { windows: string[]; permissions: string[] };
    expect(sync.windows).toEqual(['main']);
    expect(sync.permissions).toEqual(expect.arrayContaining(['allow-sync-device-forget', 'allow-sync-forgotten-delete']));
    const pairing = JSON.parse(read('src-tauri/capabilities/sync-pairing.json')) as { windows: string[]; permissions: string[] };
    expect(pairing.windows).toEqual(['pairing']);
    expect(pairing.permissions.slice().sort()).toEqual(['allow-sync-key-import', 'allow-sync-pairing-close', 'allow-sync-pairing-payload']);
  });

  it('seul tauriSync.ts invoque une commande sync_* : ni forget.ts, ni les composants, ni le moteur', () => {
    const offenders = sourcesUnder('src/').filter((file) => {
      if (file === 'src/platform/sync/tauriSync.ts') return false;
      const source = read(file);
      return /\binvoke\s*(<[^>]*>)?\s*\(\s*['"`]sync_/.test(source) || /sync_(device_forget|forgotten_delete)/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^.*SYNC_COMMAND.*$/gm, ''));
    });
    // types.ts déclare la table des commandes (noms, fenêtres) sans les appeler.
    expect(offenders.filter((f) => f !== 'src/platform/sync/types.ts')).toEqual([]);
  });
});
