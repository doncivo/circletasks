import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../../src/features/sync/syncText';
import type { SyncStatus } from '../../../../src/platform/sync/types';
import { createSimDevice, setupFirst, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';
import { A_ID, ORPHAN_SNAPSHOT, events, orphanSession } from '../../../sim/syncOrphanSession';

/**
 * Y-TECH-03 (B13), scénario 4 du banc, critère 22 (B5) : suppression en échec durable, d'abord de l'instantané orphelin (`orphan-epoch-
 * delete-failed`), puis d'un ancien instantané propre (`delete-own-failed`). Attendu (exigence d'Ali, aucun échec silencieux) : un état
 * visible durable existe tant que la suppression échoue (avertissement de Détails, bandeau, cause), et disparaît dès qu'elle réussit. Panne
 * armée à chaque rang (`times: all`) par les plans `scenario-4-*` de la fixture. Si ce scénario est rouge avec le code actuel, il est livré
 * sur la branche de Y-IOS-02-FIX-01.
 */

const DAY = 86_400_000;
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly { readonly name: string }[] };
const planNamed = (name: string): unknown => fixture.plans.find((p) => p.name === name);

/** Signal visible du statut (indépendant du nom que lui donnera le correctif) : erreur, ou avertissement, et jamais « À jour ». */
const visible = (status: SyncStatus, nowMs: number): boolean => (status.phase === 'error' || (status.warnings?.length ?? 0) > 0) && !statusLine(status, nowMs).includes('À jour');

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-03 scénario 4 : suppression en échec durable (critère 22, B5)', () => {
  it('instantané orphelin jamais supprimé : état visible à chaque cycle, levé dès que la suppression réussit', async () => {
    const { b } = await orphanSession(devices);
    b.folder.armFaults(planNamed('scenario-4-orphelin-durable'));
    const failing: SyncStatus[] = [];
    for (let i = 0; i < 3; i += 1) failing.push(await b.cycle());
    expect(events(b, 'orphan-epoch-delete-failed')).toBe(3);
    expect(b.folder.fileNames(b.id)).toContain(ORPHAN_SNAPSHOT);
    for (const status of failing) expect(visible(status, b.clock.nowMs())).toBe(true);
    b.folder.disarmFaults();
    const accepted = await b.cycle();
    expect(events(b, 'orphan-epoch-deleted')).toBe(1);
    expect(visible(accepted, b.clock.nowMs())).toBe(true);
    expect(b.folder.fileNames(b.id)).not.toContain(ORPHAN_SNAPSHOT);
    const ok = await b.cycle(); // Le scan du moteur confirme désormais la disparition complète.
    expect(visible(ok, b.clock.nowMs())).toBe(false);
    expect(statusLine(ok, b.clock.nowMs())).toContain('À jour');
  });

  it('ancien instantané propre jamais supprimé (delete-own-failed) : état visible, levé dès que la suppression réussit', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    devices.push(a);
    await setupFirst(a);
    await a.cycle();
    a.folder.armFaults(planNamed('scenario-4-instantane-propre-durable'));
    let last: SyncStatus | null = null;
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(8 * DAY);
      await a.createTask(`Semaine ${String(i)}`);
      last = await a.cycle();
    }
    expect(a.logger.entries.filter((e) => e.event === 'delete-own-failed').map((e) => e.detail)).toContainEqual({ kind: 's', code: 'io' });
    expect(a.folder.fileNames(a.id).some((f) => f.endsWith('/s-00000001.cts'))).toBe(true);
    expect(last && visible(last, a.clock.nowMs())).toBe(true);
    a.folder.disarmFaults();
    a.clock.advance(8 * DAY);
    const ok = await a.cycle();
    expect(a.folder.fileNames(a.id).some((f) => f.endsWith('/s-00000001.cts'))).toBe(false);
    expect(visible(ok, a.clock.nowMs())).toBe(false);
  });
});
