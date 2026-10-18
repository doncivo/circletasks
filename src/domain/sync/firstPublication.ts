/**
 * Y-FIX-02 (ADR 0011 §30, complète §1.4 et §24 point 10) : borne locale de la première publication. Un appareil qui n'a jamais écrit son
 * état (`stateSeq` local 0) mais a une **trace locale d'ajout** dans l'époque courante (`META.inflight`, ou `META.head` avec un segment) sait
 * ce qu'il a écrit : si chaque fichier de son dossier qui borne la publication (`listedFilesForPublish`) est expliqué par cette trace, il
 * présente son état à Rust, qui juge la tête (`write_state` : égale à `own.json`, sinon `state-mismatch`). Un fichier que la trace
 * n'explique pas garde la règle de §24 point 10 (`publish-blocked`).
 *
 * Module pur, chargé seulement par le chemin rare du moteur (`src/sync/firstPublication.ts`, à la demande) : hors du bundle de départ. Aucun
 * import exécutable (types seulement) : un import d'un module du départ le sortirait de son bloc (mesure de Y-FIX-02, +4 016 octets).
 */

import type { OwnEpochListing } from './epoch';
import type { EpochId } from './format';

/** Source de la trace locale d'ajout (journal `own-state-recovered`). */
export type LocalTraceSource = 'inflight' | 'local-head';

export interface LocalBoundInput {
  readonly currentEpoch: EpochId;
  /** `META.stateSeq` : 0 tant qu'aucun état n'a été écrit (fenêtre de la première publication). */
  readonly localSeq: number;
  /** `META.inflight` (intention d'ajout posée avant `appendJournal`). */
  readonly inflight: { readonly epoch: EpochId; readonly segment: number } | null;
  /** `META.head` (tête locale, posée dans la transaction qui suit l'ajout). */
  readonly head: { readonly epoch: EpochId; readonly segment: number } | null;
  /** `META.snapshot` (instantané enregistré localement). */
  readonly snapshot: { readonly epoch: EpochId; readonly seq: number } | null;
  /** Époques listées dans son propre dossier (forme du scan). */
  readonly ownEpochs: readonly OwnEpochListing[];
  /** Fichiers comptés par la règle actuelle : `listedFilesForPublish(ownEpochs, ...).counted` (même liste, calculée par l'appelant). */
  readonly files: number;
  /** Appareils dont l'état n'est pas lisible à ce scan (`unreadableDevices`). */
  readonly unreadable: number;
}

export interface LocalBound {
  /** La borne est ouverte : publier sans état ni accusé, Rust juge. */
  readonly covers: boolean;
  /** Trace locale d'ajout de l'époque courante (null : aucune). */
  readonly source: LocalTraceSource | null;
  /** Fichiers comptés que la trace n'explique pas (0 sans trace : la règle actuelle s'applique seule). */
  readonly unexplained: number;
}

/**
 * Règle de la borne locale (fiche Y-FIX-02, décision 2) : ouverte si et seulement si (a) trace locale d'ajout dans l'époque courante,
 * (b) `localSeq === 0`, (c) chaque fichier compté est expliqué (segments de l'époque courante de numéro au plus le plus grand segment
 * de la trace, instantané de l'époque courante enregistré localement), (d) aucun appareil illisible au scan.
 */
export function localBoundCovers(input: LocalBoundInput): LocalBound {
  const { currentEpoch: epoch } = input;
  const inflight = input.inflight?.epoch === epoch ? input.inflight : null;
  const head = input.head?.epoch === epoch && input.head.segment >= 1 ? input.head : null;
  const source: LocalTraceSource | null = inflight ? 'inflight' : head ? 'local-head' : null;
  // (b) : un état déjà écrit garde la règle de §24 point 10 (état supprimé après publication), sans cause nouvelle.
  if (source === null || input.localSeq !== 0) return { covers: false, source, unexplained: 0 };
  const traced = Math.max(inflight?.segment ?? 0, head?.segment ?? 0);
  const current = input.ownEpochs.find((e) => e.epoch === epoch);
  const snapshot = input.snapshot?.epoch === epoch ? input.snapshot.seq : null;
  const explained = (current?.segments.filter((s) => s <= traced).length ?? 0) + (current?.snapshots.filter((s) => s === snapshot).length ?? 0);
  const unexplained = input.files - explained;
  return { covers: unexplained === 0 && input.unreadable === 0, source, unexplained };
}
