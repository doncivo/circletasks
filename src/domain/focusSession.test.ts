import { describe, expect, it } from 'vitest';
import {
  activeMinutes,
  closeAtTerm,
  currentPauseMs,
  displayClock,
  elapsedActiveMs,
  endAtMs,
  focusSeconds,
  formatClock,
  isElapsed,
  isLongPause,
  isPaused,
  isTooShortToKeep,
  notificationFireAtMs,
  overdueMs,
  pauseValues,
  remainingFraction,
  remainingMs,
  resumeValues,
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

describe('pause et reprise (F-02)', () => {
  const at = (hhmmss: string): IsoDateTime => `2026-10-04T${hhmmss}.000Z` as IsoDateTime;

  it('critères 1 et 2 : la pause fige le minuteur, la reprise repart du même temps restant', () => {
    const running = session();
    // 9 min 26 s écoulées, pause à 08:09:26.
    const paused = { ...running, ...pauseValues(running, at('08:09:26')) };
    expect(paused.pausedAt).toBe(at('08:09:26'));
    // 20 minutes plus tard : le temps affiché n'a pas bougé (15:34).
    const later = ms('2026-10-04T08:29:26.000Z');
    expect(displayClock(paused, later)).toBe('15:34');
    expect(currentPauseMs(paused, later)).toBe(20 * 60_000);
    const resumed = { ...paused, ...resumeValues(paused, at('08:29:26')) };
    expect(resumed).toMatchObject({ pausedAt: null, pausedSec: 1200 });
    expect(displayClock(resumed, ms('2026-10-04T08:29:26.000Z'))).toBe('15:34');
    expect(displayClock(resumed, ms('2026-10-04T08:29:56.000Z'))).toBe('15:04');
  });

  it('critère 3 : plusieurs pauses, temps enregistré = fin - début - total des pauses, arrondi à la seconde', () => {
    let s = session();
    s = { ...s, ...pauseValues(s, at('08:05:00')) };
    s = { ...s, ...resumeValues(s, at('08:10:00')) }; // 5 min
    s = { ...s, ...pauseValues(s, at('08:15:00')) };
    s = { ...s, ...resumeValues(s, at('08:17:30')) }; // 2 min 30
    expect(s.pausedSec).toBe(450);
    const closed = { ...s, ...stopValues(s, at('08:32:30')) };
    // 32 min 30 de présence - 7 min 30 de pauses = 25 min.
    expect(focusSeconds(closed)).toBe(25 * 60);
    expect(elapsedActiveMs(closed, ms('2026-10-05T00:00:00.000Z'))).toBe(25 * 60_000);
  });

  it('critère 3 : la durée prévue n’est pas prolongée en temps actif ; seul le terme en temps d’horloge se décale', () => {
    let s = session();
    expect(endAtMs(s)).toBe(ms('2026-10-04T08:25:00.000Z'));
    s = { ...s, ...pauseValues(s, at('08:10:00')) };
    s = { ...s, ...resumeValues(s, at('08:40:00')) }; // 30 min de pause
    expect(endAtMs(s)).toBe(ms('2026-10-04T08:55:00.000Z')); // début + 25 min + 30 min de pause
    expect(remainingMs(s, ms('2026-10-04T08:40:00.000Z'))).toBe(15 * 60_000); // le temps actif restant est inchangé
    expect(isElapsed(s, ms('2026-10-04T08:54:59.000Z'))).toBe(false);
    expect(isElapsed(s, ms('2026-10-04T08:55:00.000Z'))).toBe(true);
  });

  it('critère 4 : pause à cheval sur minuit et sur plusieurs jours, comptée par horodatage', () => {
    const quick = session({ startedAt: iso('2026-10-04T23:50:00.000Z'), pausedAt: iso('2026-10-04T23:55:00.000Z') });
    expect(elapsedActiveMs(quick, ms('2026-10-06T12:00:00.000Z'))).toBe(5 * 60_000);
    expect(isElapsed(quick, ms('2026-10-06T12:00:00.000Z'))).toBe(false); // une pause ne dépasse jamais son terme
    expect(currentPauseMs(quick, ms('2026-10-05T01:55:00.000Z'))).toBe(2 * 3_600_000);
    // Reprise le surlendemain à minuit : le temps de pause (24 h 5 min) est ajouté en secondes, le temps actif ne bouge pas.
    const resumed = { ...quick, ...resumeValues(quick, iso('2026-10-06T00:00:00.000Z')) };
    expect(resumed.pausedSec).toBe(24 * 3600 + 5 * 60);
    expect(elapsedActiveMs(resumed, ms('2026-10-06T00:00:00.000Z'))).toBe(5 * 60_000);
  });

  it('critère 5 : arrêter une session en pause clôt la pause à cet instant, le temps actif seul est enregistré', () => {
    const paused = session({ pausedAt: iso('2026-10-04T08:10:00.000Z') });
    const values = stopValues(paused, at('08:40:00'));
    expect(values).toEqual({ endedAt: at('08:40:00'), pausedSec: 1800, pausedAt: null });
    const closed = { ...paused, ...values };
    expect(focusSeconds(closed)).toBe(10 * 60);
    expect(isPaused(closed)).toBe(false);
  });

  it('critère 7 : une pause de plus de 2 h propose « Toujours en pause ? », jamais d’arrêt automatique', () => {
    const paused = session({ pausedAt: iso('2026-10-04T08:10:00.000Z') });
    expect(isLongPause(paused, ms('2026-10-04T10:10:00.000Z'))).toBe(false);
    expect(isLongPause(paused, ms('2026-10-04T10:10:01.000Z'))).toBe(true);
    expect(isElapsed(paused, ms('2026-10-09T10:10:01.000Z'))).toBe(false);
    expect(isLongPause(session(), ms('2026-10-09T10:10:01.000Z'))).toBe(false);
  });

  it('une seule pause ouverte : pause sans effet si déjà en pause, reprise sans effet si la session court', () => {
    const paused = session({ pausedAt: iso('2026-10-04T08:10:00.000Z') });
    expect(pauseValues(paused, at('08:20:00'))).toBeNull();
    expect(resumeValues(session(), at('08:20:00'))).toBeNull();
  });

  it('critère 8 : la fin notifiée est annulée en pause (null) et recalculée à la reprise', () => {
    const running = session();
    expect(notificationFireAtMs(running)).toBe(ms('2026-10-04T08:25:00.000Z'));
    const paused = session({ pausedAt: iso('2026-10-04T08:10:00.000Z') });
    expect(notificationFireAtMs(paused)).toBeNull();
    const resumed = { ...paused, ...resumeValues(paused, at('08:30:00')) };
    expect(notificationFireAtMs(resumed)).toBe(ms('2026-10-04T08:45:00.000Z'));
    expect(notificationFireAtMs(session({ plannedMin: null }))).toBeNull();
    expect(notificationFireAtMs(session({ endedAt: iso('2026-10-04T08:20:00.000Z') }))).toBeNull();
  });
});
