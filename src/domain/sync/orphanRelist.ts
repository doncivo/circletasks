/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : choix des restes d'orpheline à réarmer. Module pur, séparé de `epoch.ts` (importé par le moteur
 * au départ) : il n'est chargé qu'avec `src/sync/orphanEpoch.ts`, à la demande (cas rare, taille du bundle de départ).
 */

import type { DeviceId } from '../types';
import { compareEpochs, parseEpochId, type EpochId } from './format';
import type { OwnEpochListing } from './epoch';

/**
 * Y-IOS-02-FIX-02 (ADR 0011 §24 point 10) : époques de son propre dossier à supprimer comme restes d'orpheline quand le mémo
 * `sync_meta.orphanEpoch` a été perdu (cause racine : substitut `.icloud` d'un fichier évincé, non supprimé par le plugin). Une époque l'est si :
 * ouverte par cet appareil, **plus grande** que l'époque courante, des instantanés et aucun segment, ni l'époque locale (`sync_meta.epoch`),
 * jamais annoncée (ni par son propre état publié, ni par un état ou un accusé d'un autre appareil). Son propre état publié doit être
 * **connu** (`ownAnnounced` non nul : écrit dans ce cycle ou lu au scan) : sinon rien n'est retenu. Triées, la plus petite d'abord.
 * Pourquoi « plus grande » : l'époque de `own.json` ne recule jamais (Rust refuse toute écriture dans une époque plus ancienne), sauf par
 * l'abandon d'une orpheline (preuve : aucun segment). Une époque plus grande que la courante n'a donc jamais reçu un segment de cet appareil,
 * même si un listing iCloud transitoire en cache une partie : sa suppression ne peut rien effacer de publié. Une orpheline plus petite que
 * l'époque courante ne borne déjà plus la publication (`listedFilesForPublish`) et part avec les anciennes époques (`maintain`).
 */
export function relistedOrphanEpochs(input: {
  readonly self: DeviceId;
  readonly ownEpochs: readonly OwnEpochListing[];
  readonly currentEpoch: EpochId;
  readonly localEpoch: EpochId | null;
  /** Époque annoncée par son propre état publié ; null : état inconnu. */
  readonly ownAnnounced: EpochId | null;
  /** Époques des états acceptés des autres appareils et de leurs accusés sur soi. */
  readonly announced: readonly EpochId[];
}): EpochId[] {
  if (input.ownAnnounced === null) return [];
  const out: EpochId[] = [];
  for (const e of input.ownEpochs) {
    if (e.segments.length > 0 || e.snapshots.length === 0) continue;
    if (parseEpochId(e.epoch)?.opener !== input.self || parseEpochId(input.currentEpoch) === null) continue;
    if (compareEpochs(e.epoch, input.currentEpoch) <= 0 || e.epoch === input.localEpoch || e.epoch === input.ownAnnounced || input.announced.includes(e.epoch)) continue;
    out.push(e.epoch);
  }
  return out.sort(compareEpochs);
}
