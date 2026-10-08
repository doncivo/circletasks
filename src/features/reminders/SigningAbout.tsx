import { useEffect } from 'react';
import { signingNotice } from '../../domain/signingNotice';
import { isValidTimeZone } from '../../domain/timeZone';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { localDateTimeAt } from '../../domain/notificationInstant';
import type { SigningStatusV1 } from '../../domain/signingNotice';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { notificationStatusStore } from './notificationStatus';
import { signingAlertFailure } from './signingNotice';
import { signingStatusController, signingStatusStore } from './signingStatus';
import { aboutRemaining, wallText } from './signingText';

/**
 * Expiration de la signature SideStore dans « À propos » et dans Réglages > Rappels (I-02, ADR 0013 §3.3, fiche I-02 critères 7 et 8).
 * iPhone installé seulement : la source n'est pas prise en charge sur le PC et dans le navigateur, la ligne est alors absente. Aucun
 * échec silencieux : date illisible ou absente, autorisation refusée et alerte non planifiée sont dits en toutes lettres.
 */

const failureCodeText = (code: 'profile-missing' | 'profile-unreadable'): string => t(code === 'profile-missing' ? 'signing.about.codeMissing' : 'signing.about.codeUnreadable');

function useSigningState() {
  const container = useAppContainer();
  const state = useFeatureStore(signingStatusStore, (s) => s);
  useEffect(() => {
    if (container.signing.source.supported) void signingStatusController(container).load();
  }, [container]);
  const rawZone = container.notificationClock.zone();
  const zone = rawZone !== null && isValidTimeZone(rawZone) ? rawZone : null;
  return { container, status: state.status, loaded: state.loaded, zone, nowMs: container.notificationClock.nowMs() };
}

/** Ligne « Date d'expiration inconnue » : lecture en échec, avec l'heure et le code (Réglages > Rappels et À propos). */
export function SigningFailureLine({ status, zone }: { readonly status: SigningStatusV1; readonly zone: string | null }) {
  if (status.failure === null) return null;
  return (
    <>
      <span className="ct-settings__hint ct-settings__hint--danger" role="status" data-kind="signing-unknown">
        {t('signing.about.unknown')}
      </span>
      <span className="ct-settings__hint">
        {t('signing.about.unknownAt', { time: formatTime(localDateTimeAt(Date.parse(status.failure.at), zone).slice(11, 16)), code: failureCodeText(status.failure.code) })}
      </span>
    </>
  );
}

/** Ligne de Réglages > Rappels : la lecture de la date a échoué, l'alerte avant expiration est désactivée. */
export function SigningRemindersLine() {
  const { container, status, zone } = useSigningState();
  if (!container.signing.source.supported || status.failure === null) return null;
  return (
    <p className="ct-recap__statusLine" data-kind="problem">
      {t('signing.about.unknown')} · {t('signing.about.unknownAt', { time: formatTime(localDateTimeAt(Date.parse(status.failure.at), zone).slice(11, 16)), code: failureCodeText(status.failure.code) })}
    </p>
  );
}

/** Ligne « Expire le … » de « À propos » (iPhone). */
export function SigningAboutRow() {
  const { container, status, zone, nowMs } = useSigningState();
  const permission = useFeatureStore(notificationStatusStore, (s) => s.status.permission);
  if (!container.signing.source.supported) return null;

  let main: string;
  let hint: string | null = null;
  let hintDanger = false;
  let mainDanger = false;
  if (status.failure !== null) {
    return (
      <div className="ct-settings__row" data-kind="signing">
        <span className="ct-settings__stack">
          <SigningFailureLine status={status} zone={zone} />
        </span>
      </div>
    );
  }
  if (status.lastRead === null) {
    // Aucun passage terminé depuis le lancement et rien d'enregistré : la lecture est en cours.
    main = t('signing.about.reading');
  } else {
    const expiresAt = Date.parse(status.lastRead.expiresAt);
    const notice = signingNotice({ expiresAt, now: nowMs, zone });
    const { date, time } = wallText(expiresAt, zone);
    if (notice.state === 'unknown') {
      main = t('signing.about.unknown');
      mainDanger = true;
    } else if (notice.state === 'expired') {
      main = t('signing.about.expired', { date, time });
      mainDanger = true;
    } else {
      main = t('signing.about.expires', { date, time, remaining: aboutRemaining(expiresAt - nowMs) });
      if (permission === 'denied') {
        hint = t('signing.about.notificationsDenied');
        hintDanger = true;
      } else if (permission === 'undetermined') {
        hint = t('signing.about.notificationsUndetermined');
        hintDanger = true;
      } else if (signingAlertFailure(container) !== null) {
        hint = t('signing.about.alertFailed');
        hintDanger = true;
      } else if (notice.state === 'soon') {
        hint = t('signing.about.alertSoon');
      } else {
        const alert = wallText(notice.alertInstant, zone);
        hint = t('signing.about.alertAt', { date: alert.date, time: alert.time });
      }
    }
  }
  return (
    <div className="ct-settings__row" data-kind="signing">
      <span className="ct-settings__stack">
        <span className={mainDanger ? 'ct-settings__hint--danger' : undefined}>{main}</span>
        {hint !== null && (
          <span className={hintDanger ? 'ct-settings__hint ct-settings__hint--danger' : 'ct-settings__hint'} role="status">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}
