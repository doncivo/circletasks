import { describe, expect, it } from 'vitest';
import { epochId, type DeviceAck } from '../../../src/domain/sync/format';
import type { DeviceId, Hlc } from '../../../src/domain/types';
import { positionAfterReplace, positionFromCover } from '../../../src/sync/positions';

/** Y-TECH-01 : aucune position {époque, 0, 0} sur un appareil qui n'a rien publié dans cette époque (positions locales après un instantané). */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const E1 = epochId(1, A);
const E2 = epochId(2, A);
const HLC = `001791187209000-0001-${A}` as Hlc;
const cover = (epoch = E1): DeviceAck => ({ epoch, segment: 3, record: 7, hlc: HLC, stateSeq: 4 });

describe('positionAfterReplace (remplacement, « Appliquer partout »)', () => {
  it('appareil qui a déjà publié dans la cible (ouvreur) : début de la cible', () => {
    expect(positionAfterReplace(E2, cover(), E2)).toEqual({ epoch: E2, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
  });
  it('appareil resté dans l’ancienne époque, couvert : position covers de l’ancienne époque', () => {
    expect(positionAfterReplace(E1, cover(), E2)).toEqual({ epoch: E1, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
    expect(positionAfterReplace(null, cover(), E2)).toEqual({ epoch: E1, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
  });
  it('non couvert : aucune position, jamais {cible, 0, 0}', () => {
    expect(positionAfterReplace(E1, undefined, E2)).toEqual({ epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
    expect(positionAfterReplace(null, cover(E2), E2)).toEqual({ epoch: null, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
  });
});

describe('positionFromCover (reprise, arrivée)', () => {
  it('entrée de l’époque courante : telle quelle', () => {
    expect(positionFromCover(cover(E2), E2, false)).toEqual({ epoch: E2, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
  });
  it('entrée d’une époque antérieure : gardée (accusé hérité), jamais ramenée au début', () => {
    expect(positionFromCover(cover(E1), E2, false)).toEqual({ epoch: E1, cursorSegment: 3, cursorRecord: 7, ackHlc: HLC });
  });
  it('sa propre ligne : toujours dans l’époque courante (ses écritures au-delà de l’instantané sont relues)', () => {
    expect(positionFromCover(cover(E1), E2, true)).toEqual({ epoch: E2, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
  });
  it('sans entrée : début de l’époque courante', () => {
    expect(positionFromCover(undefined, E2, false)).toEqual({ epoch: E2, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
  });
});
