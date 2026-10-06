import { describe, expect, it } from 'vitest';
import type { DeviceAck, ForgottenDevice } from '../../../../src/domain/sync/format';
import { cutoff, forgetOrder, forgottenDeleteCheck, learnDeclarations, type ForgetKnownDevice, type ForgetStateStatus } from '../../../../src/domain/sync/retention';
import { snapshotReadOf } from './snapshotJson';
import type { DeviceId, Hlc } from '../../../../src/domain/types';
import random from '../../../fixtures/sync/forget-order-random.json';
import table from '../../../fixtures/sync/forget-order.json';
import { generateForgetRandom } from '../../../fixtures/sync/forgetRandom';

/**
 * Y-10, QA (critères 7, 8, 11, 12) : comparaison différentielle Rust / TypeScript. Le fichier `forget-order-random.json` est produit par
 * `tests/fixtures/sync/forgetRandom.ts` avec la sortie de `retention.ts` pour référence ; `sync_forget_qa.rs` exige de `forget.rs`
 * exactement la même sortie sur chaque cas. Aucune horloge, aucun délai : graine fixe.
 */

type JsonAcks = Readonly<Record<string, DeviceAck>>;
const toAcks = (acks: JsonAcks): Map<DeviceId, DeviceAck> => new Map(Object.entries(acks).map(([id, ack]) => [id as DeviceId, ack]));

describe('cas pseudo-aléatoires figés (référence TypeScript de forget.rs)', () => {
  it('le fichier est exactement ce que produit le générateur aujourd’hui (une règle modifiée sans régénérer le fichier fait échouer ce test et le test Rust)', () => {
    expect(JSON.parse(JSON.stringify(generateForgetRandom()))).toEqual(random);
  });

  it('la table exerce les issues utiles : « prêt » et « en attente » nombreux, des déclarations retenues et écartées', () => {
    const kinds = random.forgottenDelete.map((c) => (c.expected as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'ready').length).toBeGreaterThanOrEqual(30);
    expect(kinds.filter((k) => k === 'waiting').length).toBeGreaterThanOrEqual(100);
    expect(random.forgetOrder.filter((c) => Object.keys(c.expected as object).length > 0).length).toBeGreaterThanOrEqual(60);
    expect(random.forgetOrder.filter((c) => (c.entries as unknown[]).length > Object.keys(c.expected as object).length).length).toBeGreaterThanOrEqual(30);
    expect(random.learn.filter((c) => (c.expected as { overflow: boolean }).overflow).length).toBeGreaterThanOrEqual(5);
    expect(random.cutoff.filter((c) => c.expected !== null).length).toBeGreaterThanOrEqual(60);
  });

  it('forgetOrder, learnDeclarations, cutoff et forgottenDeleteCheck redonnent chaque sortie attendue', () => {
    for (const c of random.forgetOrder) expect(Object.fromEntries(forgetOrder(c.entries as unknown as ForgottenDevice[])), c.name).toEqual(c.expected);
    for (const c of random.learn) expect(learnDeclarations(c.master as unknown as ForgottenDevice[], c.candidates as unknown as ForgottenDevice[], c.cap), c.name).toEqual(c.expected);
    for (const c of random.cutoff) {
      const ackers = c.ackers.map((a) => ({ deviceId: a.deviceId as DeviceId, acks: toAcks(a.acks as unknown as JsonAcks) }));
      expect(cutoff(c.target as DeviceId, ackers), c.name).toEqual(c.expected);
    }
    for (const c of random.forgottenDelete) {
      const known: ForgetKnownDevice[] = c.known.map((d) => ({
        deviceId: d.deviceId as DeviceId,
        status: d.status as ForgetStateStatus,
        seen: d.seen,
        state: d.state ? { deviceId: d.deviceId as DeviceId, stateSeq: d.state.stateSeq, acks: toAcks(d.state.acks as unknown as JsonAcks), forgotten: d.state.forgotten as unknown as ForgottenDevice[] } : null,
      }));
      expect(forgottenDeleteCheck(c.target as DeviceId, c.self as DeviceId, c.master as unknown as ForgottenDevice[], c.done as DeviceId[], known, snapshotReadOf(c.ownSnapshot)), c.name).toEqual(c.expected);
    }
  });
});

describe('table commune forget-order.json : chaque condition de suppression du critère 12 y figure', () => {
  const names = table.forgottenDelete.map((c) => c.name);
  const expectCase = (fragment: RegExp, kind: string, code?: string): void => {
    const found = table.forgottenDelete.filter((c) => fragment.test(c.name));
    expect(found.length, String(fragment)).toBeGreaterThan(0);
    for (const c of found) {
      expect((c.expected as { kind: string }).kind, c.name).toBe(kind);
      if (code) expect((c.expected as { code?: string }).code, c.name).toBe(code);
    }
  };
  it('cible = appareil local (bad-name), aucune déclaration, déclaration d’un oublié, coupure, état de la déclaration, états non authentifiés', () => {
    expect(names.length).toBeGreaterThanOrEqual(16);
    expectCase(/cible = appareil local/, 'refused', 'bad-name');
    expectCase(/aucune déclaration/, 'refused', 'state-mismatch');
    expectCase(/déclaration d’un appareil oublié avant/, 'refused', 'state-mismatch');
    expectCase(/un actif n’a pas lu jusqu’à la coupure/, 'waiting', 'state-mismatch');
    expectCase(/ne republie pas une déclaration retenue/, 'waiting', 'state-mismatch');
    expectCase(/fantôme jamais vu/, 'ready');
    expectCase(/state\.ctx de la cible dans le nuage/, 'waiting', 'cloud-pending');
    expectCase(/cible terminée/, 'ready');
    expectCase(/état d’un actif dans le nuage/, 'waiting', 'cloud-pending');
    expectCase(/actif étranger|actif rejoué/, 'waiting', 'state-mismatch');
  });
});

describe('hlc d’une déclaration mal formé (QA-2, corrigé : forgetOrder vérifie le hlc strict, comme forget.rs)', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
  const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId;
  it('QA-2 : forgetOrder écarte un hlc non strict, comme forget.rs', () => {
    const bad = `bad791000000023-0000-${A}` as Hlc;
    expect(forgetOrder([{ deviceId: X, at: bad, lastAck: null }]).size).toBe(0);
  });
});
