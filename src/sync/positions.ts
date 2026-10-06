import type { SyncStatePatch, SyncStateRow } from '../db/repositories';
import { compareEpochs, type DeviceAck, type EpochId } from '../domain/sync/format';

/**
 * Position locale sur un autre appareil quand la base vient d'un instantané (Y-TECH-01, même règle que Y-11 §18 point 14 : **aucun accusé
 * {époque, 0, 0} sur un appareil qui n'y a rien publié**). La lecture d'un appareil dans l'époque courante part de 0 dès que la ligne
 * est dans une autre époque (`engine.ts`), et `ackMap` ne publie une position d'une autre époque que pour un oublié retenu ou un appareil
 * figé par une réinitialisation : garder la position de l'ancienne époque ne change donc rien à la lecture, seulement à l'accusé publié
 * (coupure d'un oubli déclaré plus tard, §14.2).
 */

type Position = Pick<SyncStatePatch, 'epoch' | 'cursorSegment' | 'cursorRecord' | 'ackHlc'>;

const at = (cover: DeviceAck): Position => ({ epoch: cover.epoch, cursorSegment: cover.segment, cursorRecord: cover.record, ackHlc: cover.hlc });

/** Aucune position : rien de cet appareil n'est dans la base (jamais d'accusé publié tant qu'il n'est pas lu). */
const NONE: Position = { epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null };

/** Ligne locale actuelle d'un appareil (position et époque de son dernier état accepté). */
export type LocalRow = Pick<SyncStateRow, 'epoch' | 'cursorSegment' | 'cursorRecord' | 'ackHlc' | 'stateEpoch'>;

/**
 * Reprise ou arrivée depuis un instantané de `epoch` (section 5.5, fusion : la base locale est gardée) :
 * - entrée `covers` de l'époque courante : telle quelle ; d'une époque antérieure : gardée telle quelle (accusé **hérité**, §14.2) ;
 * - sans entrée (revue Y-TECH-01, point 1 : instantané plus récent que l'ouverture, dont l'auteur n'avait pas de position) : début de
 *   `epoch` **seulement** pour un appareil dont le dernier état accepté est déjà dans `epoch` (il y est lu depuis le début) ; sinon la
 *   ligne locale est gardée si elle est dans une époque antérieure (la base fusionnée contient toujours ce qu'elle désigne), ou aucune
 *   position ; jamais {`epoch`, 0, 0} sur un appareil qui n'y a rien publié.
 * Sa propre ligne (`self`) : toujours dans `epoch` (ses écritures au-delà de l'instantané sont relues).
 */
export function positionFromCover(cover: DeviceAck | undefined, epoch: EpochId, self: boolean, row?: LocalRow): Position {
  const start: Position = { epoch, cursorSegment: 0, cursorRecord: 0, ackHlc: null };
  if (self) return cover !== undefined && cover.epoch === epoch ? at(cover) : start;
  if (cover !== undefined && compareEpochs(cover.epoch, epoch) <= 0) return at(cover);
  if (row?.stateEpoch != null && compareEpochs(row.stateEpoch as EpochId, epoch) >= 0) return start;
  if (row?.epoch != null && compareEpochs(row.epoch as EpochId, epoch) < 0) return { epoch: row.epoch, cursorSegment: row.cursorSegment, cursorRecord: row.cursorRecord, ackHlc: row.ackHlc };
  return NONE;
}

/**
 * Base **remplacée** par l'instantané qui ouvre `target` (restauration « Appliquer partout », époques concurrentes ; section 9.1 b) :
 * - appareil dont le dernier état accepté (`stateEpoch`) est déjà dans `target` (l'ouvreur) : sa position `covers` de `target` si
 *   l'instantané en a une, sinon début de `target` ; lu ensuite ;
 * - sinon, oubliés retenus et terminés compris (ADR §20 point 3, « l'accusé suit la base »), la base ne contient de lui que ce que
 *   l'instantané couvre : position `covers` de l'ancienne époque (accusé hérité, §14.2), ou aucune position si l'instantané ne le couvre
 *   pas ; jamais {`target`, 0, 0}.
 */
export function positionAfterReplace(stateEpoch: string | null, cover: DeviceAck | undefined, target: EpochId): Position {
  // L'ouvreur (état déjà dans la cible) : position `covers` de la cible si l'instantané en a une (instantané autre que celui d'ouverture).
  if (stateEpoch !== null && compareEpochs(stateEpoch as EpochId, target) >= 0) return cover !== undefined && cover.epoch === target ? at(cover) : { epoch: target, cursorSegment: 0, cursorRecord: 0, ackHlc: null };
  if (cover !== undefined && compareEpochs(cover.epoch, target) < 0) return at(cover);
  return NONE;
}
