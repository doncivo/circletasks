import type { ExportedRow, OutboxEntry, PublishedEntry, Repositories } from '../db/repositories';
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

/**
 * Entrée de file « ligne entière » : posée par le report d'époque (section 9.1 (c)) sur une ligne qu'il recrée. Toutes les colonnes
 * publiées partent, champs des autres appareils compris (avec leurs horloges), en une seule opération classée à son plus grand hlc.
 */
export const ROW_REPUBLISH_FIELD = '+';

// ---------------------------------------------------------------------------------------------------------------------------------
// Tâches courtes (Y-05 critère 6 « sans bloquer l'interface » ; décision D4 de Y-04 : aucune tâche longue de plus de 250 ms pendant
// un cycle de 5 000 opérations). La mise en forme d'une grosse file (lecture des lignes, enregistrements) rend la main à la boucle
// d'événements dès qu'elle a travaillé `SLICE_MS` ms d'affilée ; le résultat est identique (mêmes opérations, mêmes enregistrements).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Durée de travail continu avant de rendre la main (ms). */
export const SLICE_MS = 50;
/** Lignes lues par instruction pendant la mise en forme (même découpage que le repository). */
const READ_CHUNK = 400;
/** Entrées de file lues par instruction (la file entière d'une grosse file hors ligne ne tient pas dans une tâche courte). */
const OUTBOX_PAGE = 500;

/**
 * Lit la file par pages, dans l'ordre (`limit` : au plus ce nombre d'entrées ; `maxSeq` : entrées de numéro inférieur ou égal
 * seulement), avec une pause possible entre deux pages. Chaque page est une instruction : aucune transaction n'est tenue entre deux.
 */
async function readOutboxPaged(repos: Repositories, limit: number | undefined, slicer: Slicer, maxSeq = Number.POSITIVE_INFINITY): Promise<OutboxEntry[]> {
  const out: OutboxEntry[] = [];
  let after = 0;
  for (;;) {
    const want = limit === undefined ? OUTBOX_PAGE : Math.min(OUTBOX_PAGE, limit - out.length);
    if (want <= 0) return out;
    const page = await repos.sync.readOutbox(want, after);
    const kept = page.filter((entry) => entry.seq <= maxSeq);
    out.push(...kept);
    const last = page.at(-1);
    if (page.length < want || !last || kept.length < page.length) return out;
    after = last.seq;
    await slicer.pause();
  }
}

export interface Slicer {
  /** Rend la main à la boucle d'événements si la tranche de temps est écoulée. */
  pause(): Promise<void>;
}

/** Aucun découpage (appels directs et tests de règles). */
export const NO_SLICING: Slicer = { pause: () => Promise.resolve() };

/** Une tâche de la boucle d'événements : `scheduler.yield` (Chromium, WebView2), sinon un message (jamais une minuterie : aucune horloge factice ne la retient). */
function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export function createSlicer(now: () => number = () => performance.now(), budgetMs: number = SLICE_MS): Slicer {
  let start = now();
  return {
    async pause() {
      if (now() - start < budgetMs) return;
      await yieldToEventLoop();
      start = now();
    },
  };
}

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

/**
 * Bornes d'une lecture faite **hors transaction** (Y-05 critère 6, défaut 1 de la QA de Y-04 : la base n'est jamais tenue pendant la mise
 * en forme d'une grosse file). `cut` : hlc local pris **avant** la lecture (le dernier des hlc réservés) ; `maxSeq` : dernier numéro de
 * la file lu juste après. Toute écriture locale faite pendant la lecture a un hlc plus grand que `cut` et une entrée de numéro plus
 * grand que `maxSeq` : le champ qu'elle porte n'est pas publié dans ce cycle (ni son entrée retirée) et part au suivant ; la tête
 * publiée ne dépasse donc jamais `cut`, et aucune écriture non vue ne passe sous elle. Une création dont un champ est ainsi différé part
 * en deux opérations, que l'autre appareil recompose (`missing-row`, ADR 0011 §3.3) ; une ligne entière (« + ») ne part jamais en partie :
 * elle attend le cycle suivant avec toutes ses entrées.
 */
export interface MaterializeBounds {
  readonly maxSeq: number;
  readonly cut: Hlc;
}

/**
 * Lit la file et la transforme en opérations (valeurs courantes de la base). Sans `bounds`, à appeler dans **une seule transaction de
 * lecture** (aucune écriture ne s'intercale entre la file et les lignes) ; avec `bounds`, lecture par instructions courtes hors
 * transaction (valeurs et horloges d'une ligne toujours lues ensemble). `reserved` : hlc locaux neufs, **pris avant cette transaction**, donnés dans
 * l'ordre aux lignes entières (« + ») comme rang de publication (les suivantes partagent le dernier) : leurs horloges peuvent toutes
 * être sous la tête déjà publiée (rappel vivant d'une cible restaurée, ligne recréée par le report d'époque) et, classées à leur
 * maximum, un appel fait seulement de telles lignes serait refusé (`hlc-order`) à chaque cycle. Pris avant la lecture, ces hlc sont
 * inférieurs à toute écriture validée après elle : la tête publiée ne dépasse jamais une écriture que la lecture n'a pas vue (elle
 * serait sinon écartée comme déjà publiée). Les champs gardent leurs propres horloges.
 */
export async function materializeOutbox(
  repos: Repositories,
  self: DeviceId,
  publishedMax: Hlc | null,
  limit?: number,
  reserved: readonly Hlc[] = [],
  slicer: Slicer = NO_SLICING,
  bounds: MaterializeBounds | null = null,
): Promise<Materialized> {
  let nextReserved = 0;
  const outbox = await readOutboxPaged(repos, limit, slicer, bounds?.maxSeq);
  /** Écrit après la coupure : publié au cycle suivant. */
  const late = (hlc: Hlc): boolean => bounds !== null && hlc > bounds.cut;
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
    // Valeurs et horloges d'une ligne lues par une seule instruction : une écriture ne peut pas tomber entre les deux. Par paquets, avec
    // une pause possible entre deux (tâches courtes).
    const rows = new Map<string, ExportedRow>();
    for (let i = 0; i < ids.length; i += READ_CHUNK) {
      for (const [id, row] of await repos.sync.readRowsWithClocks(t, ids.slice(i, i + READ_CHUNK))) rows.set(id, row);
      await slicer.pause();
    }
    for (const [id, rowEntries] of rowsEntries) {
      await slicer.pause();
      const row = rows.get(id);
      if (!row) {
        stale.push(...rowEntries);
        continue;
      }
      const rowClocks = row.clocks;
      const fallback = rowClocks.get('*') ?? { hlc: row.hlc, base: null };
      if (rowEntries.some((entry) => entry.field === ROW_REPUBLISH_FIELD)) {
        // Ligne recréée par le report d'époque : republiée entière, une opération à son plus grand hlc.
        const f = new Map<string, SyncField>();
        let max: Hlc | null = null;
        // Une ligne entière part en entier ou pas du tout (seconde revue de Y-04, point 1) : l'appareil qui l'a purgée ne peut la recréer
        // qu'avec toutes ses colonnes (ADR 0011 §5.4). Un champ écrit après la coupure : rien de la ligne dans ce cycle, toutes ses
        // entrées restent (ni publiées ni retirées) ; elle part entière, avec ce champ, au cycle suivant.
        if (t.columns.some((col) => late((rowClocks.get(col.name) ?? fallback).hlc))) continue;
        for (const col of t.columns) {
          const clock = rowClocks.get(col.name) ?? fallback;
          f.set(col.name, [row.values.get(col.name) ?? null, clock.hlc, rowClocks.get(col.name)?.base ?? null]);
          if (max === null || clock.hlc > max) max = clock.hlc;
        }
        if (max === null) {
          stale.push(...rowEntries);
          continue;
        }
        const rank = reserved[Math.min(nextReserved, reserved.length - 1)];
        nextReserved += 1;
        const key = rank !== undefined && rank > max ? rank : max;
        for (const entry of rowEntries) entries.push({ entry, hlc: key });
        ops.push({ op: { t: t.name, id, at: row.updatedAt, f }, hlc: key, rank: tableRank(t.name) });
        continue;
      }
      const byHlc = new Map<Hlc, Map<string, SyncField>>();
      const entryHlc = new Map<OutboxEntry, Hlc>();
      const deferredEntries = new Set<OutboxEntry>();
      for (const entry of rowEntries) {
        const names = entry.field === '*' ? t.columns.map((c) => c.name) : t.columns.some((c) => c.name === entry.field) ? [entry.field] : [];
        for (const name of names) {
          const clock = rowClocks.get(name) ?? fallback;
          if (hlcDevice(clock.hlc) !== self || (publishedMax !== null && clock.hlc <= publishedMax)) continue;
          if (late(clock.hlc)) {
            deferredEntries.add(entry);
            continue;
          }
          const fields = byHlc.get(clock.hlc) ?? new Map<string, SyncField>();
          fields.set(name, [row.values.get(name) ?? null, clock.hlc, rowClocks.get(name)?.base ?? null]);
          byHlc.set(clock.hlc, fields);
          const known = entryHlc.get(entry);
          if (known === undefined || clock.hlc > known) entryHlc.set(entry, clock.hlc);
        }
      }
      for (const entry of rowEntries) {
        const hlc = entryHlc.get(entry);
        if (hlc !== undefined) entries.push({ entry, hlc });
        else if (!deferredEntries.has(entry)) stale.push(entry);
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
  const records: BuiltRecord[] = [];
  for (const _step of recordSteps(ops, sv, onTooLarge, records)) {
    // Chaque pas est un groupe de même hlc : sans découpage en tâches, on enchaîne.
  }
  return records;
}

/** Même résultat que `buildRecords`, avec une pause possible après chaque groupe de même hlc (tâches courtes). */
export async function buildRecordsSliced(ops: readonly PendingOp[], sv: number, onTooLarge: (op: SyncOp) => void, slicer: Slicer): Promise<BuiltRecord[]> {
  const records: BuiltRecord[] = [];
  for (const _step of recordSteps(ops, sv, onTooLarge, records)) await slicer.pause();
  return records;
}

/** Construit les enregistrements dans `records`, un pas par groupe de même hlc. */
function* recordSteps(ops: readonly PendingOp[], sv: number, onTooLarge: (op: SyncOp) => void, records: BuiltRecord[]): Generator<void> {
  const envelope = journalEnvelopeBytes(sv);
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
    const sizes = parts.map((op) => opTextBytes(op));
    const groupBytes = sizes.reduce((sum, size) => sum + size, 0);
    if (current.length > 0 && currentBytes + groupBytes > MAX_RECORD_PLAINTEXT_BYTES) flush();
    parts.forEach((op, index) => {
      const size = sizes[index] as number;
      if (current.length > 0 && currentBytes + size > MAX_RECORD_PLAINTEXT_BYTES) flush();
      current.push(op);
      currentBytes += size;
      currentMax = hlc;
    });
    yield;
  }
  flush();
}

function splitOp(op: SyncOp, envelope: number, onTooLarge: (op: SyncOp) => void): SyncOp[] {
  const out: SyncOp[] = [];
  // Chaque partie porte aussi `deleted_at` et le champ au plus grand hlc (quelques octets) : une ligne entière restaurée et découpée
  // reste reconnaissable à la réception comme une restauration fondée sur la trace (apply.ts), et toutes ses parties ont le même hlc
  // maximal, ce qui les garde dans un même groupe à la lecture (reader.ts ne coupe jamais un groupe de même hlc).
  // Champ partagé : le plus petit des champs au hlc maximal (une longue note recopiée dans chaque partie ferait refuser l'opération).
  let maxHlc: Hlc | null = null;
  for (const field of op.f.values()) if (maxHlc === null || field[1] > maxHlc) maxHlc = field[1];
  let top: string | null = null;
  let topBytes = Infinity;
  for (const [name, field] of op.f) {
    if (field[1] !== maxHlc) continue;
    const bytes = utf8Bytes(JSON.stringify(field[0]));
    if (bytes < topBytes) {
      top = name;
      topBytes = bytes;
    }
  }
  const shared = new Map<string, SyncField>();
  const deletedAt = op.f.get('deleted_at');
  if (deletedAt) shared.set('deleted_at', deletedAt);
  if (top !== null) shared.set(top, op.f.get(top) as SyncField);
  for (const [name, field] of op.f) {
    if (shared.has(name) && op.f.size > shared.size) continue;
    // Partie avec les champs partagés si elle tient ; sinon avec deleted_at seul ; sinon le champ seul (au-delà : refusé, journalisé).
    const variants = [[...shared].filter(([n]) => n !== name), [...shared].filter(([n]) => n !== name && n === 'deleted_at'), []];
    const fitting = variants.map((extra) => ({ ...op, f: new Map<string, SyncField>([[name, field], ...extra]) })).find((part) => opTextBytes(part) + envelope <= MAX_RECORD_PLAINTEXT_BYTES);
    if (fitting) out.push(fitting);
    else onTooLarge({ ...op, f: new Map<string, SyncField>([[name, field]]) });
  }
  return out;
}

/**
 * Appels d'ajout : 1 Mio écrit au plus par appel, et **jamais un même hlc coupé entre deux appels** (Rust exige un `maxHlc` strictement
 * croissant d'un appel à l'autre : la suite d'un hlc dans l'appel suivant serait refusée, `hlc-order`, à chaque cycle). Les
 * enregistrements d'un même hlc sont consécutifs (`buildRecords`) ; un groupe qui dépasse à lui seul 1 Mio est refusé (`onTooLarge`).
 */
export function batchRecords(records: readonly BuiltRecord[], onTooLarge: (hlc: Hlc) => void = () => undefined): BuiltRecord[][] {
  const groups: { hlc: Hlc; records: BuiltRecord[]; bytes: number }[] = [];
  for (const record of records) {
    const last = groups.at(-1);
    if (last && last.hlc === record.maxHlc) {
      last.records.push(record);
      last.bytes += record.bytes;
    } else {
      groups.push({ hlc: record.maxHlc, records: [record], bytes: record.bytes });
    }
  }
  const batches: BuiltRecord[][] = [];
  let batch: BuiltRecord[] = [];
  let bytes = 0;
  for (const group of groups) {
    if (group.bytes > MAX_APPEND_CALL_BYTES) {
      onTooLarge(group.hlc);
      continue;
    }
    if (batch.length > 0 && bytes + group.bytes > MAX_APPEND_CALL_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(...group.records);
    bytes += group.bytes;
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
  // Rangs des lignes entières réservés avant la lecture (le pilote est sérialisé : toute écriture tamponnée avant est déjà en file et
  // sera vue ; toute écriture tamponnée après a un hlc plus grand).
  // Tâches courtes (Y-05 critère 6) : une grosse file est lue et mise en forme par tranches, la boucle d'événements reprend la main entre deux.
  const slicer = createSlicer();
  const wholeRows = (await readOutboxPaged(data.repos, undefined, slicer)).filter((e) => e.field === ROW_REPUBLISH_FIELD).length;
  const reserved = Array.from({ length: wholeRows + 1 }, () => deps.hlc.now());
  // Coupure : dernier hlc réservé, puis dernier numéro de la file. La lecture se fait ensuite par instructions courtes, hors
  // transaction : l'interface lit et écrit pendant la mise en forme ; ce qu'elle écrit part au cycle suivant (voir MaterializeBounds).
  const bounds: MaterializeBounds = { cut: reserved.at(-1) as Hlc, maxSeq: await data.repos.sync.maxOutboxSeq() };
  const material = await materializeOutbox(data.repos, deviceId, head.epoch === epoch ? head.hlc : null, undefined, reserved, slicer, bounds);
  // Entrées lues sans rien à publier : retirées par numéro (une écriture faite depuis la lecture a un nouveau numéro et reste).
  if (material.stale.length > 0) await data.transaction((repos) => repos.sync.dropOutbox(material.stale));
  if (material.ops.length === 0) return { published: 0, head, error: null };
  const records = await buildRecordsSliced(material.ops, sv, (op) => logger.log('publish-too-large', { table: op.t }), slicer);
  const refused = new Set<Hlc>();
  const batches = batchRecords(records, (hlc) => {
    refused.add(hlc);
    logger.log('publish-too-large', { table: 'group' });
  });
  // Opération trop grosse pour un appel : refusée et journalisée, ses entrées sont retirées (par numéro) au lieu de bloquer la file.
  const refusedEntries = material.entries.filter((e) => refused.has(e.hlc)).map((e) => e.entry);
  if (refusedEntries.length > 0) await data.transaction((repos) => repos.sync.dropOutbox(refusedEntries));
  // Entrées à retirer après le lot qui porte leur plus grand hlc.
  const pending = material.entries.filter((e) => !refused.has(e.hlc)).sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
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
      // ADR 0011 §22 point 6 : échéance comparée avant l'unité « intention, ajout, retrait de la file », jamais au milieu.
      deps.deadline?.check('append');
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
