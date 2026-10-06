/**
 * Analyse stricte et écriture canonique du texte clair de la synchronisation (ADR 0011, sections 1.4, 3.1, 5.1 ; audit H5, M4 ;
 * Y-02 critère 6).
 *
 * Tout texte déchiffré est hostile tant qu'il n'a pas passé ce module :
 * - schéma écrit à la main, clés exactes à chaque niveau ;
 * - toute clé `__proto__`, `constructor` ou `prototype`, à n'importe quel niveau, refuse l'enregistrement entier ;
 * - une clé répétée dans un même objet est refusée (JSON.parse garderait la dernière, serde refuse) ;
 * - chaque hlc est validé par l'expression stricte **avant** toute comparaison ;
 * - les champs deviennent des `Map` (jamais un objet ordinaire indexé par un nom reçu).
 * Les noms de tables et de colonnes ne sont pas contrôlés ici (le catalogue s'en charge à l'application) : seule leur forme l'est.
 *
 * Module pur.
 */

import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { isIsoDateTime } from '../types';
import {
  FORBIDDEN_KEYS,
  hasStrictJsonShape,
  isDeviceAck,
  isEpochId,
  isStrictHlc,
  isSyncDeviceId,
  publishedStateFromJson,
  publishedStateToJson,
  type DeviceAck,
  type JournalRecord,
  type PublishedDeviceState,
  type SnapshotClocks,
  type SnapshotRecord,
  type SnapshotRow,
  type SnapshotUnknownField,
  type SyncField,
  type SyncOp,
  type SyncValue,
} from './format';
import { MAX_RECORD_PLAINTEXT_BYTES, MAX_SYNC_ID_LENGTH, utf8Bytes } from './limits';

/** Forme d'un nom de table ou de champ reçu (avant le catalogue) : identifiant SQL simple, ou `*` pour les horloges. */
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

// ---------------------------------------------------------------------------------------------------------------------------------
// Garde lexicale : clés interdites et clés répétées, à tous les niveaux
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Parcours caractère par caractère d'un texte JSON (déjà accepté par JSON.parse) : vrai si aucun objet ne répète une clé et si aucune
 * clé n'est interdite. Les chaînes et leurs échappements sont suivis ; une valeur ne peut pas imiter une clé.
 */
export function hasSafeJsonKeys(text: string): boolean {
  const stack: ({ readonly object: true; readonly keys: Set<string>; expectKey: boolean } | { readonly object: false })[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      let raw = '';
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') {
          raw += text.slice(end, end + 2);
          end += 2;
        } else {
          raw += text[end];
          end += 1;
        }
      }
      const top = stack.at(-1);
      if (top?.object === true && top.expectKey) {
        let key: string;
        try {
          key = JSON.parse(`"${raw}"`) as string;
        } catch {
          return false;
        }
        if (FORBIDDEN_KEYS.has(key) || top.keys.has(key)) return false;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (ch === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ object: false });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack.at(-1);
      if (top?.object === true) top.expectKey = true;
    }
    i += 1;
  }
  return true;
}

/** JSON.parse protégé : texte borné, clés sûres ; null en cas d'échec. */
function parseJsonSafely(text: string, maxBytes = MAX_RECORD_PLAINTEXT_BYTES): unknown {
  if (typeof text !== 'string' || utf8Bytes(text) > maxBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return hasSafeJsonKeys(text) ? value : null;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const isSyncValue = (value: unknown): value is SyncValue => value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isRowIdShape(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SYNC_ID_LENGTH && !FORBIDDEN_KEYS.has(value);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Journal (section 3.1)
// ---------------------------------------------------------------------------------------------------------------------------------

function parseField(value: unknown): SyncField | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [v, hlc, base] = value as unknown[];
  if (!isSyncValue(v) || !isStrictHlc(hlc) || !(base === null || isStrictHlc(base))) return null;
  return [v, hlc, base];
}

function parseOp(value: unknown): SyncOp | null {
  if (!hasExactKeys(value, ['t', 'id', 'at', 'f'])) return null;
  const { t, id, at, f } = value;
  if (typeof t !== 'string' || !NAME_RE.test(t) || !isRowIdShape(id) || typeof at !== 'string' || !isIsoDateTime(at) || !isPlainObject(f)) return null;
  const names = Object.keys(f);
  if (names.length === 0) return null;
  const fields = new Map<string, SyncField>();
  for (const name of names) {
    if (!NAME_RE.test(name)) return null;
    const field = parseField(f[name]);
    if (!field) return null;
    fields.set(name, field);
  }
  return { t, id, at: at, f: fields };
}

/** Enregistrement de journal : `{"k":"ops","sv":n,"ops":[…]}` ; null si le texte est invalide (corruption, rien n'est appliqué). */
export function parseJournalRecord(text: string): JournalRecord | null {
  const value = parseJsonSafely(text);
  if (!hasExactKeys(value, ['k', 'sv', 'ops']) || value['k'] !== 'ops' || !isPositiveInt(value['sv']) || !Array.isArray(value['ops'])) return null;
  const ops: SyncOp[] = [];
  for (const raw of value['ops'] as unknown[]) {
    const op = parseOp(raw);
    if (!op) return null;
    ops.push(op);
  }
  return { k: 'ops', sv: value['sv'], ops };
}

/** Texte canonique d'une opération (`f` dans l'ordre de la Map). */
function opToJson(op: SyncOp): Record<string, unknown> {
  const f: Record<string, SyncField> = Object.create(null) as Record<string, SyncField>;
  for (const [name, field] of op.f) f[name] = field;
  return { t: op.t, id: op.id, at: op.at, f };
}

export function journalRecordToText(record: JournalRecord): string {
  return JSON.stringify({ k: 'ops', sv: record.sv, ops: record.ops.map(opToJson) });
}

/** Taille du texte clair d'une opération dans un enregistrement (virgule de séparation comprise). */
export function opTextBytes(op: SyncOp): number {
  return utf8Bytes(JSON.stringify(opToJson(op))) + 1;
}

/** Enveloppe d'un enregistrement vide (`{"k":"ops","sv":…,"ops":[]}`). */
export function journalEnvelopeBytes(sv: number): number {
  return utf8Bytes(journalRecordToText({ k: 'ops', sv, ops: [] }));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Instantané (section 5.1)
// ---------------------------------------------------------------------------------------------------------------------------------

function parseRowObject(value: unknown): ReadonlyMap<string, SyncValue> | null {
  if (!isPlainObject(value)) return null;
  const row = new Map<string, SyncValue>();
  for (const name of Object.keys(value)) {
    const v = value[name];
    if (!(NAME_RE.test(name) || name === 'id' || name === 'key') || !isSyncValue(v)) return null;
    row.set(name, v);
  }
  return row;
}

function parseClocks(value: unknown): SnapshotClocks | null {
  if (!isPlainObject(value)) return null;
  const clocks = new Map<string, Hlc>();
  for (const name of Object.keys(value)) {
    const hlc = value[name];
    if (!(name === '*' || NAME_RE.test(name)) || !isStrictHlc(hlc)) return null;
    clocks.set(name, hlc);
  }
  return clocks.has('*') ? clocks : null;
}

function parseSnapshotRow(value: unknown): SnapshotRow | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [t, row, clocks] = value as unknown[];
  if (typeof t !== 'string' || !NAME_RE.test(t)) return null;
  const parsedRow = parseRowObject(row);
  const parsedClocks = parseClocks(clocks);
  return parsedRow && parsedClocks ? [t, parsedRow, parsedClocks] : null;
}

function parseUnknownField(value: unknown): SnapshotUnknownField | null {
  if (!hasExactKeys(value, ['t', 'id', 'field', 'value', 'hlc', 'base', 'sv'])) return null;
  const { t, id, field, hlc, base, sv } = value;
  const v = value['value'];
  if (typeof t !== 'string' || !NAME_RE.test(t) || !isRowIdShape(id) || typeof field !== 'string' || !NAME_RE.test(field)) return null;
  if (!isSyncValue(v) || !isStrictHlc(hlc) || !(base === null || isStrictHlc(base)) || !isPositiveInt(sv)) return null;
  return { t, id, field, value: v, hlc, base, sv };
}

function parseCovers(value: unknown): ReadonlyMap<DeviceId, DeviceAck> | null {
  if (!isPlainObject(value)) return null;
  const covers = new Map<DeviceId, DeviceAck>();
  for (const id of Object.keys(value)) {
    const ack = value[id];
    if (!isSyncDeviceId(id) || !isDeviceAck(ack)) return null;
    covers.set(id, ack);
  }
  return covers;
}

/** Enregistrement d'instantané ; null si invalide (l'instantané entier est alors ignoré). */
export function parseSnapshotRecord(text: string): SnapshotRecord | null {
  const value = parseJsonSafely(text);
  if (!isPlainObject(value)) return null;
  switch (value['k']) {
    case 'snap-rows': {
      if (!hasExactKeys(value, ['k', 'rows']) || !Array.isArray(value['rows'])) return null;
      const rows: SnapshotRow[] = [];
      for (const raw of value['rows'] as unknown[]) {
        const row = parseSnapshotRow(raw);
        if (!row) return null;
        rows.push(row);
      }
      return { k: 'snap-rows', rows };
    }
    case 'snap-row': {
      if (!hasExactKeys(value, ['k', 't', 'row', 'clocks'])) return null;
      const row = parseSnapshotRow([value['t'], value['row'], value['clocks']]);
      return row ? { k: 'snap-row', t: row[0], row: row[1], clocks: row[2] } : null;
    }
    case 'snap-unknown': {
      if (!hasExactKeys(value, ['k', 'fields']) || !Array.isArray(value['fields'])) return null;
      const fields: SnapshotUnknownField[] = [];
      for (const raw of value['fields'] as unknown[]) {
        const field = parseUnknownField(raw);
        if (!field) return null;
        fields.push(field);
      }
      return { k: 'snap-unknown', fields };
    }
    case 'snap-tombstones': {
      if (!hasExactKeys(value, ['k', 'ids']) || !Array.isArray(value['ids'])) return null;
      const ids: (readonly [string, string, Hlc])[] = [];
      for (const raw of value['ids'] as unknown[]) {
        if (!Array.isArray(raw) || raw.length !== 3) return null;
        const [t, id, hlc] = raw as unknown[];
        if (typeof t !== 'string' || !NAME_RE.test(t) || !isRowIdShape(id) || !isStrictHlc(hlc)) return null;
        ids.push([t, id, hlc]);
      }
      return { k: 'snap-tombstones', ids };
    }
    case 'snap-end': {
      if (!hasExactKeys(value, ['k', 'count', 'covers', 'epoch', 'sv'])) return null;
      const covers = parseCovers(value['covers']);
      if (!isCount(value['count']) || !covers || !isEpochId(value['epoch']) || !isPositiveInt(value['sv'])) return null;
      return { k: 'snap-end', count: value['count'], covers, epoch: value['epoch'], sv: value['sv'] };
    }
    default:
      return null;
  }
}

const mapToObject = <V>(map: ReadonlyMap<string, V>): Record<string, V> => {
  const out: Record<string, V> = Object.create(null) as Record<string, V>;
  for (const [key, value] of map) out[key] = value;
  return out;
};

export function snapshotRowToJson(row: SnapshotRow): unknown {
  return [row[0], mapToObject(row[1]), mapToObject(row[2])];
}

export function snapshotRecordToText(record: SnapshotRecord): string {
  switch (record.k) {
    case 'snap-rows':
      return JSON.stringify({ k: record.k, rows: record.rows.map(snapshotRowToJson) });
    case 'snap-row':
      return JSON.stringify({ k: record.k, t: record.t, row: mapToObject(record.row), clocks: mapToObject(record.clocks) });
    case 'snap-unknown':
      return JSON.stringify({ k: record.k, fields: record.fields });
    case 'snap-tombstones':
      return JSON.stringify({ k: record.k, ids: record.ids });
    case 'snap-end':
      return JSON.stringify({ k: record.k, count: record.count, covers: mapToObject(record.covers), epoch: record.epoch, sv: record.sv });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// État publié (section 1.4)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Texte clair de `state.ctx` : forme lexicale de serde (clés de premier niveau comptées, répétitions comprises ; entiers canoniques),
 * clés sûres à tous les niveaux, puis analyse stricte de la forme (`publishedStateFromJson`). Null : état `corrupt`.
 */
export function parsePublishedStateText(text: string): PublishedDeviceState | null {
  const value = parseJsonSafely(text);
  if (!isPlainObject(value)) return null;
  // Clés facultatives de premier niveau : `pairedBy` et `closed` (Y-TECH-02, ADR 0011 §21 point 2).
  const keys = 14 + (Object.prototype.hasOwnProperty.call(value, 'pairedBy') ? 1 : 0) + (Object.prototype.hasOwnProperty.call(value, 'closed') ? 1 : 0);
  if (!hasStrictJsonShape(text, keys)) return null;
  return publishedStateFromJson(value);
}

/** Texte canonique de l'état publié (même état ⇒ même texte, condensé stable). */
export function publishedStateToText(state: PublishedDeviceState): string {
  return JSON.stringify(publishedStateToJson(state));
}

/** Date d'un hlc strict (temps physique, ms) ; à n'appeler qu'après validation. */
export function hlcMs(hlc: Hlc): number {
  return Number(hlc.slice(0, 15));
}

/** Appareil d'un hlc strict. */
export function hlcDevice(hlc: Hlc): DeviceId {
  return hlc.slice(21) as DeviceId;
}

/** Instant ISO d'un hlc (affichage, comparaison avec une date de sauvegarde). */
export function hlcIso(hlc: Hlc): IsoDateTime {
  return new Date(hlcMs(hlc)).toISOString() as IsoDateTime;
}
