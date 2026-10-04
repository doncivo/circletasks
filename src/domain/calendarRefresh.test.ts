import { describe, expect, it } from 'vitest';
import { CALENDAR_REFRESH_INTERVAL_MS, calendarAppStatuses, nextAccountState, shouldRefresh, type CalendarAccountState, type RefreshDecisionInput } from './calendarRefresh';
import type { CalendarAccountId, IsoDateTime } from './types';

const iso = (value: string): IsoDateTime => value as IsoDateTime;
const T0 = iso('2026-10-04T10:00:00.000Z');
const plus = (minutes: number): IsoDateTime => iso(new Date(Date.parse(T0) + minutes * 60_000).toISOString());
const connected = (lastSuccessAt: IsoDateTime | null = T0): CalendarAccountState => ({ kind: 'connected', lastSuccessAt });

const base = (patch: Partial<RefreshDecisionInput>): RefreshDecisionInput => ({ state: connected(), trigger: 'tick', now: plus(0), foreground: true, inFlight: false, ...patch });

describe('shouldRefresh (K-03)', () => {
  it("à l'ouverture, toujours (critère 1)", () => {
    expect(shouldRefresh(base({ trigger: 'open', state: connected(plus(-1)) }))).toBe(true);
    expect(shouldRefresh(base({ trigger: 'open', state: connected(null) }))).toBe(true);
  });

  it('retour au premier plan : seulement après 15 min depuis la dernière réussite (critère 1)', () => {
    expect(shouldRefresh(base({ trigger: 'resume', now: plus(14) }))).toBe(false);
    expect(shouldRefresh(base({ trigger: 'resume', now: plus(15) }))).toBe(true);
    expect(CALENDAR_REFRESH_INTERVAL_MS).toBe(900_000);
  });

  it('échéance : toutes les 15 min au premier plan, jamais en arrière-plan (critère 2, D3)', () => {
    expect(shouldRefresh(base({ now: plus(14) }))).toBe(false);
    expect(shouldRefresh(base({ now: plus(15) }))).toBe(true);
    expect(shouldRefresh(base({ now: plus(60), foreground: false }))).toBe(false);
    expect(shouldRefresh(base({ now: plus(1), state: connected(null) }))).toBe(true);
  });

  it('jamais deux rafraîchissements du même compte, « Actualiser » compris (critère 7)', () => {
    for (const trigger of ['open', 'resume', 'tick', 'manual', 'connected'] as const) expect(shouldRefresh(base({ trigger, now: plus(60), inFlight: true }))).toBe(false);
    expect(shouldRefresh(base({ trigger: 'manual', now: plus(1) }))).toBe(true);
  });

  it('compte à reconnecter : aucune tentative automatique, seulement manuelle ou après reconnexion (critère 6)', () => {
    const state: CalendarAccountState = { kind: 'reconnect-required', lastSuccessAt: T0 };
    for (const trigger of ['open', 'resume', 'tick'] as const) expect(shouldRefresh(base({ state, trigger, now: plus(600) }))).toBe(false);
    expect(shouldRefresh(base({ state, trigger: 'connected' }))).toBe(true);
    expect(shouldRefresh(base({ state, trigger: 'manual' }))).toBe(true);
  });

  it('erreur réseau : prochaine échéance seulement ; 429 : délai du serveur pour tous (critère 5)', () => {
    const network: CalendarAccountState = { kind: 'error', lastSuccessAt: T0, error: 'network', retryAt: plus(15) };
    expect(shouldRefresh(base({ state: network, now: plus(10) }))).toBe(false);
    expect(shouldRefresh(base({ state: network, trigger: 'resume', now: plus(10) }))).toBe(false);
    expect(shouldRefresh(base({ state: network, trigger: 'manual', now: plus(10) }))).toBe(true);
    expect(shouldRefresh(base({ state: network, now: plus(15) }))).toBe(true);
    const limited: CalendarAccountState = { kind: 'error', lastSuccessAt: T0, error: 'rate-limited', retryAt: plus(2) };
    expect(shouldRefresh(base({ state: limited, trigger: 'manual', now: plus(1) }))).toBe(false);
    expect(shouldRefresh(base({ state: limited, trigger: 'open', now: plus(1) }))).toBe(false);
    expect(shouldRefresh(base({ state: limited, trigger: 'manual', now: plus(2) }))).toBe(true);
  });
});

describe('nextAccountState (K-03, A-09)', () => {
  const previous = connected(T0);
  it('réussite : connecté, horodaté', () => {
    expect(nextAccountState({ kind: 'reconnect-required', lastSuccessAt: null }, { ok: true, at: plus(1) })).toEqual({ kind: 'connected', lastSuccessAt: plus(1) });
  });

  it('401 : à reconnecter, dernière réussite conservée', () => {
    expect(nextAccountState(previous, { ok: false, at: plus(1), error: { kind: 'unauthorized' } })).toEqual({ kind: 'reconnect-required', lastSuccessAt: T0 });
  });

  it('429 : délai du serveur, sinon 15 min', () => {
    expect(nextAccountState(previous, { ok: false, at: plus(1), error: { kind: 'rate-limited', retryAfterMs: 120_000 } })).toEqual({ kind: 'error', lastSuccessAt: T0, error: 'rate-limited', retryAt: plus(3) });
    expect(nextAccountState(previous, { ok: false, at: plus(1), error: { kind: 'rate-limited', retryAfterMs: null } })).toMatchObject({ retryAt: plus(16) });
  });

  it('réseau et serveur : erreur, nouvelle tentative à la prochaine échéance', () => {
    expect(nextAccountState(previous, { ok: false, at: plus(1), error: { kind: 'network' } })).toEqual({ kind: 'error', lastSuccessAt: T0, error: 'network', retryAt: plus(16) });
    expect(nextAccountState(previous, { ok: false, at: plus(1), error: { kind: 'server', status: 503 } })).toMatchObject({ kind: 'error', error: 'server' });
  });

  it("erreurs d'un seul agenda : compte inchangé", () => {
    for (const error of [{ kind: 'forbidden' }, { kind: 'not-found' }, { kind: 'malformed' }] as const) expect(nextAccountState(previous, { ok: false, at: plus(1), error })).toBe(previous);
  });
});

describe('calendarAppStatuses (A-09 critère 10)', () => {
  const accounts = [
    { id: 'a' as CalendarAccountId, label: 'ali@gmail.com' },
    { id: 'b' as CalendarAccountId, label: 'ali@icloud.com' },
  ];
  const states = (entries: Record<string, CalendarAccountState>): Map<CalendarAccountId, CalendarAccountState> => new Map(Object.entries(entries).map(([id, state]) => [id as CalendarAccountId, state]));

  it('rien quand tout est connecté ou pas encore tenté', () => {
    expect(calendarAppStatuses(accounts, states({ a: connected() }))).toEqual({});
  });

  it('« Agenda déconnecté » nomme le premier compte à reconnecter', () => {
    const result = calendarAppStatuses(accounts, states({ a: connected(), b: { kind: 'reconnect-required', lastSuccessAt: null } }));
    expect(result).toEqual({ calendarDisconnected: { detail: 'ali@icloud.com' } });
  });

  it('« Hors ligne » pour une erreur réseau ou serveur, pas pour un 429', () => {
    expect(calendarAppStatuses(accounts, states({ a: { kind: 'error', lastSuccessAt: null, error: 'network', retryAt: null } }))).toEqual({ offline: {} });
    expect(calendarAppStatuses(accounts, states({ a: { kind: 'error', lastSuccessAt: null, error: 'server', retryAt: null } }))).toEqual({ offline: {} });
    expect(calendarAppStatuses(accounts, states({ a: { kind: 'error', lastSuccessAt: null, error: 'rate-limited', retryAt: null } }))).toEqual({});
  });

  it('les deux états peuvent coexister (la priorité est celle du bandeau)', () => {
    const result = calendarAppStatuses(accounts, states({ a: { kind: 'reconnect-required', lastSuccessAt: null }, b: { kind: 'error', lastSuccessAt: null, error: 'network', retryAt: null } }));
    expect(Object.keys(result).sort()).toEqual(['calendarDisconnected', 'offline']);
  });
});
