import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import { warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { B_ID, ORPHAN, ORPHAN_SNAPSHOT, events, orphanScenarioViolations, orphanSession, playOrphanScenario } from '../../../sim/syncOrphanSession';

/**
 * Y-TECH-03 (B13), scénario 1 du banc, critère 19 (a) et (c) : l'instantané orphelin du 8 octobre (B1). L'iPhone a abandonné son époque
 * orpheline, `s-00000001.cts` reste dans iCloud sous forme de substitut évincé (`.s-00000001.cts.icloud`), `orphanEpoch` est nul et la
 * première suppression échoue (`io`). Plans de `tests/fixtures/sync/fault-plan.json` ; horloge injectée, rangs d'appel et cycles comptés.
 * La preuve (b) (rouge avec l'ancienne règle de `canPublish`) est dans scenario1OldRule.test.ts (module de règle remplacé dans ce fichier
 * seulement).
 */

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly { readonly name: string }[] };
const planNamed = (name: string): unknown => {
  const plan = fixture.plans.find((p) => p.name === name);
  if (!plan) throw new Error(`plan absent de la fixture : ${name}`);
  return plan;
};

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-03 scénario 1 : instantané orphelin évincé, première suppression en échec (critère 19 a)', () => {
  it('réarmé, suppression en échec io puis réussie, dossier orphelin parti, publication reprise, jamais publish-deferred durable', async () => {
    const session = await orphanSession(devices);
    const { b } = session;
    const obs = await playOrphanScenario(session, planNamed('scenario-1-orphelin'), statusLine);
    expect(orphanScenarioViolations(obs)).toEqual([]);
    // Les deux pannes armées ont été rejouées : substitut présenté au premier listage, première suppression refusée.
    expect(b.folder.faultLog().map((f) => [f.id, f.call])).toEqual([
      ['orphan-placeholder', 1],
      ['orphan-remove-io', 1],
    ]);
    expect(obs.deleteFailures).toEqual([{ code: 'io' }]);
    // Ordre au journal : réarmé puis échec au cycle 1, supprimé au cycle 2, plus rien ensuite.
    expect(obs.cycles[0]?.events.filter((e) => e.startsWith('orphan-epoch-'))).toEqual(['orphan-epoch-relisted', 'orphan-epoch-delete-failed']);
    expect(obs.cycles[1]?.events.filter((e) => e.startsWith('orphan-epoch-'))).toEqual(['orphan-epoch-deleted']);
    expect(obs.cycles[2]?.events.filter((e) => e.startsWith('orphan-epoch-'))).toEqual([]);
    // Publication dès le premier cycle malgré l'échec (l'instantané orphelin ne borne rien) ; aucun publish-deferred à aucun cycle.
    expect(obs.cycles[0]?.ownFiles).toContain('state.ctx');
    expect(events(b, 'publish-deferred')).toBe(0);
    expect(obs.cycles.every((c) => !c.warnings.includes('publish-blocked'))).toBe(true);
    expect(b.folder.devices.get(B_ID)?.epochs.has(ORPHAN) ?? false).toBe(false);
  });
});

describe('Y-TECH-03 scénario 1 : faux en mode historique (critère 19 c, critère 14 côté TypeScript)', () => {
  it('mode historique : le substitut reste malgré la suppression, le bug du 8 octobre se reproduit (réarmé et « déjà parti » à chaque cycle)', async () => {
    const session = await orphanSession(devices);
    const { b } = session;
    const obs = await playOrphanScenario(session, planNamed('scenario-1-orphelin-historique'), statusLine);
    // Le substitut est toujours là : le dossier orphelin reste listé à chaque cycle.
    expect(obs.cycles.every((c) => c.ownFiles.includes(ORPHAN_SNAPSHOT))).toBe(true);
    expect(b.folder.isPlaceholder(B_ID, ORPHAN_SNAPSHOT)).toBe(true);
    expect(orphanScenarioViolations(obs)).toContain('dossier orphelin toujours présent');
    // Le moteur n'a aucun moyen de le voir autrement : la suppression répond « rien supprimé », jamais un faux succès au journal.
    expect(events(b, 'orphan-epoch-deleted')).toBe(0);
    expect(events(b, 'orphan-epoch-already-gone')).toBe(3);
    expect(events(b, 'orphan-epoch-relisted')).toBe(3);
  });

  it('mode correct (plugin actuel, Y-IOS-02-FIX-02) : la suppression du vrai nom emporte le substitut', async () => {
    const session = await orphanSession(devices);
    const { b } = session;
    const obs = await playOrphanScenario(session, { name: 'substitut-seul', faults: [{ id: 'orphan-placeholder', op: 'list', file: `devices/${B_ID}/${ORPHAN_SNAPSHOT}`, nth: 1, effect: 'placeholder' }] }, statusLine);
    expect(b.folder.faultLog().map((f) => f.id)).toEqual(['orphan-placeholder']);
    expect(orphanScenarioViolations(obs)).toEqual([]);
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(events(b, 'orphan-epoch-already-gone')).toBe(0);
  });
});
