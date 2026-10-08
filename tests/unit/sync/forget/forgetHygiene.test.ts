import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SYNC_TEST_FILES } from '../syncTestFiles';

/**
 * Y-10 critère 20 (exigence d'Ali) : aucun test de la story ne dépend d'un délai réel, aucun test instable n'est « réparé » par une attente
 * plus longue, un nouvel essai ou une désactivation. Cherche ces motifs dans les fichiers de test de Y-10 (la QA les cherche, la revue de
 * code les refuse).
 */

const root = new URL('../../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const TS_TESTS = [
  'tests/unit/sync/forget/forgetInterrupt.test.ts',
  'tests/unit/sync/forget/forgetSim.test.ts',
  'tests/unit/sync/forget/memoryForget.test.ts',
  'tests/unit/sync/forget/retentionForget.test.ts',
  'tests/unit/sync/forget/forgetQa.test.ts',
  'tests/unit/sync/forget/forgetDifferential.test.ts',
  'tests/unit/sync/forget/forgetScope.test.ts',
  'tests/fixtures/sync/forgetRandom.ts',
  'src/features/sync/SyncDetailsForget.test.tsx',
  'src/features/sync/forgetBanner.test.tsx',
  'src/features/sync/forgetBannerQa.test.tsx',
  'tests/e2e/parcours/Y10-oublier-appareil.spec.ts',
];
const RUST_TESTS = ['src-tauri/tests/desktop/sync_forget.rs', 'src-tauri/tests/desktop/sync_forget_qa.rs'];

/** Motifs interdits : attente réelle, horloge réelle, nouvel essai, test désactivé ou ralenti. */
const FORBIDDEN: readonly [RegExp, string][] = [
  [/(?<!test\.)\bsetTimeout\s*\(/, 'setTimeout( ... ) (hors test.setTimeout, budget d’un parcours)'],
  [/\bsetInterval\s*\(/, 'setInterval( ... )'],
  [/\bwaitForTimeout\b/, 'waitForTimeout'],
  [/\bsleep\s*\(/, 'sleep('],
  [/\bDate\.now\s*\(/, 'Date.now()'],
  [/\bnew Date\(\s*\)/, 'new Date() sans argument'],
  [/\bperformance\.now\s*\(/, 'performance.now()'],
  [/\bvi\.waitFor\b|\bwaitFor\s*\(/, 'waitFor (sondage temporisé)'],
  [/\bvi\.setConfig\s*\(\s*\{[^}]*(retry|testTimeout)/, 'retry ou testTimeout dans setConfig'],
  [/\{\s*(retry|timeout)\s*:\s*\d/, 'option retry/timeout chiffrée'],
  [/\btest\.slow\s*\(|\btest\.fixme\s*\(|\btest\.skip\s*\(\s*\)|\bit\.skip\b|\bit\.todo\b|\bdescribe\.skip\b|\.only\s*\(/, 'test ralenti, désactivé ou isolé'],
  [/\bretries\s*:/, 'retries'],
];


describe('Y-TECH-02 : mêmes interdits dans tous les tests de la synchro (tests/unit/sync/**, src/features/sync/**)', () => {
  it('la liste couvre les deux arborescences', () => {
    expect(SYNC_TEST_FILES.some((f) => f.startsWith('tests/unit/sync/reset/'))).toBe(true);
    expect(SYNC_TEST_FILES.some((f) => f.startsWith('src/features/sync/pairing-window/'))).toBe(true);
  });
  for (const file of SYNC_TEST_FILES) {
    it(`${file}`, () => {
      const source = stripComments(read(file));
      for (const [pattern, name] of FORBIDDEN) expect(source.match(pattern)?.[0] ?? null, `${file} : ${name}`).toBeNull();
    });
  }
});

describe('critère 20 : aucun délai réel, aucun nouvel essai, aucun test désactivé dans les tests de Y-10', () => {
  for (const file of TS_TESTS) {
    it(`${file}`, () => {
      const source = stripComments(read(file));
      for (const [pattern, name] of FORBIDDEN) expect(source.match(pattern)?.[0] ?? null, `${file} : ${name}`).toBeNull();
    });
  }

  it('Rust : ni thread::sleep, ni Instant::now, ni SystemTime::now dans les tests de Y-10 (horloge de test injectée)', () => {
    for (const file of RUST_TESTS) {
      const source = read(file);
      for (const pattern of [/thread::sleep/, /Instant::now/, /SystemTime::now/, /#\[ignore/, /tokio::time::sleep/]) expect(source.match(pattern)?.[0] ?? null, `${file} : ${String(pattern)}`).toBeNull();
    }
  });

  it('le scénario Playwright n’emploie aucune attente à durée fixe ; ses seules durées sont le budget du parcours et l’attente de lancement de l’app', () => {
    const source = stripComments(read('tests/e2e/parcours/Y10-oublier-appareil.spec.ts'));
    expect(source).not.toMatch(/waitForTimeout|page\.pause|test\.slow|retries|\.retry/);
    // Durées nommées : le budget du parcours (une fois) et le délai d'attente d'une réaction de l'interface (APP_READY_TIMEOUT_MS, commun, y compris l’attente du rechargement de la relance).
    expect([...source.matchAll(/setTimeout\(/g)].length).toBe(1);
    const timeouts = [...source.matchAll(/timeout:\s*([A-Za-z_0-9]+)/g)].map((m) => m[1]);
    expect(timeouts.length).toBe(3);
    expect(timeouts.every((name) => name === 'APP_READY_TIMEOUT_MS'), String(timeouts)).toBe(true);
  });
});
