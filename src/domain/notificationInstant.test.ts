import { describe, expect, it } from 'vitest';
import { fireAtInstant, fireAtInstantLocal, localDateTimeAt, pluginDate } from './notificationInstant';
import type { LocalDateTime } from './types';

const at = (value: string): LocalDateTime => value as LocalDateTime;
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * N-01 critère 2 et N-06 critère 4 : conversion d'une échéance flottante en instant, fuseau passé en argument (indépendant de `TZ`).
 */
describe('fireAtInstant', () => {
  it('Europe/Paris : heure ordinaire, été (UTC+2) et hiver (UTC+1)', () => {
    expect(iso(fireAtInstant(at('2026-07-01T09:00'), 'Europe/Paris'))).toBe('2026-07-01T07:00:00.000Z');
    expect(iso(fireAtInstant(at('2026-12-01T09:00'), 'Europe/Paris'))).toBe('2026-12-01T08:00:00.000Z');
  });

  it('Europe/Paris 2027-03-28 02:30 (heure inexistante) : décalée d’une heure vers l’avant, soit 03:30 à l’heure murale', () => {
    const instant = fireAtInstant(at('2027-03-28T02:30'), 'Europe/Paris');
    expect(iso(instant)).toBe('2027-03-28T01:30:00.000Z');
    expect(pluginDate(instant, 'Europe/Paris')).toBe('2027-03-28T03:30:00.000Z');
  });

  it('Europe/Paris 2026-10-25 02:30 (heure répétée) : la première occurrence (UTC+2)', () => {
    expect(iso(fireAtInstant(at('2026-10-25T02:30'), 'Europe/Paris'))).toBe('2026-10-25T00:30:00.000Z');
    // Une heure plus tôt ou plus tard n’est pas répétée.
    expect(iso(fireAtInstant(at('2026-10-25T01:30'), 'Europe/Paris'))).toBe('2026-10-24T23:30:00.000Z');
    expect(iso(fireAtInstant(at('2026-10-25T03:30'), 'Europe/Paris'))).toBe('2026-10-25T02:30:00.000Z');
  });

  it('America/New_York : saut du 2027-03-14 (02:30 inexistante) et retour du 2026-11-01 (01:30 répétée, la première)', () => {
    expect(iso(fireAtInstant(at('2027-03-14T02:30'), 'America/New_York'))).toBe('2027-03-14T07:30:00.000Z');
    expect(pluginDate(fireAtInstant(at('2027-03-14T02:30'), 'America/New_York'), 'America/New_York')).toBe('2027-03-14T03:30:00.000Z');
    expect(iso(fireAtInstant(at('2026-11-01T01:30'), 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(fireAtInstant(at('2026-11-02T09:00'), 'America/New_York'))).toBe('2026-11-02T14:00:00.000Z');
  });

  it('Pacific/Auckland : saut du 2026-09-27 (02:30 inexistante) et retour du 2027-04-04 (02:30 répétée, la première)', () => {
    expect(iso(fireAtInstant(at('2026-09-27T02:30'), 'Pacific/Auckland'))).toBe('2026-09-26T14:30:00.000Z');
    expect(pluginDate(fireAtInstant(at('2026-09-27T02:30'), 'Pacific/Auckland'), 'Pacific/Auckland')).toBe('2026-09-27T03:30:00.000Z');
    // Retour à l’heure d’hiver : 03:00 NZDT (UTC+13) redevient 02:00 NZST (UTC+12) ; la première 02:30 est NZDT.
    expect(iso(fireAtInstant(at('2027-04-04T02:30'), 'Pacific/Auckland'))).toBe('2027-04-03T13:30:00.000Z');
  });

  it('un changement d’heure d’été entre deux échéances : chaque échéance garde son heure locale (09:00 avant et après)', () => {
    const before = fireAtInstant(at('2027-03-27T09:00'), 'Europe/Paris');
    const after = fireAtInstant(at('2027-03-29T09:00'), 'Europe/Paris');
    expect(pluginDate(before, 'Europe/Paris')).toBe('2027-03-27T09:00:00.000Z');
    expect(pluginDate(after, 'Europe/Paris')).toBe('2027-03-29T09:00:00.000Z');
    expect(after - before).toBe(47 * 3_600_000);
  });

  it('un voyage : la même échéance donne un instant plus tard de 6 h (Paris vers New York en hiver)', () => {
    const paris = fireAtInstant(at('2026-12-01T09:00'), 'Europe/Paris');
    const newYork = fireAtInstant(at('2026-12-01T09:00'), 'America/New_York');
    expect(newYork - paris).toBe(6 * 3_600_000);
  });

  it('ne dépend pas de la variable TZ du processus', () => {
    const original = process.env['TZ'];
    try {
      const results = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map((zone) => {
        process.env['TZ'] = zone;
        return [fireAtInstant(at('2026-10-25T02:30'), 'Europe/Paris'), fireAtInstant(at('2027-03-28T02:30'), 'Europe/Paris'), pluginDate(0, 'Europe/Paris')];
      });
      expect(new Set(results.map((row) => JSON.stringify(row))).size).toBe(1);
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });

  it('lève RangeError pour un fuseau ou une échéance invalide (l’appelant bascule sur le décalage courant)', () => {
    expect(() => fireAtInstant(at('2026-10-25T02:30'), 'Pas/UnFuseau')).toThrow(RangeError);
    expect(() => fireAtInstant('pas une date' as LocalDateTime, 'Europe/Paris')).toThrow(RangeError);
  });
});

describe('format du plugin (constat 7 de l’ADR 0012)', () => {
  it('heure murale du fuseau avec un Z littéral, jamais toISOString', () => {
    const instant = Date.UTC(2026, 6, 1, 7, 0, 0);
    expect(pluginDate(instant, 'Europe/Paris')).toBe('2026-07-01T09:00:00.000Z');
    expect(pluginDate(instant, 'Europe/Paris')).not.toBe(new Date(instant).toISOString());
    expect(pluginDate(instant, 'Pacific/Auckland')).toBe('2026-07-01T19:00:00.000Z');
    expect(pluginDate(instant, 'America/New_York')).toBe('2026-07-01T03:00:00.000Z');
  });

  it('fuseau illisible (null) : le décalage courant du moteur JS, jamais UTC en silence', () => {
    const wall = fireAtInstantLocal(at('2026-07-01T09:00'));
    expect(wall).toBe(new Date(2026, 6, 1, 9, 0).getTime());
    expect(pluginDate(wall, null)).toBe('2026-07-01T09:00:00.000Z');
    expect(localDateTimeAt(wall, null)).toBe('2026-07-01T09:00');
  });

  it('localDateTimeAt : minute de l’heure murale', () => {
    expect(localDateTimeAt(Date.UTC(2026, 11, 31, 23, 30), 'Europe/Paris')).toBe('2027-01-01T00:30');
  });
});
