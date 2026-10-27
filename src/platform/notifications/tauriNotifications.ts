import { invoke } from '@tauri-apps/api/core';
import { compareCodeUnits } from '../../domain/compareCodeUnits';
import { ACTION_TYPE_ID } from '../../domain/notificationActions';
import type { LedgerEntry, NotificationLedgerV1 } from '../../domain/notificationLedger';
import { fireAtInstant, fireAtInstantLocal, localDateTimeAt, pluginDate } from '../../domain/notificationInstant';
import { fnv1a32, NUMERIC_ID_MAX, NUMERIC_ID_MIN, notificationNumericId } from '../../domain/notificationId';
import { isValidTimeZone } from '../../domain/timeZone';
import type { LocalDateTime } from '../../domain/types';
import type { LedgerStore } from './notificationLedger';
import type { NotificationClock } from './notificationClock';
import {
  NOTIFICATION_LIMIT,
  NotificationSchedulerError,
  type NotificationAvailability,
  type NotificationCategory,
  type NotificationPermission,
  type NotificationRequest,
  type NotificationScheduler,
  type ReplaceReport,
} from './types';
import { sortRequests, validateRequests } from './validate';

/**
 * Adaptateur iOS des notifications locales (N-01, ADR 0012 avenant N1.2) : SEUL fichier de `src` qui nomme `plugin:notification|`.
 * Le plugin officiel `tauri-plugin-notification` =2.5.1 n'existe que dans le build iOS (cfg Rust, capability `notifications-ios.json`) ;
 * le résolveur ne charge ce fichier que pour (`tauri`, `ios`). Jamais `sendNotification` (qui perd les erreurs), jamais `cancel` sans
 * liste (qui retirerait aussi la fin de Focus), jamais `batch` ni `get_active` (constat 9 : arrêt de l'app).
 */

/** Identifiants réservés hors plan : 1 à 65 535 (1 = fin de session Focus). */
export const RESERVED_ID_MAX = NUMERIC_ID_MIN - 1;
/** Une échéance à moins de 5 s n'est plus transmise (iOS la refuserait : `pastScheduledTime`). */
export const SEND_MARGIN_MS = 5_000;
/** À la relecture, une échéance déjà passée depuis moins de 2 s a pu sonner : son absence n'est pas un échec. */
export const VERIFY_GRACE_MS = 2_000;

const isPlanId = (id: number): boolean => id >= NUMERIC_ID_MIN && id <= NUMERIC_ID_MAX;
const isReservedId = (id: number): boolean => id >= 1 && id <= RESERVED_ID_MAX;

/** Notification en attente telle que la rend iOS : ni échéance ni `extra` (constat 3). */
export interface PendingItem {
  readonly id: number;
  readonly title: string;
  readonly body: string | null;
}

/** Charge de la commande `show` (constat 7 : la date est une heure murale locale, `Z` littéral). */
export interface ShowPayload {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly sound: string;
  readonly extra: Readonly<Record<string, string>>;
  readonly actionTypeId?: string;
  readonly schedule: { readonly at: { readonly date: string; readonly repeating: false; readonly allowWhileIdle: false } };
}

/** Pont bas niveau vers les commandes du plugin ; partagé avec l'adaptateur de la fin de Focus (`tauriFocusEnd.ts`). */
export interface IosNotificationBridge {
  show(payload: ShowPayload): Promise<void>;
  /** Toujours avec une liste d'identifiants. */
  cancel(ids: readonly number[]): Promise<void>;
  pending(): Promise<readonly PendingItem[]>;
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
}

export type PluginInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Plugin absent ou commande refusée par la capability : l'état du système, pas un échec d'envoi. */
const UNAVAILABLE_MESSAGE = /window is not defined|__TAURI|reading 'invoke'|not allowed|plugin .*not found|command .*not found|not registered|unknown command|no such plugin/i;

function failureOf(error: unknown): Error {
  if (error instanceof NotificationSchedulerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return UNAVAILABLE_MESSAGE.test(message) ? new NotificationSchedulerError('unavailable') : new Error(message);
}

const PLUGIN = 'plugin:notification|';

export function createIosNotificationBridge(call: PluginInvoke = (command, args) => invoke(command, args)): IosNotificationBridge {
  const run = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    try {
      return await call(`${PLUGIN}${command}`, args);
    } catch (error) {
      throw failureOf(error);
    }
  };
  const state = (value: unknown): NotificationPermission => (value === 'granted' ? 'granted' : value === 'denied' ? 'denied' : 'undetermined');
  return {
    show: async (payload) => {
      await run('show', { ...payload });
    },
    cancel: async (ids) => {
      await run('cancel', { notifications: [...ids] });
    },
    pending: async () => {
      const list = await run('get_pending');
      if (!Array.isArray(list)) throw new Error('get_pending: réponse inattendue');
      return list.flatMap((item: unknown): PendingItem[] => {
        const entry = item as { id?: unknown; title?: unknown; body?: unknown } | null;
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'number') return [];
        return [{ id: entry.id, title: typeof entry.title === 'string' ? entry.title : '', body: typeof entry.body === 'string' ? entry.body : null }];
      });
    },
    permission: async () => {
      const granted = await run('is_permission_granted');
      return granted === true ? 'granted' : granted === false ? 'denied' : 'undetermined';
    },
    requestPermission: async () => state(await run('request_permission')),
  };
}

export interface TauriSchedulerDeps {
  readonly bridge: IosNotificationBridge;
  readonly ledger: LedgerStore;
  readonly clock: NotificationClock;
  /** Journal technique : code et nombres seulement, jamais un titre ni un texte de rappel. */
  readonly log?: (code: string, data?: Readonly<Record<string, number>>) => void;
}

/** Empreinte du texte d'une notification (registre : aucun titre n'y est écrit). */
export function requestFingerprint(request: Pick<NotificationRequest, 'title' | 'body' | 'kind' | 'category'>): string {
  return fnv1a32([request.title, request.body, request.kind, request.category ?? ''].join('\u0000')).toString(16).padStart(8, '0');
}

/**
 * Identifiants numériques d'un plan : celui du registre s'il est libre (éléments inchangés), sinon la valeur déterministe de
 * l'identifiant stable ; collision : valeur libre suivante de la plage (parcours des identifiants stables dans l'ordre croissant,
 * bouclage). `blocked` (N-FIX-03) : numéros encore en attente chez iOS, jamais donnés à un élément sans numéro préféré, pour qu'un
 * élément changé reçoive un numéro NEUF et que sa pose soit vérifiable par présence.
 */
export function assignPlanIds(stableIds: readonly string[], preferred: ReadonlyMap<string, number>, blocked: ReadonlySet<number> = new Set()): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>(blocked);
  const sorted = [...new Set(stableIds)].sort(compareCodeUnits);
  const claimed = new Set<number>();
  for (const sid of sorted) {
    const wanted = preferred.get(sid);
    if (wanted !== undefined && isPlanId(wanted) && !claimed.has(wanted)) {
      out.set(sid, wanted);
      claimed.add(wanted);
      taken.add(wanted);
    }
  }
  for (const sid of sorted) {
    if (out.has(sid)) continue;
    let value = notificationNumericId(sid);
    while (taken.has(value)) value = value === NUMERIC_ID_MAX ? NUMERIC_ID_MIN : value + 1;
    out.set(sid, value);
    taken.add(value);
  }
  return out;
}

const ACTION_TYPE: Readonly<Record<NotificationCategory, string>> = ACTION_TYPE_ID;

interface PlannedSend {
  readonly request: NotificationRequest;
  readonly instant: number;
  readonly hash: string;
  n: number;
}

export function createTauriNotificationScheduler(deps: TauriSchedulerDeps): NotificationScheduler {
  const { bridge, ledger, clock } = deps;
  const log = deps.log ?? (() => undefined);
  /** Identifiants envoyés par le processus courant (constat 9 : la table du plugin est en mémoire). */
  const sentThisProcess = new Set<number>();

  const readPending = async (): Promise<readonly PendingItem[]> => {
    try {
      return await bridge.pending();
    } catch (error) {
      if (error instanceof NotificationSchedulerError) throw error;
      throw new NotificationSchedulerError('verify-failed');
    }
  };

  const instantOf = (fireAt: LocalDateTime, zone: string | null): number => (zone === null ? fireAtInstantLocal(fireAt) : fireAtInstant(fireAt, zone));

  const currentZone = (): string | null => {
    const zone = clock.zone();
    return zone !== null && isValidTimeZone(zone) ? zone : null;
  };

  const permission = async (): Promise<NotificationPermission> => {
    try {
      return await bridge.permission();
    } catch (error) {
      if (error instanceof NotificationSchedulerError) throw error;
      throw new NotificationSchedulerError('unavailable');
    }
  };

  return {
    availability: async (): Promise<NotificationAvailability> => {
      try {
        await bridge.permission();
        return 'available';
      } catch {
        return 'unavailable';
      }
    },

    permission,

    requestPermission: async () => {
      try {
        return await bridge.requestPermission();
      } catch (error) {
        if (error instanceof NotificationSchedulerError) throw error;
        throw new NotificationSchedulerError('permission-denied');
      }
    },

    reservedCount: async () => (await readPending()).filter((item) => isReservedId(item.id)).length,

    async replace(requests) {
      // 1. La vérité : ce qu'iOS a en attente. Les réservés (fin de Focus) réduisent la place.
      const pending1 = await readPending();
      const reservedPending = pending1.filter((item) => isReservedId(item.id)).length;
      validateRequests(requests, reservedPending);
      // 2. État du système, avant tout effet.
      if ((await permission()) !== 'granted') throw new NotificationSchedulerError('permission-denied');

      const read = await ledger.read();
      const previous: NotificationLedgerV1 | null = read.state === 'valid' ? read.ledger : null;
      const zone = currentZone();
      const nowMs = clock.nowMs();
      const entryBySid = new Map((previous?.entries ?? []).map((entry) => [entry.sid, entry]));
      const pendingPlanIds = new Set(pending1.filter((item) => isPlanId(item.id)).map((item) => item.id));

      // 3. Instants calculés avec le fuseau courant ; une échéance trop proche n'est pas transmise (sans erreur).
      const all = requests.map((request) => ({ request, instant: instantOf(request.fireAt, zone), hash: requestFingerprint(request) }));
      const live: PlannedSend[] = all.filter((item) => item.instant > nowMs + SEND_MARGIN_MS).map((item) => ({ ...item, n: 0 }));

      // 4. Inchangé = même instant, même texte, et le numéro du registre encore en attente chez iOS : il garde son numéro. Tout autre
      //    élément est « changé » (N-FIX-03, décision d'Ali du 2026-10-27) : il reçoit un numéro NEUF, jamais un numéro en attente, pour
      //    que sa pose soit vérifiable par présence (get_pending ne rend pas l'échéance, constat 3) ; son ancien numéro n'est annulé
      //    qu'APRÈS la pose vérifiée. Si l'annulation précédait la pose et que la pose échouait, il ne resterait aucun rappel, sans le
      //    savoir ; dans l'ordre inverse, le pire cas est un doublon ou un rappel à l'ancienne heure, visible donc corrigeable.
      const matching = (item: PlannedSend): LedgerEntry | undefined => {
        const entry = entryBySid.get(item.request.id);
        return entry !== undefined && entry.at === item.instant && entry.h === item.hash && pendingPlanIds.has(entry.n) ? entry : undefined;
      };
      const kept = live.filter((item) => matching(item) !== undefined);
      const changed = live.filter((item) => matching(item) === undefined);
      const preferred = new Map(kept.flatMap((item) => {
        const entry = matching(item);
        return entry === undefined ? [] : [[item.request.id, entry.n] as const];
      }));
      const ids = assignPlanIds(live.map((item) => item.request.id), preferred, pendingPlanIds);
      for (const item of live) item.n = ids.get(item.request.id) ?? notificationNumericId(item.request.id);
      const newIds = new Set(live.map((item) => item.n));
      /** Ancien numéro encore en attente d'un élément changé : annulé après la pose réussie du nouveau, conservé sinon. */
      const oldOf = new Map<string, LedgerEntry>();
      for (const item of changed) {
        const entry = entryBySid.get(item.request.id);
        if (entry !== undefined && pendingPlanIds.has(entry.n) && !newIds.has(entry.n)) oldOf.set(item.request.id, entry);
      }
      const oldIds = new Set([...oldOf.values()].map((entry) => entry.n));

      // Une notification sur le point de sonner (échéance dans la marge) et déjà planifiée n'est jamais annulée.
      const protectedEntries = all
        .filter((item) => item.instant <= nowMs + SEND_MARGIN_MS)
        .flatMap((item) => {
          const entry = entryBySid.get(item.request.id);
          return entry !== undefined && pendingPlanIds.has(entry.n) && !newIds.has(entry.n) ? [entry] : [];
        });
      const protectedIds = new Set(protectedEntries.map((entry) => entry.n));
      // Constat 9 : au premier passage d'un processus, les inchangés sont renvoyés (même identifiant : iOS remplace) mais comptés `kept`.
      const reaffirmed = kept.filter((item) => !sentThisProcess.has(item.n));

      // État courant chez iOS pendant le passage (optimiste : chaque appel réussi le met à jour) et appels d'annulation.
      const pendingSet = new Set(pendingPlanIds);
      let cancelOk = true;
      let cancelledCount = 0;
      const cancel = async (list: readonly number[]): Promise<boolean> => {
        if (list.length === 0) return true;
        try {
          await bridge.cancel(list);
          for (const id of list) {
            pendingSet.delete(id);
            sentThisProcess.delete(id);
          }
          return true;
        } catch (error) {
          if (error instanceof NotificationSchedulerError && error.reason === 'unavailable') throw error;
          cancelOk = false;
          log('cancel-failed', { count: list.length });
          return false;
        }
      };
      const room = (): number => NOTIFICATION_LIMIT - reservedPending - pendingSet.size;

      // 5. Numéros sortis du plan (ni nouveaux, ni protégés, ni anciens d'un élément changé) : annulés d'abord, ils ne reviendront pas.
      //    Registre perdu : tout numéro en attente est inconnu, donc sorti ; le plan entier est reposé une fois (critère 6 de N-01).
      const leftovers = [...pendingPlanIds].filter((id) => !newIds.has(id) && !protectedIds.has(id) && !oldIds.has(id)).sort((a, b) => a - b);
      if (await cancel(leftovers)) cancelledCount += leftovers.length;

      // 6. Pose élément par élément, dans l'ordre chronologique, AVANT l'annulation de l'ancien : une coupure laisse les plus proches
      //    planifiés et ne retire jamais un rappel dont le remplaçant n'est pas posé. Plafond iOS (64) : quand aucune place n'est libre,
      //    la notification la plus LOINTAINE encore en attente est déplacée pour faire place (ancien d'un élément changé non encore posé,
      //    ou élément inchangé reposé à la fin du passage) : en cas de coupure, le manque est lointain et réparé au passage suivant.
      const failed: string[] = [];
      const sent = new Set<number>();
      const displaced: PlannedSend[] = [];
      const sacrificed = new Set<string>();
      const show = async (item: PlannedSend): Promise<void> => {
        const category = item.request.category;
        const payload: ShowPayload = {
          id: item.n,
          title: item.request.title,
          body: item.request.body,
          sound: 'default',
          extra: { sid: item.request.id, at: String(item.instant) },
          ...(category === undefined ? {} : { actionTypeId: ACTION_TYPE[category] }),
          schedule: { at: { date: pluginDate(item.instant, zone), repeating: false, allowWhileIdle: false } },
        };
        try {
          await bridge.show(payload);
          sent.add(item.n);
          sentThisProcess.add(item.n);
          pendingSet.add(item.n);
        } catch (error) {
          if (error instanceof NotificationSchedulerError && error.reason === 'unavailable') throw error;
          failed.push(item.request.id);
          log('show-failed', { n: item.n });
        }
      };
      const sends = [...changed, ...reaffirmed].sort((a, b) => a.instant - b.instant || compareCodeUnits(a.request.id, b.request.id));
      /** Éléments changés posés dont l'ancien numéro attend la vérification avant d'être annulé. */
      let unreleased: PlannedSend[] = [];
      /** Vérification intermédiaire : les anciens des remplaçants confirmés par get_pending sont annulés, ce qui libère des places. */
      const verifyAndRelease = async (): Promise<void> => {
        const now = new Set((await readPending()).map((item) => item.id));
        const release = unreleased
          .filter((item) => now.has(item.n))
          .map((item) => (oldOf.get(item.request.id) as LedgerEntry).n)
          .filter((n) => pendingSet.has(n))
          .sort((a, b) => a - b);
        unreleased = [];
        if (await cancel(release)) cancelledCount += release.length;
      };
      // Déplacements par lot : un à la fois pour une modification ordinaire (règle stricte : un seul lointain déplacé, puis chaque
      // ancien libéré après vérification), huit à la fois quand tout le plan change (fuseau), pour borner les relectures de get_pending.
      const batch = changed.length <= 8 ? 1 : 8;
      for (const item of sends) {
        if (!pendingSet.has(item.n) && room() <= 0 && unreleased.length > 0) await verifyAndRelease();
        if (!pendingSet.has(item.n) && room() <= 0) {
          // Candidats au déplacement : l'ancien d'un élément changé pas encore posé, ou un inchangé encore en attente ; le plus lointain d'abord.
          const olds = changed
            .filter((other) => other !== item && !sent.has(other.n) && !failed.includes(other.request.id) && oldOf.has(other.request.id) && !sacrificed.has(other.request.id))
            .map((other) => ({ n: (oldOf.get(other.request.id) as LedgerEntry).n, at: (oldOf.get(other.request.id) as LedgerEntry).at, kind: 'old' as const, item: other }));
          const own = oldOf.get(item.request.id);
          if (own !== undefined && !sacrificed.has(item.request.id)) olds.push({ n: own.n, at: own.at, kind: 'old', item });
          const unchanged = kept.filter((other) => pendingSet.has(other.n) && !displaced.includes(other)).map((other) => ({ n: other.n, at: other.instant, kind: 'kept' as const, item: other }));
          const victims = [...olds, ...unchanged].filter((candidate) => !protectedIds.has(candidate.n)).sort((a, b) => b.at - a.at || a.n - b.n).slice(0, batch);
          if (victims.length === 0) {
            failed.push(item.request.id);
            log('show-no-room', { n: item.n });
            continue;
          }
          if (!(await cancel(victims.map((victim) => victim.n)))) {
            failed.push(item.request.id);
            continue;
          }
          for (const victim of victims) {
            if (victim.kind === 'old') {
              sacrificed.add(victim.item.request.id);
              cancelledCount += 1;
            } else {
              displaced.push(victim.item);
            }
          }
        }
        await show(item);
        if (sent.has(item.n) && oldOf.has(item.request.id) && !sacrificed.has(item.request.id)) unreleased.push(item);
      }

      // 7. Vérification : get_pending relu ; un identifiant attendu absent est un échec.
      let pendingNow = new Set((await readPending()).map((item) => item.id));
      let readAt = clock.nowMs();
      const isMissing = (item: PlannedSend): boolean => !pendingNow.has(item.n) && item.instant > readAt + VERIFY_GRACE_MS && !failed.includes(item.request.id);
      const posed = (item: PlannedSend): boolean => !failed.includes(item.request.id) && !isMissing(item);

      // 8. Annulation des anciens numéros des éléments changés POSÉS. L'ancien d'un remplaçant non posé est CONSERVÉ (il sonnera à
      //    l'ancienne heure) et compté `stale` : l'état visible le dit.
      const stale = changed.filter((item) => oldOf.has(item.request.id) && !sacrificed.has(item.request.id) && !posed(item));
      const staleEntries = stale.flatMap((item) => {
        const entry = oldOf.get(item.request.id);
        return entry === undefined ? [] : [entry];
      });
      const released = changed
        .filter((item) => oldOf.has(item.request.id) && !sacrificed.has(item.request.id) && posed(item))
        .map((item) => (oldOf.get(item.request.id) as LedgerEntry).n)
        .filter((n) => pendingSet.has(n))
        .sort((a, b) => a - b);
      if (await cancel(released)) cancelledCount += released.length;

      // 9. Les inchangés déplacés pour faire place sont reposés (même numéro, libre à présent), puis vérifiés à leur tour.
      if (displaced.length > 0) {
        for (const item of displaced.sort((a, b) => a.instant - b.instant)) await show(item);
        pendingNow = new Set((await readPending()).map((item) => item.id));
        readAt = clock.nowMs();
      }
      const missing = live.filter(isMissing).map((item) => item.request.id);
      if (stale.length > 0) log('replace-stale', { count: stale.length });

      const report: ReplaceReport = {
        scheduled: changed.filter((item) => sent.has(item.n)).length,
        cancelled: cancelOk ? cancelledCount : 0,
        kept: kept.length + protectedEntries.filter((entry) => pendingNow.has(entry.n)).length,
        ...(stale.length > 0 ? { stale: stale.length } : {}),
      };

      // 10. Registre : ce que get_pending confirme (même en échec partiel), anciens conservés compris ; fuseau mis à jour après une
      //     réussite seulement. Un ancien numéro qu'un `cancel` en échec a laissé n'y figure pas : le passage suivant l'annule à nouveau.
      const confirmed: LedgerEntry[] = [
        ...live.filter((item) => pendingNow.has(item.n)).map((item): LedgerEntry => ({ n: item.n, sid: item.request.id, at: item.instant, h: item.hash, kind: item.request.kind })),
        ...staleEntries.filter((entry) => pendingNow.has(entry.n)),
        ...protectedEntries.filter((entry) => pendingNow.has(entry.n)),
      ];
      const succeeded = failed.length === 0 && cancelOk && missing.length === 0;
      let ledgerError = false;
      try {
        await ledger.update((current) => ({ ...current, zone: succeeded ? zone : (previous?.zone ?? zone), entries: confirmed }));
      } catch {
        ledgerError = true;
        log('ledger-write-failed', { entries: confirmed.length });
      }

      if (failed.length > 0 || !cancelOk) throw new NotificationSchedulerError('schedule-failed', failed, report);
      if (missing.length > 0) throw new NotificationSchedulerError('verify-failed', missing, report);
      if (ledgerError) throw new NotificationSchedulerError('ledger-failed', [], report);
      return report;
    },

    async cancelAll() {
      const planIds = (await readPending()).filter((item) => isPlanId(item.id)).map((item) => item.id);
      if (planIds.length > 0) {
        try {
          await bridge.cancel(planIds);
        } catch (error) {
          throw error instanceof NotificationSchedulerError ? error : new NotificationSchedulerError('schedule-failed', [], { scheduled: 0, cancelled: 0, kept: 0 });
        }
      }
      for (const id of planIds) sentThisProcess.delete(id);
      try {
        await ledger.update((current) => ({ ...current, entries: [] }));
      } catch {
        throw new NotificationSchedulerError('ledger-failed');
      }
    },

    async pending() {
      const items = (await readPending()).filter((item) => isPlanId(item.id));
      const read = await ledger.read();
      if (read.state !== 'valid') return [];
      const byNumber = new Map(read.ledger.entries.map((entry) => [entry.n, entry]));
      const zone = read.ledger.zone !== null && isValidTimeZone(read.ledger.zone) ? read.ledger.zone : null;
      return sortRequests(
        items.flatMap((item): NotificationRequest[] => {
          const entry = byNumber.get(item.id);
          return entry === undefined ? [] : [{ id: entry.sid, fireAt: localDateTimeAt(entry.at, zone), title: item.title, body: item.body ?? '', kind: entry.kind }];
        }),
      );
    },
  };
}
