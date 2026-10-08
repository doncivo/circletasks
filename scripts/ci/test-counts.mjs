// Comptage des tests par job pour le résumé de suite.yml.
//   node scripts/ci/test-counts.mjs write <vitest|playwright|cargo> <fichier de rapport> <sortie.json> <étiquette>
//   node scripts/ci/test-counts.mjs summary <dossier de sorties>   (Markdown sur la sortie standard)
// Aucune dépendance : s'exécute avant ou sans `npm ci`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, ...args] = process.argv.slice(2);

function parse(kind, file) {
  const raw = readFileSync(file, 'utf8');
  if (kind === 'vitest') {
    const r = JSON.parse(raw);
    return { total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + (r.numTodoTests ?? 0) };
  }
  if (kind === 'playwright') {
    const s = JSON.parse(raw).stats;
    return { total: s.expected + s.unexpected + s.flaky + s.skipped, passed: s.expected, failed: s.unexpected + s.flaky, skipped: s.skipped };
  }
  if (kind === 'cargo') {
    const t = { total: 0, passed: 0, failed: 0, skipped: 0 };
    for (const m of raw.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) {
      t.passed += Number(m[1]);
      t.failed += Number(m[2]);
      t.skipped += Number(m[3]);
    }
    t.total = t.passed + t.failed + t.skipped;
    return t;
  }
  throw new Error(`type inconnu : ${kind}`);
}

if (mode === 'write') {
  const [kind, file, out, label] = args;
  writeFileSync(out, JSON.stringify({ label, ...parse(kind, file) }));
} else if (mode === 'summary') {
  const byLabel = new Map();
  for (const f of readdirSync(args[0]).filter((n) => n.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(join(args[0], f), 'utf8'));
    const t = byLabel.get(r.label) ?? { shards: 0, total: 0, passed: 0, failed: 0, skipped: 0 };
    t.shards += 1;
    for (const k of ['total', 'passed', 'failed', 'skipped']) t[k] += r[k];
    byLabel.set(r.label, t);
  }
  const rows = [...byLabel.entries()].sort(([a], [b]) => a.localeCompare(b));
  const sum = (k) => rows.reduce((n, [, t]) => n + t[k], 0);
  const lines = ['| Job | Tranches | Tests | Réussis | Échoués | Ignorés |', '|---|---:|---:|---:|---:|---:|'];
  for (const [label, t] of rows) lines.push(`| ${label} | ${t.shards} | ${t.total} | ${t.passed} | ${t.failed} | ${t.skipped} |`);
  lines.push(`| **Total** | ${rows.reduce((n, [, t]) => n + t.shards, 0)} | **${sum('total')}** | ${sum('passed')} | ${sum('failed')} | ${sum('skipped')} |`);
  console.log(lines.join('\n'));
} else {
  throw new Error('usage : write|summary');
}
