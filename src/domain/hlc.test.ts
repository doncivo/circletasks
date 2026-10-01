import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import {
  HLC_MAX_COUNTER,
  compareHlc,
  createHlcClock,
  createWriteStamper,
  formatHlc,
  isHlc,
  parseHlc,
} from './hlc';
import type { DeviceId, Hlc } from './types';

const PC = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const IPHONE = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const T0 = Date.UTC(2026, 9, 1, 8, 0);

describe('format HLC', () => {
  it('sérialise en largeur fixe et relit à l’identique', () => {
    const hlc = formatHlc({ ms: T0, counter: 10, deviceId: PC });
    expect(hlc).toBe(`00${T0}-000a-${PC}`);
    expect(parseHlc(hlc)).toEqual({ ms: T0, counter: 10, deviceId: PC });
    expect(isHlc(hlc)).toBe(true);
  });

  it('refuse les valeurs hors format', () => {
    expect(isHlc('n’importe quoi')).toBe(false);
    expect(isHlc(`00${T0}-000a-pas-un-uuid`)).toBe(false);
    expect(() => formatHlc({ ms: -1, counter: 0, deviceId: PC })).toThrow(RangeError);
    expect(() => formatHlc({ ms: T0, counter: HLC_MAX_COUNTER + 1, deviceId: PC })).toThrow(RangeError);
    expect(() => formatHlc({ ms: T0, counter: 0, deviceId: 'x' as DeviceId })).toThrow(TypeError);
  });

  it('l’ordre des chaînes suit le temps, puis le compteur, puis l’appareil', () => {
    const a = formatHlc({ ms: T0, counter: 0xff, deviceId: IPHONE });
    const b = formatHlc({ ms: T0 + 1, counter: 0, deviceId: PC });
    const c = formatHlc({ ms: T0 + 1, counter: 0, deviceId: IPHONE });
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, c)).toBeLessThan(0);
    expect(compareHlc(c, c)).toBe(0);
    expect(compareHlc(c, a)).toBeGreaterThan(0);
  });
});

describe('générateur HLC', () => {
  it('est strictement croissant, même horloge figée ou reculée', () => {
    const clock = createManualClock(T0);
    const hlc = createHlcClock({ clock, deviceId: PC });
    expect(hlc.last()).toBeNull();
    const a = hlc.now();
    const b = hlc.now();
    clock.advance(-60_000);
    const c = hlc.now();
    clock.advance(120_000);
    const d = hlc.now();
    expect([a, b, c, d]).toEqual([...[a, b, c, d]].sort());
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(parseHlc(d)).toMatchObject({ ms: T0 + 60_000, counter: 0 });
    expect(hlc.last()).toBe(d);
  });

  it('repart de la graine lue en base', () => {
    const seed = formatHlc({ ms: T0 + 5_000, counter: 3, deviceId: IPHONE });
    const hlc = createHlcClock({ clock: createManualClock(T0), deviceId: PC, seed });
    expect(hlc.last()).toBe(formatHlc({ ms: T0 + 5_000, counter: 3, deviceId: PC }));
    expect(parseHlc(hlc.now())).toEqual({ ms: T0 + 5_000, counter: 4, deviceId: PC });
  });

  it('avance d’une milliseconde quand le compteur déborde', () => {
    const seed = formatHlc({ ms: T0, counter: HLC_MAX_COUNTER, deviceId: PC });
    const hlc = createHlcClock({ clock: createManualClock(T0), deviceId: PC, seed });
    expect(parseHlc(hlc.now())).toMatchObject({ ms: T0 + 1, counter: 0 });
  });

  it('intègre une valeur distante et reste au-dessus des deux', () => {
    const clock = createManualClock(T0);
    const hlc = createHlcClock({ clock, deviceId: PC });
    const local = hlc.now();
    const ahead = formatHlc({ ms: T0 + 10_000, counter: 7, deviceId: IPHONE });
    const merged = hlc.receive(ahead);
    expect(compareHlc(merged, ahead)).toBeGreaterThan(0);
    expect(compareHlc(merged, local)).toBeGreaterThan(0);
    expect(parseHlc(merged)).toEqual({ ms: T0 + 10_000, counter: 8, deviceId: PC });

    // Même ms local et distant : max des compteurs + 1.
    const same = formatHlc({ ms: T0 + 10_000, counter: 20, deviceId: IPHONE });
    expect(parseHlc(hlc.receive(same))).toMatchObject({ counter: 21 });
    // Distant en retard : on garde notre temps, compteur + 1.
    const behind = formatHlc({ ms: T0 - 1, counter: 0, deviceId: IPHONE });
    expect(parseHlc(hlc.receive(behind))).toMatchObject({ ms: T0 + 10_000, counter: 22 });
    // Horloge physique devant tout le monde : compteur remis à 0.
    clock.set(T0 + 60_000);
    expect(parseHlc(hlc.receive(behind))).toMatchObject({ ms: T0 + 60_000, counter: 0 });
  });

  it('refuse une valeur distante illisible', () => {
    const hlc = createHlcClock({ clock: createManualClock(T0), deviceId: PC });
    expect(() => hlc.receive('abc' as Hlc)).toThrow(TypeError);
  });
});

describe('tampon d’écriture', () => {
  it('fournit instant ISO, appareil et hlc croissant', () => {
    const clock = createManualClock('2026-10-01T08:00:00.000Z');
    const stamper = createWriteStamper(clock, createHlcClock({ clock, deviceId: PC }));
    const first = stamper.next();
    const second = stamper.next();
    expect(first).toMatchObject({ at: '2026-10-01T08:00:00.000Z', deviceId: PC });
    expect(compareHlc(first.hlc, second.hlc)).toBeLessThan(0);
  });
});
