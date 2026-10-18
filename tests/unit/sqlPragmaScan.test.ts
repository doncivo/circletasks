import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SEC-01 (revue I1) : le plugin SQL fermé refuse tout pragma hors de sa liste blanche et quelques fonctions SQL dangereuses. Un `PRAGMA`
 * ou un `pragma_*` ajouté demain dans un repository ne doit pas être découvert en production : ce test parcourt le code du front
 * (`src/**`, hors tests) et vérifie que chaque pragma figure dans la liste blanche **lue dans** `guard.rs` (`PRAGMA_WHITELIST`, une seule
 * liste), et qu'aucune fonction refusée n'est utilisée dans du SQL. Les commentaires sont retirés avant la recherche (ils citent les
 * pragmas) ; `src/i18n` (textes affichés) est exclu.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const GUARD = join(ROOT, 'src-tauri/vendor/tauri-plugin-sql/src/guard.rs');

function whitelist(): string[] {
  const match = /PRAGMA_WHITELIST: &\[&str\] = &\[([^\]]*)\]/.exec(readFileSync(GUARD, 'utf8'));
  if (!match?.[1]) throw new Error('PRAGMA_WHITELIST introuvable dans guard.rs');
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] ?? '');
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(join(ROOT, 'src'), path).replaceAll('\\', '/') !== 'i18n') out.push(...sources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('SEC-01 : le code du front n\'émet que des pragmas et fonctions que le plugin SQL fermé accepte', () => {
  const allowed = whitelist();
  const files = sources(join(ROOT, 'src')).map((path) => ({ path: relative(ROOT, path).replaceAll('\\', '/'), text: stripComments(readFileSync(path, 'utf8')) }));

  it('lit une liste blanche non vide et parcourt le code', () => {
    expect(allowed).toEqual(expect.arrayContaining(['foreign_keys', 'journal_mode', 'wal_checkpoint']));
    expect(files.length).toBeGreaterThan(200);
  });

  it('chaque `PRAGMA nom` et `pragma_nom` est dans la liste blanche de guard.rs', () => {
    const unknown: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\bPRAGMA\s+(\w+)/g)) if (!allowed.includes((m[1] ?? '').toLowerCase())) unknown.push(`${path} : PRAGMA ${m[1] ?? ''}`);
      for (const m of text.matchAll(/\bpragma_(\w+)/gi)) if (!allowed.includes((m[1] ?? '').toLowerCase())) unknown.push(`${path} : pragma_${m[1] ?? ''}`);
    }
    expect(unknown, 'pragma hors liste blanche du plugin SQL (ajouter à PRAGMA_WHITELIST avec une ligne d\'ADR, ou retirer)').toEqual([]);
  });

  it('aucune fonction ni instruction refusée dans du SQL', () => {
    const found: string[] = [];
    for (const { path, text } of files) {
      for (const m of text.matchAll(/\b(load_extension|fts3_tokenizer|readfile|writefile)\b/gi)) found.push(`${path} : ${m[1] ?? ''}`);
      for (const line of text.split('\n')) {
        if (/\bedit\s*\(/.test(line) && /\b(SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES)\b/.test(line)) found.push(`${path} : edit( dans du SQL`);
        if (/\b(ATTACH|DETACH)\s+(DATABASE\b|'|")/i.test(line) || /\bVACUUM\s+(INTO\b|;|'|"|`|$)/.test(line)) found.push(`${path} : ${line.trim().slice(0, 60)}`);
      }
    }
    expect(found).toEqual([]);
  });
});
