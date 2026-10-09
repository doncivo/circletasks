import type { Repositories } from '../db/repositories';
import { parseStoredJson, type StoredStateLog } from '../domain/sync/stored';
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
  /** Y-TECH-02 (seconde revue, point 6) : début de l'attente d'iCloud en cours (ISO), effacé quand elle cesse. */
  waitingSince: 'waitingSince',
  /** Quatrième revue, point B : trous impossibles à combler, par appareil lu (ADR 0011 §5.5). */
  segmentGaps: 'segmentGaps',
  /** Cinquième revue, point 1 : dernier instantané essayé par une reprise, `{epoch, author, seq}` (ADR 0011 §5.5). */
  resumeTried: 'resumeTried',
  /** Y-IOS-02 : époque pour laquelle une reprise a déjà été demandée parce que des opérations restaient en attente d'une ligne (une fois par époque). */
  parkedResume: 'parkedResume',
  /** Y-IOS-02 : époque orpheline abandonnée dont les fichiers restent à supprimer, `{epoch}`. */
  orphanEpoch: 'orphanEpoch',
  /** Dernier choix refusé ou en échec après une restauration (`restoreChoice.ts`, chargé à la demande). */
  restoreFailure: 'restoreFailure',
  /** Y-IOS-02 : traces purgées (`table|id`) de l'orpheline abandonnée, auteur cet appareil (garde `orphan-trace-hit`, §24 point 4 (a)). */
  orphanTraces: 'orphanTraces',
  /** Y-IOS-02 : une opération reçue a visé l'une de ces traces ; levé en avertissement `received-unapplied` au cycle suivant. */
  orphanTraceHit: 'orphanTraceHit',
  /** Y-IOS-02 : reprise complète demandée par l'utilisateur : acquitte `orphanTraceHit` (effacé au cycle qui reprend). */
  orphanTraceAck: 'orphanTraceAck',
  /** Y-IOS-02 : « Démarrer la synchro depuis cet appareil » confirmé : lève l'attente des autres appareils (clé importée). */
  startHere: 'startHere',
  /** Quatrième revue, point D : repères `[stateSeq, lastSyncHlc]` de ses états publiés (ADR 0011 §5.5, condition 3). */
  ownStateHlcs: 'ownStateHlcs',
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
