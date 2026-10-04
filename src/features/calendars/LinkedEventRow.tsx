import { useEffect, useState } from 'react';
import { externalEventSpan } from '../../domain/externalEvents';
import type { ExternalEvent, Task } from '../../domain/model';
import { weekStartOf } from '../../domain/week';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { t } from '../../i18n';
import { detectTimeZone } from '../../platform';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { onEventsChanged } from '../events/eventEvents';
import { useNavigationStore } from '../app/navigation';
import { DetailRow } from '../tasks/DetailRow';
import { displayTitle } from '../../domain/externalEvents';

/**
 * Ligne « Événement : Point client » de la fiche d'une tâche créée depuis un événement externe (K-04 critère 3), en lecture seule :
 * elle ouvre la fiche de l'événement (dans la Semaine, à la semaine de l'événement). Si l'événement a disparu (rafraîchissement,
 * compte supprimé, appareil qui ne l'a pas), la ligne dit « Événement supprimé » et n'est pas cliquable (critères 6 et 9). Rien
 * ne s'affiche pour une tâche sans lien.
 */
export function LinkedEventRow({ task }: { readonly task: Pick<Task, 'externalEventId'> }) {
  const container = useAppContainer();
  const navigate = useNavigationStore((s) => s.navigate);
  const openDetail = useNavigationStore((s) => s.openDetail);
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const eventId = task.externalEventId;
  const [loaded, setLoaded] = useState<{ readonly id: string; readonly event: ExternalEvent | null } | null>(null);

  useEffect(() => {
    if (eventId === null) return undefined;
    let alive = true;
    const read = (): void => {
      container.data.repos.externalEvents.getById(eventId).then(
        (event) => alive && setLoaded({ id: eventId, event }),
        () => alive && setLoaded({ id: eventId, event: null }),
      );
    };
    read();
    // Un rafraîchissement peut retirer l'événement pendant que la fiche est ouverte.
    const off = onEventsChanged(container.data, read);
    return () => {
      alive = false;
      off();
    };
  }, [container, eventId]);

  if (eventId === null || loaded === null || loaded.id !== eventId) return null;
  const { event } = loaded;
  if (event === null) return <DetailRow label={t('calendars.linkedEvent')}>{t('calendars.linkedEventDeleted')}</DetailRow>;
  const title = displayTitle(event.title, t('calendars.untitled'));
  const open = (): void => {
    const span = externalEventSpan(event, timeZone);
    if (span) navigate({ tab: 'week', weekStart: weekStartOf(span.firstDay, getFirstWeekday()), somedayPanel: false });
    openDetail({ type: 'externalEvent', id: event.id });
  };
  return (
    <DetailRow label={t('calendars.linkedEvent')}>
      <button type="button" className="ct-task-detail__valueButton" aria-label={t('calendars.linkedEventOpen', { title })} onClick={open}>
        {title}
      </button>
    </DetailRow>
  );
}
