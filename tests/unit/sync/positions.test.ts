import { describe, expect, it } from 'vitest';
import { epochId, type DeviceAck } from '../../../src/domain/sync/format';
import type { DeviceId, Hlc } from '../../../src/domain/types';
import { positionAfterReplace, positionFromCover, type LocalRow } from '../../../src/sync/positions';

/**
 * Y-TECH-01 (ADR 0011 §9.1 (d), §5.5, §20) : aucune position {époque, 0, 0} sur un appareil qui n'a rien publié dans cette époque ;
 * au remplacement, l'accusé suit la base (oubliés retenus et terminés compris).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const E1 = epochId(1, A);
const E2 = epochId(2, A);
const HLC = `001791187209000-0001-${A}` as Hlc;
const cover = (epoch = E1): DeviceAck => ({ epoch, segment: 3, record: 7, hlc: HLC, stateSeq: 4 });
const START = { epoch: E2, cursorSegment: 0, cursorRecord: 0, ackHlc: null };
const NONE = { epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null };
const OLD = { epoch: E1, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC };
const row = (patch: Partial<LocalRow>): LocalRow => ({ epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null, stateEpoch: null, ...patch });

describe('positionAfterReplace (remplacement, « Appliquer partout », époques concurrentes)', () => {
  it('ouvreur (état déjà dans la cible) : début de la cible, ou sa position covers de la cible si l’instantané en a une', () => {
    expect(positionAfterReplace(E2, undefined, E2)).toEqual(START);
    expect(positionAfterReplace(E2, cover(E1), E2)).toEqual(START);
    expect(positionAfterReplace(E2, cover(E2), E2)).toEqual({ epoch: E2, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
  });
  it('actif, oublié retenu ou terminé resté dans l’ancienne époque, couvert : covers de l’ancienne époque (l’accusé suit la base)', () => {
    // La fonction ne distingue pas ces trois cas : c'est la règle (§20 point 3) ; `keep` n'est plus appliqué en remplacement.
    for (const stateEpoch of [E1, null]) expect(positionAfterReplace(stateEpoch, cover(), E2)).toEqual(OLD);
  });
  it('non couvert : aucune position, jamais {cible, 0, 0}', () => {
    expect(positionAfterReplace(E1, undefined, E2)).toEqual(NONE);
    expect(positionAfterReplace(null, cover(E2), E2)).toEqual(NONE);
  });
});

describe('positionFromCover (reprise, arrivée : fusion)', () => {
  it('entrée de l’époque courante : telle quelle', () => {
    expect(positionFromCover(cover(E2), E2, false)).toEqual({ epoch: E2, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
  });
  it('entrée d’une époque antérieure : gardée (accusé hérité), jamais ramenée au début', () => {
    expect(positionFromCover(cover(E1), E2, false)).toEqual(OLD);
  });
  it('sa propre ligne : toujours dans l’époque courante (ses écritures au-delà de l’instantané sont relues)', () => {
    expect(positionFromCover(cover(E1), E2, true)).toEqual(START);
    expect(positionFromCover(cover(E2), E2, true)).toEqual({ epoch: E2, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
  });
  it('sans entrée, appareil qui a publié dans l’époque courante : début de l’époque', () => {
    expect(positionFromCover(undefined, E2, false, row({ stateEpoch: E2 }))).toEqual(START);
  });
  it('sans entrée, appareil resté dans l’ancienne époque (revue, point 1) : ligne locale de l’ancienne époque gardée, sinon aucune', () => {
    expect(positionFromCover(undefined, E2, false, row({ stateEpoch: E1, ...OLD }))).toEqual(OLD);
    expect(positionFromCover(undefined, E2, false, row({ stateEpoch: E1, epoch: E2 }))).toEqual(NONE);
    expect(positionFromCover(undefined, E2, false, row({ stateEpoch: E1 }))).toEqual(NONE);
    expect(positionFromCover(undefined, E2, false)).toEqual(NONE);
  });
});
