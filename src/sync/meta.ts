import type { Repositories } from '../db/repositories';
import { parseStoredJson, type StoredStateLog } from '../db/repositories/syncRepository';
import { defaultSyncLogger } from './log';

/** Clés de `sync_meta` (état local du moteur, jamais publié). */
export const META = {
  /** Époque courante suivie par cet appareil. */
  epoch: 'epoch',
  /** Plus grand `stateSeq` écrit par cet appareil (toutes époques). */
  stateSeq: 'stateSeq',
  /** Tête de ses propres ajouts dans l'époque courante (`DeviceAck`). */
  head: 'head',
  /** Intention d'ajout en cours (publisher). */
  inflight: 'inflight',
  /** Dernier état écrit : texte sans `lastSyncHlc`, heure d'écriture (réécriture seulement s'il a changé, section 1.4). */
  lastState: 'lastState',
  /** Dernier instantané écrit par cet appareil dans l'époque courante. */
  snapshot: 'snapshot',
  /** Plus grand `deleted_hlc` purgé par cet appareil (Y-09). */
  purgeHorizon: 'purgeHorizon',
  /** Changement d'époque en cours (section 9.1). */
  epochSwitch: 'epochSwitch',
  /** Dernier numéro de file reporté pendant le changement d'époque (écritures faites depuis le début de (a)). */
  epochCarry: 'epochCarry',
  /** Heure du dernier ajout à chacun de ses segments de l'époque courante (purge à 30 jours, section 5.3). */
  segments: 'segments',
  /** Reprise depuis l'instantané demandée (corruption, « Garder », 180 jours). */
  resume: 'resume',
} as const;

/** Valeur JSON de `sync_meta` ; absente : null ; illisible : `SyncStateUnreadableError` journalisée (jamais lue comme absente). */
export async function readJson<T>(repos: Repositories, key: string, log: StoredStateLog = defaultSyncLogger): Promise<T | null> {
  const raw = await repos.sync.getMeta(key);
  if (raw === null) return null;
  return parseStoredJson(raw, `sync_meta.${key}`, log) as T;
}

export async function writeJson(repos: Repositories, key: string, value: unknown): Promise<void> {
  await repos.sync.setMeta(key, value === null || value === undefined ? null : JSON.stringify(value));
}
