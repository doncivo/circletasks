import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * I-04 critère 9 (ADR 0014, « Conséquences ») : contrôles statiques du journal technique.
 * - aucun `console.warn|error|log|info|debug` hors `src/platform/desktop/log.ts` (tests exclus) ;
 * - aucun `eprintln!` hors `src-tauri/src/applog.rs` (commentaires exclus) ;
 * - `log_append`, `log_read`, `log_clear` nommés seulement par `src/platform/logs/tauriLogs.ts` ;
 * - capabilities `logs.json` et `logs-ios.json` exactes, aucune autre capability ne porte ces commandes.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function filesOf(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesOf(path, extensions);
    return extensions.some((ext) => name.endsWith(ext)) ? [path] : [];
  });
}

const rel = (path: string): string => relative(ROOT, path).split(sep).join('/');
const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
const codeLines = (text: string): string[] => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

describe('I-04 critère 9 : contrôles statiques du journal', () => {
  const sources = filesOf(join(ROOT, 'src'), ['.ts', '.tsx']).filter((path) => !isTest(path));

  it('aucun console.* hors src/platform/desktop/log.ts', () => {
    expect(sources.length).toBeGreaterThan(200);
    const offenders = sources.filter((path) => rel(path) !== 'src/platform/desktop/log.ts' && codeLines(readFileSync(path, 'utf8')).some((line) => /\bconsole\.(warn|error|log|info|debug)\b/.test(line)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('aucun eprintln! hors src-tauri/src/applog.rs', () => {
    const rust = filesOf(join(ROOT, 'src-tauri', 'src'), ['.rs']);
    const offenders = rust.filter((path) => rel(path) !== 'src-tauri/src/applog.rs' && codeLines(readFileSync(path, 'utf8')).some((line) => line.includes('eprintln!')));
    expect(offenders.map(rel)).toEqual([]);
    expect(codeLines(readFileSync(join(ROOT, 'src-tauri', 'src', 'applog.rs'), 'utf8')).filter((line) => line.includes('eprintln!'))).toHaveLength(1);
  });

  it('les commandes du journal ne sont nommées que par tauriLogs.ts', () => {
    const offenders = sources.filter((path) => rel(path) !== 'src/platform/logs/tauriLogs.ts' && /['"]log_(append|read|clear)['"]/.test(readFileSync(path, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('capabilities logs.json et logs-ios.json exactes ; aucune autre (pairing, capture, focus…) ne porte ces commandes', () => {
    const dir = join(ROOT, 'src-tauri', 'capabilities');
    const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { windows: string[]; platforms: string[]; permissions: string[] };
    for (const [name, platform] of [
      ['logs.json', 'windows'],
      ['logs-ios.json', 'iOS'],
    ] as const) {
      const capability = read(name);
      expect(capability.windows).toEqual(['main']);
      expect(capability.platforms).toEqual([platform]);
      expect([...capability.permissions].sort()).toEqual(['allow-log-append', 'allow-log-clear', 'allow-log-read']);
    }
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json') && file !== 'logs.json' && file !== 'logs-ios.json')) {
      expect(read(name).permissions.filter((permission) => typeof permission === 'string' && permission.includes('-log-')), name).toEqual([]);
    }
  });
});
