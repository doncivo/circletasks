import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeAndDetailOf, LOG_MASK, normalizeScope, sanitizeLogDetail } from './sanitize';
import { categoryOf } from './types';

interface Vector {
  readonly input?: string;
  readonly repeat?: readonly [string, number];
  readonly expected: string;
}

const vectors = (JSON.parse(readFileSync(new URL('../../../tests/fixtures/logs/sanitize-vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] }).vectors;

describe('I-04 critère 5 : assainissement du journal (vecteurs partagés avec Rust)', () => {
  it.each(vectors.map((vector) => [vector.input ?? `${vector.repeat?.[0] ?? ''} × ${String(vector.repeat?.[1] ?? 0)}`, vector] as const))('%s', (_, vector) => {
    const input = vector.input ?? (vector.repeat ? vector.repeat[0].repeat(vector.repeat[1]) : '');
    expect(sanitizeLogDetail(input)).toBe(vector.expected);
  });

  it('les vecteurs couvrent chaque règle (chemin Windows, POSIX, file://, URL avec requête, e-mail, Bearer, hexadécimal, > 300 caractères)', () => {
    const masked = vectors.filter((vector) => vector.expected.includes(LOG_MASK)).map((vector) => vector.input ?? '');
    for (const sample of ['C:\\', '/var/', 'file://', '?pageToken', '@example.fr', 'Bearer', '0123456789abcdef0123456789abcdef']) {
      expect(masked.some((input) => input.includes(sample)), sample).toBe(true);
    }
    expect(vectors.some((vector) => vector.repeat && vector.repeat[1] > 300 && vector.expected === LOG_MASK)).toBe(true);
  });

  // 40 détails réels, relevés dans les appels de logFailure (src/sync/log.ts, rappels, sauvegardes, import, export, mise à jour…), avec
  // parfois un chemin ou une adresse que l'erreur système aurait pu porter : après assainissement, ni chemin, ni adresse, ni jeton.
  const REAL: readonly string[] = [
    'sync-now {"reason":"open"}',
    'cycle-start {"trigger":"interval"}',
    'scan-done {"files":12,"segments":3}',
    'folder-unreachable {"code":"folder-unreachable"}',
    'banner-failed {"code":"io"}',
    'remote-reload-failed {"code":"io"}',
    'garde trouvée au démarrage : 2',
    "réintégration des champs inconnus impossible (SqlError)",
    'replan open: unreadable (3)',
    'replan sync: partial (12)',
    'actions lost 2',
    'actions queue-write-failed',
    'action apply-failed',
    'focus-end-failed denied',
    'status-write-failed',
    'ledger-unreadable',
    'request-permission-failed',
    'sauvegarde : io',
    'sauvegarde : corrupt',
    'sauvegarde : restore-pending',
    'export de fichier : write-failed',
    'export de fichier : too-large',
    'export de fichier : unavailable',
    'UNIQUE constraint failed: task.id',
    'database is locked',
    'error returned from database: (code: 5) database is locked',
    'Failed to fetch dynamically imported module: http://tauri.localhost/assets/SettingsScreen-abc.js',
    'Échec de la vérification : https://github.com/doncivo/circletasks-releases/releases/latest/download/latest.json?x=1',
    "ENOENT: no such file or directory, open 'C:\\Users\\Ali\\AppData\\Roaming\\fr.circletasks.planner\\circletasks.db'",
    'EACCES /var/mobile/Containers/Data/Application/1234/Library/x',
    'chargement file:///private/var/containers/Bundle/Application/x/index.html impossible',
    'compte ali.s.cherif@gmail.com refusé',
    'Authorization: Bearer ya29.a0AfH6SMBx',
    'clé 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 refusée',
    'not-foreground',
    'haptics unavailable',
    'security biometry-not-enrolled',
    'catalog-en NetworkError',
    'quick-capture-register Raccourci déjà utilisé',
    'tray-labels tray-unavailable',
  ];

  it('40 entrées réelles : aucune ne garde un chemin, une adresse, un jeton ni une URL avec requête', () => {
    expect(REAL).toHaveLength(40);
    for (const raw of REAL) {
      const clean = sanitizeLogDetail(raw);
      expect(clean, raw).not.toMatch(/[A-Za-z]:\\|\\\\|\/var\/|\/Users\/|file:|@gmail|ya29|9f86d081|\?x=1/);
    }
    // Les codes et compteurs restent lisibles.
    expect(sanitizeLogDetail(REAL[0] ?? '')).toBe('sync-now {"reason":"open"}');
    expect(sanitizeLogDetail('replan open: unreadable (3)')).toBe('replan open: unreadable (3)');
  });
});

describe('codeAndDetailOf (ADR 0014 §3)', () => {
  it('code de l’erreur, sinon premier mot du texte, sinon nom, sinon unknown ; détail assaini', () => {
    expect(codeAndDetailOf({ code: 'too-large', message: 'C:\\Users\\x trop gros' })).toEqual({ code: 'too-large', detail: `${LOG_MASK} trop gros` });
    expect(codeAndDetailOf('sync-now {"reason":"open"}')).toEqual({ code: 'sync-now', detail: '{"reason":"open"}' });
    expect(codeAndDetailOf(new TypeError('Échec de lecture'))).toEqual({ code: 'typeerror', detail: 'Échec de lecture' });
    expect(codeAndDetailOf(Object.assign(new Error('x'), { name: 'Bizarre Nom' }))).toEqual({ code: 'x', detail: '' });
    expect(codeAndDetailOf(null)).toEqual({ code: 'unknown', detail: '' });
    expect(codeAndDetailOf(42)).toEqual({ code: 'unknown', detail: '' });
  });

  it('scope en forme stricte, sinon invalid ; catégories d’affichage', () => {
    expect(normalizeScope('import-pick')).toBe('import-pick');
    expect(normalizeScope('desktop:sync')).toBe('invalid');
    expect(normalizeScope('Titre secret')).toBe('invalid');
    expect(categoryOf('sync')).toBe('sync');
    expect(categoryOf('sync-rust')).toBe('sync');
    expect(categoryOf('notifications')).toBe('notifications');
    expect(categoryOf('reminders-plan')).toBe('notifications');
    expect(categoryOf('backup-daily')).toBe('errors');
  });
});
