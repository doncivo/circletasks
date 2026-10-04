import { createPortal } from 'react-dom';
import { displayTitle, externalEventSpan } from '../../domain/externalEvents';
import { t } from '../../i18n';
import { formatDetailDate } from '../../i18n/format';
import { DetailPanel, Sheet, useDetailSlot, useLayout } from '../../ui';
import { detectTimeZone } from '../../platform';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { DetailRow } from '../tasks/DetailRow';
import { weekStore } from './weekStore';

/**
 * Fiche en lecture seule d'un événement d'agenda externe (S-05) : titre, date, heures locales de début et de fin, agenda source.
 * Aucun champ n'est modifiable, aucune action (ni terminer, ni reporter, ni supprimer) : l'événement se modifie dans son agenda.
 * Panneau à droite sur PC (par-dessus la grille), feuille sur iPhone, comme la fiche d'une tâche (A-08).
 */
export function ExternalEventDetail() {
  const detail = useNavigationStore((s) => s.detail);
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const layout = useLayout();
  const slot = useDetailSlot();
  const events = useFeatureStore(weekStore, (s) => s.externalEvents);
  const accounts = useFeatureStore(weekStore, (s) => s.calendarAccounts);
  // Fuseau de l'appareil (T-11) : les heures de la fiche suivent un changement de fuseau, comme la grille.
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';

  const event = detail?.type === 'externalEvent' ? events.find((candidate) => candidate.id === detail.id) : undefined;
  if (!event) return null;
  const account = accounts.find((candidate) => candidate.id === event.accountId);
  const calendar = account?.calendars.find((candidate) => candidate.id === event.calendarId);
  const span = externalEventSpan(event, timeZone);
  const source = [calendar?.name, account?.label].filter((part): part is string => Boolean(part)).join(' · ');

  const content = (
    <div className="ct-task-detail">
      <div className="ct-task-detail__header">
        <h2 className="ct-task-detail__title">{displayTitle(event.title, t('calendars.untitled'))}</h2>
      </div>
      <p className="ct-week-eventDetail__note">{t('week.eventReadOnlyNote')}</p>
      {span && (
        <>
          <DetailRow label={t('week.eventDate')}>
            {span.lastDay === span.firstDay
              ? formatDetailDate(span.firstDay)
              : t('week.eventDateRange', { from: formatDetailDate(span.firstDay, false), to: formatDetailDate(span.lastDay) })}
          </DetailRow>
          <DetailRow label={t('week.eventStart')}>{span.allDay || span.startTime === null ? t('today.eventAllDay') : span.startTime}</DetailRow>
          {!span.allDay && span.endTime !== null && <DetailRow label={t('week.eventEnd')}>{span.endTime}</DetailRow>}
        </>
      )}
      {source !== '' && <DetailRow label={t('week.eventCalendar')}>{source}</DetailRow>}
    </div>
  );

  if (layout === 'pc') {
    const panel = (
      <DetailPanel label={t('week.eventDetailLabel')} onClose={closeDetail} width={588}>
        {content}
      </DetailPanel>
    );
    return slot ? createPortal(panel, slot) : panel;
  }
  return (
    <Sheet open onClose={closeDetail} label={t('week.eventDetailLabel')} className="ct-sheet--tall">
      {content}
    </Sheet>
  );
}
