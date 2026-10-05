import type { Repositories } from '../db/repositories';

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
  /** Heure du dernier ajout à chacun de ses segments de l'époque courante (purge à 30 jours, section 5.3). */
  segments: 'segments',
  /** Reprise depuis l'instantané demandée (corruption, « Garder », 180 jours). */
  resume: 'resume',
} as const;

export async function readJson<T>(repos: Repositories, key: string): Promise<T | null> {
  const raw = await repos.sync.getMeta(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJson(repos: Repositories, key: string, value: unknown): Promise<void> {
  await repos.sync.setMeta(key, value === null || value === undefined ? null : JSON.stringify(value));
}
