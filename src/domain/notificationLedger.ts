import { NUMERIC_ID_MAX, NUMERIC_ID_MIN } from './notificationId';

/**
 * Registre local des notifications planifiées (N-01, ADR 0012 avenant N1.2) : réglage LOCAL `notifications.ledger`, jamais synchronisé,
 * sans titre ni texte. La vérité reste `get_pending` : un registre perdu ou illisible fait seulement tout replanifier une fois.
 */

export type LedgerKind = 'task' | 'routine' | 'event' | 'recap' | 'snooze';
const LEDGER_KINDS: readonly string[] = ['task', 'routine', 'event', 'recap', 'snooze'];

export interface LedgerEntry {
  /** Identifiant numérique du plugin (plage du plan). */
  readonly n: number;
  /** Identifiant stable du domaine. */
  readonly sid: string;
  /** Instant (ms UTC) de l'échéance au moment de l'envoi. */
  readonly at: number;
  /** Empreinte du texte (FNV-1a de titre, corps, nature et catégorie). */
  readonly h: string;
  readonly kind: LedgerKind;
}

export interface NotificationLedgerV1 {
  readonly v: 1;
  /** Fuseau des instants enregistrés (null : illisible à l'envoi). */
  readonly zone: string | null;
  readonly entries: readonly LedgerEntry[];
  /** Fin de session Focus (identifiant numérique 1). */
  readonly focusEnd: { readonly sessionId: string; readonly at: number } | null;
}

export const EMPTY_LEDGER: NotificationLedgerV1 = { v: 1, zone: null, entries: [], focusEnd: null };

/** Lecture du registre : valide, jamais écrit (installation neuve) ou illisible (à reconstruire, information visible). */
export type LedgerRead =
  | { readonly state: 'valid'; readonly ledger: NotificationLedgerV1 }
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null;
  const { n, sid, at, h, kind } = value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < NUMERIC_ID_MIN || n > NUMERIC_ID_MAX) return null;
  if (typeof sid !== 'string' || sid === '') return null;
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  if (typeof h !== 'string' || typeof kind !== 'string' || !LEDGER_KINDS.includes(kind)) return null;
  return { n, sid, at, h, kind: kind as LedgerKind };
}

/** Analyse stricte d'une valeur lue dans le réglage : `null` (jamais écrit) = `missing`, tout champ faux = `unreadable`. */
export function parseNotificationLedger(raw: unknown): LedgerRead {
  if (raw === null || raw === undefined) return { state: 'missing' };
  if (!isRecord(raw) || raw['v'] !== 1) return { state: 'unreadable' };
  const { zone, entries, focusEnd } = raw;
  if (zone !== null && typeof zone !== 'string') return { state: 'unreadable' };
  if (!Array.isArray(entries)) return { state: 'unreadable' };
  const parsed: LedgerEntry[] = [];
  for (const entry of entries) {
    const ok = parseEntry(entry);
    if (ok === null) return { state: 'unreadable' };
    parsed.push(ok);
  }
  if (new Set(parsed.map((entry) => entry.sid)).size !== parsed.length || new Set(parsed.map((entry) => entry.n)).size !== parsed.length) return { state: 'unreadable' };
  let focus: NotificationLedgerV1['focusEnd'] = null;
  if (focusEnd !== null) {
    if (!isRecord(focusEnd) || typeof focusEnd['sessionId'] !== 'string' || typeof focusEnd['at'] !== 'number' || !Number.isFinite(focusEnd['at'])) return { state: 'unreadable' };
    focus = { sessionId: focusEnd['sessionId'], at: focusEnd['at'] };
  } else if (focusEnd === undefined) {
    return { state: 'unreadable' };
  }
  return { state: 'valid', ledger: { v: 1, zone, entries: parsed, focusEnd: focus } };
}
