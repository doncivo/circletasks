import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyParts, type ReminderBodyItem } from './notificationBody';

const item = (over: Record<string, unknown> = {}): ReminderBodyItem => ({
  kind: 'task', offsetMin: 30, scheduledAt: '2026-09-22T19:30', fireAt: '2026-09-23T08:00', occurrenceDate: '2026-09-22', ...over,
}) as unknown as ReminderBodyItem;

describe('N-FIX-02 : description pure du corps', () => {
  it('rétablit l’échéance 20:00, sans reprendre 19:30 ni 08:00', () => {
    expect(bodyParts(item())).toEqual({ day: '2026-09-22', time: '20:00', allDay: false, shifted: true, snoozed: false });
  });
  it('une avance de la veille restaure le jour réel de l’élément', () => {
    expect(bodyParts(item({ offsetMin: 1440, scheduledAt: '2026-09-23T09:00', fireAt: '2026-09-23T09:00', occurrenceDate: '2026-09-24' }))).toEqual({ day: '2026-09-24', time: '09:00', allDay: false, shifted: false, snoozed: false });
  });
  it('routine du même jour : pas de date redondante', () => {
    expect(bodyParts(item({ kind: 'routine', offsetMin: 0, scheduledAt: '2026-09-23T07:00', fireAt: '2026-09-23T07:00' }))).toEqual({ day: null, time: '07:00', allDay: false, shifted: false, snoozed: false });
  });
  it('journée entière : date toujours, aucune heure conventionnelle', () => {
    expect(bodyParts(item({ kind: 'event', offsetMin: 0, scheduledAt: '2027-03-12T09:00', fireAt: '2027-03-12T09:00' }), { allDay: true })).toEqual({ day: '2027-03-12', time: null, allDay: true, shifted: false, snoozed: false });
  });
  it('répétition de tâche : heure et date lues sur la cible, aucun décalage annoncé', () => {
    expect(bodyParts(item({ kind: 'snooze', originKind: 'task', occurrenceDate: null, fireAt: '2026-09-23T09:15' }), { date: '2026-09-24', time: '09:00' })).toEqual({ day: '2026-09-24', time: '09:00', allDay: false, shifted: false, snoozed: true });
  });
  it('répétition d’événement : la date d’occurrence prime sur la première occurrence de série', () => {
    expect(bodyParts(item({ kind: 'snooze', originKind: 'event', occurrenceDate: '2027-03-12', fireAt: '2027-03-12T09:15' }), { date: '2026-03-12', time: null, allDay: true })).toEqual({ day: '2027-03-12', time: null, allDay: true, shifted: false, snoozed: true });
  });
  it('ne dépend d’aucun texte, plateforme, base ou horloge et ne modifie pas ses entrées', () => {
    const source = readFileSync(new URL('./notificationBody.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Date\.now|Math\.random|new Date\(\s*\)|from ['"][^'"]*\/(?:i18n|platform|db)(?:\/|['"])/);
    const frozen = Object.freeze(item());
    const context = Object.freeze({ date: '2026-09-22', time: '20:00' });
    const before = JSON.stringify({ frozen, context });
    expect(bodyParts(frozen, context)).toEqual(bodyParts(frozen, context));
    expect(JSON.stringify({ frozen, context })).toBe(before);
  });
});
