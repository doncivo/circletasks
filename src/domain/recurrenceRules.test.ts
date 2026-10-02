import { describe, expect, it } from 'vitest';
import type { RecurrenceFields } from './model';
import { addDays, daysInMonth, makeLocalDate, parseLocalDate, weekdayOf } from './localDate';
import {
  defaultRecurrence,
  nextOccurrenceDate,
  nthWeekdayOfMonth,
  validateRecurrence,
  type RecurrenceErrorCode,
} from './recurrenceRules';
import { asLocalDate, type LocalDate, type Weekday } from './types';

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

/** Génère `n` occurrences à partir de `start` (indice 0), en suivant exactement le moteur. */
function series(r: RecurrenceFields, start: string, n: number): LocalDate[] {
  const out: LocalDate[] = [d(start)];
  while (out.length < n) {
    const next = nextOccurrenceDate(r, out[out.length - 1] as LocalDate, out.length - 1);
    if (next === null) break;
    out.push(next);
  }
  return out;
}
const strs = (xs: readonly LocalDate[]): string[] => xs.map(String);

describe('helpers de date', () => {
  it('parse, make, jours du mois, jour de semaine', () => {
    expect(parseLocalDate(d('2028-02-29'))).toEqual({ year: 2028, month: 2, day: 29 });
    expect(makeLocalDate(2026, 3, 5)).toBe('2026-03-05');
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(weekdayOf(d('2026-09-21'))).toBe(1);
    expect(weekdayOf(d('2026-09-27'))).toBe(7);
    expect(weekdayOf(d('2026-09-23'))).toBe(3);
  });
});

describe('validateRecurrence', () => {
  const codes = (r: RecurrenceFields, start: string | null = '2026-09-23', today?: string): RecurrenceErrorCode[] => {
    const res = validateRecurrence(r, {
      startDate: start === null ? null : d(start),
      ...(today ? { today: d(today) } : {}),
    });
    return res.ok ? [] : res.error.map((e) => e.code);
  };

  it('accepte les règles valides de chaque fréquence', () => {
    expect(codes(rule({ freq: 'daily', interval: 3 }))).toEqual([]);
    expect(codes(rule({ freq: 'weekly', weekdays: [1, 4], interval: 2 }))).toEqual([]);
    expect(codes(rule({ freq: 'monthly', monthDay: 31 }))).toEqual([]);
    expect(codes(rule({ freq: 'monthly', nthWeekday: { nth: -1, weekday: 5 } }))).toEqual([]);
    expect(codes(rule({ freq: 'yearly', monthDay: 29 }))).toEqual([]);
    expect(codes(rule({ freq: 'yearly' }))).toEqual([]);
    const ok = validateRecurrence(rule({ freq: 'daily' }), { startDate: d('2026-01-01') });
    expect(ok.ok && ok.value.freq).toBe('daily');
  });

  it('exige une date de départ', () => {
    expect(codes(rule({}), null)).toEqual(['start_required']);
  });

  it('refuse un intervalle invalide', () => {
    expect(codes(rule({ interval: 0 }))).toEqual(['interval_invalid']);
    expect(codes(rule({ interval: 1.5 }))).toEqual(['interval_invalid']);
  });

  it('hebdo : jours obligatoires, valides et sans doublon', () => {
    expect(codes(rule({ freq: 'weekly' }))).toEqual(['weekdays_required']);
    expect(codes(rule({ freq: 'weekly', weekdays: [8 as Weekday] }))).toEqual(['weekday_invalid']);
    expect(codes(rule({ freq: 'weekly', weekdays: [1, 1] }))).toEqual(['weekday_invalid']);
  });

  it('refuse les champs hors fréquence', () => {
    expect(codes(rule({ freq: 'daily', weekdays: [1] }))).toEqual(['field_not_allowed']);
    expect(codes(rule({ freq: 'daily', monthDay: 3 }))).toEqual(['field_not_allowed']);
    expect(codes(rule({ freq: 'weekly', weekdays: [1], nthWeekday: { nth: 1, weekday: 1 } }))).toEqual([
      'field_not_allowed',
    ]);
  });

  it('mensuelle : exactement un de jour du mois ou Nᵉ jour de semaine', () => {
    expect(codes(rule({ freq: 'monthly' }))).toEqual(['month_rule_required']);
    expect(codes(rule({ freq: 'monthly', monthDay: 3, nthWeekday: { nth: 1, weekday: 1 } }))).toEqual([
      'month_rule_conflict',
    ]);
    expect(codes(rule({ freq: 'monthly', monthDay: 0 }))).toEqual(['month_day_invalid']);
    expect(codes(rule({ freq: 'monthly', monthDay: 32 }))).toEqual(['month_day_invalid']);
    expect(codes(rule({ freq: 'monthly', monthDay: 2.5 }))).toEqual(['month_day_invalid']);
    expect(codes(rule({ freq: 'monthly', nthWeekday: { nth: 6 as 5, weekday: 1 } }))).toEqual(['nth_invalid']);
    expect(codes(rule({ freq: 'monthly', nthWeekday: { nth: 2, weekday: 9 as Weekday } }))).toEqual(['nth_invalid']);
  });

  it('fin : exclusive, count ≥ 1, until valide, postérieure au départ et non passée', () => {
    expect(codes(rule({ until: d('2026-12-31'), count: 3 }))).toEqual(['end_conflict']);
    expect(codes(rule({ count: 0 }))).toEqual(['count_invalid']);
    expect(codes(rule({ count: 2.5 }))).toEqual(['count_invalid']);
    expect(codes(rule({ until: '2026-02-30' as LocalDate }))).toEqual(['until_invalid']);
    expect(codes(rule({ until: d('2026-09-22') }))).toEqual(['until_before_start']);
    expect(codes(rule({ until: d('2026-09-23') }))).toEqual([]);
    expect(codes(rule({ until: d('2026-10-05') }), '2026-09-23', '2026-10-06')).toEqual(['until_in_past']);
    expect(codes(rule({ until: d('2026-10-06') }), '2026-09-23', '2026-10-06')).toEqual([]);
  });

  it('cumule les erreurs avec leur champ', () => {
    const res = validateRecurrence(rule({ freq: 'weekly', interval: 0 }), { startDate: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.map((e) => e.field)).toEqual(['startDate', 'interval', 'weekdays']);
  });
});

describe('defaultRecurrence (T-09 critères 1 à 3)', () => {
  it('propose des règles par défaut tirées de la date', () => {
    const start = d('2026-09-23');
    expect(defaultRecurrence('daily', start)).toEqual(base);
    expect(defaultRecurrence('weekly', start).weekdays).toEqual([3]);
    expect(defaultRecurrence('monthly', start).monthDay).toBe(23);
    expect(defaultRecurrence('yearly', start).monthDay).toBe(23);
  });
});

describe('nthWeekdayOfMonth', () => {
  it('2ᵉ lundi, dernier vendredi, 5ᵉ lundi absent', () => {
    expect(nthWeekdayOfMonth(2026, 9, 2, 1)).toBe(14);
    expect(nthWeekdayOfMonth(2026, 9, 1, 1)).toBe(7);
    expect(nthWeekdayOfMonth(2026, 9, -1, 5)).toBe(25);
    expect(nthWeekdayOfMonth(2026, 9, 5, 1)).toBe(28); // sept. 2026 : lundis 7, 14, 21, 28 : pas de 5ᵉ
    expect(nthWeekdayOfMonth(2026, 3, 5, 1)).toBe(30); // mars 2026 : le 5ᵉ lundi existe
    expect(nthWeekdayOfMonth(2026, 2, -1, 7)).toBe(22);
  });
});

describe('nextOccurrenceDate : quotidienne', () => {
  it('tous les 3 jours depuis le 23 : 26, 29, 2 oct. (critère 9)', () => {
    expect(strs(series(rule({ interval: 3 }), '2026-09-23', 4))).toEqual([
      '2026-09-23',
      '2026-09-26',
      '2026-09-29',
      '2026-10-02',
    ]);
  });

  it('traverse fin de mois, fin d’année et 29 février', () => {
    expect(nextOccurrenceDate(rule({}), d('2026-12-31'), 0)).toBe('2027-01-01');
    expect(nextOccurrenceDate(rule({}), d('2028-02-28'), 0)).toBe('2028-02-29');
    expect(nextOccurrenceDate(rule({}), d('2028-02-29'), 0)).toBe('2028-03-01');
    expect(nextOccurrenceDate(rule({}), d('2027-02-28'), 0)).toBe('2027-03-01');
  });

  it('changement d’heure : aucun effet (dates civiles)', () => {
    expect(nextOccurrenceDate(rule({}), d('2026-03-28'), 0)).toBe('2026-03-29');
    expect(nextOccurrenceDate(rule({}), d('2026-03-29'), 0)).toBe('2026-03-30');
    expect(nextOccurrenceDate(rule({}), d('2026-10-24'), 0)).toBe('2026-10-25');
    expect(nextOccurrenceDate(rule({}), d('2026-10-25'), 0)).toBe('2026-10-26');
  });
});

describe('nextOccurrenceDate : hebdomadaire', () => {
  const lunJeu = rule({ freq: 'weekly', weekdays: [4, 1] });

  it('lundi → jeudi de la même semaine (critère 8), puis lundi suivant', () => {
    expect(nextOccurrenceDate(lunJeu, d('2026-09-21'), 0)).toBe('2026-09-24');
    expect(nextOccurrenceDate(lunJeu, d('2026-09-24'), 1)).toBe('2026-09-28');
  });

  it('semaine commençant le lundi : dimanche → lundi suivant', () => {
    expect(nextOccurrenceDate(rule({ freq: 'weekly', weekdays: [7, 1] }), d('2026-09-27'), 0)).toBe('2026-09-28');
  });

  it('date de départ hors des jours choisis', () => {
    expect(nextOccurrenceDate(lunJeu, d('2026-09-23'), 0)).toBe('2026-09-24'); // mercredi
    expect(nextOccurrenceDate(lunJeu, d('2026-09-26'), 0)).toBe('2026-09-28'); // samedi
  });

  it('intervalle > 1 : toutes les 2 semaines, ancré sur la semaine courante', () => {
    const r = rule({ freq: 'weekly', weekdays: [1, 4], interval: 2 });
    expect(strs(series(r, '2026-09-21', 5))).toEqual([
      '2026-09-21',
      '2026-09-24',
      '2026-10-05',
      '2026-10-08',
      '2026-10-19',
    ]);
  });

  it('fin d’année et un seul jour', () => {
    const r = rule({ freq: 'weekly', weekdays: [3] });
    expect(strs(series(r, '2026-12-23', 3))).toEqual(['2026-12-23', '2026-12-30', '2027-01-06']);
  });

  it('défensif : règle sans jour, prend le jour courant', () => {
    expect(nextOccurrenceDate(rule({ freq: 'weekly' }), d('2026-09-23'), 0)).toBe('2026-09-30');
  });

  it('changement d’heure (29 mars et 25 oct. 2026) sans décalage', () => {
    const r = rule({ freq: 'weekly', weekdays: [7] });
    expect(strs(series(r, '2026-03-22', 3))).toEqual(['2026-03-22', '2026-03-29', '2026-04-05']);
    expect(strs(series(r, '2026-10-18', 3))).toEqual(['2026-10-18', '2026-10-25', '2026-11-01']);
  });
});

describe('nextOccurrenceDate : mensuelle par jour', () => {
  it('le 23 : 23 sept. → 23 oct. (critère 7)', () => {
    expect(nextOccurrenceDate(rule({ freq: 'monthly', monthDay: 23 }), d('2026-09-23'), 0)).toBe('2026-10-23');
  });

  it('le 31 depuis le 31 janv. 2027 : 28 févr., 31 mars, 30 avr., 31 mai (critère 13)', () => {
    const r = rule({ freq: 'monthly', monthDay: 31 });
    expect(strs(series(r, '2027-01-31', 6))).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
      '2027-06-30',
    ]);
  });

  it('le 29, 30 : février bissextile et non bissextile', () => {
    expect(strs(series(rule({ freq: 'monthly', monthDay: 29 }), '2028-01-29', 3))).toEqual([
      '2028-01-29',
      '2028-02-29',
      '2028-03-29',
    ]);
    expect(strs(series(rule({ freq: 'monthly', monthDay: 30 }), '2027-01-30', 3))).toEqual([
      '2027-01-30',
      '2027-02-28',
      '2027-03-30',
    ]);
  });

  it('fin d’année', () => {
    expect(nextOccurrenceDate(rule({ freq: 'monthly', monthDay: 15 }), d('2026-12-15'), 0)).toBe('2027-01-15');
    expect(nextOccurrenceDate(rule({ freq: 'monthly', monthDay: 31 }), d('2026-12-31'), 0)).toBe('2027-01-31');
  });

  it('date de départ antérieure au jour de la règle : même mois', () => {
    expect(nextOccurrenceDate(rule({ freq: 'monthly', monthDay: 23 }), d('2026-09-20'), 0)).toBe('2026-09-23');
  });

  it('intervalle > 1 : tous les 3 mois', () => {
    const r = rule({ freq: 'monthly', monthDay: 31, interval: 3 });
    expect(strs(series(r, '2026-11-30', 3))).toEqual(['2026-11-30', '2027-02-28', '2027-05-31']);
    expect(strs(series(r, '2026-10-31', 3))).toEqual(['2026-10-31', '2027-01-31', '2027-04-30']);
  });
});

describe('nextOccurrenceDate : mensuelle par Nᵉ jour de semaine', () => {
  it('2ᵉ lundi sur 24 mois : toujours un lundi du 8 au 14, un par mois', () => {
    const r = rule({ freq: 'monthly', nthWeekday: { nth: 2, weekday: 1 } });
    const list = series(r, '2026-09-14', 24);
    expect(list).toHaveLength(24);
    list.forEach((date, i) => {
      const { year, month, day } = parseLocalDate(date);
      expect(weekdayOf(date)).toBe(1);
      expect(day).toBeGreaterThanOrEqual(8);
      expect(day).toBeLessThanOrEqual(14);
      expect(year * 12 + month - 1).toBe(2026 * 12 + 8 + i);
    });
  });

  it('dernier vendredi sur 24 mois : un par mois, dans les 7 derniers jours', () => {
    const r = rule({ freq: 'monthly', nthWeekday: { nth: -1, weekday: 5 } });
    const list = series(r, '2026-09-25', 24);
    list.forEach((date, i) => {
      const { year, month, day } = parseLocalDate(date);
      expect(weekdayOf(date)).toBe(5);
      expect(day).toBeGreaterThan(daysInMonth(year, month) - 7);
      expect(year * 12 + month - 1).toBe(2026 * 12 + 8 + i);
    });
    expect(list[1]).toBe('2026-10-30');
    expect(list[5]).toBe('2027-02-26');
  });

  it('5ᵉ lundi absent : retombe sur le dernier lundi, aucun mois sauté', () => {
    const r = rule({ freq: 'monthly', nthWeekday: { nth: 5, weekday: 1 } });
    expect(strs(series(r, '2026-08-31', 4))).toEqual(['2026-08-31', '2026-09-28', '2026-10-26', '2026-11-30']);
  });

  it('4ᵉ mercredi (critère 2) et intervalle 2', () => {
    const r = rule({ freq: 'monthly', nthWeekday: { nth: 4, weekday: 3 }, interval: 2 });
    expect(strs(series(r, '2026-09-23', 3))).toEqual(['2026-09-23', '2026-11-25', '2027-01-27']);
  });

  it('départ avant le Nᵉ jour du mois : même mois ; fin d’année', () => {
    const r = rule({ freq: 'monthly', nthWeekday: { nth: 1, weekday: 1 } });
    expect(nextOccurrenceDate(r, d('2026-09-01'), 0)).toBe('2026-09-07');
    expect(nextOccurrenceDate(r, d('2026-12-07'), 0)).toBe('2027-01-04');
  });
});

describe('nextOccurrenceDate : annuelle', () => {
  it('29 févr. 2028 : 28 févr. 2029, 2030, 2031 puis 29 févr. 2032 (critère 13)', () => {
    const r = rule({ freq: 'yearly', monthDay: 29 });
    expect(strs(series(r, '2028-02-29', 6))).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
      '2033-02-28',
    ]);
  });

  it('sans monthDay : jour de la date courante', () => {
    expect(nextOccurrenceDate(rule({ freq: 'yearly' }), d('2026-09-23'), 0)).toBe('2027-09-23');
    expect(nextOccurrenceDate(rule({ freq: 'yearly' }), d('2028-02-29'), 0)).toBe('2029-02-28');
  });

  it('départ avant le jour de la règle la même année', () => {
    expect(nextOccurrenceDate(rule({ freq: 'yearly', monthDay: 23 }), d('2026-09-20'), 0)).toBe('2026-09-23');
  });

  it('intervalle 4 sur 29 févr. et fin d’année', () => {
    const r = rule({ freq: 'yearly', monthDay: 29, interval: 4 });
    expect(strs(series(r, '2028-02-29', 3))).toEqual(['2028-02-29', '2032-02-29', '2036-02-29']);
    expect(nextOccurrenceDate(rule({ freq: 'yearly', monthDay: 31 }), d('2026-12-31'), 0)).toBe('2027-12-31');
  });
});

describe('fin de série (T-10)', () => {
  it('until inclus : la date égale à until est créée, la suivante non', () => {
    const r = rule({ interval: 7, until: d('2026-10-14') });
    expect(strs(series(r, '2026-09-23', 10))).toEqual(['2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14']);
    expect(nextOccurrenceDate(r, d('2026-10-14'), 3)).toBeNull();
  });

  it('until avant la prochaine date : série terminée', () => {
    const r = rule({ freq: 'monthly', monthDay: 23, until: d('2026-10-22') });
    expect(nextOccurrenceDate(r, d('2026-09-23'), 0)).toBeNull();
  });

  it('count : 6 occurrences, la 6ᵉ ne crée pas de 7ᵉ', () => {
    const r = rule({ count: 6 });
    expect(series(r, '2026-09-23', 20)).toHaveLength(6);
    expect(nextOccurrenceDate(r, d('2026-09-28'), 5)).toBeNull();
    expect(nextOccurrenceDate(r, d('2026-09-27'), 4)).toBe('2026-09-28');
  });

  it('count = 1 : aucune suivante', () => {
    expect(nextOccurrenceDate(rule({ count: 1 }), d('2026-09-23'), 0)).toBeNull();
  });
});

describe('séries longues et propriétés', () => {
  const cases: [string, RecurrenceFields, string][] = [
    ['daily 1', rule({}), '2026-01-01'],
    ['daily 3', rule({ interval: 3 }), '2026-02-27'],
    ['weekly lun/mer/dim', rule({ freq: 'weekly', weekdays: [1, 3, 7] }), '2026-03-02'],
    ['weekly /3', rule({ freq: 'weekly', weekdays: [2, 5], interval: 3 }), '2026-12-29'],
    ['monthly 31', rule({ freq: 'monthly', monthDay: 31 }), '2026-01-31'],
    ['monthly 29 /5', rule({ freq: 'monthly', monthDay: 29, interval: 5 }), '2027-01-29'],
    ['monthly 5e lundi', rule({ freq: 'monthly', nthWeekday: { nth: 5, weekday: 1 } }), '2026-03-30'],
    ['monthly dernier dim', rule({ freq: 'monthly', nthWeekday: { nth: -1, weekday: 7 } }), '2026-03-29'],
    ['yearly 29 fév', rule({ freq: 'yearly', monthDay: 29 }), '2024-02-29'],
    ['yearly 31 déc /2', rule({ freq: 'yearly', monthDay: 31, interval: 2 }), '2026-12-31'],
  ];

  it.each(cases)('%s : 250 occurrences strictement croissantes', (_name, r, start) => {
    const list = series(r, start, 250);
    expect(list).toHaveLength(250);
    for (let i = 1; i < list.length; i++) {
      expect((list[i] as LocalDate) > (list[i - 1] as LocalDate)).toBe(true);
    }
  });

  it('mensuelle : 250 occurrences = 250 mois consécutifs, jour = fin de mois pour le 31', () => {
    const list = series(rule({ freq: 'monthly', monthDay: 31 }), '2026-01-31', 250);
    list.forEach((date, i) => {
      const { year, month, day } = parseLocalDate(date);
      expect(year * 12 + month - 1).toBe(2026 * 12 + i);
      expect(day).toBe(daysInMonth(year, month) === 31 ? 31 : daysInMonth(year, month));
    });
  });

  it('annuelle 29 févr. : 200 ans, aucune année sautée, 29 si bissextile', () => {
    const list = series(rule({ freq: 'yearly', monthDay: 29 }), '2024-02-29', 200);
    list.forEach((date, i) => {
      const { year, month, day } = parseLocalDate(date);
      expect(year).toBe(2024 + i);
      expect(month).toBe(2);
      expect(day).toBe(daysInMonth(year, 2));
    });
    expect(list[76]).toBe('2100-02-28'); // 2100 n'est pas bissextile
  });

  it('quotidienne : l’écart est exactement l’intervalle sur 250 occurrences', () => {
    const list = series(rule({ interval: 3 }), '2026-02-27', 250);
    list.forEach((date, i) => expect(date).toBe(addDays(d('2026-02-27'), 3 * i)));
  });
});
