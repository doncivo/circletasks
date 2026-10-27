import { afterEach, describe, expect, it } from 'vitest';
import { asLocalDateTime, type LocalTime } from '../domain/types';
import { setLocale } from './index';
import { quietShiftFormText, routineQuietLineText } from './quietShiftText';

/** N-FIX-04 : formulation unique d'Ali, « une phrase, une cause ». Catalogue chargé avec les formulaires, hors du départ. */
describe('texte de l’avertissement de plage silencieuse (formulaires)', () => {
  afterEach(() => setLocale('fr'));

  it('autre jour, plage du soir : « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 »', () => {
    expect(quietShiftFormText({ fireAt: asLocalDateTime('2026-10-09T20:00'), effective: asLocalDateTime('2026-10-12T08:00'), cause: { kind: 'after', from: '19:00' as LocalTime } }, 'Pro')).toBe(
      'Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00',
    );
  });

  it('week-end : « … — aucun rappel Pro le week-end »', () => {
    expect(quietShiftFormText({ fireAt: asLocalDateTime('2026-10-10T20:00'), effective: asLocalDateTime('2026-10-12T08:00'), cause: { kind: 'weekend' } }, 'Pro')).toBe(
      'Rappel décalé au lundi 08:00 — aucun rappel Pro le week-end',
    );
  });

  it('même jour, matin : « Rappel décalé à 08:00 — aucun rappel Pro avant 08:00 »', () => {
    expect(quietShiftFormText({ fireAt: asLocalDateTime('2026-10-06T07:30'), effective: asLocalDateTime('2026-10-06T08:00'), cause: { kind: 'before', to: '08:00' as LocalTime } }, 'Pro')).toBe(
      'Rappel décalé à 08:00 — aucun rappel Pro avant 08:00',
    );
  });

  it('journée entière sur un jour : « … — aucun rappel Pro le mercredi »', () => {
    expect(quietShiftFormText({ fireAt: asLocalDateTime('2026-10-07T10:00'), effective: asLocalDateTime('2026-10-08T00:00'), cause: { kind: 'all-day', weekdays: [3] } }, 'Pro')).toBe(
      'Rappel décalé au jeudi 00:00 — aucun rappel Pro le mercredi',
    );
  });

  it('anglais', () => {
    setLocale('en');
    expect(quietShiftFormText({ fireAt: asLocalDateTime('2026-10-09T20:00'), effective: asLocalDateTime('2026-10-12T08:00'), cause: { kind: 'after', from: '19:00' as LocalTime } }, 'Pro')).toBe(
      'Reminder moved to Monday 08:00 — no Pro reminders after 19:00',
    );
  });
});

describe('ligne de l’écran Routines : trois états', () => {
  it('tous décalés : « Rappels décalés à 08:00 » ; sans heure commune : « Rappels décalés »', () => {
    expect(routineQuietLineText({ state: 'all', time: '08:00' as LocalTime })).toBe('Rappels décalés à 08:00');
    expect(routineQuietLineText({ state: 'all', time: null })).toBe('Rappels décalés');
  });

  it('partiel : nomme ce qui est touché et la cible', () => {
    expect(routineQuietLineText({ state: 'partial', weekdays: [6, 7], target: { weekday: 1, time: '08:00' as LocalTime } })).toBe('Rappels du week-end décalés au lundi 08:00');
    expect(routineQuietLineText({ state: 'partial', weekdays: [2, 4], target: { weekday: null, time: '08:00' as LocalTime } })).toBe('Rappels du mardi et du jeudi décalés à 08:00');
    expect(routineQuietLineText({ state: 'partial', weekdays: [1, 2, 3, 4, 5, 6, 7], target: { weekday: null, time: null } })).toBe('Rappels de tous les jours décalés');
  });

  it('aucun : null, rien à afficher', () => {
    expect(routineQuietLineText({ state: 'none' })).toBeNull();
  });
});
