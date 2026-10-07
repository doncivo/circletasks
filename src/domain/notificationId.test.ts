import { describe, expect, it } from 'vitest';
import {
  assignNumericIds,
  eventNotificationId,
  fnv1a32,
  NUMERIC_ID_MAX,
  NUMERIC_ID_MIN,
  notificationNumericId,
  recapNotificationId,
  routineNotificationId,
  taskNotificationId,
} from './notificationId';
import { asLocalDate, type ReminderId } from './types';

const rid = '20000000-0000-4000-8000-000000000001' as ReminderId;

describe('identifiants stables (ADR 0012, section 3.1)', () => {
  it('formes task, routine, event, recap', () => {
    expect(taskNotificationId(rid)).toBe(`task:${rid}`);
    expect(routineNotificationId(rid, asLocalDate('2026-10-08'))).toBe(`routine:${rid}:2026-10-08`);
    expect(eventNotificationId(rid, asLocalDate('2027-03-12'))).toBe(`event:${rid}:2027-03-12`);
    expect(recapNotificationId('evening', asLocalDate('2026-10-07'))).toBe('recap:evening:2026-10-07');
    expect(recapNotificationId('morning', asLocalDate('2026-10-07'))).toBe('recap:morning:2026-10-07');
  });
});

describe('identifiant numérique FNV-1a (ADR 0012, section 3.2)', () => {
  it('vecteurs de référence FNV-1a 32 bits', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('empreinte sur les octets UTF-8 (é = deux octets)', () => {
    // FNV-1a des octets C3 A9 : ((0x811c9dc5 ^ 0xc3) * p ^ 0xa9) * p, calculé à la main en 32 bits.
    const byHand = Math.imul((Math.imul(0x811c9dc5 ^ 0xc3, 0x01000193) >>> 0) ^ 0xa9, 0x01000193) >>> 0;
    expect(fnv1a32('é')).toBe(byHand);
  });

  it('valeur = 65 536 + (empreinte mod (2^31 − 65 536)), toujours dans la plage du plan', () => {
    expect(NUMERIC_ID_MIN).toBe(65_536);
    expect(NUMERIC_ID_MAX).toBe(2_147_483_647);
    expect(notificationNumericId('a')).toBe(65_536 + (0xe40c292c % (2_147_483_648 - 65_536)));
    for (let i = 0; i < 2000; i += 1) {
      const value = notificationNumericId(`task:${i}`);
      expect(value).toBeGreaterThanOrEqual(NUMERIC_ID_MIN);
      expect(value).toBeLessThanOrEqual(NUMERIC_ID_MAX);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('déterministe, sans état', () => {
    expect(notificationNumericId('recap:evening:2026-10-07')).toBe(notificationNumericId('recap:evening:2026-10-07'));
  });
});

describe('attribution sans collision', () => {
  it('identifiants distincts : la valeur de chacun est son empreinte', () => {
    const stable = ['task:b', 'task:a', 'recap:morning:2026-10-08'];
    const map = assignNumericIds(stable);
    for (const id of stable) expect(map.get(id)).toBe(notificationNumericId(id));
  });

  it('un identifiant répété compte une fois', () => {
    expect(assignNumericIds(['x', 'x']).size).toBe(1);
  });

  it('collision : le premier dans l’ordre croissant garde sa valeur, le suivant prend la valeur libre suivante', () => {
    const forced = (): number => 70_000;
    const map = assignNumericIds(['task:b', 'task:a', 'task:c'], forced);
    expect(map.get('task:a')).toBe(70_000);
    expect(map.get('task:b')).toBe(70_001);
    expect(map.get('task:c')).toBe(70_002);
  });

  it('collision en fin de plage : bouclage vers 65 536', () => {
    const map = assignNumericIds(['a', 'b'], () => NUMERIC_ID_MAX);
    expect(map.get('a')).toBe(NUMERIC_ID_MAX);
    expect(map.get('b')).toBe(NUMERIC_ID_MIN);
  });

  it('le résultat ne dépend pas de l’ordre d’entrée', () => {
    const ids = ['task:2', 'task:1', 'recap:morning:2026-10-08', 'event:x:2027-03-12'];
    const forced = (id: string): number => 80_000 + (id.length % 2);
    expect([...assignNumericIds(ids, forced)]).toEqual([...assignNumericIds([...ids].reverse(), forced)]);
  });
});
