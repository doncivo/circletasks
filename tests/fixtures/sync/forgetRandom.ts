import { cutoff, forgetOrder, forgottenDeleteCheck, learnDeclarations, type SnapshotEndRead } from '../../../src/domain/sync/retention';
import type { DeviceAck, EpochId, ForgottenDevice } from '../../../src/domain/sync/format';
import type { DeviceId, Hlc } from '../../../src/domain/types';

/**
 * Générateur des cas pseudo-aléatoires figés de `forget-order-random.json` (Y-10, QA ; règles de l'ADR 0011 §18 points 3 à 10) :
 * congruence linéaire de graine fixe, aucune horloge ni source d'aléa. La sortie de `forgetOrder`, `learnDeclarations`, `cutoff` et
 * `forgottenDeleteCheck` (TypeScript) est la référence ; `forget.rs` doit donner exactement la même (comparaison différentielle Rust /
 * TypeScript, `sync_forget_qa.rs`). Le test `forgetDifferential.test.ts` vérifie que le fichier est celui que ce générateur produit
 * aujourd'hui ; pour le régénérer après un changement voulu des règles : écrire `JSON.stringify(generateForgetRandom())` dans le fichier.
 */

const IDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'] as const;
const STATUS = ['cloud-pending', 'foreign', 'corrupt', 'rollback', 'missing', 'too-large', 'newer-format'] as const;

export function generateForgetRandom(): { description: string; forgetOrder: unknown[]; learn: unknown[]; cutoff: unknown[]; forgottenDelete: unknown[] } {
  let s = 20261006;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 4294967296) * n);
  };
  const pick = <T>(a: readonly T[]): T => a[rnd(a.length)] as T;
  const hlc = (ms: number, c: number, dev: string): string => `${String(1_791_000_000_000 + ms).padStart(15, '0')}-${c.toString(16).padStart(4, '0')}-${dev}`;
  const epoch = (): string => `e000${String(1 + rnd(2))}-${IDS[0]}`;
  const ack = (): DeviceAck => {
    const segment = rnd(4);
    const record = rnd(4);
    return { epoch: epoch(), segment, record, hlc: segment === 0 && record === 0 ? null : hlc(segment * 10 + record, rnd(2), pick(IDS)), stateSeq: rnd(7) } as DeviceAck;
  };
  const acks = (): Record<string, DeviceAck> => {
    const o: Record<string, DeviceAck> = {};
    for (const id of IDS) if (rnd(3) > 0) o[id] = ack();
    return o;
  };
  /** Déclaration (auteur = appareil du hlc) ; parfois mal formée : hlc non strict, auteur = cible. */
  const decl = (): ForgottenDevice => {
    const kind = rnd(12);
    const author = pick(IDS);
    const target = kind === 0 ? author : pick(IDS);
    const at = kind === 1 ? `x${hlc(rnd(30), rnd(2), author).slice(1)}` : hlc(rnd(30), rnd(2), author);
    return { deviceId: target, at, lastAck: rnd(2) ? null : ack() } as ForgottenDevice;
  };

  const out = { description: '', forgetOrder: [] as unknown[], learn: [] as unknown[], cutoff: [] as unknown[], forgottenDelete: [] as unknown[] };
  out.description =
    'Cas pseudo-aléatoires figés (congruence linéaire, graine 20261006, tests/fixtures/sync/forgetRandom.ts) de l’ordre total, de l’apprentissage de la liste maître, de la coupure et des conditions de suppression (ADR 0011 §18 points 3 à 13, condition (h) et oubli annulé compris) : la sortie de la version TypeScript est la référence, forget.rs doit donner exactement la même (comparaison différentielle Rust / TypeScript, Y-10 QA).';
  for (let i = 0; i < 120; i += 1) {
    const entries = Array.from({ length: 1 + rnd(8) }, decl);
    out.forgetOrder.push({ name: `aléatoire ${String(i)}`, entries, expected: Object.fromEntries(forgetOrder(entries)) });
  }
  for (let i = 0; i < 80; i += 1) {
    const master = Array.from({ length: rnd(5) }, decl);
    const candidates = Array.from({ length: rnd(7) }, decl);
    const cap = rnd(3) === 0 ? 2 + rnd(3) : 64;
    out.learn.push({ name: `aléatoire ${String(i)}`, master, candidates, cap, expected: learnDeclarations(master, candidates, cap) });
  }
  for (let i = 0; i < 120; i += 1) {
    const target = pick(IDS);
    const ackers = IDS.filter(() => rnd(4) > 0).map((id) => ({ deviceId: id, acks: acks() }));
    const expected = cutoff(target as DeviceId, ackers.map((a) => ({ deviceId: a.deviceId as DeviceId, acks: new Map(Object.entries(a.acks) as [DeviceId, DeviceAck][]) })));
    out.cutoff.push({ name: `aléatoire ${String(i)}`, target, ackers, expected });
  }
  const self = IDS[0] as string;
  for (let i = 0; i < 300; i += 1) {
    const ids: string[] = IDS.slice(0, 3 + rnd(3));
    const author = rnd(3) === 0 ? (pick(ids.slice(1)) as string) : self;
    const target = pick(ids.filter((id) => id !== author && id !== self));
    const master: ForgottenDevice[] = [{ deviceId: target, at: hlc(10 + rnd(5), rnd(2), author), lastAck: null } as ForgottenDevice, ...(rnd(4) === 0 ? [decl()] : [])];
    // Terminé : la cible, ou (oubli annulé, §18 point 12) un appareil qui n'est pas oublié.
    const doneKind = rnd(14);
    const done = doneKind < 2 ? [target] : doneKind === 2 ? [pick(ids.filter((id) => id !== self && id !== target))] : [];
    const cutPos = ack();
    const list = ids.map((id) => {
      const status: string = rnd(10) === 0 ? pick(STATUS) : 'ok';
      const a: Record<string, DeviceAck> = {};
      for (const other of ids) {
        if (other === id) continue;
        if (other === target) {
          if (rnd(8) > 0) a[other] = rnd(5) === 0 ? ack() : { ...cutPos, stateSeq: rnd(7) };
        } else if (rnd(2)) a[other] = ack();
      }
      const forgotten = rnd(8) === 0 ? master.slice(1) : rnd(10) === 0 ? [decl()] : master;
      return { deviceId: id, status, seen: rnd(5) > 0, state: status === 'ok' ? { stateSeq: 1 + rnd(6), acks: a, forgotten } : null };
    });
    // Condition (h) (§18 point 11) : instantané annoncé de l'appareil local, absent, illisible, dans le nuage, couvrant ou non.
    const snapKind = rnd(14);
    const ownSnapshot =
      snapKind === 0
        ? 'none'
        : snapKind === 1
          ? 'unreadable'
          : snapKind === 2
            ? 'cloud-pending'
            : { author: self, epoch: `e0001-${self}`, seq: 1 + rnd(3), endHlc: hlc(40 + rnd(9), 0, self), covers: { [target]: rnd(3) === 0 ? ack() : { ...cutPos, stateSeq: 0 } } };
    const ownRead: SnapshotEndRead =
      typeof ownSnapshot === 'string'
        ? ownSnapshot
        : { author: self as DeviceId, epoch: ownSnapshot.epoch as EpochId, seq: ownSnapshot.seq, endHlc: ownSnapshot.endHlc as Hlc, covers: new Map(Object.entries(ownSnapshot.covers) as [DeviceId, DeviceAck][]) };
    const expected = forgottenDeleteCheck(
      target as DeviceId,
      self as DeviceId,
      master,
      done as DeviceId[],
      list.map((d) => ({
        deviceId: d.deviceId as DeviceId,
        status: d.status as never,
        seen: d.seen,
        state: d.state ? { deviceId: d.deviceId as DeviceId, stateSeq: d.state.stateSeq, forgotten: d.state.forgotten, acks: new Map(Object.entries(d.state.acks) as [DeviceId, DeviceAck][]) } : null,
      })),
      ownRead,
    );
    out.forgottenDelete.push({ name: `aléatoire ${String(i)}`, target, self, master, done, known: list, ownSnapshot, expected });
  }
  return out;
}
