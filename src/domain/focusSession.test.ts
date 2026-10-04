import { describe, expect, it } from 'vitest';
import {
  activeMinutes,
  closeAtTerm,
  displayClock,
  elapsedActiveMs,
  endAtMs,
  formatClock,
  isElapsed,
  isTooShortToKeep,
  overdueMs,
  remainingFraction,
  remainingMs,
  sanitizeFocusDuration,
  stopValues,
  type FocusSessionRecord,
} from './focusSession';
import type { IsoDateTime, SpaceId, TaskId } from './types';

const iso = (value: string): IsoDateTime => value as IsoDateTime;
const ms = (value: string): number => Date.parse(value);

const session = (patch: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: 's1' as never,
  taskId: 't1' as TaskId,
  spaceId: 'pro' as SpaceId,
  plannedMin: 25,
  startedAt: iso('2026-10-04T08:00:00.000Z'),
  endedAt: null,
  pausedSec: 0,
  pausedAt: null,
  ...patch,
});

describe('minuteur calculé depuis les horodatages (F-01 critère 5)', () => {
  it('le temps écoulé ne dépend que de l’instant fourni : un saut de 40 minutes (veille) donne le temps juste', () => {
    const s = session();
    expect(elapsedActiveMs(s, ms('2026-10-04T08:09:26.000Z'))).toBe(9 * 60_000 + 26_000);
    // Plus de tick pendant 40 minutes (veille, arrière-plan) : aucune dérive.
    expect(elapsedActiveMs(s, ms('2026-10-04T08:49:26.000Z'))).toBe(49 * 60_000 + 26_000);
    expect(remainingMs(s, ms('2026-10-04T08:49:26.000Z'))).toBeLessThan(0);
  });

  it('15:34 restantes sur 25 min à 9 min 26 s', () => {
    const now = ms('2026-10-04T08:09:26.000Z');
    expect(displayClock(session(), now)).toBe('15:34');
    expect(displayClock(session(), now + 500)).toBe('15:34'); // arrondi à la seconde supérieure
    expect(displayClock(session(), now + 1000)).toBe('15:33');
  });

  it('« Libre » compte le temps écoulé et l’anneau reste plein', () => {
    const s = session({ plannedMin: null });
    const now = ms('2026-10-04T08:12:41.900Z');
    expect(displayClock(s, now)).toBe('12:41');
    expect(remainingMs(s, now)).toBeNull();
    expect(remainingFraction(s, now)).toBe(1);
  });

  it('l’anneau se vide avec le temps actif', () => {
    expect(remainingFraction(session(), ms('2026-10-04T08:12:30.000Z'))).toBeCloseTo(0.5);
    expect(remainingFraction(session(), ms('2026-10-04T09:00:00.000Z'))).toBe(0);
  });

  it('une horloge qui recule ne donne jamais un temps négatif', () => {
    expect(elapsedActiveMs(session(), ms('2026-10-04T07:00:00.000Z'))).toBe(0);
  });

  it('un instant illisible donne 0', () => {
    expect(elapsedActiveMs(session({ startedAt: iso('illisible') }), 1000)).toBe(0);
  });

  it('fuseaux : le résultat est indépendant du fuseau (instants UTC, décalage de l’heure d’été)', () => {
    // Nuit du passage à l’heure d’été (Paris, 2026-03-29 02:00 -> 03:00) : 30 minutes réelles restent 30 minutes.
    const s = session({ startedAt: iso('2026-03-29T00:45:00.000Z') });
    expect(elapsedActiveMs(s, ms('2026-03-29T01:15:00.000Z'))).toBe(30 * 60_000);
  });

  it('une session terminée garde sa valeur finale', () => {
    const s = session({ endedAt: iso('2026-10-04T08:25:00.000Z') });
    expect(elapsedActiveMs(s, ms('2026-10-05T08:00:00.000Z'))).toBe(25 * 60_000);
    expect(isElapsed(s, ms('2026-10-05T08:00:00.000Z'))).toBe(false);
  });

  it('minutes entières de temps actif', () => {
    expect(activeMinutes(session(), ms('2026-10-04T08:12:59.000Z'))).toBe(12);
  });
});

describe('terme, dépassement et clôture', () => {
  it('le terme est atteint exactement à la durée prévue', () => {
    expect(isElapsed(session(), ms('2026-10-04T08:24:59.999Z'))).toBe(false);
    expect(isElapsed(session(), ms('2026-10-04T08:25:00.000Z'))).toBe(true);
    expect(overdueMs(session(), ms('2026-10-04T08:27:00.000Z'))).toBe(2 * 60_000);
    expect(overdueMs(session(), ms('2026-10-04T08:10:00.000Z'))).toBe(0);
  });

  it('closeAtTerm clôt à la durée prévue, sans temps supplémentaire', () => {
    expect(closeAtTerm(session())).toBe('2026-10-04T08:25:00.000Z');
    expect(endAtMs(session())).toBe(ms('2026-10-04T08:25:00.000Z'));
  });

  it('« Libre » est plafonnée à 8 h de temps actif, pauses closes non comprises', () => {
    const free = session({ plannedMin: null, pausedSec: 3600 });
    expect(isElapsed(free, ms('2026-10-04T16:59:59.000Z'))).toBe(false);
    expect(isElapsed(free, ms('2026-10-04T17:00:00.000Z'))).toBe(true);
    expect(closeAtTerm(free)).toBe('2026-10-04T17:00:00.000Z');
  });

  it('moins d’une minute de temps actif : la session n’est pas conservée', () => {
    expect(isTooShortToKeep(session(), ms('2026-10-04T08:00:59.999Z'))).toBe(true);
    expect(isTooShortToKeep(session(), ms('2026-10-04T08:01:00.000Z'))).toBe(false);
  });

  it('arrêt : l’instant de fin est posé, sans pause en cours rien d’autre ne change', () => {
    expect(stopValues(session({ pausedSec: 30 }), iso('2026-10-04T08:10:00.000Z'))).toEqual({ endedAt: '2026-10-04T08:10:00.000Z', pausedSec: 30, pausedAt: null });
  });
});

describe('durées et horloge', () => {
  it('formatClock : MM:SS, puis H:MM:SS au-delà d’une heure', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(934)).toBe('15:34');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(5400)).toBe('1:30:00');
    expect(formatClock(-5)).toBe('00:00');
  });

  it('la durée mémorisée est une durée connue ou « Libre »', () => {
    expect(sanitizeFocusDuration(50)).toBe(50);
    expect(sanitizeFocusDuration(null)).toBeNull();
    expect(sanitizeFocusDuration(37)).toBe(25);
    expect(sanitizeFocusDuration(undefined)).toBe(25);
    expect(sanitizeFocusDuration('90')).toBe(25);
  });
});
