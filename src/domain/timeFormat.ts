import type { LocalTime } from './types';

/**
 * P-03 : format d'affichage des heures. Les valeurs stockées restent 'HH:mm' (24 h, flottantes) ; seul l'affichage change.
 * Ce module est le seul à produire un texte d'heure (test d'architecture `timeFormat.arch.test.ts`).
 */
export type TimeFormat = '24h' | '12h';
export const TIME_FORMATS: readonly TimeFormat[] = ['24h', '12h'];
export const DEFAULT_TIME_FORMAT: TimeFormat = '24h';

const pad2 = (n: number): string => String(n).padStart(2, '0');

function split(time: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours > 23 || minutes > 59 ? null : { hours, minutes };
}

/** « 09:00 » en 24 h ; « 9:00 AM » / « 3:30 PM » en 12 h (D4 : AM / PM en capitales, heure sans zéro initial). Texte non reconnu : rendu tel quel. */
export function formatTime(time: string, format: TimeFormat = DEFAULT_TIME_FORMAT): string {
  const parts = split(time);
  if (!parts) return time;
  if (format === '24h') return `${pad2(parts.hours)}:${pad2(parts.minutes)}`;
  const hour12 = parts.hours % 12 === 0 ? 12 : parts.hours % 12;
  return `${hour12}:${pad2(parts.minutes)} ${parts.hours < 12 ? 'AM' : 'PM'}`;
}

/** Plage « 09:00 – 10:30 » (ou une seule heure si la fin est absente ou identique). */
export function formatTimeRange(start: string, end: string | null, format: TimeFormat = DEFAULT_TIME_FORMAT): string {
  return end !== null && end !== start ? `${formatTime(start, format)} – ${formatTime(end, format)}` : formatTime(start, format);
}

const UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante'];

function frenchNumber(n: number): string {
  if (n < 20) return UNITS[n] ?? String(n);
  const ten = Math.floor(n / 10);
  const unit = n % 10;
  if (unit === 0) return TENS[ten] ?? String(n);
  return `${TENS[ten] ?? ''}${unit === 1 ? ' et un' : `-${UNITS[unit] ?? ''}`}`;
}

/** Heure lue en langage naturel, indépendante du format affiché : « quinze heures trente », « neuf heures » (accessibilité). */
export function spokenTime(time: string): string {
  const parts = split(time);
  if (!parts) return time;
  const hours = `${frenchNumber(parts.hours).replace(/\bun$/, 'une')} ${parts.hours <= 1 ? 'heure' : 'heures'}`;
  return parts.minutes === 0 ? hours : `${hours} ${frenchNumber(parts.minutes)}`;
}

/** Heures de la roue iPhone (T-14) : 0 à 23 en 24 h ; en 12 h, 12, 1…11 avec une colonne AM / PM à part. */
export function hourColumnLabel(hour24: number, format: TimeFormat): string {
  if (format === '24h') return pad2(hour24);
  return String(hour24 % 12 === 0 ? 12 : hour24 % 12);
}

/** Convertit une heure 1–12 et AM / PM en heure 0–23. */
export function hour12To24(hour12: number, pm: boolean): number {
  return (hour12 % 12) + (pm ? 12 : 0);
}

/** 'HH:mm' à partir d'heures et minutes valides. */
export function toLocalTime(hours: number, minutes: number): LocalTime | null {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${pad2(hours)}:${pad2(minutes)}` as LocalTime;
}
