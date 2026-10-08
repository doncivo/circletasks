import type { PlanCoverage } from './notificationPlan';
import type { IsoDateTime, LocalDateTime } from './types';

/**
 * État persistant des rappels (N-01 critère 12, ADR 0012 avenant N1.3) : réglage LOCAL `notifications.status`, lu au démarrage avant le
 * premier passage pour que le bandeau survive à un redémarrage. Codes et nombres seulement : jamais un titre ni un texte de rappel.
 */

export type StatusPermission = 'granted' | 'denied' | 'undetermined';

/** Raisons d'échec de planification (celles de `NotificationFailure`, plus `zone-unknown` de N-06). */
export const PLAN_FAILURE_REASONS = [
  'duplicate-id',
  'over-limit',
  'invalid-request',
  'unavailable',
  'permission-denied',
  'schedule-failed',
  'verify-failed',
  'ledger-failed',
  'zone-unknown',
] as const;
export type PlanFailureReason = (typeof PLAN_FAILURE_REASONS)[number];

export interface StatusReport {
  readonly scheduled: number;
  readonly cancelled: number;
  readonly kept: number;
}

export interface NotificationStatusV1 {
  readonly v: 1;
  readonly permission: StatusPermission | null;
  readonly lastSuccess: { readonly at: IsoDateTime; readonly coverage: PlanCoverage; readonly total: number; readonly zone: string | null } | null;
  readonly planFailure: { readonly at: IsoDateTime; readonly reason: PlanFailureReason; readonly count: number; readonly partial: StatusReport | null } | null;
  readonly focusEndFailure: { readonly at: IsoDateTime; readonly sessionId: string; readonly reason: PlanFailureReason } | null;
  readonly zoneChange: { readonly at: IsoDateTime; readonly from: string; readonly to: string } | null;
  readonly ledgerRebuiltAt: IsoDateTime | null;
}

export const EMPTY_NOTIFICATION_STATUS: NotificationStatusV1 = {
  v: 1,
  permission: null,
  lastSuccess: null,
  planFailure: null,
  focusEndFailure: null,
  zoneChange: null,
  ledgerRebuiltAt: null,
};

export type StatusRead = { readonly state: 'valid'; readonly status: NotificationStatusV1 } | { readonly state: 'unreadable' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIso = (value: unknown): value is IsoDateTime => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isReason = (value: unknown): value is PlanFailureReason => typeof value === 'string' && (PLAN_FAILURE_REASONS as readonly string[]).includes(value);

function parseReport(value: unknown): StatusReport | null | 'bad' {
  if (value === null) return null;
  if (!isRecord(value) || !isCount(value['scheduled']) || !isCount(value['cancelled']) || !isCount(value['kept'])) return 'bad';
  return { scheduled: value['scheduled'], cancelled: value['cancelled'], kept: value['kept'] };
}

function parseCoverage(value: unknown): PlanCoverage | null {
  if (!isRecord(value)) return null;
  if (value['state'] === 'complete') return { state: 'complete' };
  if (value['state'] === 'empty') return { state: 'empty' };
  if (value['state'] === 'until' && typeof value['until'] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value['until'])) {
    return { state: 'until', until: value['until'] as LocalDateTime };
  }
  return null;
}

/** Analyse stricte ; `null` ou `undefined` (jamais écrit) = état vide valide, tout champ faux = illisible. */
export function parseNotificationStatus(raw: unknown): StatusRead {
  if (raw === null || raw === undefined) return { state: 'valid', status: EMPTY_NOTIFICATION_STATUS };
  if (!isRecord(raw) || raw['v'] !== 1) return { state: 'unreadable' };
  const permission = raw['permission'];
  if (permission !== null && permission !== 'granted' && permission !== 'denied' && permission !== 'undetermined') return { state: 'unreadable' };

  let lastSuccess: NotificationStatusV1['lastSuccess'] = null;
  const ls = raw['lastSuccess'];
  if (ls !== null) {
    if (!isRecord(ls)) return { state: 'unreadable' };
    const coverage = parseCoverage(ls['coverage']);
    const zone = ls['zone'];
    if (!isIso(ls['at']) || coverage === null || !isCount(ls['total']) || (zone !== null && typeof zone !== 'string')) return { state: 'unreadable' };
    lastSuccess = { at: ls['at'], coverage, total: ls['total'], zone: zone as string | null };
  }

  let planFailure: NotificationStatusV1['planFailure'] = null;
  const pf = raw['planFailure'];
  if (pf !== null) {
    if (!isRecord(pf)) return { state: 'unreadable' };
    const partial = parseReport(pf['partial']);
    if (!isIso(pf['at']) || !isReason(pf['reason']) || !isCount(pf['count']) || partial === 'bad') return { state: 'unreadable' };
    planFailure = { at: pf['at'], reason: pf['reason'], count: pf['count'], partial };
  }

  let focusEndFailure: NotificationStatusV1['focusEndFailure'] = null;
  const ff = raw['focusEndFailure'];
  if (ff !== null) {
    if (!isRecord(ff) || !isIso(ff['at']) || typeof ff['sessionId'] !== 'string' || !isReason(ff['reason'])) return { state: 'unreadable' };
    focusEndFailure = { at: ff['at'], sessionId: ff['sessionId'], reason: ff['reason'] };
  }

  let zoneChange: NotificationStatusV1['zoneChange'] = null;
  const zc = raw['zoneChange'];
  if (zc !== null) {
    if (!isRecord(zc) || !isIso(zc['at']) || typeof zc['from'] !== 'string' || typeof zc['to'] !== 'string') return { state: 'unreadable' };
    zoneChange = { at: zc['at'], from: zc['from'], to: zc['to'] };
  }

  const rebuilt = raw['ledgerRebuiltAt'];
  if (rebuilt !== null && !isIso(rebuilt)) return { state: 'unreadable' };

  return { state: 'valid', status: { v: 1, permission, lastSuccess, planFailure, focusEndFailure, zoneChange, ledgerRebuiltAt: rebuilt as IsoDateTime | null } };
}
