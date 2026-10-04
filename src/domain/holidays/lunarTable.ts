import type { LocalDate } from '../types';

/**
 * Table annuelle des fêtes religieuses tunisiennes à date lunaire (E-03 critère 2, PRD 6 : source « table annuelle »).
 *
 * SOURCE ET FIABILITÉ — ces dates sont PRÉVISIONNELLES. Elles ont été tabulées le 2026-10-04 avec le calendrier Umm al-Qura
 * (ICU / CLDR, `Intl.DateTimeFormat('en-u-ca-islamic-umalqura')`) : 1er chawwal (Aïd el-Fitr), 10 dhou al-hijja (Aïd el-Idha),
 * 1er mouharram (Ras el am el hejri) et 12 rabi' al-awwal (Mouled). La Tunisie fixe ces fêtes par l'observation du croissant, annoncée
 * par la Mufti de la République : l'écart avec la table est d'un jour au plus. Elles sont donc toutes affichées « date estimée » tant
 * que l'utilisateur ne les a pas confirmées en saisissant la date officielle (saisie manuelle, `overridden`).
 * Seul le premier jour de chaque fête est inscrit (l'Aïd est chômé deux jours en Tunisie : le second jour n'est pas listé).
 *
 * MISE À JOUR ANNUELLE — ajouter l'année suivante AVANT la fin de l'année en cours ; Réglages › Jours fériés avertit (sans bloquer) quand l'année
 * suivante n'est pas couverte. Au démarrage, la table de la base est rapprochée de celle-ci (`ensureHolidayTable`) : les dates
 * saisies à la main ne sont jamais écrasées.
 */
export const LUNAR_HOLIDAY_KEYS = ['eidAlFitr', 'eidAlAdha', 'rasElAmElHejri', 'mouled'] as const;
export type LunarHolidayKey = (typeof LUNAR_HOLIDAY_KEYS)[number];

export function isLunarKey(key: string): key is LunarHolidayKey {
  return (LUNAR_HOLIDAY_KEYS as readonly string[]).includes(key);
}

type YearTable = Readonly<Record<LunarHolidayKey, LocalDate>>;

const row = (eidAlFitr: string, eidAlAdha: string, rasElAmElHejri: string, mouled: string): YearTable => ({
  eidAlFitr: eidAlFitr as LocalDate,
  eidAlAdha: eidAlAdha as LocalDate,
  rasElAmElHejri: rasElAmElHejri as LocalDate,
  mouled: mouled as LocalDate,
});

/** Dates prévisionnelles 2026 à 2030, par année. */
export const LUNAR_HOLIDAY_TABLE: Readonly<Record<number, YearTable>> = {
  2026: row('2026-03-20', '2026-05-27', '2026-06-16', '2026-08-25'),
  2027: row('2027-03-09', '2027-05-16', '2027-06-06', '2027-08-14'),
  2028: row('2028-02-26', '2028-05-05', '2028-05-25', '2028-08-03'),
  2029: row('2029-02-14', '2029-04-24', '2029-05-14', '2029-07-24'),
  2030: row('2030-02-04', '2030-04-13', '2030-05-04', '2030-07-13'),
};

/** Années couvertes par la table embarquée, dans l'ordre. */
export const LUNAR_TABLE_YEARS: readonly number[] = Object.keys(LUNAR_HOLIDAY_TABLE)
  .map(Number)
  .sort((a, b) => a - b);

export const LUNAR_TABLE_LAST_YEAR = LUNAR_TABLE_YEARS[LUNAR_TABLE_YEARS.length - 1] ?? 0;

/** Date de la table pour une fête lunaire et une année ; null si l'année n'est pas couverte. */
export function lunarTableDate(year: number, key: LunarHolidayKey): LocalDate | null {
  return LUNAR_HOLIDAY_TABLE[year]?.[key] ?? null;
}

/** L'année est-elle couverte par la table des fêtes religieuses ? (critère 8 : sinon, elles manquent et l'écran le signale.) */
export function isLunarYearCovered(year: number): boolean {
  return LUNAR_HOLIDAY_TABLE[year] !== undefined;
}
