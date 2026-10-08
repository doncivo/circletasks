import { localDateTimeAt } from '../../domain/notificationInstant';
import { t } from '../../i18n';
import { formatTime } from '../../i18n/format';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { formatCoverage } from './coverageText';
import { isInstalledIphone, notificationStatusStore, reminderProblems } from './notificationStatus';
import { PcReminderWarningSummary } from './PcReminderWarningSummary';
import { requestPermissionOnGesture } from './requestPermission';

/**
 * État des rappels dans Réglages > Rappels (N-01 critères 10 à 13, N-06, avenant N1.8) : couverture (« Planifiés jusqu'au… »), autorisation
 * (invitation « Autoriser » sur geste, ou refus avec renvoi aux réglages iOS), échec de planification, fin de Focus, fuseau, registre
 * reconstruit. PC : « Les rappels sont envoyés par l'iPhone », jamais un état d'échec de planification. Écran sans maquette, composé avec les
 * styles de l'écran des récapitulatifs.
 */
export function RemindersStatusSection() {
  const container = useAppContainer();
  const state = useFeatureStore(notificationStatusStore, (s) => s);
  const { status, availability } = state;
  const iphone = isInstalledIphone(container);
  const zoneName = container.notificationClock.zone();
  const clockTime = (iso: string): string => formatTime(localDateTimeAt(Date.parse(iso), zoneName).slice(11, 16));
  const nowLocal = localDateTimeAt(container.clock.nowMs(), zoneName);

  if (availability === 'unavailable' && !iphone) {
    return (
      <section className="ct-recap__status" aria-label={t('reminders.status.sectionTitle')}>
        <h2 className="ct-recap__sectionTitle">{t('reminders.status.sectionTitle')}</h2>
        <p className="ct-recap__statusLine" data-kind="pc">
          {t('reminders.status.pcInfo')}
        </p>
        <PcReminderWarningSummary />
      </section>
    );
  }

  const problems = reminderProblems(state, iphone);
  const failure = status.planFailure;
  return (
    <section className="ct-recap__status" aria-label={t('reminders.status.sectionTitle')}>
      <h2 className="ct-recap__sectionTitle">{t('reminders.status.sectionTitle')}</h2>
      {availability === 'unavailable' && (
        <p className="ct-recap__statusLine" data-kind="problem">
          {t('reminders.status.unavailable')}
        </p>
      )}
      {availability !== 'unavailable' && status.permission === 'denied' && (
        <p className="ct-recap__statusLine" data-kind="problem">
          {t('reminders.status.permissionDenied')}
        </p>
      )}
      {availability !== 'unavailable' && status.permission === 'undetermined' && (
        <>
          <p className="ct-recap__statusLine" data-kind="problem">
            {t('reminders.status.permissionUndetermined')}
          </p>
          <p className="ct-recap__statusLine">{t('reminders.status.allowExplain')}</p>
          <Button type="button" onClick={() => void requestPermissionOnGesture(container)}>
            {t('reminders.status.allowButton')}
          </Button>
        </>
      )}
      {failure !== null && failure.reason !== 'zone-unknown' && (
        <p className="ct-recap__statusLine" data-kind="problem">
          {t('reminders.status.planFailed')} · {t('reminders.status.planFailedAt', { time: clockTime(failure.at), code: failure.reason })}
          {failure.partial !== null && ` · ${t('reminders.status.planFailedPartial', failure.partial)}`}
        </p>
      )}
      {status.focusEndFailure !== null && (
        <p className="ct-recap__statusLine" data-kind="problem">
          {t('reminders.status.focusEndFailed')} · {t('reminders.status.planFailedAt', { time: clockTime(status.focusEndFailure.at), code: status.focusEndFailure.reason })}
        </p>
      )}
      {failure !== null && failure.reason === 'zone-unknown' && (
        <p className="ct-recap__statusLine" data-kind="problem">
          {t('reminders.status.zoneUnknown')}
        </p>
      )}
      {status.zoneChange !== null && <p className="ct-recap__statusLine">{t('reminders.status.zoneChanged', { time: clockTime(status.zoneChange.at) })}</p>}
      {status.ledgerRebuiltAt !== null && <p className="ct-recap__statusLine">{t('reminders.status.ledgerRebuilt', { time: clockTime(status.ledgerRebuiltAt) })}</p>}
      {availability === 'available' && status.permission === 'granted' && problems.length === 0 && (
        <p className="ct-recap__statusLine" data-kind="coverage">
          {status.lastSuccess === null ? t('reminders.status.neverPlanned') : formatCoverage(status.lastSuccess.coverage, nowLocal)}
        </p>
      )}
      {availability === 'available' && status.permission === 'granted' && problems.length > 0 && status.lastSuccess !== null && (
        <p className="ct-recap__statusLine" data-kind="coverage">
          {formatCoverage(status.lastSuccess.coverage, nowLocal)}
        </p>
      )}
      {availability === 'available' && <p className="ct-recap__statusLine">{t('reminders.status.zoneLimit')}</p>}
    </section>
  );
}
