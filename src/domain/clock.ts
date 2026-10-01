import type { IsoDateTime, LocalDate, LocalTime } from './types';

/**
 * Horloge injectable. Aucune règle métier n'appelle `Date.now()` ni `new Date()`
 * directement : elle reçoit une `Clock` (système en production, contrôlée en test).
 */
export interface Clock {
  /** Millisecondes depuis l'époque Unix (UTC). */
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

/** Horloge de test : figée, avançable à la main. */
export interface ManualClock extends Clock {
  set(isoOrMs: string | number): void;
  advance(ms: number): void;
}

export function createManualClock(start: string | number): ManualClock {
  let current = toMs(start);
  return {
    nowMs: () => current,
    set: (value) => {
      current = toMs(value);
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

function toMs(value: string | number): number {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) throw new TypeError(`Instant invalide : « ${String(value)} »`);
  return ms;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Instant courant en ISO UTC (colonnes created_at / updated_at / deleted_at). */
export function nowIso(clock: Clock): IsoDateTime {
  return new Date(clock.nowMs()).toISOString() as IsoDateTime;
}

/** Date civile locale (fuseau de l'appareil) de l'instant courant. */
export function todayLocal(clock: Clock): LocalDate {
  const d = new Date(clock.nowMs());
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as LocalDate;
}

/** Heure locale flottante (fuseau de l'appareil) de l'instant courant, 24 h. */
export function nowLocalTime(clock: Clock): LocalTime {
  const d = new Date(clock.nowMs());
  return `${pad(d.getHours())}:${pad(d.getMinutes())}` as LocalTime;
}
