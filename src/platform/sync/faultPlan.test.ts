// Y-TECH-03 (B13 de docs/audit-1.0.md), critères 1, 3 et 4 : schéma du plan de pannes partagé (`tests/fixtures/sync/fault-plan.json`),
// refus explicite de toute entrée que le faux ne sait pas rejouer, déterminisme, et aucun délai ni nouvel essai dans les fichiers du banc.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAULT_EFFECTS, FAULT_OPS, FaultCounters, FaultPlanError, effectsOf, matchFaultPath, parseFaultPlan } from './faultPlan';
import { MemorySyncFolder } from './memory';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'sync', 'fault-plan.json'), 'utf8')) as { readonly $comment: readonly string[]; readonly schema: number; readonly plans: readonly unknown[] };
const plans = fixture.plans.map((p) => parseFaultPlan(p));

const entry = (extra: Record<string, unknown>): unknown => ({ name: 'essai', faults: [{ id: 'e1', op: 'remove', file: 'devices/*/state.ctx', nth: 1, effect: 'error', code: 'io', ...extra }] });
const refusal = (plan: unknown): string => {
  try {
    parseFaultPlan(plan);
  } catch (error) {
    if (error instanceof FaultPlanError) return error.message;
    throw error;
  }
  throw new Error('plan accepté à tort');
};

describe('Y-TECH-03 : plan de pannes, schéma de la fixture (critère 1)', () => {
  it('racine : $comment, schema 1, plans aux noms uniques', () => {
    expect(Object.keys(fixture).sort()).toEqual(['$comment', 'plans', 'schema']);
    expect(fixture.schema).toBe(1);
    expect(new Set(plans.map((p) => p.name)).size).toBe(plans.length);
  });

  it('chaque entrée porte un identifiant, une opération, un chemin, un rang et un effet de la liste fermée', () => {
    for (const plan of plans) {
      for (const e of plan.faults) {
        expect(e.id.length, `${plan.name}`).toBeGreaterThan(0);
        expect(FAULT_OPS).toContain(e.op);
        expect(e.file.startsWith('devices/')).toBe(true);
        expect(Number.isInteger(e.nth) && e.nth >= 1).toBe(true);
        expect(FAULT_EFFECTS).toContain(e.effect);
        expect(effectsOf(e.op)).toContain(e.effect);
      }
    }
  });

  it('un plan d’exemple par effet, et chaque opération est employée', () => {
    const effects = new Set(plans.filter((p) => p.name.startsWith('exemple-')).flatMap((p) => p.faults.map((e) => e.effect)));
    expect([...effects].sort()).toEqual([...FAULT_EFFECTS].sort());
    const ops = new Set(plans.flatMap((p) => p.faults.map((e) => e.op)));
    for (const op of ['list', 'read', 'write', 'remove', 'hydrate']) expect(ops.has(op as never), op).toBe(true);
    // Le mode historique du plugin est décrit par un plan d'exemple.
    expect(plans.some((p) => p.options.removeLeavesPlaceholder)).toBe(true);
  });

  it('le $comment décrit chaque opération, chaque effet et le mode historique (réimplémentation Rust)', () => {
    const text = fixture.$comment.join('\n');
    for (const word of [...FAULT_OPS, ...FAULT_EFFECTS, 'removeLeavesPlaceholder', 'resurrectAfterCycles', 'partialLastLine', 'content', 'times', 'nth', 'advanceCycle', 'MemFs', 'fake_bookmark', 'include_str!']) {
      expect(text, word).toContain(word);
    }
  });

  it('chaque plan de la fixture s’arme sur memory.ts', () => {
    for (const plan of fixture.plans) expect(() => new MemorySyncFolder().armFaults(plan)).not.toThrow();
  });
});

describe('Y-TECH-03 : le schéma refuse (critères 1 et 3)', () => {
  it('un champ inconnu, en nommant l’entrée et le champ', () => {
    expect(refusal(entry({ couleur: 'rouge' }))).toBe('plan « essai », entrée « e1 » : champ inconnu « couleur »');
  });

  it('un effet inconnu ou une opération inconnue, en nommant l’entrée', () => {
    expect(refusal(entry({ effect: 'explose' }))).toBe('plan « essai », entrée « e1 » : effet inconnu « explose »');
    expect(refusal(entry({ op: 'chmod' }))).toBe('plan « essai », entrée « e1 » : opération inconnue « chmod »');
  });

  it('un effet que l’opération ne sait pas rejouer', () => {
    expect(refusal(entry({ effect: 'evict-after-read', code: undefined }))).toContain('entrée « e1 »');
    expect(refusal({ name: 'essai', faults: [{ id: 'e2', op: 'write', file: 'devices/a/state.ctx', nth: 1, effect: 'download-error' }] })).toBe("plan « essai », entrée « e2 » : effet « download-error » non rejouable sur l'opération « write »");
  });

  it('un rang absent ou invalide', () => {
    const noRank = { name: 'essai', faults: [{ id: 'e1', op: 'remove', file: 'devices/a/state.ctx', effect: 'error', code: 'io' }] };
    expect(refusal(noRank)).toBe('plan « essai », entrée « e1 » : rang « nth » absent');
    expect(refusal(entry({ nth: 0 }))).toContain('rang « nth » invalide');
    expect(refusal(entry({ nth: 1.5 }))).toContain('rang « nth » invalide');
  });

  it('un champ de durée, quel que soit son nom', () => {
    for (const key of ['delayMs', 'timeoutMs', 'afterMs', 'durationMs', 'waitSeconds', 'at', 'firesAt', 'date', 'time']) {
      expect(refusal(entry({ [key]: 1000 })), key).toBe(`plan « essai », entrée « e1 » : champ de durée « ${key} » interdit (rang d'appel et cycles seulement)`);
    }
    expect(refusal({ name: 'essai', timeoutMs: 5, faults: [] })).toBe('plan « essai » : champ de durée « timeoutMs » interdit');
  });

  it('un horodatage dans le chemin, un chemin hors de devices/, un dossier pour une opération sur fichier', () => {
    expect(refusal(entry({ file: 'devices/a/2026-10-08T10:00:00Z' }))).toContain('horodatage interdit');
    expect(refusal(entry({ file: 'devices/a/1791000000000.ctx' }))).toContain('horodatage interdit');
    expect(refusal(entry({ file: 'autre/a/state.ctx' }))).toContain('invalide');
    expect(refusal(entry({ file: 'devices/a/' }))).toContain('désigne un fichier');
    expect(refusal({ name: 'essai', faults: [{ id: 'e1', op: 'list', file: 'devices/a', nth: 1, effect: 'error', code: 'io' }] })).toContain('désigne un dossier');
  });

  it('un paramètre manquant ou sans objet', () => {
    expect(refusal(entry({ code: undefined }))).toContain('« code » attendu');
    expect(refusal(entry({ code: 'disk-full' }))).toContain('« code » attendu');
    expect(refusal(entry({ resurrectAfterCycles: 2 }))).toContain('« resurrectAfterCycles » sans objet');
    expect(refusal({ name: 'essai', faults: [{ id: 'e1', op: 'remove', file: 'devices/a/state.ctx', nth: 1, effect: 'accept-not-propagated' }] })).toContain('« resurrectAfterCycles » attendu');
    expect(refusal({ name: 'essai', faults: [{ id: 'e1', op: 'read', file: 'devices/a/state.ctx', nth: 1, effect: 'overwrite-before-read' }] })).toContain('« content » attendu');
    expect(refusal({ name: 'essai', faults: [{ id: 'e1', op: 'write', file: 'devices/a/state.ctx', nth: 1, effect: 'error', code: 'io', partialLastLine: true }] })).toContain('réservé aux segments');
    expect(refusal({ name: 'essai', faults: [{ id: 'e1', op: 'remove', file: 'devices/a/state.ctx', nth: 1, effect: 'error', code: 'io' }, { id: 'e1', op: 'read', file: 'devices/a/state.ctx', nth: 1, effect: 'error', code: 'io' }] })).toContain('« id » en double');
    expect(refusal({ name: 'essai', options: { lent: true }, faults: [] })).toContain('option inconnue « lent »');
  });

  it('memory.ts refuse de s’armer avec une entrée qu’il ne sait pas rejouer, message qui nomme l’entrée (jamais ignorée)', () => {
    const folder = new MemorySyncFolder();
    expect(() => folder.armFaults({ name: 'essai', faults: [{ id: 'panne-x', op: 'remove', file: 'devices/a/state.ctx', nth: 1, effect: 'teleport' }] })).toThrow(/entrée « panne-x » : effet inconnu « teleport »/);
    expect(folder.faultLog()).toEqual([]);
  });
});

describe('Y-TECH-03 : rang d’appel et déterminisme (critères 2 et 4)', () => {
  it('motifs : joker dans un composant seulement, dossier et fichier distingués', () => {
    expect(matchFaultPath('devices/*/e0001-*/s-00000001.cts', 'devices/ef50/e0001-ef50/s-00000001.cts')).toBe(true);
    expect(matchFaultPath('devices/*/s-00000001.cts', 'devices/ef50/e0001-ef50/s-00000001.cts')).toBe(false);
    expect(matchFaultPath('devices/*/', 'devices/ef50/')).toBe(true);
    expect(matchFaultPath('devices/*/', 'devices/ef50/state.ctx')).toBe(false);
    expect(matchFaultPath('devices/a.b/state.ctx', 'devices/aXb/state.ctx')).toBe(false);
  });

  it('nth et times : seuls les appels du rang armé sont touchés, chaque entrée compte ses appels', () => {
    const counters = new FaultCounters(parseFaultPlan({ name: 'rangs', faults: [{ id: 'deux-trois', op: 'remove', file: 'devices/a/*', nth: 2, times: 2, effect: 'error', code: 'io' }, { id: 'tous', op: 'read', file: 'devices/a/state.ctx', nth: 1, times: 'all', effect: 'error', code: 'cloud-pending' }] }));
    const removes = [1, 2, 3, 4].map(() => counters.hit('remove', 'devices/a/state.ctx')?.id ?? null);
    expect(removes).toEqual([null, 'deux-trois', 'deux-trois', null]);
    expect([1, 2, 3].map(() => counters.hit('read', 'devices/a/state.ctx')?.id ?? null)).toEqual(['tous', 'tous', 'tous']);
    expect(counters.hit('read', 'devices/b/state.ctx')).toBeNull();
    expect(counters.unfired()).toEqual([]);
  });

  it('deux exécutions du même plan et de la même suite d’appels : même journal des pannes', () => {
    const run = (): unknown => {
      const reference = plans.find((p) => p.name === 'exemple-error-io');
      if (!reference) throw new Error('plan exemple-error-io absent');
      const counters = new FaultCounters(reference);
      const calls = ['devices/x/e0001-x/s-00000001.cts', 'devices/x/e0001-x/j-00000001.ctj', 'devices/x/e0001-x/s-00000001.cts', 'devices/x/e0001-x/s-00000001.cts'];
      return { results: calls.map((path) => counters.hit('remove', path)?.id ?? null), log: counters.fired() };
    };
    expect(run()).toEqual(run());
    expect((run() as { results: unknown }).results).toEqual(['remove-s1-io', null, null, null]);
  });
});

describe('Y-TECH-03 : aucun délai, aucun nouvel essai, aucun test désactivé dans les fichiers du banc (critère 4)', () => {
  const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const BANK = [
    'src/platform/sync/faultPlan.ts',
    'src/platform/sync/memoryFaults.test.ts',
    'src/platform/sync/syncFsConformance.test.ts',
    'tests/sim/syncCloudSim.ts',
    'tests/sim/syncOrphanSession.ts',
    'tests/unit/sync/hostile/cloudSimDeletions.test.ts',
    'tests/unit/sync/hostile/scenario1Orphan.test.ts',
    'tests/unit/sync/hostile/scenario1OldRule.test.ts',
  ];
  const FORBIDDEN: readonly [RegExp, string][] = [
    [/\bsetTimeout\s*\(/, 'setTimeout('],
    [/\bsetInterval\s*\(/, 'setInterval('],
    [/\bsleep\s*\(/, 'sleep('],
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bperformance\.now\s*\(/, 'performance.now()'],
    [/\bvi\.waitFor\b|\bwaitFor\s*\(/, 'waitFor'],
    [/\bvi\.useFakeTimers\b|\badvanceTimers/, 'minuteries simulées (le banc compte des appels et des cycles)'],
    [/\bretry\b|\bretries\b/, 'nouvel essai'],
    [/\bit\.skip\b|\bit\.todo\b|\bdescribe\.skip\b|\bxit\b|\.only\s*\(/, 'test désactivé ou isolé'],
  ];
  for (const file of BANK) {
    it(file, () => {
      const source = stripComments(readFileSync(join(root, file), 'utf8'));
      for (const [pattern, name] of FORBIDDEN) expect(source.match(pattern)?.[0] ?? null, `${file} : ${name}`).toBeNull();
    });
  }
});
