import type { LocalDateTime } from './types';

/**
 * Conversion d'une échéance flottante en instant (N-01 critère 2, ADR 0012 avenant N1.2). Le fuseau est TOUJOURS passé en argument
 * (IANA, calcul par `Intl` avec fuseau explicite) : le résultat ne dépend ni de la variable `TZ` ni du fuseau du processus.
 *
 * - heure inexistante (saut de l'heure d'été) : décalée d'une heure vers l'avant (décalage d'avant la transition) ;
 * - heure répétée (retour à l'heure d'hiver) : la PREMIÈRE occurrence (`localToUtcMs` de timeZone.ts rend « l'une des deux »).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let known = formatters.get(zone);
  if (known === undefined) {
    known = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, known);
  }
  return known;
}

/** Heure murale (champs numériques) de l'instant `ms` dans `zone`. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function wallClockAt(ms: number, zone: string): WallClock {
  const values: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year'] ?? 0,
    month: values['month'] ?? 0,
    day: values['day'] ?? 0,
    hour: (values['hour'] ?? 0) % 24,
    minute: values['minute'] ?? 0,
    second: values['second'] ?? 0,
  };
}

/** Décalage (ms) du fuseau à l'instant `ms` : heure murale moins UTC. */
function offsetAt(ms: number, zone: string): number {
  const w = wallClockAt(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

const DAY_MS = 86_400_000;

function parts(fireAt: LocalDateTime): [number, number, number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(fireAt);
  if (m === null) throw new RangeError(`Échéance invalide : « ${fireAt} »`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
}

/** Instant (ms UTC) de l'heure murale `fireAt` dans le fuseau IANA `zone`. Lève `RangeError` si le fuseau ou l'échéance est invalide. */
export function fireAtInstant(fireAt: LocalDateTime, zone: string): number {
  const [year, month, day, hour, minute] = parts(fireAt);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Les décalages possibles autour de l'échéance : un jour avant et un jour après (une transition au plus, hors cas exotiques).
  const before = offsetAt(wall - DAY_MS, zone);
  const after = offsetAt(wall + DAY_MS, zone);
  const valid = [...new Set([before, after])].map((offset) => wall - offset).filter((instant) => offsetAt(instant, zone) === wall - instant);
  if (valid.length > 0) return Math.min(...valid);
  // Heure inexistante : le décalage d'avant la transition place l'échéance une heure plus tard à l'heure murale.
  return wall - before;
}

/** Fuseau illisible : le décalage courant du moteur JS (N-06 critère 3), jamais un calcul silencieux sur UTC. */
export function fireAtInstantLocal(fireAt: LocalDateTime): number {
  const [year, month, day, hour, minute] = parts(fireAt);
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** Heure murale d'un instant, au format de date du plugin : `YYYY-MM-DDTHH:mm:00.000Z` (le `Z` n'est pas UTC, constat 7 de l'ADR). */
export function pluginDate(instantMs: number, zone: string | null): string {
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  if (zone === null) {
    const d = new Date(instantMs);
    return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00.000Z`;
  }
  const w = wallClockAt(instantMs, zone);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:00.000Z`;
}

/** Échéance flottante (minute) de l'heure murale d'un instant. */
export function localDateTimeAt(instantMs: number, zone: string | null): LocalDateTime {
  return pluginDate(instantMs, zone).slice(0, 16) as LocalDateTime;
}
