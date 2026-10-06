import { cutoff, forgetOrder, forgottenDeleteCheck } from '../../../src/domain/sync/retention';
import type { DeviceId } from '../../../src/domain/types';

/**
 * Générateur des cas pseudo-aléatoires figés de `forget-order-random.json` (Y-10, QA) : congruence linéaire de graine fixe, aucune
 * horloge ni source d'aléa. La sortie de `forgetOrder`, `cutoff` et `forgottenDeleteCheck` (TypeScript) est la référence ; `forget.rs`
 * doit donner exactement la même (comparaison différentielle Rust / TypeScript, `sync_forget_qa.rs`). Le test
 * `forgetDifferential.test.ts` vérifie que le fichier est celui que ce générateur produit aujourd'hui ; pour le régénérer après un
 * changement voulu des règles : écrire `JSON.stringify(generateForgetRandom())` dans le fichier.
 */

const IDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] as const;
const STATUS = ['cloud-pending', 'foreign', 'corrupt', 'rollback', 'missing', 'too-large', 'newer-format'] as const;

export function generateForgetRandom(): { description: string; forgetOrder: unknown[]; cutoff: unknown[]; forgottenDelete: unknown[] } {
  let s = 20261006;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
  const pick = <T>(a: readonly T[]): T => a[rnd(a.length)] as T;
  const hlc = (ms: number, c: number, dev: string): string => `${String(1_791_000_000_000 + ms).padStart(15, '0')}-${c.toString(16).padStart(4, '0')}-${dev}`;
  const epoch = (): string => `e000${String(1 + rnd(2))}-${IDS[0]}`;
  const ack = () => {
    const segment = rnd(4);
    const record = rnd(4);
    return { epoch: epoch(), segment, record, hlc: segment === 0 && record === 0 ? null : hlc(segment * 10 + record, rnd(2), pick(IDS)), stateSeq: rnd(7) };
  };
  const acks = () => {
    const o: Record<string, unknown> = {};
    for (const id of IDS) if (rnd(3) > 0) o[id] = ack();
    return o;
  };
  /** Déclaration de `by` : le plus souvent valide ; parfois datée par un autre appareil (hlc toujours bien formé : un hlc mal formé n'atteint jamais ces fonctions, l'analyse de l'état le refuse). */
  const decl = (by: string) => {
    const kind = rnd(10);
    const at = kind === 0 ? hlc(rnd(30), rnd(2), pick(IDS)) : hlc(rnd(30), rnd(2), by);
    return { deviceId: pick(IDS), at, lastAck: rnd(2) ? null : ack() };
  };

  const out = { description: '', forgetOrder: [] as unknown[], cutoff: [] as unknown[], forgottenDelete: [] as unknown[] };
  out.description =
    'Cas pseudo-aléatoires figés (congruence linéaire, graine 20261006, tests/fixtures/sync/forgetRandom.ts) de l’ordre total, de la coupure et des conditions de suppression : la sortie de la version TypeScript est la référence, forget.rs doit donner exactement la même (comparaison différentielle Rust / TypeScript, Y-10 QA).';
  for (let i = 0; i < 120; i += 1) {
    const declarations = Array.from({ length: 1 + rnd(8) }, () => {
      const by = pick(IDS);
      return { by, entry: decl(by) };
    });
    out.forgetOrder.push({ name: `aléatoire ${String(i)}`, declarations, expected: Object.fromEntries(forgetOrder(declarations as never)) });
  }
  for (let i = 0; i < 120; i += 1) {
    const target = pick(IDS);
    const ackers = IDS.filter(() => rnd(4) > 0).map((id) => ({ deviceId: id, acks: acks() }));
    const expected = cutoff(target as DeviceId, ackers.map((a) => ({ deviceId: a.deviceId as DeviceId, acks: new Map(Object.entries(a.acks)) })) as never);
    out.cutoff.push({ name: `aléatoire ${String(i)}`, target, ackers, expected });
  }
  const self = IDS[0] as string;
  for (let i = 0; i < 300; i += 1) {
    const ids: string[] = IDS.slice(0, 3 + rnd(3));
    const by = rnd(3) === 0 ? (pick(ids.slice(1)) as string) : self;
    const target = pick(ids.filter((id) => id !== by && id !== self));
    const cutPos = ack();
    const seq: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 1 + rnd(6)]));
    const list = ids.map((id) => {
      const status: string = rnd(10) === 0 ? pick(STATUS) : 'ok';
      const a: Record<string, unknown> = {};
      for (const other of ids) {
        if (other === id) continue;
        if (other === target) {
          if (rnd(8) > 0) a[other] = rnd(5) === 0 ? ack() : { ...cutPos, stateSeq: rnd(7) };
        } else if (other === by) {
          if (rnd(8) > 0) a[other] = { ...ack(), stateSeq: Math.max(0, (seq[by] as number) + rnd(3) - 1) };
        } else if (rnd(2)) a[other] = ack();
      }
      const forgotten = id === by ? [{ deviceId: target, at: hlc(10 + rnd(5), rnd(2), by), lastAck: null }] : rnd(6) === 0 ? [decl(id)] : [];
      return { deviceId: id, status, state: status === 'ok' ? { stateSeq: seq[id] as number, acks: a, forgotten } : null };
    });
    const expected = forgottenDeleteCheck(
      target as DeviceId,
      self as DeviceId,
      list.map((d) => ({ ...d, state: d.state ? { deviceId: d.deviceId, stateSeq: d.state.stateSeq, forgotten: d.state.forgotten, acks: new Map(Object.entries(d.state.acks)) } : null })) as never,
    );
    out.forgottenDelete.push({ name: `aléatoire ${String(i)}`, target, self, known: list, expected });
  }
  return out;
}
