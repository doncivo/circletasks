import { describe, expect, it } from 'vitest';
import { IPHONE_STALE_AFTER_MS, REMINDER_WARNING_WINDOW_MS, warnIphoneReminder, warnIphoneReminders, type WarningDevice } from './iphoneReminderWarning';

const NOW = Date.parse('2026-10-08T10:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

const pc: WarningDevice = { platform: 'windows', self: true, status: 'active' };
const iphone = (ageMs: number | null, over: Partial<WarningDevice> = {}): WarningDevice => ({
  platform: 'ios',
  self: false,
  status: 'active',
  publishedSyncAt: ageMs === null ? null : iso(NOW - ageMs),
  ...over,
});
const warn = (fireInMs: number, devices: readonly WarningDevice[]) => warnIphoneReminder({ nowMs: NOW, fireAtMs: NOW + fireInMs, devices });

/** N-07 critères 4 à 8 : fonction pure, sans horloge globale. */
describe('warnIphoneReminder (N-07)', () => {
  it('constantes : fenêtre de 2 h, seuil de 2 h 30 sur la valeur publiée (2 h plus le rafraîchissement de 30 minutes)', () => {
    expect(REMINDER_WARNING_WINDOW_MS).toBe(2 * HOUR);
    expect(IPHONE_STALE_AFTER_MS).toBe(2 * HOUR + 30 * MIN);
  });

  it('critère 4 : rappel dans moins de 2 h et iPhone sans synchro publiée depuis plus de 2 h 30 : stale (bornes 1 h 59, 2 h 00, 2 h 30, 2 h 31)', () => {
    expect(warn(HOUR, [pc, iphone(HOUR + 59 * MIN)])).toBe('none');
    expect(warn(HOUR, [pc, iphone(2 * HOUR)])).toBe('none');
    expect(warn(HOUR, [pc, iphone(2 * HOUR + 30 * MIN)])).toBe('none');
    expect(warn(HOUR, [pc, iphone(2 * HOUR + 30 * MIN + 1000)])).toBe('stale');
    expect(warn(HOUR, [pc, iphone(5 * HOUR)])).toBe('stale');
  });

  it('critère 4 : le rappel concerné est à moins de 2 h (1 h 59 oui, 2 h 00 et 2 h 01 non, passé non)', () => {
    const stale = [pc, iphone(10 * HOUR)];
    expect(warn(HOUR + 59 * MIN, stale)).toBe('stale');
    expect(warn(2 * HOUR, stale)).toBe('none');
    expect(warn(2 * HOUR + MIN, stale)).toBe('none');
    expect(warn(0, stale)).toBe('none');
    expect(warn(-MIN, stale)).toBe('none');
    expect(warn(1, stale)).toBe('stale');
  });

  it('critère 5 : iPhone synchronisé depuis moins de 2 h : aucun avertissement ; rappel à plus de 2 h : aucun avertissement même si l’iPhone est ancien', () => {
    expect(warn(30 * MIN, [pc, iphone(10 * MIN)])).toBe('none');
    expect(warn(3 * HOUR, [pc, iphone(10 * HOUR)])).toBe('none');
    expect(warn(3 * HOUR, [pc])).toBe('none');
  });

  it('critère 6 : aucun iPhone associé (aucun appareil iOS, ou synchro non configurée) : no-iphone', () => {
    expect(warn(HOUR, [pc])).toBe('no-iphone');
    expect(warn(HOUR, [])).toBe('no-iphone');
    expect(warn(HOUR, [pc, { platform: 'windows', self: false, status: 'active' }])).toBe('no-iphone');
    // Un iPhone jamais lu (cité seulement dans un accusé) n'est pas un iPhone associé.
    expect(warn(HOUR, [pc, iphone(MIN, { seen: false })])).toBe('no-iphone');
    // Soi-même sur iOS (jamais le cas du PC) ne compte pas non plus.
    expect(warn(HOUR, [{ platform: 'ios', self: true, status: 'active', publishedSyncAt: iso(NOW) }])).toBe('no-iphone');
  });

  it.each(['forgotten', 'expired', 'corrupt', 'foreign', 'rollback', 'newer-major', 'clock-ahead'])('critère 8 : un iPhone %s compte comme non synchronisé (stale), jamais comme synchronisé', (status) => {
    expect(warn(HOUR, [pc, iphone(MIN, { status })])).toBe('stale');
  });

  it('valeur de synchro inconnue ou illisible : stale (jamais un faux rassurant)', () => {
    expect(warn(HOUR, [pc, iphone(null)])).toBe('stale');
    expect(warn(HOUR, [pc, iphone(null, { publishedSyncAt: 'pas une date' })])).toBe('stale');
  });

  it('plusieurs iPhone : un seul synchronisé suffit', () => {
    expect(warn(HOUR, [pc, iphone(10 * HOUR), iphone(5 * MIN)])).toBe('none');
    expect(warn(HOUR, [pc, iphone(10 * HOUR), iphone(5 * MIN, { status: 'forgotten' })])).toBe('stale');
  });

  it('une horloge du PC en retard sur la valeur publiée (synchro « dans le futur ») compte comme synchronisée', () => {
    expect(warn(HOUR, [pc, { ...iphone(0), publishedSyncAt: iso(NOW + 5 * MIN) }])).toBe('none');
  });
});

describe('warnIphoneReminders (plusieurs rappels)', () => {
  it('le plus grave et le nombre de rappels concernés', () => {
    const devices = [pc, iphone(10 * HOUR)];
    expect(warnIphoneReminders({ nowMs: NOW, fireAtMs: [NOW + 30 * MIN, NOW + 90 * MIN, NOW + 5 * HOUR], devices })).toEqual({ warning: 'stale', count: 2 });
    expect(warnIphoneReminders({ nowMs: NOW, fireAtMs: [NOW + 5 * HOUR], devices })).toEqual({ warning: 'none', count: 0 });
    expect(warnIphoneReminders({ nowMs: NOW, fireAtMs: [NOW + MIN], devices: [pc] })).toEqual({ warning: 'no-iphone', count: 1 });
    expect(warnIphoneReminders({ nowMs: NOW, fireAtMs: [], devices: [pc] })).toEqual({ warning: 'none', count: 0 });
  });
});
