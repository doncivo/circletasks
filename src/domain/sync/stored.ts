import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { isDeviceAck, isEpochId, isStrictHlc, isSyncDeviceId, type DeviceAck, type EpochId } from './format';

/**
 * Analyse des valeurs JSON stockées de l'état local de la synchro (`sync_meta`, `sync_state.last_acks`) : module pur (Y-TECH-02, point 4 ;
 * revue, suggestion 12). Une valeur illisible n'est jamais lue comme « aucune » : journalisée, `SyncStateUnreadableError`
 * (`state-unreadable`, ADR 0011 §19 point 7).
 */

/** Journal des incidents de lecture (forme de `SyncLogger` de `src/sync/log.ts`) : codes et noms seulement, jamais la valeur lue. */
export interface StoredStateLog {
  log(event: string, detail?: Readonly<Record<string, string | number | boolean | null>>): void;
}

/**
 * Valeur stockée de l'état local de la synchro (`sync_meta`, `sync_state.last_acks`) illisible : état `state-unreadable` (ADR 0011 §19
 * point 7), jamais lue comme « aucune ». `code` : code de cycle (`io`, aucun code d'erreur nouveau) ; `where` : clé ou colonne, sans valeur.
 */
export class SyncStateUnreadableError extends Error {
  override readonly name = 'SyncStateUnreadableError';
  readonly code = 'io';
  constructor(readonly where: string) {
    super(`état local de la synchro illisible : ${where}`);
  }
}

/** Erreur d'un état local illisible (reconnue par sa classe, après un `throw` ou une promesse rejetée). */
export function isSyncStateUnreadable(error: unknown): error is SyncStateUnreadableError {
  return error instanceof SyncStateUnreadableError;
}

function unreadable(where: string, log: StoredStateLog): never {
  log.log('state-unreadable', { where });
  throw new SyncStateUnreadableError(where);
}

/** Seule analyse d'une valeur JSON stockée : JSON corrompu → journalisé, `SyncStateUnreadableError`. */
export function parseStoredJson(raw: string, where: string, log: StoredStateLog): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return unreadable(where, log);
  }
}

/** Seule analyse des accusés stockés (`sync_state.last_acks`) : objet d'accusés valides, sinon `SyncStateUnreadableError` journalisée. */
export function parseStoredAcks(raw: string, where: string, log: StoredStateLog): Map<DeviceId, DeviceAck> {
  const value = parseStoredJson(raw, where, log);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return unreadable(where, log);
  const out = new Map<DeviceId, DeviceAck>();
  for (const [id, ack] of Object.entries(value as Record<string, unknown>)) {
    if (!isDeviceAck(ack)) return unreadable(where, log);
    out.set(id as DeviceId, ack);
  }
  return out;
}

/** Date ISO complète en UTC telle qu'écrite par `toISOString()`. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * Troisième revue, point M1 : seule analyse d'une date stockée (`sync_meta.waitingSince`) : absente → null ; chaîne ISO valide → la date ;
 * toute autre valeur (JSON corrompu, nombre, texte, date impossible) → journalisée, `SyncStateUnreadableError` (jamais lue comme absente).
 */
export function parseStoredIso(raw: string | null, where: string, log: StoredStateLog): IsoDateTime | null {
  if (raw === null) return null;
  const value = parseStoredJson(raw, where, log);
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return unreadable(where, log);
  const ms = Date.parse(value);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return unreadable(where, log);
  return value as IsoDateTime;
}

/**
 * Quatrième revue, point D : seule analyse des repères de ses états publiés (`sync_meta.ownStateHlcs`) : absente → [] ; liste de
 * `[stateSeq, lastSyncHlc]` (entier positif, hlc strict) à `stateSeq` strictement croissant → la liste ; sinon journalisée,
 * `SyncStateUnreadableError` (l'appelant n'en tire alors aucune preuve et la réécrit à la prochaine écriture de son état).
 */
export function parseStoredOwnStateMarks(raw: string | null, where: string, log: StoredStateLog): Array<readonly [number, Hlc]> {
  if (raw === null) return [];
  const value = parseStoredJson(raw, where, log);
  if (!Array.isArray(value)) return unreadable(where, log);
  const out: Array<readonly [number, Hlc]> = [];
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return unreadable(where, log);
    const [seq, hlc] = entry as [unknown, unknown];
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || !isStrictHlc(hlc)) return unreadable(where, log);
    const last = out.at(-1);
    if (last !== undefined && seq <= last[0]) return unreadable(where, log);
    out.push([seq, hlc]);
  }
  return out;
}

/** Trou mémorisé (forme de `SegmentGap` de `retention.ts`). */
export interface StoredSegmentGap {
  readonly epoch: EpochId;
  readonly segment: number;
  readonly author: DeviceId | null;
  readonly seq: number | null;
  readonly since: IsoDateTime;
}

/**
 * Quatrième revue, point B : seule analyse des trous mémorisés (`sync_meta.segmentGaps`) : absente → aucun ; objet d'entrées valides par
 * appareil ; sinon journalisée, `SyncStateUnreadableError` (`state-unreadable` visible, jamais lue comme « aucun trou »).
 */
export function parseStoredSegmentGaps(raw: string | null, where: string, log: StoredStateLog): Map<DeviceId, StoredSegmentGap> {
  const out = new Map<DeviceId, StoredSegmentGap>();
  if (raw === null) return out;
  const value = parseStoredJson(raw, where, log);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return unreadable(where, log);
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isSyncDeviceId(id) || typeof entry !== 'object' || entry === null) return unreadable(where, log);
    const { epoch, segment, author, seq, since } = entry as Record<string, unknown>;
    const validSince = typeof since === 'string' && ISO_UTC.test(since) && !Number.isNaN(Date.parse(since));
    if (!isEpochId(epoch) || !isCount(segment) || !(author === null || isSyncDeviceId(author)) || !(seq === null || isCount(seq)) || !validSince) return unreadable(where, log);
    out.set(id as DeviceId, { epoch, segment, author: author as DeviceId | null, seq: seq as number | null, since: since as IsoDateTime });
  }
  return out;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
