import { DEFAULT_TIME_FORMAT, type TimeFormat } from '../domain/timeFormat';
import { DEFAULT_FIRST_WEEKDAY, type FirstWeekday } from '../domain/week';

/**
 * P-03 : préférences d'affichage courantes (format d'heure, premier jour de semaine). Comme `getLocale()`, valeur de module lue au
 * moment du rendu ; le changement notifie les abonnés (la coquille se réaffiche, donc tout change sans redémarrage). Les valeurs
 * stockées (`time = "09:00"`) ne changent jamais.
 */
export interface FormatPrefs {
  readonly timeFormat: TimeFormat;
  readonly firstWeekday: FirstWeekday;
}

let current: FormatPrefs = { timeFormat: DEFAULT_TIME_FORMAT, firstWeekday: DEFAULT_FIRST_WEEKDAY };
let version = 0;
const listeners = new Set<() => void>();

export function getTimeFormat(): TimeFormat {
  return current.timeFormat;
}

export function getFirstWeekday(): FirstWeekday {
  return current.firstWeekday;
}

/** Applique des préférences (partielles) ; ne notifie que si une valeur change. */
export function setFormatPrefs(next: Partial<FormatPrefs>): void {
  const merged = { ...current, ...next };
  if (merged.timeFormat === current.timeFormat && merged.firstWeekday === current.firstWeekday) return;
  current = merged;
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Compteur qui change à chaque modification (clé de réaffichage, `useSyncExternalStore`). */
export function formatPrefsVersion(): number {
  return version;
}

export function subscribeFormatPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
