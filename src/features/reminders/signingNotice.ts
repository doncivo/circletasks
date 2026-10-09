import { signingNotice } from '../../domain/signingNotice';
import type { IsoDateTime } from '../../domain/types';
import type { PlanFailureReason } from '../../domain/notificationStatus';
import { isValidTimeZone } from '../../domain/timeZone';
import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import type { NotificationPermission } from '../../platform/notifications';
import { useAppStatusStore } from '../app/appStatus';
import { useNavigationStore } from '../app/navigation';
import type { AppContainer } from '../app/container';
import type { ReplanTrigger } from './replanNotifications';
import { bannerSoonText, signingAlertText } from './signingText';
import { signingStatusController } from './signingStatus';

/**
 * Alerte avant l'expiration hebdomadaire de la signature SideStore (I-02, ADR 0013 §3.4), une étape du passage du `NotificationRunner`
 * (ADR 0012 N1.3) pour les déclencheurs `open`, `resume` et `permission` : après la lecture de l'autorisation et AVANT le calcul de la place
 * disponible (`64 − reservedCount()`), pour que l'alerte compte dans le plafond du même passage.
 *
 * - Lecture du profil (`container.signing.source`) puis `signingNotice` (domaine, pur) :
 *   `ok` : l'alerte est envoyée avec l'identifiant réservé 2, à `expiresAt − 24 h` ; même instant et même texte déjà envoyés par CE processus
 *   et toujours en attente chez iOS : rien ; premier passage d'un processus : renvoyée (la table du plugin est en mémoire, ADR 0012 constat 9) ;
 *   `soon` et `expired` : l'alerte est retirée, le bandeau `signingExpiry` s'affiche (D3, pas de notification immédiate).
 * - Échec de lecture : état `failure` écrit et affiché (À propos, Réglages > Rappels) ; une alerte planifiée par une lecture réussie
 *   antérieure est GARDÉE (son échéance est future ou l'app n'aurait pas été ouverte).
 * - Autorisation refusée ou non décidée : aucune planification ; l'état de lecture reste écrit (À propos le dit).
 * - Rejet de l'envoi, ou identifiant 2 absent de `get_pending` après l'envoi : échec `schedule-failed`, mémorisé jusqu'à la prochaine étape,
 *   que le passage inscrit dans `planFailure` (bandeau « Les rappels n'ont pas pu être planifiés », chemin de N-01 critère 12).
 * Le journal ne reçoit que des codes.
 */

/** Une alerte à moins de 5 s n'est plus transmise (iOS la refuserait) : même marge que les rappels (`SEND_MARGIN_MS`, copiée pour ne pas charger l'adaptateur iOS au démarrage). */
const SEND_MARGIN_MS = 5_000;

export const SIGNING_TRIGGERS: readonly ReplanTrigger[] = ['open', 'resume', 'permission'];

interface ProcessMemory {
  /** Instant et texte du dernier envoi réussi de CE processus. */
  sent: string | null;
  /** Échec de l'alerte à la dernière étape : réinscrit dans `planFailure` par chaque passage jusqu'à la prochaine étape. */
  failure: PlanFailureReason | null;
  /** Minuterie qui tient le bandeau à jour tant que l'app est ouverte (revue I-02) ; arrêtée sans échéance connue et au démontage. */
  ticker: ReturnType<typeof setInterval> | null;
}

/** Le bandeau « expire dans … » se recalcule chaque minute tant que l'app est affichée. */
export const SIGNING_BANNER_TICK_MS = 60_000;

const memories = new WeakMap<AppContainer, ProcessMemory>();

function memoryOf(container: AppContainer): ProcessMemory {
  let known = memories.get(container);
  if (known === undefined) {
    known = { sent: null, failure: null, ticker: null };
    memories.set(container, known);
  }
  return known;
}

/** Échec de l'alerte d'expiration à mêler au `planFailure` du passage (null : aucun). */
export function signingAlertFailure(container: AppContainer): PlanFailureReason | null {
  return memoryOf(container).failure;
}

/** Action « Voir » du bandeau : l'écran « À propos », où la date, l'état de l'alerte et la marche à suivre sont écrits. */
const openAbout = (): void => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'about' });

const setBanner = (state: { readonly detail: 'soon' | 'expired'; readonly message: string } | null): void => useAppStatusStore.getState().setStatus('signingExpiry', state === null ? null : { ...state, onAction: openAbout });

/** Retire le bandeau et arrête sa minuterie (démontage de l'intégration). */
export function clearSigningBanner(container?: AppContainer): void {
  if (container !== undefined) stopTicker(memoryOf(container));
  setBanner(null);
}

function stopTicker(memory: ProcessMemory): void {
  if (memory.ticker !== null) clearInterval(memory.ticker);
  memory.ticker = null;
}

/** Bandeau selon l'échéance et l'heure courante : aucun (plus de 24 h), « expire dans … » ou « expirée ». Rend vrai tant qu'il peut encore changer. */
function showBanner(container: AppContainer, expiresAt: number): boolean {
  const clock = container.notificationClock;
  const zoneName = clock.zone();
  const notice = signingNotice({ expiresAt, now: clock.nowMs(), zone: zoneName !== null && isValidTimeZone(zoneName) ? zoneName : null });
  if (notice.state === 'soon') setBanner({ detail: 'soon', message: bannerSoonText(notice.remainingMs) });
  else if (notice.state === 'expired') setBanner({ detail: 'expired', message: t('status.signingExpired') });
  else setBanner(null);
  return notice.state !== 'expired';
}

/** Tient le bandeau à jour (durée restante, passage sous 24 h, expiration) tant que l'app est ouverte ; une seule minuterie par conteneur. */
function keepBannerFresh(container: AppContainer, memory: ProcessMemory, expiresAt: number): void {
  stopTicker(memory);
  if (!showBanner(container, expiresAt)) return;
  memory.ticker = setInterval(() => {
    if (!showBanner(container, expiresAt)) stopTicker(memory);
  }, SIGNING_BANNER_TICK_MS);
}

export interface SigningStepInput {
  readonly trigger: ReplanTrigger;
  readonly permission: NotificationPermission;
  readonly nowMs: number;
  readonly zone: string | null;
}

/** Une étape ; ne rejette jamais (une exception inattendue devient l'échec visible `schedule-failed`). */
export async function runSigningStep(container: AppContainer, input: SigningStepInput): Promise<void> {
  if (!SIGNING_TRIGGERS.includes(input.trigger) || !container.signing.source.supported) return;
  const memory = memoryOf(container);
  try {
    await step(container, input, memory);
  } catch {
    logFailure('signing', 'signing-step-failed');
    memory.failure = 'schedule-failed';
  }
}

async function step(container: AppContainer, input: SigningStepInput, memory: ProcessMemory): Promise<void> {
  const { source, alert } = container.signing;
  const { permission, nowMs, zone } = input;
  const controller = signingStatusController(container);
  await controller.load();
  const at = new Date(nowMs).toISOString() as IsoDateTime;

  const read = await source.read();
  if (!read.ok) {
    // `unavailable` sur l'iPhone installé : la commande est absente ou refusée, la date reste inconnue (jamais un silence).
    const code = read.code === 'profile-missing' ? 'profile-missing' : 'profile-unreadable';
    logFailure('signing', read.code);
    memory.failure = null;
    stopTicker(memory);
    setBanner(null);
    await controller.patch((current) => ({ ...current, failure: { at, code } }));
    return;
  }

  const expiresAt = Date.parse(read.expiresAt);
  const notice = signingNotice({ expiresAt, now: nowMs, zone });
  const lastRead = { at, expiresAt: read.expiresAt, issuedAt: read.issuedAt };

  if (notice.state === 'ok') {
    keepBannerFresh(container, memory, expiresAt);
    let scheduled = controller.get().scheduled;
    memory.failure = null;
    if (permission === 'granted' && notice.alertInstant - nowMs > SEND_MARGIN_MS) {
      const text = signingAlertText(expiresAt, zone);
      const key = `${String(notice.alertInstant)}|${text.title}|${text.body}`;
      try {
        // Même instant et même texte déjà envoyés par ce processus et présents chez iOS : rien.
        if (memory.sent === key && (await alert.isPending())) {
          scheduled = { instant: notice.alertInstant, expiresAt: read.expiresAt };
        } else {
          await alert.schedule({ instant: notice.alertInstant, zone, title: text.title, body: text.body });
          if (!(await alert.isPending())) throw new Error('absent de get_pending');
          memory.sent = key;
          scheduled = { instant: notice.alertInstant, expiresAt: read.expiresAt };
        }
      } catch {
        // Rejet de l'envoi ou alerte absente après l'envoi : l'ancienne alerte (autre échéance) n'est plus garantie.
        logFailure('signing', 'signing-alert-failed');
        memory.sent = null;
        memory.failure = 'schedule-failed';
      }
    }
    await controller.patch((current) => ({ ...current, lastRead, failure: null, scheduled }));
    return;
  }

  // `soon` ou `expired` : pas de notification, l'éventuelle alerte devenue inutile est retirée, le bandeau s'affiche.
  memory.failure = null;
  memory.sent = null;
  if (permission === 'granted') {
    try {
      if (controller.get().scheduled !== null || (await alert.isPending())) await alert.cancel();
    } catch {
      logFailure('signing', 'signing-cancel-failed');
      memory.failure = 'schedule-failed';
    }
  }
  keepBannerFresh(container, memory, expiresAt);
  await controller.patch((current) => ({ ...current, lastRead, failure: null, scheduled: memory.failure === null ? null : current.scheduled }));
}
