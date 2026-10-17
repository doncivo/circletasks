import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import type { EpochId } from '../../../../src/domain/sync/format';
import type * as EpochRules from '../../../../src/domain/sync/epoch';
import { warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { events, orphanScenarioViolations, orphanSession, playOrphanScenario } from '../../../sim/syncOrphanSession';

/**
 * Y-TECH-03 (B13), critère 19 (b) : preuve de détection du banc. Le scénario 1 est rejoué avec l'**ancienne** règle de comptage des fichiers
 * qui bornent la publication (avant Y-IOS-02-FIX-02, commit edb5b925 : tous les segments et instantanés listés, sauf ceux d'une orpheline
 * déjà abandonnée), injectée dans ce fichier de test seulement (module du domaine remplacé par `vi.mock`, aucun code livré modifié). Le banc
 * aurait vu la P1 : avec cette règle, les attentes du scénario 1 échouent (publication bloquée pour toujours, aucun réarmement).
 */
vi.mock('../../../../src/domain/sync/epoch', async (importOriginal) => {
  const real = await importOriginal<typeof EpochRules>();
  return {
    ...real,
    listedFilesForPublish: (ownEpochs: readonly { readonly epoch: EpochId; readonly segments: readonly number[]; readonly snapshots: readonly number[] }[], ctx: { readonly currentEpoch: EpochId; readonly ignored?: EpochId | null }) => ({
      // Règle de 0.3.2 : `files = epochs.filter(e => e.epoch !== orphanLeft || e.epoch === currentEpoch).reduce(segments + snapshots)`.
      counted: ownEpochs.filter((e) => e.epoch !== (ctx.ignored ?? null) || e.epoch === ctx.currentEpoch).reduce((n, e) => n + e.segments.length + e.snapshots.length, 0),
      ignoredSnapshots: 0,
    }),
  };
});

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly { readonly name: string }[] };

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-03 scénario 1 avec l’ancienne règle de canPublish (critère 19 b)', () => {
  it('le scénario devient rouge : publication bloquée à chaque cycle, aucun réarmement, l’orphelin reste', async () => {
    const session = await orphanSession(devices);
    const { b } = session;
    const obs = await playOrphanScenario(session, fixture.plans.find((p) => p.name === 'scenario-1-orphelin'), statusLine, 5);
    const violations = orphanScenarioViolations(obs);
    expect(violations).toEqual(expect.arrayContaining(['orphan-epoch-relisted absent', 'dossier orphelin toujours présent', 'publication jamais reprise (aucun state.ctx)', 'publish-blocked au dernier cycle', 'publish-deferred au dernier cycle (dure)']));
    // La P1 telle que vue sur l'iPhone : publish-deferred à chaque cycle, jamais « À jour ».
    expect(obs.cycles.every((c) => c.warnings.includes('publish-blocked'))).toBe(true);
    expect(events(b, 'publish-deferred')).toBe(5);
    expect(obs.cycles.some((c) => c.line.includes('À jour'))).toBe(false);
  });
});
