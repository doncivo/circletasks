import { localDateTimeAt } from '../../domain/notificationInstant';
import { t } from '../../i18n';
import { formatDayLabel, formatTime } from '../../i18n/format';

/**
 * Textes de l'expiration de la signature (I-02) : tout vient de `src/i18n` (espace `signing`). Le contenu de l'alerte ne porte ni titre de
 * tâche ni donnée personnelle (critère 10) ; le journal technique n'en reçoit jamais le texte.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Jour court et heure (format choisi dans Réglages, 24 h par défaut) d'un instant, en heure murale du fuseau. */
export function wallText(instantMs: number, zone: string | null): { readonly date: string; readonly time: string } {
  const local = localDateTimeAt(instantMs, zone);
  return { date: formatDayLabel(local.slice(0, 10)), time: formatTime(local.slice(11, 16)) };
}

/** Titre et corps de l'alerte (D1, texte neutre : SideStore peut actualiser l'app sans l'ouvrir). */
export function signingAlertText(expiresAt: number, zone: string | null): { readonly title: string; readonly body: string } {
  const { date, time } = wallText(expiresAt, zone);
  return { title: t('signing.alertTitle'), body: t('signing.alertBody', { date, time }) };
}

/** Durée restante du bandeau (< 24 h) : « 5 h » ou « 40 min » (au moins 1 min). */
export function bannerDuration(remainingMs: number): string {
  if (remainingMs >= HOUR_MS) return t('signing.durationHours', { n: Math.floor(remainingMs / HOUR_MS) });
  return t('signing.durationMinutes', { n: Math.max(1, Math.floor(remainingMs / MINUTE_MS)) });
}

/** Bandeau « CircleTasks expire dans {durée} : actualisez-la dans SideStore » (D3). */
export function bannerSoonText(remainingMs: number): string {
  return t('signing.bannerSoon', { duration: bannerDuration(remainingMs) });
}

/** « dans 6 jours » ; « dans 30 h » sous 48 h ; « dans 40 min » sous 1 h (D4). */
export function aboutRemaining(remainingMs: number): string {
  if (remainingMs >= 48 * HOUR_MS) return t('signing.about.remainingDays', { n: Math.round(remainingMs / (24 * HOUR_MS)) });
  if (remainingMs >= HOUR_MS) return t('signing.about.remainingHours', { n: Math.floor(remainingMs / HOUR_MS) });
  return t('signing.about.remainingMinutes', { n: Math.max(1, Math.floor(remainingMs / MINUTE_MS)) });
}
