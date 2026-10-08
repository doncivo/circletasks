import { localDateTimeAt } from './notificationInstant';
import type { IsoDateTime, LocalDateTime } from './types';

/**
 * Alerte avant l'expiration hebdomadaire de la signature SideStore (I-02, ADR 0013 §3.3) : fonctions pures. Le fuseau est injecté
 * (indépendant de `TZ`) ; null : fuseau du moteur JS (comme `pluginDate`).
 */

/** L'alerte part 24 h (instant absolu) avant l'expiration. */
export const SIGNING_ALERT_LEAD_MS = 24 * 3_600_000;

export type SigningNotice =
  | { readonly state: 'ok'; readonly expiresAt: number; readonly alertInstant: number; readonly alertAt: LocalDateTime }
  | { readonly state: 'soon'; readonly expiresAt: number; readonly remainingMs: number }
  | { readonly state: 'expired'; readonly expiresAt: number }
  | { readonly state: 'unknown' };

/** État de l'alerte : `ok` (alerte à venir), `soon` (moins de 24 h, sans alerte), `expired`, `unknown` (date absente ou invalide). */
export function signingNotice(input: { readonly expiresAt: number | null; readonly now: number; readonly zone: string | null }): SigningNotice {
  const { expiresAt, now, zone } = input;
  if (expiresAt === null || !Number.isFinite(expiresAt) || !Number.isFinite(now)) return { state: 'unknown' };
  if (now >= expiresAt) return { state: 'expired', expiresAt };
  const alertInstant = expiresAt - SIGNING_ALERT_LEAD_MS;
  if (now >= alertInstant) return { state: 'soon', expiresAt, remainingMs: expiresAt - now };
  return { state: 'ok', expiresAt, alertInstant, alertAt: localDateTimeAt(alertInstant, zone) };
}

export type SigningFailureCode = 'profile-missing' | 'profile-unreadable';

export interface SigningStatusV1 {
  readonly v: 1;
  readonly lastRead: { readonly at: IsoDateTime; readonly expiresAt: IsoDateTime; readonly issuedAt: IsoDateTime | null } | null;
  readonly failure: { readonly at: IsoDateTime; readonly code: SigningFailureCode } | null;
  /** Alerte en attente (identifiant réservé 2, avenant lot M de l'ADR 0012). */
  readonly scheduled: { readonly instant: number; readonly expiresAt: IsoDateTime } | null;
}

export const EMPTY_SIGNING_STATUS: SigningStatusV1 = { v: 1, lastRead: null, failure: null, scheduled: null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is IsoDateTime => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isFailureCode = (value: unknown): value is SigningFailureCode => value === 'profile-missing' || value === 'profile-unreadable';

/**
 * Lecture du réglage local `notifications.signing` (valeur brute). Absent ou null : vide, lisible. Toute autre forme : vide et
 * `unreadable` (l'appelant journalise `signing-status-unreadable`).
 */
export function parseSigningStatus(raw: unknown): { readonly status: SigningStatusV1; readonly unreadable: boolean } {
  if (raw === null || raw === undefined) return { status: EMPTY_SIGNING_STATUS, unreadable: false };
  const bad = { status: EMPTY_SIGNING_STATUS, unreadable: true } as const;
  if (!isRecord(raw) || raw['v'] !== 1) return bad;

  const lastRaw = raw['lastRead'];
  let lastRead: SigningStatusV1['lastRead'] = null;
  if (lastRaw !== null && lastRaw !== undefined) {
    if (!isRecord(lastRaw) || !isIso(lastRaw['at']) || !isIso(lastRaw['expiresAt'])) return bad;
    const issued = lastRaw['issuedAt'];
    if (issued !== null && issued !== undefined && !isIso(issued)) return bad;
    lastRead = { at: lastRaw['at'], expiresAt: lastRaw['expiresAt'], issuedAt: isIso(issued) ? issued : null };
  }

  const failRaw = raw['failure'];
  let failure: SigningStatusV1['failure'] = null;
  if (failRaw !== null && failRaw !== undefined) {
    if (!isRecord(failRaw) || !isIso(failRaw['at']) || !isFailureCode(failRaw['code'])) return bad;
    failure = { at: failRaw['at'], code: failRaw['code'] };
  }

  const schedRaw = raw['scheduled'];
  let scheduled: SigningStatusV1['scheduled'] = null;
  if (schedRaw !== null && schedRaw !== undefined) {
    const instant = isRecord(schedRaw) ? schedRaw['instant'] : undefined;
    if (!isRecord(schedRaw) || typeof instant !== 'number' || !Number.isFinite(instant) || !isIso(schedRaw['expiresAt'])) return bad;
    scheduled = { instant, expiresAt: schedRaw['expiresAt'] };
  }

  return { status: { v: 1, lastRead, failure, scheduled }, unreadable: false };
}
