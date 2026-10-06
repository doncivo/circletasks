import { describe, expect, it } from 'vitest';
import { epochId, publishedStateFromJson, publishedStateToJson, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../../src/domain/sync/format';
import { MAX_STATE_CLOSED_SEGMENTS } from '../../../src/domain/sync/limits';
import { parsePublishedStateText } from '../../../src/domain/sync/parse';
import type { DeviceId, Hlc } from '../../../src/domain/types';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from '../../../src/platform/sync/memory';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import table from '../../fixtures/sync/closed-segments.json';

/**
 * Y-TECH-02, ADR 0011 §21 point 2 : nombre d'enregistrements des segments clos (`closed` de `state.ctx`, maître Rust, reproduit par
 * `memory.ts`). Table commune avec Rust (`tests/fixtures/sync/closed-segments.json`), schéma, écriture. Aucun délai réel.
 */

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const E1 = epochId(1, A);
const E2 = epochId(2, A);
const hlc = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;
const nowMs = 1_800_000_000_000;
const clock = (): number => nowMs;

interface SegmentCase {
  readonly segment: number;
  readonly written: number;
  readonly keep?: number;
  readonly extra?: number;
  readonly partial?: boolean;
  readonly corrupt?: number;
  readonly cloud?: boolean;
}
interface ReadCase {
  readonly name: string;
  readonly announce: boolean;
  readonly segments: readonly SegmentCase[];
  readonly from: { readonly segment: number; readonly record: number };
  readonly expect: { readonly status: string; readonly next: { readonly segment: number; readonly record: number }; readonly records: number };
}

async function writer(folder = new MemorySyncFolder()): Promise<MemorySyncPlatform> {
  const p = createMemorySyncPlatform({ folder, nowMs: clock });
  await p.folder.choose();
  await p.bindDevice(A);
  await p.key.create();
  return p;
}

const state = (epoch: EpochId, stateSeq: number, head: Omit<DeviceAck, 'epoch' | 'stateSeq'>, over: Partial<PublishedDeviceState> = {}): PublishedDeviceState => ({
  deviceId: A,
  platform: 'windows',
  appVersion: '0.1.1',
  sm: 1,
  sv: 14,
  epoch,
  stateSeq,
  head: { epoch, ...head, stateSeq },
  acks: new Map<DeviceId, DeviceAck>(),
  snapshot: null,
  purgeHorizon: null,
  lastSyncHlc: hlc(1_000_000),
  forgotten: [],
  reset: null,
  ...over,
});

/** Écrit chaque segment dans l'ordre (rotation), puis l'état ; renvoie la dernière tête. */
async function writeSegments(p: MemorySyncPlatform, segments: readonly SegmentCase[], announce: boolean): Promise<void> {
  let ms = 10;
  let last = { segment: 0, record: 0, hlc: null as Hlc | null };
  for (const s of segments) {
    const records = Array.from({ length: s.written }, (_, i) => `{"k":"ops","s":${String(s.segment)},"i":${String(i)}}`);
    ms += 10;
    await p.appendJournal({ epoch: E1, segment: s.segment, expectRecords: 0, sv: 14, maxHlc: hlc(ms), records });
    last = { segment: s.segment, record: s.written, hlc: hlc(ms) };
  }
  if (!announce) p.testing.clearClosedSegments();
  await p.writeState({ sv: 14, state: state(E1, 1, last) });
}

function alter(folder: MemorySyncFolder, s: SegmentCase): void {
  const file = folder.devices.get(A)?.epochs.get(E1)?.segments.get(s.segment) as unknown as { lines: { text: string; corrupt?: boolean }[]; partialTail: boolean; availability: string };
  if (s.keep !== undefined) file.lines.splice(s.keep);
  for (let i = 0; i < (s.extra ?? 0); i += 1) file.lines.push({ ...(file.lines.at(-1) as { text: string }) });
  if (s.partial) file.partialTail = true;
  if (s.corrupt !== undefined) file.lines[s.corrupt] = { ...(file.lines[s.corrupt] as { text: string }), corrupt: true };
  if (s.cloud) file.availability = 'cloud';
}

describe('table commune closed-segments.json (memory.ts, même table que store.rs)', () => {
  for (const c of table.cases as readonly ReadCase[]) {
    it(c.name, async () => {
      const folder = new MemorySyncFolder();
      const p = await writer(folder);
      await writeSegments(p, c.segments, c.announce);
      for (const s of c.segments) alter(folder, s);
      const page = await p.readJournal({ deviceId: A, epoch: E1, from: c.from });
      expect({ status: page.status, next: page.next, records: page.records.length }).toEqual(c.expect);
    });
  }
});

describe('schéma de closed (parse.ts, format.ts)', () => {
  it('plafond commun à Rust et TypeScript (table commune)', () => {
    expect(MAX_STATE_CLOSED_SEGMENTS).toBe(table.maxEntries);
  });
  const base = (closed?: unknown, head = { segment: 3, record: 2, hlc: hlc(30) }): Record<string, unknown> => {
    const json = publishedStateToJson(state(E1, 4, head)) as unknown as Record<string, unknown>;
    return closed === undefined ? json : { ...json, closed };
  };
  it('absent et [] acceptés (liste vide) ; texte canonique sans la clé quand elle est vide', () => {
    expect(publishedStateFromJson(base())?.closed ?? []).toEqual([]);
    expect(publishedStateFromJson(base([]))?.closed ?? []).toEqual([]);
    expect(JSON.stringify(publishedStateToJson(publishedStateFromJson(base([])) as PublishedDeviceState))).not.toContain('closed');
  });
  it('entrées valides gardées, texte canonique identique quel que soit l’ordre des clés', () => {
    const closed = [
      { segment: 1, records: 3 },
      { segment: 2, records: 5 },
    ];
    const parsed = publishedStateFromJson(base(closed)) as PublishedDeviceState;
    expect(parsed.closed).toEqual(closed);
    const reordered = { closed: [{ records: 3, segment: 1 }, { records: 5, segment: 2 }], ...base() };
    expect(JSON.stringify(publishedStateToJson(publishedStateFromJson(reordered) as PublishedDeviceState))).toBe(JSON.stringify(publishedStateToJson(parsed)));
    const text = JSON.stringify(publishedStateToJson(parsed));
    expect(text.endsWith('"closed":[{"segment":1,"records":3},{"segment":2,"records":5}]}')).toBe(true);
    expect(parsePublishedStateText(text)?.closed).toEqual(closed);
  });
  it('refusé : non croissant, segment ≥ head.segment, segment 0, records à 0, clé en trop, plus de 1 024 entrées', () => {
    for (const bad of [
      [{ segment: 2, records: 1 }, { segment: 1, records: 1 }],
      [{ segment: 1, records: 1 }, { segment: 1, records: 2 }],
      [{ segment: 3, records: 1 }],
      [{ segment: 0, records: 1 }],
      [{ segment: 1, records: 0 }],
      [{ segment: 1, records: 1, extra: 1 }],
      'x',
    ]) {
      expect(publishedStateFromJson(base(bad)), JSON.stringify(bad)).toBeNull();
    }
    const many = Array.from({ length: MAX_STATE_CLOSED_SEGMENTS + 1 }, (_, i) => ({ segment: i + 1, records: 1 }));
    expect(publishedStateFromJson(base(many, { segment: MAX_STATE_CLOSED_SEGMENTS + 2, record: 1, hlc: hlc(30) }))).toBeNull();
    expect(publishedStateFromJson(base(many.slice(1), { segment: MAX_STATE_CLOSED_SEGMENTS + 2, record: 1, hlc: hlc(30) }))?.closed).toHaveLength(MAX_STATE_CLOSED_SEGMENTS);
  });
  it('texte de state.ctx : la clé closed compte comme pairedBy (champ facultatif de premier niveau)', () => {
    const text = JSON.stringify(base([{ segment: 1, records: 3 }]));
    expect(parsePublishedStateText(text)?.closed).toEqual([{ segment: 1, records: 3 }]);
    expect(parsePublishedStateText(text.replace('"closed"', '"closed":[],"closed"'))).toBeNull();
  });
});

describe('écriture (memory.ts, mêmes règles que store.rs)', () => {
  const published = (folder: MemorySyncFolder): PublishedDeviceState => {
    const text = folder.devices.get(A)?.state?.lines[0]?.text ?? '';
    return parsePublishedStateText(text) as PublishedDeviceState;
  };

  it('rotation : entrée { segment, records } ; omis par le moteur → complété ; différent → state-mismatch', async () => {
    const folder = new MemorySyncFolder();
    const p = await writer(folder);
    await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['{"a":1}', '{"a":2}'] });
    await p.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['{"a":3}'] });
    await p.writeState({ sv: 14, state: state(E1, 1, { segment: 2, record: 1, hlc: hlc(20) }) });
    expect(published(folder).closed).toEqual([{ segment: 1, records: 2 }]);
    const code = await p.writeState({ sv: 14, state: state(E1, 2, { segment: 2, record: 1, hlc: hlc(20) }, { closed: [{ segment: 1, records: 1 }] }) }).then(
      () => 'ok',
      (e: unknown) => (e instanceof SyncPlatformError ? e.code : 'autre'),
    );
    expect(code).toBe('state-mismatch');
    await p.writeState({ sv: 14, state: state(E1, 3, { segment: 2, record: 1, hlc: hlc(20) }, { closed: [{ segment: 1, records: 2 }] }) });
    expect(published(folder).closed).toEqual([{ segment: 1, records: 2 }]);
  });

  it('segment-mismatch après une ligne incomplète puis rotation : entrée = ce que l’état a pu annoncer (own.record)', async () => {
    const folder = new MemorySyncFolder();
    const p = await writer(folder);
    await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['{"a":1}', '{"a":2}'] });
    const file = folder.devices.get(A)?.epochs.get(E1)?.segments.get(1) as unknown as { partialTail: boolean };
    file.partialTail = true;
    const refused = await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 2, sv: 14, maxHlc: hlc(20), records: ['{"a":3}'] }).then(
      () => 'ok',
      (e: unknown) => (e instanceof SyncPlatformError ? e.code : 'autre'),
    );
    expect(refused).toBe('segment-mismatch');
    await p.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['{"a":3}'] });
    await p.writeState({ sv: 14, state: state(E1, 1, { segment: 2, record: 1, hlc: hlc(20) }) });
    expect(published(folder).closed).toEqual([{ segment: 1, records: 2 }]);
    // Le lecteur lit tout, sans attente sans fin sur la ligne incomplète du segment clos.
    const page = await p.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } });
    expect([page.status, page.records.length]).toEqual(['complete', 3]);
  });

  it('nouvelle époque : liste vide ; suppression d’un segment : son entrée retirée', async () => {
    const folder = new MemorySyncFolder();
    const p = await writer(folder);
    await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['{"a":1}'] });
    await p.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['{"a":2}'] });
    await p.appendJournal({ epoch: E1, segment: 3, expectRecords: 0, sv: 14, maxHlc: hlc(30), records: ['{"a":3}'] });
    await p.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }]);
    await p.writeState({ sv: 14, state: state(E1, 1, { segment: 3, record: 1, hlc: hlc(30) }) });
    expect(published(folder).closed).toEqual([{ segment: 2, records: 1 }]);
    await p.writeState({ sv: 14, state: state(E2, 2, { segment: 0, record: 0, hlc: null }) });
    expect(published(folder).closed ?? []).toEqual([]);
  });

  it('plafond : au-delà de 1 024 entrées, la plus ancienne est retirée', async () => {
    const folder = new MemorySyncFolder();
    const p = await writer(folder);
    for (let n = 1; n <= MAX_STATE_CLOSED_SEGMENTS + 2; n += 1) {
      await p.appendJournal({ epoch: E1, segment: n, expectRecords: 0, sv: 14, maxHlc: hlc(10 * n), records: ['{"a":1}'] });
    }
    const last = MAX_STATE_CLOSED_SEGMENTS + 2;
    await p.writeState({ sv: 14, state: state(E1, 1, { segment: last, record: 1, hlc: hlc(10 * last) }) });
    const closed = published(folder).closed ?? [];
    expect(closed).toHaveLength(MAX_STATE_CLOSED_SEGMENTS);
    expect(closed[0]).toEqual({ segment: 2, records: 1 });
  });

  it('reconstruction de own.json : entrée gardée depuis son état ; entrée dépassée par un accusé écartée ; état absent : aucune', async () => {
    const folder = new MemorySyncFolder();
    const p = await writer(folder);
    await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['{"a":1}', '{"a":2}'] });
    await p.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['{"a":3}'] });
    await p.writeState({ sv: 14, state: state(E1, 1, { segment: 2, record: 1, hlc: hlc(20) }) });
    p.testing.dropOwnState();
    await p.writeState({ sv: 14, state: state(E1, 2, { segment: 2, record: 1, hlc: hlc(20) }) });
    expect(published(folder).closed).toEqual([{ segment: 1, records: 2 }]);
  });
});
