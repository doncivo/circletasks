import { t } from './index';

/**
 * Durée de concentration (F-03 critère 6), un seul formateur : « 45 min », « 1 h 15 », « 14 h 20 », « 2 h » ; jamais « 75 min » au-delà
 * de 60 ; 24 h et plus restent en heures. Minutes arrondies à l'entier, jamais négatives.
 */
export function formatFocusDuration(totalMinutes: number): string {
  const total = Math.max(0, Math.round(totalMinutes));
  if (total < 60) return t('focus.unitMinutes', { min: total });
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? t('focus.unitHours', { hours }) : t('focus.unitHoursMinutes', { hours, min: String(minutes).padStart(2, '0') });
}

/** « 1 session », « 3 sessions ». */
export function formatFocusSessions(count: number): string {
  return count === 1 ? t('focus.sessionOne') : t('focus.sessionMany', { count });
}

/** Pied de l'écran Focus (F-03 critères 1 et 2) : sessions terminées seulement. */
export function formatFocusToday(minutes: number, sessions: number): string {
  return sessions === 0 && minutes <= 0 ? t('focus.todayZero') : t('focus.today', { duration: formatFocusDuration(minutes), sessions: formatFocusSessions(sessions) });
}

/**
 * Pied de l'écran Focus avec la session active (UI-FIX-06) : `runningSeconds` = secondes actives de la session en cours (pauses
 * exclues), null sans session active. Sous la minute et sans session terminée, les secondes ; ensuite la minute entamée s'ajoute aux
 * sessions terminées, et « en cours » le dit. Le total persistant (F-03) n'est pas modifié.
 */
export function formatFocusTodayLive(today: { readonly minutes: number; readonly sessions: number }, runningSeconds: number | null): string {
  const running = Math.max(0, Math.floor(runningSeconds ?? 0));
  if (runningSeconds === null || running === 0) return formatFocusToday(today.minutes, today.sessions);
  const totalSeconds = today.minutes * 60 + running;
  if (today.sessions === 0 && totalSeconds < 60) return t('focus.todaySeconds', { seconds: running });
  const duration = formatFocusDuration(Math.floor(totalSeconds / 60));
  return today.sessions === 0 ? t('focus.todayRunning', { duration }) : t('focus.todayRunningAfter', { duration, sessions: formatFocusSessions(today.sessions) });
}
