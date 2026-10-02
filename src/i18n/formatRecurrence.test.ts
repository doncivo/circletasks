import { afterEach, describe, expect, it } from 'vitest';
import { formatMessageRef } from './formatRecurrence';
import { setLocale } from './index';
import type { RecurrenceFields } from '../domain/model';
import { recurrenceLabel, type RecurrenceLabelStyle } from '../domain/recurrenceLabel';
import { asLocalDate } from '../domain/types';

const d = asLocalDate;
const base: RecurrenceFields = {
  freq: 'daily',
  interval: 1,
  weekdays: [],
  monthDay: null,
  nthWeekday: null,
  until: null,
  count: null,
};
const rule = (over: Partial<RecurrenceFields>): RecurrenceFields => ({ ...base, ...over });
const fr = (r: RecurrenceFields, style: RecurrenceLabelStyle = 'detail', anchor = '2026-09-23') =>
  formatMessageRef(recurrenceLabel(r, d(anchor), style), 'fr');
const en = (r: RecurrenceFields, style: RecurrenceLabelStyle = 'detail') =>
  formatMessageRef(recurrenceLabel(r, d('2026-09-23'), style), 'en');

describe('recurrenceLabel (T-09 critère 6)', () => {
  afterEach(() => setLocale('fr'));

  it('détail français', () => {
    expect(fr(rule({}))).toBe('Tous les jours');
    expect(fr(rule({ interval: 3 }))).toBe('Tous les 3 jours');
    expect(fr(rule({ freq: 'weekly', weekdays: [4, 1] }))).toBe('Toutes les semaines : lun., jeu.');
    expect(fr(rule({ freq: 'weekly', weekdays: [1], interval: 2 }))).toBe('Toutes les 2 semaines : lun.');
    expect(fr(rule({ freq: 'monthly', monthDay: 23 }))).toBe('Mensuelle, le 23');
    expect(fr(rule({ freq: 'monthly', monthDay: 1 }))).toBe('Mensuelle, le 1ᵉʳ');
    expect(fr(rule({ freq: 'monthly', monthDay: 15, interval: 2 }))).toBe('Tous les 2 mois, le 15');
    expect(fr(rule({ freq: 'monthly', nthWeekday: { nth: 2, weekday: 1 } }))).toBe('Mensuelle, le 2ᵉ lundi');
    expect(fr(rule({ freq: 'monthly', nthWeekday: { nth: 4, weekday: 3 }, interval: 3 }))).toBe(
      'Tous les 3 mois, le 4ᵉ mercredi',
    );
    expect(fr(rule({ freq: 'monthly', nthWeekday: { nth: -1, weekday: 5 } }))).toBe('Mensuelle, le dernier vendredi');
    expect(fr(rule({ freq: 'monthly', nthWeekday: { nth: -1, weekday: 5 }, interval: 2 }))).toBe(
      'Tous les 2 mois, le dernier vendredi',
    );
    expect(fr(rule({ freq: 'yearly' }))).toBe('Annuelle, chaque 23 sept.');
    expect(fr(rule({ freq: 'yearly', monthDay: 1, interval: 2 }), 'detail', '2026-01-01')).toBe(
      'Tous les 2 ans, le 1ᵉʳ janv.',
    );
    expect(formatMessageRef(recurrenceLabel(rule({ freq: 'yearly' }), null), 'fr')).toBe('Annuelle, chaque 1ᵉʳ janv.');
  });

  it('fin : date ou nombre', () => {
    expect(fr(rule({ freq: 'monthly', monthDay: 23, until: d('2026-12-31') }))).toBe(
      'Mensuelle, le 23, jusqu’au 31 déc. 2026',
    );
    expect(fr(rule({ freq: 'monthly', monthDay: 23, count: 6 }))).toBe('Mensuelle, le 23, 6 fois');
  });

  it('résumé court (sous-ligne)', () => {
    expect(fr(rule({ freq: 'monthly', monthDay: 23 }), 'short')).toBe('mensuelle');
    expect(fr(rule({ freq: 'weekly', weekdays: [1] }), 'short')).toBe('hebdo');
    expect(fr(rule({ freq: 'yearly' }), 'short')).toBe('annuelle');
    expect(fr(rule({ interval: 3 }), 'short')).toBe('tous les 3 j');
    expect(fr(rule({}), 'short')).toBe('quotidienne');
    expect(fr(rule({ freq: 'weekly', weekdays: [1], interval: 2 }), 'short')).toBe('toutes les 2 sem.');
    expect(fr(rule({ freq: 'monthly', monthDay: 1, interval: 2 }), 'short')).toBe('tous les 2 mois');
    expect(fr(rule({ freq: 'yearly', interval: 2 }), 'short')).toBe('tous les 2 ans');
    expect(fr(rule({ count: 3 }), 'short')).toBe('quotidienne');
  });

  it('anglais', () => {
    expect(en(rule({ freq: 'monthly', monthDay: 23, until: d('2026-12-31') }))).toBe(
      'Monthly, day 23, until Dec 31, 2026',
    );
    expect(en(rule({ freq: 'weekly', weekdays: [1, 4] }))).toBe('Every week: Mon, Thu');
    expect(en(rule({ freq: 'monthly', nthWeekday: { nth: 2, weekday: 1 } }))).toBe('Monthly, 2nd Monday');
    expect(en(rule({ freq: 'yearly' }))).toBe('Yearly, every Sep 23');
    expect(en(rule({ interval: 3 }), 'short')).toBe('every 3 d');
  });

  it('utilise la langue courante par défaut', () => {
    setLocale('en');
    expect(formatMessageRef(recurrenceLabel(rule({}), null))).toBe('Every day');
  });
});
