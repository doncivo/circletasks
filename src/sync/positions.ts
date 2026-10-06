import type { SyncStatePatch } from '../db/repositories';
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

/**
 * Reprise ou arrivée depuis un instantané de `epoch` (section 5.5) : `covers` de l'époque courante tel quel ; position d'une époque
 * antérieure gardée telle quelle (accusé **hérité** de l'instantané, §14.2), jamais ramenée au début de `epoch` ; sans entrée : début de
 * `epoch` (lu depuis le début). Sa propre ligne (`self`) : toujours dans `epoch` (ses écritures au-delà de l'instantané sont relues).
 */
export function positionFromCover(cover: DeviceAck | undefined, epoch: EpochId, self: boolean): Position {
  if (cover !== undefined && (cover.epoch === epoch || (!self && compareEpochs(cover.epoch, epoch) < 0))) return at(cover);
  return { epoch, cursorSegment: 0, cursorRecord: 0, ackHlc: null };
}

/**
 * Base **remplacée** par l'instantané qui ouvre `target` (restauration « Appliquer partout », époques concurrentes ; section 9.1 b) :
 * - appareil dont le dernier état accepté (`stateEpoch`) est déjà dans `target` (l'ouvreur) : début de `target`, lu ensuite ;
 * - sinon, la base ne contient de lui que ce que l'instantané couvre : position `covers` de l'ancienne époque (accusé hérité, §14.2),
 *   ou aucune position si l'instantané ne le couvre pas ; jamais {`target`, 0, 0}.
 */
export function positionAfterReplace(stateEpoch: string | null, cover: DeviceAck | undefined, target: EpochId): Position {
  if (stateEpoch !== null && compareEpochs(stateEpoch as EpochId, target) >= 0) return { epoch: target, cursorSegment: 0, cursorRecord: 0, ackHlc: null };
  if (cover !== undefined && compareEpochs(cover.epoch, target) < 0) return at(cover);
  return NONE;
}
