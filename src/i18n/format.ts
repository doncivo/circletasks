import { getLocale, t } from './index';

/** Jour court lisible (« lun. 28 sept. »), selon la langue courante ; date civile, sans effet de fuseau. */
export function formatDayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

const MONTH_LABEL_OPTIONS = { month: 'long', year: 'numeric', timeZone: 'UTC' } as const;

function utcDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

/**
 * En-tête d'une période de tâches terminées (T-07), selon la langue courante :
 * « 23 sept. », « 21 – 27 sept. » (« 28 sept. – 4 oct. » à cheval sur deux mois), « septembre 2026 ».
 */
export function formatDonePeriodLabel(kind: 'day' | 'week' | 'month', from: string, to: string): string {
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const fmt = (options: Intl.DateTimeFormatOptions, date: string) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(utcDate(date));
  if (kind === 'month') return new Intl.DateTimeFormat(locale, MONTH_LABEL_OPTIONS).format(utcDate(from));
  if (kind === 'day') return fmt({ day: 'numeric', month: 'short' }, from);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return sameMonth
    ? `${fmt({ day: 'numeric' }, from)} – ${fmt({ day: 'numeric', month: 'short' }, to)}`
    : `${fmt({ day: 'numeric', month: 'short' }, from)} – ${fmt({ day: 'numeric', month: 'short' }, to)}`;
}

const intlLocale = (): string => (getLocale() === 'fr' ? 'fr-FR' : 'en-US');
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Jour complet pour le bandeau « Compris : » (« vendredi 25 sept. »), selon la langue courante. */
export function formatDayFull(isoDate: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(utcDate(isoDate));
}

/** Libellé d'un jour de la roue iPhone (« Jeu. 24 sept. »), première lettre en majuscule. */
export function formatWheelDay(isoDate: string): string {
  return capitalize(formatDayLabel(isoDate));
}

/** Titre du mini-calendrier (« Septembre 2026 »). */
export function formatMonthTitle(year: number, month: number): string {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return capitalize(new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date));
}

/** Initiales des jours, lundi en premier (« L M M J V S D »). */
export function weekdayInitials(): string[] {
  const format = new Intl.DateTimeFormat(intlLocale(), { weekday: 'narrow', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 1 + i)))); // 1er janv. 2024 : lundi
}

/** Nom accessible d'une case du calendrier (« 25 septembre »). */
export function formatDayAria(isoDate: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(utcDate(isoDate));
}

/** Noms complets des jours, lundi en premier (« lundi »…), pour les en-têtes de colonne du calendrier. */
export function weekdayNamesLong(): string[] {
  const format = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => format.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/**
 * En-tête d'Aujourd'hui (A-01, Main.html / PC-Aujourdhui.html) : « sept. 2026 » et « 23 mer. » en
 * format court (iPhone), « septembre 2026 » et « 23 mercredi » en format long (PC).
 */
export function formatTodayHeader(isoDate: string, style: 'short' | 'long'): { monthLine: string; dayLine: string } {
  const locale = intlLocale();
  const date = utcDate(isoDate);
  const monthLine = new Intl.DateTimeFormat(locale, { month: style === 'long' ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: style === 'long' ? 'long' : 'short', timeZone: 'UTC' }).format(date);
  return { monthLine, dayLine: `${String(date.getUTCDate())} ${weekday}` };
}

/** Nom du jour de la semaine (« dimanche »), pour la phrase de l'état vide (Main-Vide.html). */
export function formatWeekdayName(isoDate: string): string {
  return new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', timeZone: 'UTC' }).format(utcDate(isoDate));
}

/** Date de la fiche détail (« Mer. 23 sept. 2026 », sans l'année si `withYear` est faux), première lettre en majuscule. */
export function formatDetailDate(isoDate: string, withYear = true): string {
  return capitalize(
    new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' as const } : {}), timeZone: 'UTC' }).format(utcDate(isoDate)),
  );
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Horodatage relatif de la fiche détail (« aujourd'hui à 18:04 », « hier à 18:04 », « le 2 sept. à 18:04 ») pour un
 * instant UTC ISO, dans le fuseau de l'appareil, heures en 24 h.
 */
export function formatStamp(isoInstant: string, nowMs: number): string {
  const then = new Date(isoInstant);
  const now = new Date(nowMs);
  const dayStart = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(then)) / 86_400_000);
  const time = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`;
  if (days === 0) return t('detail.stampToday', { time });
  if (days === 1) return t('detail.stampYesterday', { time });
  const date = new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', ...(then.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) }).format(then);
  return t('detail.stampOn', { date, time });
}

/**
 * Plage d'une semaine (S-01) : « 21 – 27 septembre 2026 » (PC, `long`) ou « 21 – 27 sept. » (iPhone, `short`) ; à cheval
 * sur deux mois « 28 sept. – 4 oct. » (court) ou « 28 septembre – 4 octobre 2026 » (long) ; sur deux années, l'année
 * suit chaque bout en format long (« 28 décembre 2026 – 3 janvier 2027 ») et n'est pas affichée en format court.
 */
export function formatWeekRange(from: string, to: string, style: 'long' | 'short'): string {
  const locale = intlLocale();
  const fmt = (options: Intl.DateTimeFormatOptions, date: string): string =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(utcDate(date));
  const month = style === 'long' ? 'long' : 'short';
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${fmt({ day: 'numeric' }, from)} – ${fmt({ day: 'numeric', month, ...(style === 'long' ? { year: 'numeric' as const } : {}) }, to)}`;
  }
  if (style === 'short') return `${fmt({ day: 'numeric', month }, from)} – ${fmt({ day: 'numeric', month }, to)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${fmt({ day: 'numeric', month }, from)} – ${fmt({ day: 'numeric', month, year: 'numeric' }, to)}`;
  return `${fmt({ day: 'numeric', month, year: 'numeric' }, from)} – ${fmt({ day: 'numeric', month, year: 'numeric' }, to)}`;
}

/** En-tête d'un jour de la Semaine (maquettes : « LUN. » et « 21 ») : jour court en capitales et numéro. */
export function formatWeekDayHeader(isoDate: string): { weekday: string; day: string } {
  const date = utcDate(isoDate);
  const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' }).format(date);
  return { weekday: weekday.toLocaleUpperCase(intlLocale()), day: String(date.getUTCDate()) };
}
