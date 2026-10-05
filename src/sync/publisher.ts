import type { OutboxEntry, PublishedEntry, Repositories } from '../db/repositories';
import { MAX_APPEND_CALL_BYTES, MAX_RECORD_PLAINTEXT_BYTES, SYNC_FORMAT_MAJOR, encryptedLineBytes, utf8Bytes, type DeviceAck, type EpochId, type SyncField, type SyncOp } from '../domain/sync/format';
import { hlcDevice, journalEnvelopeBytes, journalRecordToText, opTextBytes } from '../domain/sync/parse';
import { syncTable, tableRank, type SyncTable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc } from '../domain/types';
import { syncErrorCodeOf } from '../platform/sync/types';
import type { SyncDeps } from './deps';
import { META, readJson, writeJson } from './meta';

/**
 * Publication de la file d'envoi (ADR 0011, sections 3.3, 10.2 étape 5 et 1.3 ; Y-02 critère 5, Y-05 critères 1, 3, 5 et 6).
 *
 * File → opérations par ligne **et par horloge de champ** (valeur courante relue) → tri par hlc croissant (à hlc égal, ordre
 * topologique) → enregistrements de 256 Kio de texte clair au plus, sans jamais couper un même hlc → appels de 1 Mio écrit au plus
 * (`encryptedLineBytes`) → `appendJournal` → retrait des entrées publiées dans une transaction. Un arrêt entre l'ajout et le retrait est
 * repris au cycle suivant par l'intention mémorisée (`inflight`, voir `resolveInflight`).
 *
 * Ne sont publiés que les champs dont l'horloge porte l'identifiant de cet appareil et dépasse le plus grand hlc déjà publié dans
 * l'époque : une valeur reçue d'ailleurs ne repart pas, une écriture déjà publiée (base restaurée) non plus.
 */

export interface PendingOp {
  readonly op: SyncOp;
  readonly hlc: Hlc;
  readonly rank: number;
}

export interface Materialized {
  readonly ops: readonly PendingOp[];
  /** Entrée de file → plus grand hlc des opérations qui la portent. */
  readonly entries: readonly { readonly entry: OutboxEntry; readonly hlc: Hlc }[];
  /** Entrées sans rien à publier (ligne disparue, valeur d'un autre appareil, déjà publiée). */
  readonly stale: readonly OutboxEntry[];
}

/** Lit la file et la transforme en opérations (valeurs courantes de la base). */
export async function materializeOutbox(repos: Repositories, self: DeviceId, publishedMax: Hlc | null, limit?: number): Promise<Materialized> {
  const outbox = await repos.sync.readOutbox(limit);
  const byTable = new Map<SyncTable, Map<string, OutboxEntry[]>>();
  const stale: OutboxEntry[] = [];
  for (const entry of outbox) {
    const t = syncTable(entry.table);
    if (!t) {
      stale.push(entry);
      continue;
    }
    const rows = byTable.get(t) ?? new Map<string, OutboxEntry[]>();
    rows.set(entry.rowId, [...(rows.get(entry.rowId) ?? []), entry]);
    byTable.set(t, rows);
  }
  const ops: PendingOp[] = [];
  const entries: { entry: OutboxEntry; hlc: Hlc }[] = [];
  for (const [t, rowsEntries] of byTable) {
    const ids = [...rowsEntries.keys()];
    const [rows, clocks] = await Promise.all([repos.sync.readRows(t, ids), repos.sync.readClocks(t, ids)]);
    for (const [id, rowEntries] of rowsEntries) {
      const row = rows.get(id);
      if (!row) {
        stale.push(...rowEntries);
        continue;
      }
      const rowClocks = clocks.get(id) ?? new Map();
      const fallback = rowClocks.get('*') ?? { hlc: row.hlc, base: null };
      const byHlc = new Map<Hlc, Map<string, SyncField>>();
      const entryHlc = new Map<OutboxEntry, Hlc>();
      for (const entry of rowEntries) {
        const names = entry.field === '*' ? t.columns.map((c) => c.name) : t.columns.some((c) => c.name === entry.field) ? [entry.field] : [];
        for (const name of names) {
          const clock = rowClocks.get(name) ?? fallback;
          if (hlcDevice(clock.hlc) !== self || (publishedMax !== null && clock.hlc <= publishedMax)) continue;
          const fields = byHlc.get(clock.hlc) ?? new Map<string, SyncField>();
          fields.set(name, [row.values.get(name) ?? null, clock.hlc, rowClocks.get(name)?.base ?? null]);
          byHlc.set(clock.hlc, fields);
          const known = entryHlc.get(entry);
          if (known === undefined || clock.hlc > known) entryHlc.set(entry, clock.hlc);
        }
      }
      for (const entry of rowEntries) {
        const hlc = entryHlc.get(entry);
        if (hlc === undefined) stale.push(entry);
        else entries.push({ entry, hlc });
      }
      for (const [hlc, fields] of byHlc) {
        // Ordre du catalogue à l'intérieur d'une opération (texte stable).
        const ordered = new Map(t.columns.filter((c) => fields.has(c.name)).map((c) => [c.name, fields.get(c.name) as SyncField]));
        ops.push({ op: { t: t.name, id, at: row.updatedAt, f: ordered }, hlc, rank: tableRank(t.name) });
      }
    }
  }
  ops.sort((a, b) => (a.hlc !== b.hlc ? (a.hlc < b.hlc ? -1 : 1) : a.rank - b.rank || (a.op.id < b.op.id ? -1 : a.op.id > b.op.id ? 1 : 0)));
  return { ops, entries, stale };
}

export interface BuiltRecord {
  readonly text: string;
  readonly maxHlc: Hlc;
  readonly bytes: number;
}

/**
 * Enregistrements de 256 Kio de texte clair au plus ; toutes les opérations d'un même hlc dans le même enregistrement. Une opération
 * seule trop grande est découpée champ par champ (même hlc, enregistrements successifs) ; un champ seul trop grand est écarté et journalisé.
 */
export function buildRecords(ops: readonly PendingOp[], sv: number, onTooLarge: (op: SyncOp) => void): BuiltRecord[] {
  const envelope = journalEnvelopeBytes(sv);
  const records: BuiltRecord[] = [];
  let current: SyncOp[] = [];
  let currentBytes = envelope;
  let currentMax: Hlc | null = null;
  const flush = (): void => {
    if (current.length === 0 || currentMax === null) return;
    const text = journalRecordToText({ k: 'ops', sv, ops: current });
    records.push({ text, maxHlc: currentMax, bytes: encryptedLineBytes(utf8Bytes(text), SYNC_FORMAT_MAJOR, sv) });
    current = [];
    currentBytes = envelope;
    currentMax = null;
  };
  let i = 0;
  while (i < ops.length) {
    const hlc = (ops[i] as PendingOp).hlc;
    const group: SyncOp[] = [];
    while (i < ops.length && (ops[i] as PendingOp).hlc === hlc) {
      group.push((ops[i] as PendingOp).op);
      i += 1;
    }
    // Opérations trop grandes pour un enregistrement : découpées par champ.
    const parts = group.flatMap((op) => (opTextBytes(op) + envelope > MAX_RECORD_PLAINTEXT_BYTES ? splitOp(op, envelope, onTooLarge) : [op]));
    const groupBytes = parts.reduce((sum, op) => sum + opTextBytes(op), 0);
    if (current.length > 0 && currentBytes + groupBytes > MAX_RECORD_PLAINTEXT_BYTES) flush();
    for (const op of parts) {
      const size = opTextBytes(op);
      if (current.length > 0 && currentBytes + size > MAX_RECORD_PLAINTEXT_BYTES) flush();
      current.push(op);
      currentBytes += size;
      currentMax = hlc;
    }
  }
  flush();
  return records;
}

function splitOp(op: SyncOp, envelope: number, onTooLarge: (op: SyncOp) => void): SyncOp[] {
  const out: SyncOp[] = [];
  for (const [name, field] of op.f) {
    const single: SyncOp = { ...op, f: new Map([[name, field]]) };
    if (opTextBytes(single) + envelope > MAX_RECORD_PLAINTEXT_BYTES) onTooLarge(single);
    else out.push(single);
  }
  return out;
}

/** Appels d'ajout : 1 Mio écrit au plus par appel. */
export function batchRecords(records: readonly BuiltRecord[]): BuiltRecord[][] {
  const batches: BuiltRecord[][] = [];
  let batch: BuiltRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    if (batch.length > 0 && bytes + record.bytes > MAX_APPEND_CALL_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += record.bytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** Intention d'ajout mémorisée avant l'appel (reprise après un arrêt entre l'ajout et le retrait de la file). */
export interface Inflight {
  readonly epoch: EpochId;
  readonly segment: number;
  readonly expect: number;
  readonly count: number;
  readonly maxHlc: Hlc;
  readonly entries: readonly PublishedEntry[];
}

export interface PublishResult {
  readonly published: number;
  readonly head: DeviceAck;
  readonly error: string | null;
}

/**
 * Publie la file dans l'époque `epoch` à partir de la tête `head` (règle 1 déjà appliquée). `maxSegment` : plus grand segment connu
 * (tête, accusés, fichiers listés), pour ouvrir `max + 1` sur `segment-full` ou `segment-mismatch`.
 */
export async function publishOutbox(deps: SyncDeps, epoch: EpochId, head: DeviceAck, maxSegment: number): Promise<PublishResult> {
  const { data, platform, deviceId, sv, logger } = deps;
  const material = await materializeOutbox(data.repos, deviceId, head.epoch === epoch ? head.hlc : null);
  if (material.stale.length > 0) await data.transaction((repos) => repos.sync.dropOutbox(material.stale));
  if (material.ops.length === 0) return { published: 0, head, error: null };
  const records = buildRecords(material.ops, sv, (op) => logger.log('publish-too-large', { table: op.t }));
  const batches = batchRecords(records);
  // Entrées à retirer après le lot qui porte leur plus grand hlc.
  const pending = [...material.entries].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
  let current: DeviceAck = head.epoch === epoch ? head : { epoch, segment: 0, record: 0, hlc: null, stateSeq: head.stateSeq };
  let segment = current.segment === 0 ? Math.max(1, maxSegment + (maxSegment > 0 ? 1 : 0)) : current.segment;
  let expect = current.segment === 0 || segment !== current.segment ? 0 : current.record;
  let published = 0;
  for (const batch of batches) {
    const maxHlc = (batch.at(-1) as BuiltRecord).maxHlc;
    const done: PublishedEntry[] = [];
    while (pending.length > 0 && (pending[0] as { hlc: Hlc }).hlc <= maxHlc) {
      const next = pending.shift() as { entry: OutboxEntry; hlc: Hlc };
      done.push({ ...next.entry, hlc: next.hlc });
    }
    let attempt = 0;
    for (;;) {
      const inflight: Inflight = { epoch, segment, expect, count: batch.length, maxHlc, entries: done };
      await writeJson(data.repos, META.inflight, inflight);
      try {
        const result = await platform.appendJournal({ epoch, segment, expectRecords: expect, sv, maxHlc, records: batch.map((r) => r.text) });
        current = { epoch, segment: result.head.segment, record: result.head.record, hlc: maxHlc, stateSeq: current.stateSeq };
        await data.transaction(async (repos) => {
          await repos.sync.clearPublished(done);
          await writeJson(repos, META.head, current);
          await writeJson(repos, META.inflight, null);
          const times = (await readJson<Record<string, number>>(repos, META.segments)) ?? {};
          await writeJson(repos, META.segments, { ...times, [`${epoch}/${String(current.segment)}`]: deps.clock.nowMs() });
        });
        published += batch.length;
        segment = current.segment;
        expect = current.record;
        break;
      } catch (error) {
        await writeJson(data.repos, META.inflight, null);
        const code = syncErrorCodeOf(error);
        if ((code === 'segment-full' || code === 'segment-mismatch') && attempt < 2) {
          // Segment suivant : max(local, publié, accusés, plus grand fichier listé) + 1 (règle 1).
          attempt += 1;
          maxSegment = Math.max(maxSegment, segment);
          segment = maxSegment + 1;
          expect = 0;
          continue;
        }
        logger.log('publish-failed', { code });
        return { published, head: current, error: code };
      }
    }
  }
  return { published, head: current, error: null };
}

/** Lecture de la tête mémorisée et de l'intention d'ajout. */
export async function readInflight(repos: Repositories): Promise<Inflight | null> {
  return readJson<Inflight>(repos, META.inflight);
}
